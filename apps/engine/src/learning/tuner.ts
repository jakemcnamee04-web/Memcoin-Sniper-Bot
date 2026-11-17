import { FILTER_ORDER, type FilterId } from "@sniperbot/shared";
import { createRng } from "./rng.js";
import { simulate, type SimOptions } from "./simulator.js";
import { SAFETY_FILTERS, describeChanges, mutate, sameTuning } from "./strategy.js";
import type { CoinRecord, SimMetrics, StrategyVersion } from "./types.js";

/**
 * The nightly decision, as a pure function of the data: rank every version,
 * decide whether the best one has earned the live slot, retire the weakest
 * and breed replacements from the strongest. Nothing here writes anywhere;
 * nightly.ts applies the plan.
 *
 * The guards against fooling ourselves:
 *  - versions are ranked on a selection window and the winner must ALSO beat
 *    the live version on the most recent days, which no ranking has looked at;
 *  - a version needs a minimum number of trades before its result counts;
 *  - the score removes each version's three best trades and charges for
 *    drawdown, so one lucky moonshot cannot carry it;
 *  - promotions are rate-limited, and sizing and risk limits are never tuned.
 */

export interface TunerParams {
  lookbackDays: number;
  holdoutDays: number;
  minTrades: number;
  minHoldoutTrades: number;
  /** % of the bankroll the challenger must beat the live version by on the holdout */
  promoteMarginPct: number;
  cooldownDays: number;
  populationSize: number;
  cullCount: number;
  /** the tracker follows a coin this long; a time exit beyond it cannot be replayed */
  maxTimeExitMin: number;
}

export interface VersionEval {
  name: string;
  isChampion: boolean;
  generation: number;
  selection: SimMetrics;
  holdout: SimMetrics;
  selectionScore: number;
  holdoutScore: number;
  eligible: boolean;
  rank: number;
}

export interface TunerPlan {
  ranAt: number;
  window: { from: number; holdoutFrom: number; to: number };
  data: { coins: number; selectionCoins: number; holdoutCoins: number; measuredFilters: FilterId[] };
  evals: VersionEval[];
  champion: string;
  candidate: string | null;
  promotion: { promote: boolean; to: string | null; checks: Array<{ check: string; ok: boolean; detail: string }>; changes: string[] };
  retire: string[];
  create: StrategyVersion[];
  notes: string[];
}

