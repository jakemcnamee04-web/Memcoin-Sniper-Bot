import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestratorVerdict, PoolEvent } from "@sniperbot/shared";
import type { MarketQuote } from "../execution/market-price.js";
import { generateEvent } from "../feeds/synthetic-feed.js";
import { OutcomeTracker, type BatchFetcher } from "./outcome-tracker.js";
import { MemoryLearningStore } from "./store.js";
import { sampleCount, tAt } from "./path.js";

const T0 = Date.UTC(2026, 10, 1);

function harness(opts: { prices: (mint: string, now: number) => number | null; fail?: (now: number) => boolean; maxRpm?: number; rejectSampleRate?: number }) {
  let now = T0;
  const store = new MemoryLearningStore();
  const calls: Array<{ at: number; ids: string[] }> = [];
  const fetchBatch: BatchFetcher = async (ids) => {
    calls.push({ at: now, ids });
    if (opts.fail?.(now)) throw new Error("Jupiter 503");
    const out = new Map<string, MarketQuote>();
    for (const id of ids) {
      const p = opts.prices(id, now);
      if (p !== null) out.set(id, { priceUsd: p, liquidityUsd: 40_000, decimals: 6, at: now });
    }
    return out;
  };
  const tracker = new OutcomeTracker({
    store,
    fetchBatch,
    thresholds: () => ({ liquidityMinUsd: 0, liquidityMaxUsd: 1e9, topHolderMaxPct: 15, top10HoldersMaxPct: 35, devRugRateMax: 0.3, maxSellTaxPct: 10, minFilterScore: 70 }),
    windowMin: 60,
    maxRpm: opts.maxRpm ?? 60,
    rejectSampleRate: opts.rejectSampleRate ?? 1,
    now: () => now,
  });
  const add = (n: number, decision: "snipe" | "reject" = "snipe") => {
    const pools: PoolEvent[] = [];
    for (let i = 0; i < n; i++) {
      const pool: PoolEvent = { ...generateEvent(), rawEvent: undefined, detectedAt: now };
      tracker.notePool(pool);
      tracker.onVerdict({ poolAddress: pool.poolAddress, decision, decidedAt: now, results: [{ filterId: "honeypot-sim", status: "pass", score: 100, evaluatedAt: now, durationMs: 0, reason: "" }] } as unknown as OrchestratorVerdict);
      pools.push(pool);
    }
    return pools;
  };
  const run = async (untilMs: number, stepMs = 1_000) => {
    while (now < untilMs) {
      now += stepMs;
      await tracker.tick();
    }
  };
  return { tracker, store, calls, add, run, at: () => now };
}

describe("outcome tracker", () => {
  test("follows a coin for the whole window, densely at first, and stores it", async () => {
    const h = harness({ prices: () => 1 });
    h.add(1);
    await h.run(T0 + 61 * 60_000);
    const [c] = await h.store.loadCoins(0);
    assert.ok(c);
    assert.equal(c.endReason, "window");
    assert.ok(tAt(c.path, 0) <= 2_000, "first price right after the verdict");
    const times = Array.from({ length: sampleCount(c.path) }, (_, i) => tAt(c.path, i));
    const firstFive = times.filter((t) => t < 5 * 60_000).length;
    const lastFive = times.filter((t) => t >= 55 * 60_000).length;
    assert.ok(firstFive >= 25 && lastFive <= 6, `${firstFive} early samples, ${lastFive} late`);
  });

  test("stays within its request budget and batches up to 50 mints", async () => {
    const h = harness({ prices: () => 1, maxRpm: 6 });
    h.add(120);
    await h.run(T0 + 10 * 60_000);
    assert.ok(h.calls.every((c) => c.ids.length <= 50));
    for (let m = 1; m < 10; m++) {
      const inMinute = h.calls.filter((c) => c.at > T0 + m * 60_000 && c.at <= T0 + (m + 1) * 60_000).length;
      assert.ok(inMinute <= 7, `minute ${m}: ${inMinute} requests`);
    }
    assert.ok(h.tracker.getStats().maxLagMs > 0, "over budget, polls run late instead of being dropped");
  });

  test("a coin with no price soon after its verdict is closed as no-price", async () => {
    const h = harness({ prices: () => null });
    h.add(1);
    await h.run(T0 + 60_000);
    const [c] = await h.store.loadCoins(0);
    assert.equal(c?.endReason, "no-price");
  });

  test("a priced coin that stops being quoted is closed as unpriced, a collapsed one as dead", async () => {
    let quiet = false;
    const h = harness({ prices: (mint, now) => (mint === dead ? (now > T0 + 60_000 ? 0.01 : 1) : quiet ? null : 1) });
    const [p1, p2] = h.add(2);
    const dead = p2!.tokenMint;
    await h.run(T0 + 2 * 60_000);
    quiet = true;
    await h.run(T0 + 8 * 60_000);
    const coins = new Map((await h.store.loadCoins(0)).map((c) => [c.poolAddress, c]));
    assert.equal(coins.get(p1!.poolAddress)?.endReason, "unpriced");
    assert.equal(coins.get(p2!.poolAddress)?.endReason, "dead");
  });

  test("a Jupiter outage does not count against the coins", async () => {
    const h = harness({ prices: () => 1, fail: (now) => now > T0 + 30_000 && now < T0 + 6 * 60_000 });
    h.add(3);
    await h.run(T0 + 10 * 60_000);
    assert.equal(h.tracker.getStats().following, 3, "still followed after a 5-minute outage");
    assert.ok(h.tracker.getStats().requestErrors > 0);
  });

  test("rejects can be sampled; bought coins never are", async () => {
    const h = harness({ prices: () => 1, rejectSampleRate: 0 });
    h.add(10, "reject");
    h.add(2, "snipe");
    assert.equal(h.tracker.getStats().following, 2);
    assert.equal(h.tracker.getStats().sampledOut, 10);
  });

  test("a synthetic coin is recorded at once from its simulated price", async () => {
    const h = harness({ prices: () => 1 });
    const pool = generateEvent();
    h.tracker.notePool(pool);
    h.tracker.onVerdict({ poolAddress: pool.poolAddress, decision: "reject", decidedAt: T0, results: [] } as unknown as OrchestratorVerdict);
    await new Promise((r) => setImmediate(r));
    const [c] = await h.store.loadCoins(0);
    assert.ok(c?.synthetic);
    assert.equal(c.timeScale, 30);
    assert.ok(sampleCount(c.path) > 5);
    assert.equal(h.calls.length, 0, "no price requests for synthetic coins");
  });

  test("stopping stores what is being followed", async () => {
    const h = harness({ prices: () => 1 });
    h.add(2);
    await h.run(T0 + 30_000);
    await h.tracker.stop();
    const coins = await h.store.loadCoins(0);
    assert.equal(coins.length, 2);
    assert.ok(coins.every((c) => c.endReason === "shutdown" && sampleCount(c.path) > 0));
  });
});
