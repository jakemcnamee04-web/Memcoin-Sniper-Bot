import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "./simulator.js";
import { SIM, baseStrategy, coin, fillingAddresses, pathFrom } from "./test-helpers.js";

const T0 = Date.UTC(2026, 10, 1);
const MIN = 60_000;

describe("replay simulator", () => {
  const [a, b, c, d, e] = fillingAddresses("sim", 5) as [string, string, string, string, string];

  test("take-profits fill at their levels, one per tick, and the rest sells at the time exit", () => {
    // +60% then +120%: two rungs; then fades below +50% peak guard? no — peak 120 keeps it open until window end
    const r = simulate(baseStrategy(), [coin(a, T0, pathFrom([[0, 1], [1, 1.6], [2, 2.2], [3, 1.9], [60, 1.8]]))], SIM);
    assert.equal(r.trades.length, 1);
    const t = r.trades[0]!;
    assert.deepEqual(t.exits.map((x) => x.reason), ["tp1", "tp2", "window-end"]);
    assert.ok(t.pnlUsd > 0);
    assert.ok(t.peakGainPct > 100 && t.peakGainPct < 120, "peak is measured from the entry price, which paid a premium");
  });

  test("a stop-loss fills at the sampled price that crossed it", () => {
    const r = simulate(baseStrategy(), [coin(a, T0, pathFrom([[0, 1], [1, 0.9], [2, 0.3]]))], SIM);
    const t = r.trades[0]!;
    assert.equal(t.exitReason, "stop-loss");
    assert.ok(t.pnlPct < -69 && t.pnlPct > -72, `sold near the -70% sample, got ${t.pnlPct}`);
  });

  test("the time exit only fires on a position that never reached +50%", () => {
    const flat = simulate(baseStrategy(), [coin(a, T0, pathFrom([[0, 1], [10, 1.1], [31, 1.05], [60, 1.0]]))], SIM);
    assert.equal(flat.trades[0]!.exitReason, "time-exit");
    const popped = simulate(baseStrategy(), [coin(a, T0, pathFrom([[0, 1], [10, 1.6], [31, 1.3], [60, 1.2]]))], SIM);
    assert.equal(popped.trades[0]!.exitReason, "window-end");
  });

  test("the trailing stop arms at its activation gain and sells on the drop from the peak", () => {
    const cfg = baseStrategy({ exits: { tpLadder: [{ gainPct: 1000, sellPct: 50 }], trailingStopActivationPct: 100, trailingStopPct: 30 } });
    const r = simulate(cfg, [coin(a, T0, pathFrom([[0, 1], [5, 2.5], [6, 2.0], [7, 1.7]]))], SIM);
    assert.equal(r.trades[0]!.exitReason, "trailing-stop");
    assert.ok(r.trades[0]!.closedAt === T0 + 7 * MIN, "2.5 → 1.7 is the first sample 30% under the peak");
  });

  test("a coin that stops being quoted is written off", () => {
    const r = simulate(baseStrategy(), [coin(a, T0, pathFrom([[0, 1], [2, 0.8]]), { endReason: "unpriced" })], SIM);
    assert.equal(r.trades[0]!.exitReason, "written-off");
    assert.ok(r.trades[0]!.pnlPct < -99);
  });

  test("a liquidity collapse closes as a rug with the extra exit cost", () => {
    const path = [...pathFrom([[0, 1], [1, 1.1]]), 2 * MIN, 0.6, 5_000];
    const r = simulate(baseStrategy(), [coin(a, T0, path)], SIM);
    assert.equal(r.trades[0]!.exitReason, "rug-pull");
  });

  test("no price soon enough after the verdict: no buy", () => {
    const late = coin(a, T0, pathFrom([[1, 1], [10, 3]]));
    assert.equal(simulate(baseStrategy(), [late], SIM).trades.length, 0);
  });

  test("open slots and buys per minute gate entries like the live trader", () => {
    const coins = [a, b, c, d].map((p, i) => coin(p, T0 + i * 1_000, pathFrom([[0, 1], [60, 1.6]])));
    const full = simulate(baseStrategy({ sizing: { maxConcurrentPositions: 2 } }), coins, SIM);
    assert.equal(full.trades.length, 2);
    assert.equal(full.metrics.skippedFull, 2);
    const rate = simulate(baseStrategy({ sizing: { maxPositionPerMin: 3 } }), coins, SIM);
    assert.equal(rate.trades.length, 3);
    assert.equal(rate.metrics.skippedRate, 1);
  });

  test("losses in a row halt new entries for a day", () => {
    const losers = fillingAddresses("lose", 4).map((p, i) => coin(p, T0 + i * 10 * MIN, pathFrom([[0, 1], [1, 0.5]])));
    const later = coin(e, T0 + 60 * MIN, pathFrom([[0, 1], [60, 1.6]]));
    const r = simulate(baseStrategy({ sizing: { haltOnConsecutiveLosses: 3 } }), [...losers, later], SIM);
    assert.equal(r.trades.length, 3);
    assert.equal(r.metrics.skippedHalted, 2);
  });

  test("filters decide what is bought", () => {
    const concentrated = coin(a, T0, pathFrom([[0, 1], [60, 3]]), {
      results: [{ filterId: "top-holders", status: "fail", score: 0, metadata: { top1: 20, top10: 40 } }],
    });
    assert.equal(simulate(baseStrategy(), [concentrated], SIM).trades.length, 0);
    const looser = baseStrategy({ filters: { topHolderMaxPct: 25, top10HoldersMaxPct: 50 } });
    assert.equal(simulate(looser, [concentrated], SIM).trades.length, 1);
  });

  test("the same input always gives the same result", () => {
    const coins = fillingAddresses("det", 30).map((p, i) =>
      coin(p, T0 + i * 7 * MIN, pathFrom([[0, 1], [1, 1 + (i % 5) * 0.3], [3, 1 + (i % 7) * 0.2], [20, 0.5 + (i % 3) * 0.4], [60, 1]])),
    );
    assert.deepEqual(simulate(baseStrategy(), coins, SIM), simulate(baseStrategy(), coins, SIM));
  });

  test("metrics: P&L without the top three removes the luck", () => {
    const coins = [
      ...fillingAddresses("win", 3).map((p, i) => coin(p, T0 + i * 60 * MIN, pathFrom([[0, 1], [1, 11], [60, 11]]))),
      ...fillingAddresses("meh", 6).map((p, i) => coin(p, T0 + (10 + i) * 60 * MIN, pathFrom([[0, 1], [1, 0.5]]))),
    ];
    const m = simulate(baseStrategy(), coins, SIM).metrics;
    assert.equal(m.trades, 9);
    assert.ok(m.netPnlPct > 0, "three 10× wins carry the total");
    assert.ok(m.pnlExTop3Pct < 0, "without them it loses");
    assert.ok(m.maxDrawdownPct > 0);
  });
});