/** Profit without the three best trades, minus half the worst drawdown — all as % of the bankroll. */
export function scoreOf(m: SimMetrics): number {
  return m.pnlExTop3Pct - 0.5 * m.maxDrawdownPct;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Filters that ran on nearly every coin: the only ones a version can switch and be judged on. */
export function measuredFilters(coins: readonly CoinRecord[]): FilterId[] {
  if (coins.length === 0) return [];
  const seen = new Map<FilterId, number>();
  for (const c of coins) for (const r of c.results) seen.set(r.filterId, (seen.get(r.filterId) ?? 0) + 1);
  return FILTER_ORDER.filter((id) => (seen.get(id) ?? 0) >= coins.length * 0.9);
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function planTuning(input: {
  coins: readonly CoinRecord[];
  population: readonly StrategyVersion[];
  now: number;
  params: TunerParams;
  sim: SimOptions;
  lastPromotionAt: number | null;
  seed: string;
}): Promise<TunerPlan> {
  const { coins, population, now, params, sim } = input;
  const notes: string[] = [];
  const champion = population.find((v) => v.isChampion);
  if (!champion) throw new Error("planTuning needs a champion in the population");

  const from = now - params.lookbackDays * DAY_MS;
  const holdoutFrom = now - params.holdoutDays * DAY_MS;
  const sorted = [...coins].filter((c) => c.decidedAt >= from && c.decidedAt < now).sort((a, b) => a.decidedAt - b.decidedAt);
  const selectionCoins = sorted.filter((c) => c.decidedAt < holdoutFrom);
  const holdoutCoins = sorted.filter((c) => c.decidedAt >= holdoutFrom);
  const measured = measuredFilters(sorted);

  const evals: VersionEval[] = [];
  for (const v of population) {
    // a pause between replays: inside the engine, the live bot keeps running between them
    await yieldToEventLoop();
    const selection = simulate(v.config, selectionCoins, sim).metrics;
    await yieldToEventLoop();
    const holdout = simulate(v.config, holdoutCoins, sim).metrics;
    evals.push({
      name: v.name,
      isChampion: v.isChampion,
      generation: v.generation,
      selection,
      holdout,
      selectionScore: scoreOf(selection),
      holdoutScore: scoreOf(holdout),
      eligible: selection.trades >= params.minTrades,
      rank: 0,
    });
  }
  evals.sort((a, b) =>
    a.eligible !== b.eligible ? (a.eligible ? -1 : 1) : a.eligible ? b.selectionScore - a.selectionScore : b.selection.trades - a.selection.trades,
  );
  evals.forEach((e, i) => (e.rank = i + 1));

  const champEval = evals.find((e) => e.isChampion)!;
  const candEval = evals.find((e) => e.eligible && !e.isChampion) ?? null;
  const byName = new Map(population.map((v) => [v.name, v]));

  // --- promotion ---
  const checks: TunerPlan["promotion"]["checks"] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ check: name, ok, detail });
  const f1 = (n: number) => n.toFixed(1);
  if (!candEval) {
    check("a challenger has enough trades", false, `none reached ${params.minTrades} trades in the selection window`);
  } else {
    const champSel = champEval.eligible ? champEval.selectionScore : -Infinity;
    check(
      "beats the live version on the selection window",
      candEval.selectionScore > champSel,
      `${f1(candEval.selectionScore)} vs ${champEval.eligible ? f1(champEval.selectionScore) : `live has only ${champEval.selection.trades} trades`}`,
    );
    check(
      "enough trades on the holdout",
      candEval.holdout.trades >= params.minHoldoutTrades,
      `${candEval.holdout.trades} (need ${params.minHoldoutTrades})`,
    );
    check("made money on the holdout", candEval.holdout.netPnlPct > 0, `${f1(candEval.holdout.netPnlPct)}% of the bankroll`);
    check(
      "beats the live version on the holdout by the margin",
      candEval.holdoutScore >= champEval.holdoutScore + params.promoteMarginPct,
      `${f1(candEval.holdoutScore)} vs ${f1(champEval.holdoutScore)} + ${params.promoteMarginPct}`,
    );
    const sinceDays = input.lastPromotionAt === null ? Infinity : (now - input.lastPromotionAt) / DAY_MS;
    check(
      "cool-down since the last promotion",
      sinceDays >= params.cooldownDays,
      input.lastPromotionAt === null ? "no promotion yet" : `${f1(sinceDays)} days (need ${params.cooldownDays})`,
    );
  }
  const promote = candEval !== null && checks.every((c) => c.ok);
  const promotion = {
    promote,
    to: promote ? candEval!.name : null,
    checks,
    changes: promote ? describeChanges(champion.config, byName.get(candEval!.name)!.config) : [],
  };

  // --- evolution ---
  const retire: string[] = [];
  const create: StrategyVersion[] = [];
  const eligible = evals.filter((e) => e.eligible);
  if (eligible.length === 0) {
    notes.push(`No version has ${params.minTrades} trades in the selection window yet, so nothing was ranked, retired or bred. Keep collecting.`);
  } else {
    const protectedNames = new Set([champEval.name, candEval?.name].filter(Boolean) as string[]);
    const retirable = evals.filter((e) => !protectedNames.has(e.name)).reverse(); // worst first
    for (const e of retirable.slice(0, params.cullCount)) retire.push(e.name);

    const parents = eligible.slice(0, Math.max(3, Math.ceil(params.populationSize / 4))).map((e) => byName.get(e.name)!);
    const rng = createRng(input.seed);
    const tunable = measured.filter((id) => !SAFETY_FILTERS.has(id));
    const keep = population.filter((v) => !retire.includes(v.name));
    const stamp = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
    const want = params.populationSize - keep.length;
    for (let i = 0; i < want; i++) {
      const parent = rng.pick(parents);
      let config = mutate(parent.config, rng, { tunableFilters: tunable, maxTimeExitMin: params.maxTimeExitMin });
      // no twins: a copy of a living version would only split its votes
      for (let tries = 0; tries < 5 && [...keep, ...create].some((v) => sameTuning(v.config, config)); tries++) {
        config = mutate(config, rng, { tunableFilters: tunable, maxTimeExitMin: params.maxTimeExitMin });
      }
      create.push({
        name: `v${stamp}-${String(i + 1).padStart(2, "0")}`,
        parentName: parent.name,
        generation: parent.generation + 1,
        config,
        isChampion: false,
        createdAt: now,
      });
    }
  }

  if (holdoutCoins.length === 0) notes.push("No coins in the holdout window: nothing can be promoted until the tracker has recent data.");
  const excluded = FILTER_ORDER.filter((id) => !measured.includes(id));
  if (sorted.length > 0 && excluded.length > 0) {
    notes.push(`Not measured on most coins, so versions cannot use them: ${excluded.join(", ")}.`);
  }

  return {
    ranAt: now,
    window: { from, holdoutFrom, to: now },
    data: { coins: sorted.length, selectionCoins: selectionCoins.length, holdoutCoins: holdoutCoins.length, measuredFilters: measured },
    evals,
    champion: champion.name,
    candidate: candEval?.name ?? null,
    promotion,
    retire,
    create,
    notes,
  };
}
