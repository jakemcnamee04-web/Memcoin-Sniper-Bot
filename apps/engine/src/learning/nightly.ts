import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILT_IN_PRESETS, type FilterId } from "@sniperbot/shared";
import { childLogger } from "../utils/logger.js";
import { createRng } from "./rng.js";
import type { SimOptions } from "./simulator.js";
import type { LearningStore } from "./store.js";
import { SAFETY_FILTERS, mutate, sameTuning, withPreset } from "./strategy.js";
import { measuredFilters, planTuning, type TunerParams, type TunerPlan } from "./tuner.js";
import { nightlyMarkdown, nightlyTelegram } from "./report.js";
import type { StrategyConfig, StrategyVersion } from "./types.js";

const log = childLogger("nightly-tuner");
const DAY_MS = 24 * 60 * 60 * 1000;

export interface NightlyDeps {
  store: LearningStore;
  now: number;
  /** the settings the live paper bot runs right now */
  live: () => StrategyConfig;
  params: TunerParams;
  sim: SimOptions;
  retentionDays: number;
  /** replay at most this many coins (an even sample above it); 0 = no limit */
  maxCoins: number;
  /** false: compute and report only; nothing is saved */
  apply: boolean;
  /** switches the live bot to a version; null leaves the live settings alone (auto-promote off, or not paper mode) */
  promoteLive: ((cfg: StrategyConfig, name: string) => Promise<void>) | null;
  reportsDir: string | null;
  notify: ((html: string) => Promise<void>) | null;
}

export interface NightlyResult {
  plan: TunerPlan;
  promotedLive: boolean;
  reportPath: string | null;
  summary: string;
}

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace(/[-:T]/g, "");

/**
 * Makes sure the population has a champion that matches what the live bot
 * runs, every version uses the live sizing and risk limits, and there are
 * enough versions to compare. Returns the population and what it changed.
 */
export function preparePopulation(input: {
  versions: StrategyVersion[];
  live: StrategyConfig;
  now: number;
  params: TunerParams;
  tunable: FilterId[];
  seed: string;
}): { population: StrategyVersion[]; changed: StrategyVersion[]; notes: string[] } {
  const { live, now, params } = input;
  const notes: string[] = [];
  const changed = new Map<string, StrategyVersion>();
  const population = input.versions.map((v) => ({ ...v, config: { ...v.config, sizing: { ...live.sizing } } }));
  for (const v of population) changed.set(v.name, v);

  let champion = population.find((v) => v.isChampion);
  if (!champion || !sameTuning(champion.config, live)) {
    const fresh: StrategyVersion = {
      name: champion ? `manual-${stamp(now)}` : `baseline-${stamp(now)}`,
      parentName: champion?.name ?? null,
      generation: champion ? champion.generation : 0,
      config: structuredClone(live),
      isChampion: true,
      createdAt: now,
    };
    notes.push(
      champion
        ? `The live settings were changed by hand since ${champion.name} was promoted, so they compete as ${fresh.name}.`
        : `First run: the current live settings start as ${fresh.name}.`,
    );
    if (champion) champion.isChampion = false;
    population.push(fresh);
    changed.set(fresh.name, fresh);
    champion = fresh;
  }

  const rng = createRng(`${input.seed}:seed`);
  const opts = { tunableFilters: input.tunable, maxTimeExitMin: params.maxTimeExitMin };
  const seeds = BUILT_IN_PRESETS.filter((p) => p.name !== "Learning") // Learning switches off safety checks
    .map((p) => ({ name: `preset-${p.name.toLowerCase().replace(/\s+/g, "-")}`, config: withPreset(champion!.config, p.config, params.maxTimeExitMin) }));
  for (const s of seeds) {
    if (population.length >= params.populationSize) break;
    if (population.some((v) => v.name === s.name || sameTuning(v.config, s.config))) continue;
    const v: StrategyVersion = { name: s.name, parentName: champion.name, generation: champion.generation, config: s.config, isChampion: false, createdAt: now };
    population.push(v);
    changed.set(v.name, v);
  }
  let i = 0;
  while (population.length < params.populationSize && i < params.populationSize * 5) {
    i++;
    const config = mutate(champion.config, rng, opts);
    if (population.some((v) => sameTuning(v.config, config))) continue;
    const v: StrategyVersion = {
      name: `seed-${stamp(now)}-${String(population.length).padStart(2, "0")}`,
      parentName: champion.name,
      generation: champion.generation + 1,
      config,
      isChampion: false,
      createdAt: now,
    };
    population.push(v);
    changed.set(v.name, v);
  }
  return { population, changed: [...changed.values()], notes };
}

