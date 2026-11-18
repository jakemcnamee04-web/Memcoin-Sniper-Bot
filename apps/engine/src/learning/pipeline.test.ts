import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedFilterConfig } from "../config/filter-config.js";
import { tpLadder, tradingSettings } from "../config/trading-settings.js";
import { generateEvent } from "../feeds/synthetic-feed.js";
import { FilterOrchestrator } from "../filters/orchestrator.js";
import { NightlyScheduler, runNightly } from "./nightly.js";
import { OutcomeTracker } from "./outcome-tracker.js";
import { weeklyData, weeklyMarkdown } from "./report.js";
import { MemoryLearningStore } from "./store.js";
import { sameTuning, strategyFromLive } from "./strategy.js";
import { SIM } from "./test-helpers.js";
import type { StrategyConfig } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 8);

const cfg: ResolvedFilterConfig = {
  enabled: () => true,
  liquidityMinUsd: 5_000,
  liquidityMaxUsd: 500_000,
  lpLockedRequired: true,
  mintAuthRenounced: true,
  freezeAuthRenounced: true,
  topHolderMaxPct: 15,
  top10HoldersMaxPct: 35,
  devRugRateMax: 0.3,
  honeypotSimRequired: true,
  maxSellTaxPct: 10,
  bundledLaunchReject: true,
  minFilterScore: 70,
};

/** Synthetic launches through the real filters and the real tracker, spread over two weeks. */
async function record(store: MemoryLearningStore, n: number): Promise<void> {
  const tracker = new OutcomeTracker({
    store,
    fetchBatch: async () => new Map(),
    thresholds: () => ({ liquidityMinUsd: 5_000, liquidityMaxUsd: 500_000, topHolderMaxPct: 15, top10HoldersMaxPct: 35, devRugRateMax: 0.3, maxSellTaxPct: 10, minFilterScore: 70 }),
    windowMin: 60,
    maxRpm: 20,
    rejectSampleRate: 1,
  });
  const orch = new FilterOrchestrator();
  orch.on("verdict-backtest", (v) => tracker.onVerdict(v));
  for (let i = 0; i < n; i++) {
    const pool = generateEvent();
    tracker.notePool(pool);
    await orch.evaluate(pool, { persist: false, configOverride: cfg });
  }
  await orch.drain();
  await new Promise((r) => setImmediate(r));
  // the recordings happened just now; place them across the lookback, as two weeks of running would
  const rows = [...store.coins.values()];
  rows.forEach((row, i) => (row.coin.decidedAt = NOW - 14 * DAY + Math.floor((i * 14 * DAY) / rows.length)));
}

describe("learning loop end to end", () => {
  test("record → nightly tune → promote → report, twice, on synthetic launches", async () => {
    const store = new MemoryLearningStore();
    await record(store, 2_500);
    assert.equal(store.coins.size, 2_500);

    let live: StrategyConfig = strategyFromLive(cfg, tradingSettings(), tpLadder());
    const promoted: string[] = [];
    const messages: string[] = [];
    const reportsDir = await mkdtemp(path.join(tmpdir(), "learning-"));
    const night = (now: number) =>
      runNightly({
        store,
        now,
        live: () => live,
        params: { lookbackDays: 14, holdoutDays: 3, minTrades: 30, minHoldoutTrades: 10, promoteMarginPct: 1, cooldownDays: 2, populationSize: 20, cullCount: 5, maxTimeExitMin: 55 },
        sim: SIM,
        retentionDays: 30,
        maxCoins: 0,
        apply: true,
        promoteLive: async (config, name) => {
          live = structuredClone(config);
          promoted.push(name);
        },
        reportsDir,
        notify: async (html) => void messages.push(html),
      });

    const first = await night(NOW);
    const versions1 = await store.loadVersions();
    assert.equal(first.plan.evals.length, 20, "the population was seeded to full size");
    assert.equal(versions1.length, 20 - first.plan.retire.length + first.plan.create.length);
    assert.equal(versions1.filter((v) => v.isChampion).length, 1);
    assert.ok(first.plan.evals.some((e) => e.eligible), "synthetic data gives enough trades to rank");
    assert.equal(store.runs.length, 1);
    assert.equal(messages.length, 1);
    const files = await readdir(reportsDir);
    assert.ok(files.includes("nightly-2026-11-20.md") && files.includes("nightly-2026-11-20.json"));
    assert.ok((await readFile(path.join(reportsDir, "nightly-2026-11-20.md"), "utf8")).includes("## Ranking"));

    const champ1 = versions1.find((v) => v.isChampion)!;
    assert.ok(sameTuning(champ1.config, live), "the live settings are the champion's");
    if (first.promotedLive) assert.equal(promoted.at(-1), champ1.name);

    const second = await night(NOW + DAY);
    const versions2 = await store.loadVersions();
    assert.equal(versions2.filter((v) => v.isChampion).length, 1);
    assert.ok(!second.plan.evals.some((e) => e.name.startsWith("manual-")), "no false 'changed by hand' after a promotion");
    assert.ok(versions2.some((v) => v.generation >= 1), "bred versions compete");
    if (first.promotedLive) assert.equal(second.promotedLive, false, "the cool-down holds the next night");

    const week = weeklyData({ coins: await store.loadCoins(NOW - 7 * DAY, NOW), champion: versions2.find((v) => v.isChampion)!, runs: store.runs, sim: SIM, from: NOW - 7 * DAY, to: NOW });
    const md = weeklyMarkdown(week);
    assert.ok(md.includes("## Missed winners") && md.includes("## Filters under the live version"));
    assert.ok(week.filters.length > 5);
  });

  test("the scheduler runs once a day, at its hour", async () => {
    let runs = 0;
    const s = new NightlyScheduler(8, async () => null, async () => void runs++);
    assert.equal(await s.check(new Date(Date.UTC(2026, 10, 20, 7, 55))), false);
    assert.equal(await s.check(new Date(Date.UTC(2026, 10, 20, 8, 1))), true);
    assert.equal(await s.check(new Date(Date.UTC(2026, 10, 20, 8, 6))), false);
    assert.equal(await s.check(new Date(Date.UTC(2026, 10, 21, 8, 2))), true);
    assert.equal(runs, 2);
  });
});
