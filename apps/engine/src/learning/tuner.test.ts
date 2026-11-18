import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { planTuning, type TunerParams } from "./tuner.js";
import { SIM, baseStrategy, coin, fillingAddresses, pathFrom } from "./test-helpers.js";
import type { CoinRecord, StrategyConfig, StrategyVersion } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 8);

const PARAMS: TunerParams = {
  lookbackDays: 14,
  holdoutDays: 3,
  minTrades: 20,
  minHoldoutTrades: 5,
  promoteMarginPct: 0.5,
  cooldownDays: 2,
  populationSize: 8,
  cullCount: 2,
  maxTimeExitMin: 55,
};

/**
 * Every coin pops to +80% in its first minutes and then falls back to -60%.
 * The live ladder (first rung at +50%) catches a little of it; a version
 * whose first rung sells most of the position at +50% catches much more.
 */
function poppers(n: number, spanDays: number): CoinRecord[] {
  return fillingAddresses("pop", n).map((p, i) =>
    coin(p, NOW - spanDays * DAY + (i * spanDays * DAY) / n, pathFrom([[0, 1], [2, 1.8], [5, 1.2], [8, 0.4], [60, 0.4]])),
  );
}

const v = (name: string, config: StrategyConfig, isChampion = false): StrategyVersion => ({
  name,
  parentName: null,
  generation: 0,
  config,
  isChampion,
  createdAt: NOW - 20 * DAY,
});

const live = baseStrategy();
const better = baseStrategy({ exits: { tpLadder: [{ gainPct: 50, sellPct: 90 }] } });
const worse = baseStrategy({ exits: { stopLossPct: -85, tpLadder: [{ gainPct: 900, sellPct: 50 }] } });
const others = Array.from({ length: 5 }, (_, i) => v(`other-${i}`, baseStrategy({ exits: { timeExitMin: 10 + i, stopLossPct: -50 - i } })));

describe("nightly tuner plan", () => {
  test("a version that wins on both windows is promoted; the plan says what changes", async () => {
    const plan = await planTuning({
      coins: poppers(200, 13),
      population: [v("live", live, true), v("better", better), v("worse", worse), ...others],
      now: NOW,
      params: PARAMS,
      sim: SIM,
      lastPromotionAt: null,
      seed: "t1",
    });
    assert.equal(plan.candidate, "better");
    assert.equal(plan.promotion.promote, true, JSON.stringify(plan.promotion.checks));
    assert.ok(plan.promotion.changes.some((c) => c.startsWith("take-profit ladder")));
    assert.equal(plan.evals[0]!.name, "better");
    assert.ok(!plan.retire.includes("live") && !plan.retire.includes("better"));
    assert.equal(plan.retire.length, PARAMS.cullCount);
    assert.equal(plan.create.length, PARAMS.cullCount);
    assert.ok(plan.retire.includes("worse"), "the worst version is retired");
  });

  test("winning only on the ranking window is not enough", async () => {
    // the holdout days are full of coins that rocket past +50% and keep going: selling early loses there
    const rockets = fillingAddresses("rocket", 40).map((p, i) =>
      coin(p, NOW - 2.5 * DAY + i * 0.05 * DAY, pathFrom([[0, 1], [2, 1.8], [10, 6], [60, 9]])),
    );
    const plan = await planTuning({
      coins: [...poppers(150, 13).filter((c) => c.decidedAt < NOW - 3 * DAY), ...rockets],
      population: [v("live", live, true), v("better", better), ...others],
      now: NOW,
      params: PARAMS,
      sim: SIM,
      lastPromotionAt: null,
      seed: "t2",
    });
    assert.equal(plan.candidate, "better");
    assert.equal(plan.promotion.promote, false);
    const failed = plan.promotion.checks.filter((c) => !c.ok).map((c) => c.check);
    assert.ok(failed.includes("beats the live version on the holdout by the margin"), failed.join(", "));
  });

  test("too few trades: nothing is ranked, retired or bred", async () => {
    const plan = await planTuning({
      coins: poppers(10, 13),
      population: [v("live", live, true), v("better", better)],
      now: NOW,
      params: PARAMS,
      sim: SIM,
      lastPromotionAt: null,
      seed: "t3",
    });
    assert.equal(plan.promotion.promote, false);
    assert.deepEqual(plan.retire, []);
    assert.deepEqual(plan.create, []);
    assert.ok(plan.notes[0]!.includes("Keep collecting"));
  });

  test("a recent promotion blocks another until the cool-down passes", async () => {
    const input = {
      coins: poppers(200, 13),
      population: [v("live", live, true), v("better", better), ...others],
      now: NOW,
      params: PARAMS,
      sim: SIM,
      seed: "t4",
    };
    assert.equal((await planTuning({ ...input, lastPromotionAt: NOW - 1 * DAY })).promotion.promote, false);
    assert.equal((await planTuning({ ...input, lastPromotionAt: NOW - 3 * DAY })).promotion.promote, true);
  });

  test("the plan is the same every time for the same data and seed", async () => {
    const input = {
      coins: poppers(120, 13),
      population: [v("live", live, true), v("better", better), v("worse", worse), ...others],
      now: NOW,
      params: PARAMS,
      sim: SIM,
      lastPromotionAt: null,
      seed: "same",
    };
    assert.deepEqual(await planTuning(input), await planTuning(input));
  });
});