export async function runNightly(deps: NightlyDeps): Promise<NightlyResult> {
  const { store, now, params } = deps;
  const seed = new Date(now).toISOString().slice(0, 10);

  if (deps.apply) {
    const removed = await store.deleteCoinsBefore(now - deps.retentionDays * DAY_MS);
    if (removed > 0) log.info({ removed }, "old recordings removed");
  }
  const from = now - params.lookbackDays * DAY_MS;
  const total = await store.countCoins(from, now);
  const keepRate = deps.maxCoins > 0 && total > deps.maxCoins ? deps.maxCoins / total : 1;
  const coins = await store.loadCoins(from, now, keepRate);
  const tunable = measuredFilters(coins).filter((id) => !SAFETY_FILTERS.has(id));
  const live = deps.live();
  const prep = preparePopulation({ versions: await store.loadVersions(), live, now, params, tunable, seed });

  const runs = await store.loadRuns(now - 365 * DAY_MS);
  const lastPromotion = [...runs].reverse().find((r) => r.promoted !== null && r.applied);

  const plan = await planTuning({
    coins,
    population: prep.population,
    now,
    params,
    sim: deps.sim,
    lastPromotionAt: lastPromotion?.ranAt ?? null,
    seed,
  });

  const byName = new Map(prep.population.map((v) => [v.name, v]));
  let promotedLive = false;
  const extraNotes = [...prep.notes];
  if (keepRate < 1) {
    extraNotes.push(`${total} coins recorded in the window; an even ${(keepRate * 100).toFixed(0)}% sample (${coins.length}) was replayed to stay within TUNER_MAX_COINS.`);
  }

  if (deps.apply) {
    for (const v of prep.changed) await store.saveVersion(v);
    for (const v of plan.create) await store.saveVersion(v);
    await store.retireVersions(plan.retire, now);
    if (plan.promotion.promote && plan.promotion.to) {
      const winner = byName.get(plan.promotion.to)!;
      if (deps.promoteLive) {
        try {
          await deps.promoteLive(winner.config, winner.name);
          await store.setChampion(winner.name);
          promotedLive = true;
        } catch (err) {
          extraNotes.push(`Promotion of ${winner.name} failed and the live settings were left alone: ${(err as Error).message}`);
          log.error({ err, version: winner.name }, "promotion failed");
        }
      } else {
        extraNotes.push(`${winner.name} passed every check, but auto-promote is off: the live settings were not changed.`);
      }
    }
  }

  const champ = plan.evals.find((e) => e.isChampion);
  const failed = plan.promotion.checks.find((c) => !c.ok);
  const summary = plan.promotion.promote
    ? `${promotedLive ? "Promoted" : "Qualified"} ${plan.promotion.to}: ${plan.promotion.changes.slice(0, 4).join("; ")}`
    : `Kept ${plan.champion} (${champ?.selection.trades ?? 0} trades, ${(champ?.selection.netPnlPct ?? 0).toFixed(1)}% net)${failed ? `; blocked by: ${failed.check}` : ""}`;

  const markdown = nightlyMarkdown(plan, {
    applied: deps.apply,
    promotedLive,
    championConfig: byName.get(plan.champion)!.config,
    candidateConfig: plan.candidate ? byName.get(plan.candidate)!.config : null,
    extraNotes,
  });

  let reportPath: string | null = null;
  if (deps.reportsDir) {
    await mkdir(deps.reportsDir, { recursive: true });
    const base = `nightly-${new Date(now).toISOString().slice(0, 10)}`;
    reportPath = path.join(deps.reportsDir, `${base}.md`);
    await writeFile(reportPath, markdown);
    await writeFile(path.join(deps.reportsDir, `${base}.json`), JSON.stringify(compactPlan(plan, summary), null, 2));
  }

  if (deps.apply) {
    await store.saveRun({ ranAt: now, applied: true, promoted: promotedLive ? plan.promotion.to : null, report: compactPlan(plan, summary) });
  }

  if (deps.notify) {
    try {
      await deps.notify(nightlyTelegram(plan, promotedLive));
    } catch (err) {
      log.warn({ err: (err as Error).message }, "nightly Telegram summary failed");
    }
  }

  log.info({ coins: plan.data.coins, versions: plan.evals.length, promoted: promotedLive ? plan.promotion.to : null, summary }, "nightly tuner finished");
  return { plan, promotedLive, reportPath, summary };
}

/** The plan without bulky fields, for the database and the JSON report. */
export function compactPlan(plan: TunerPlan, summary: string) {
  return {
    summary,
    ranAt: plan.ranAt,
    window: plan.window,
    data: plan.data,
    champion: plan.champion,
    candidate: plan.candidate,
    promotion: plan.promotion,
    retire: plan.retire,
    create: plan.create.map((v) => ({ name: v.name, parentName: v.parentName })),
    notes: plan.notes,
    evals: plan.evals.map((e) => ({
      name: e.name,
      rank: e.rank,
      isChampion: e.isChampion,
      eligible: e.eligible,
      selectionScore: e.selectionScore,
      holdoutScore: e.holdoutScore,
      selection: e.selection,
      holdout: e.holdout,
    })),
  };
}

/**
 * Runs the tuner once a day at TUNER_HOUR_UTC inside the engine, so a
 * promotion reaches the running bot at once.
 */
export class NightlyScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunDay: string | null = null;

  constructor(
    private readonly hourUtc: number,
    private readonly lastRunAt: () => Promise<number | null>,
    private readonly run: () => Promise<unknown>,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    const last = await this.lastRunAt().catch(() => null);
    this.lastRunDay = last === null ? null : new Date(last).toISOString().slice(0, 10);
    this.timer = setInterval(() => void this.check(), 5 * 60_000);
    log.info({ hourUtc: this.hourUtc, lastRunDay: this.lastRunDay }, "nightly tuner scheduled");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(now = new Date()): Promise<boolean> {
    const today = now.toISOString().slice(0, 10);
    if (this.running || now.getUTCHours() !== this.hourUtc || this.lastRunDay === today) return false;
    this.running = true;
    this.lastRunDay = today;
    try {
      await this.run();
    } catch (err) {
      log.error({ err }, "nightly tuner failed");
    } finally {
      this.running = false;
    }
    return true;
  }
}
