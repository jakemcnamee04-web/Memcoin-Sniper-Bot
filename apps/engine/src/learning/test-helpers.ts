import { FILTER_ORDER, type FilterId } from "@sniperbot/shared";
import { FAILED_FILL_RATE } from "./constants.js";
import { unitHash } from "./rng.js";
import type { SimOptions } from "./simulator.js";
import { type PackedPath, packSamples } from "./path.js";
import type { CoinRecord, RecordedResult, StrategyConfig } from "./types.js";

/** Shared fixtures for the learning tests. */

export const SIM: SimOptions = { startingBalanceUsd: 10_000, jitoTipLamports: 10_000, rugDropPct: 30 };

export function baseStrategy(over: { exits?: Partial<StrategyConfig["exits"]>; filters?: Partial<StrategyConfig["filters"]>; sizing?: Partial<StrategyConfig["sizing"]> } = {}): StrategyConfig {
  return {
    filters: {
      enabled: Object.fromEntries(FILTER_ORDER.map((id) => [id, true])) as Record<FilterId, boolean>,
      minFilterScore: 0,
      liquidityMinUsd: 0,
      liquidityMaxUsd: 5_000_000,
      topHolderMaxPct: 15,
      top10HoldersMaxPct: 35,
      devRugRateMax: 0.3,
      maxSellTaxPct: 10,
      lpLockedRequired: true,
      mintAuthRenounced: true,
      freezeAuthRenounced: true,
      honeypotSimRequired: true,
      bundledLaunchReject: true,
      ...over.filters,
    },
    exits: {
      stopLossPct: -40,
      tpLadder: [
        { gainPct: 50, sellPct: 25 },
        { gainPct: 100, sellPct: 25 },
        { gainPct: 300, sellPct: 25 },
        { gainPct: 900, sellPct: 15 },
      ],
      trailingStopPct: 30,
      trailingStopActivationPct: 200,
      timeExitMin: 30,
      ...over.exits,
    },
    sizing: {
      positionSizePct: 1,
      maxConcurrentPositions: 10,
      maxTotalExposurePct: 30,
      maxPositionPerMin: 3,
      dailyDrawdownLimitPct: 10,
      weeklyDrawdownLimitPct: 25,
      haltOnConsecutiveLosses: 20,
      ...over.sizing,
    },
  };
}

/** Pool addresses whose fixed fill draw does not fail, so a test controls every outcome. */
export function fillingAddresses(prefix: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) {
    const a = `${prefix}-${i}`;
    if (unitHash(`${a}:fill`) >= FAILED_FILL_RATE) out.push(a);
  }
  return out;
}

export const cleanResults = (top1 = 5, top10 = 20): RecordedResult[] => [
  { filterId: "honeypot-sim", status: "pass", score: 100, metadata: { sellTaxPct: 0 } },
  { filterId: "mint-authority", status: "pass", score: 100 },
  { filterId: "top-holders", status: top1 <= 15 && top10 <= 35 ? "pass" : "fail", score: top1 <= 15 && top10 <= 35 ? 100 : 0, metadata: { top1, top10 } },
];

/** price as a multiple of 1 at each [minute] mark */
export function pathFrom(points: Array<[number, number]>, liq: number | null = 50_000): PackedPath {
  return packSamples(points.map(([min, mult]) => [Math.round(min * 60_000), mult, liq] as const));
}

export function coin(poolAddress: string, decidedAt: number, path: PackedPath, over: Partial<CoinRecord> = {}): CoinRecord {
  return {
    poolAddress,
    tokenMint: `mint-${poolAddress}`,
    source: "pumpswap",
    synthetic: false,
    decidedAt,
    decision: "snipe",
    initialLiquidityUsd: 50_000,
    results: cleanResults(),
    evalThresholds: { liquidityMinUsd: 0, liquidityMaxUsd: 5_000_000, topHolderMaxPct: 15, top10HoldersMaxPct: 35, devRugRateMax: 0.3, maxSellTaxPct: 10, minFilterScore: 0 },
    path,
    timeScale: 1,
    endReason: "window",
    ...over,
  };
}
