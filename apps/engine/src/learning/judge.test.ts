import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FilterId, OrchestratorVerdict, PoolEvent } from "@sniperbot/shared";
import { FILTER_ORDER } from "@sniperbot/shared";
import type { ResolvedFilterConfig } from "../config/filter-config.js";
import { tpLadder, tradingSettings } from "../config/trading-settings.js";
import { generateEvent } from "../feeds/synthetic-feed.js";
import { FilterOrchestrator } from "../filters/orchestrator.js";
import { judgeCoin } from "./judge.js";
import { strategyFromLive } from "./strategy.js";
import type { EvalThresholds, RecordedResult } from "./types.js";

function resolved(over: Partial<Omit<ResolvedFilterConfig, "enabled">> & { off?: FilterId[] } = {}): ResolvedFilterConfig {
  const { off = [], ...t } = over;
  return {
    enabled: (id) => !off.includes(id),
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
    ...t,
  };
}

const thresholdsOf = (c: ResolvedFilterConfig): EvalThresholds => ({
  liquidityMinUsd: c.liquidityMinUsd,
  liquidityMaxUsd: c.liquidityMaxUsd,
  topHolderMaxPct: c.topHolderMaxPct,
  top10HoldersMaxPct: c.top10HoldersMaxPct,
  devRugRateMax: c.devRugRateMax,
  maxSellTaxPct: c.maxSellTaxPct,
  minFilterScore: c.minFilterScore,
});

async function verdicts(pools: PoolEvent[], cfg: ResolvedFilterConfig): Promise<Map<string, OrchestratorVerdict>> {
  const orch = new FilterOrchestrator();
  const out = new Map<string, OrchestratorVerdict>();
  orch.on("verdict-backtest", (v) => out.set(v.poolAddress, v));
  for (const p of pools) await orch.evaluate(p, { persist: false, configOverride: cfg });
  await orch.drain();
  return out;
}

const record = (v: OrchestratorVerdict): RecordedResult[] =>
  v.results.map((r) => ({ filterId: r.filterId, status: r.status, score: r.score, metadata: r.metadata }));

describe("judge replays the orchestrator", () => {
  const pools = Array.from({ length: 400 }, () => generateEvent());

  test("same settings: same decision and score as the live orchestrator", async () => {
    const cfg = resolved();
    const live = await verdicts(pools, cfg);
    const strategy = strategyFromLive(cfg, tradingSettings(), tpLadder());
    let snipes = 0;
    for (const p of pools) {
      const v = live.get(p.poolAddress)!;
      const j = judgeCoin({ results: record(v), evalThresholds: thresholdsOf(cfg) }, strategy.filters);
      assert.equal(j.decision, v.decision, `decision for ${p.poolAddress}`);
      assert.equal(j.scorePct, v.totalScore, `score for ${p.poolAddress}`);
      if (j.decision === "snipe") snipes++;
    }
    assert.ok(snipes > 0 && snipes < pools.length, "the sample has both outcomes");
  });

  test("new thresholds on old recordings: same decisions as running the filters again", async () => {
    const a = resolved();
    const variants = [
      resolved({ topHolderMaxPct: 25, top10HoldersMaxPct: 60, devRugRateMax: 0.5, maxSellTaxPct: 20, minFilterScore: 50 }),
      resolved({ topHolderMaxPct: 8, top10HoldersMaxPct: 25, devRugRateMax: 0.1, maxSellTaxPct: 3, liquidityMinUsd: 20_000 }),
      resolved({ off: ["social-signal", "volume-velocity", "anti-sniper-war"], minFilterScore: 85 }),
    ];
    const recorded = await verdicts(pools, a);
    for (const b of variants) {
      const fresh = await verdicts(pools, b);
      const strategy = strategyFromLive(b, tradingSettings(), tpLadder());
      let changed = 0;
      for (const p of pools) {
        const old = recorded.get(p.poolAddress)!;
        const now = fresh.get(p.poolAddress)!;
        const j = judgeCoin({ results: record(old), evalThresholds: thresholdsOf(a) }, strategy.filters);
        assert.equal(j.decision, now.decision, `decision for ${p.poolAddress}`);
        assert.equal(j.scorePct, now.totalScore, `score for ${p.poolAddress}`);
        if (now.decision !== old.decision) changed++;
      }
      assert.ok(changed > 0, "the variant changes some decisions, so the test means something");
    }
  });

  test("a filter that did not run is treated as off", () => {
    const strategy = strategyFromLive(resolved({ minFilterScore: 0 }), tradingSettings(), tpLadder());
    const results: RecordedResult[] = [{ filterId: "honeypot-sim", status: "pass", score: 100 }];
    const j = judgeCoin({ results, evalThresholds: thresholdsOf(resolved()) }, strategy.filters);
    assert.equal(j.decision, "snipe");
    assert.equal(j.scorePct, 100);
    assert.deepEqual(Object.keys(j.statuses), ["honeypot-sim"]);
    assert.ok(FILTER_ORDER.length > 1);
  });

  test("a honeypot fail is not undone by a looser tax limit", () => {
    const strict = resolved({ maxSellTaxPct: 10 });
    const loose = strategyFromLive(resolved({ maxSellTaxPct: 30, minFilterScore: 0 }), tradingSettings(), tpLadder());
    const results: RecordedResult[] = [{ filterId: "honeypot-sim", status: "fail", score: 0, metadata: { sellTaxPct: 2 } }];
    assert.equal(judgeCoin({ results, evalThresholds: thresholdsOf(strict) }, loose.filters).decision, "reject");
    const taxed: RecordedResult[] = [{ filterId: "honeypot-sim", status: "fail", score: 0, metadata: { sellTaxPct: 20 } }];
    assert.equal(judgeCoin({ results: taxed, evalThresholds: thresholdsOf(strict) }, loose.filters).decision, "snipe");
  });
});
