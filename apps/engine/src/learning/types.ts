import type { Decision, DexSource, FilterId, FilterStatus, TpRung } from "@sniperbot/shared";

/**
 * One filter's answer as it was recorded when the coin was judged. The
 * metadata carries the measured numbers (top-holder %, rug rate, round-trip
 * loss), which is what lets a different version re-judge the same coin later
 * without asking any API again.
 */
export interface RecordedResult {
  filterId: FilterId;
  status: FilterStatus;
  score: number;
  metadata?: Record<string, unknown>;
}

/** The numeric thresholds in force when a coin was judged. */
export interface EvalThresholds {
  liquidityMinUsd: number;
  liquidityMaxUsd: number;
  topHolderMaxPct: number;
  top10HoldersMaxPct: number;
  devRugRateMax: number;
  maxSellTaxPct: number;
  minFilterScore: number;
}

import type { PackedPath } from "./path.js";

export type TrackEndReason =
  // followed for the whole window
  | "window"
  // fell below the floor every version's stop-loss sits above
  | "dead"
  // had prices, then nobody quoted it: its value is gone
  | "unpriced"
  // never got a first price in time: no version could have bought it
  | "no-price"
  // the engine stopped or crashed while it was being followed
  | "shutdown";

/**
 * Everything needed to replay one coin under any version: what the filters
 * measured, and what its price did afterwards.
 */
export interface CoinRecord {
  poolAddress: string;
  tokenMint: string;
  source: DexSource;
  synthetic: boolean;
  /** epoch ms of the verdict: the moment a version would have bought */
  decidedAt: number;
  /** what the live bot decided */
  decision: Decision;
  initialLiquidityUsd: number;
  results: RecordedResult[];
  evalThresholds: EvalThresholds;
  /** flat [ms since the verdict, price USD, liquidity USD or -1] triples; see path.ts */
  path: PackedPath;
  /**
   * Multiplier from path time to the time exits are judged on. 1 for real
   * coins; synthetic coins run 30× faster, as the live exit engine runs them.
   */
  timeScale: number;
  endReason: TrackEndReason | null;
}

/** The filter half of a version. Booleans are not tuned; they are copied from the live settings. */
export interface StrategyFilters {
  enabled: Record<FilterId, boolean>;
  minFilterScore: number;
  liquidityMinUsd: number;
  liquidityMaxUsd: number;
  topHolderMaxPct: number;
  top10HoldersMaxPct: number;
  devRugRateMax: number;
  maxSellTaxPct: number;
  lpLockedRequired: boolean;
  mintAuthRenounced: boolean;
  freezeAuthRenounced: boolean;
  honeypotSimRequired: boolean;
  bundledLaunchReject: boolean;
}

export interface StrategyExits {
  /** negative */
  stopLossPct: number;
  tpLadder: TpRung[];
  trailingStopPct: number;
  trailingStopActivationPct: number;
  timeExitMin: number;
}

/** Sizing and risk are copied from the live settings and never tuned: the tuner must not win by betting bigger. */
export interface StrategySizing {
  positionSizePct: number;
  maxConcurrentPositions: number;
  maxTotalExposurePct: number;
  maxPositionPerMin: number;
  dailyDrawdownLimitPct: number;
  weeklyDrawdownLimitPct: number;
  haltOnConsecutiveLosses: number;
}

export interface StrategyConfig {
  filters: StrategyFilters;
  exits: StrategyExits;
  sizing: StrategySizing;
}

export interface StrategyVersion {
  name: string;
  parentName: string | null;
  generation: number;
  config: StrategyConfig;
  isChampion: boolean;
  createdAt: number;
}

export type SimExitReason =
  | "tp1"
  | "tp2"
  | "tp3"
  | "tp4"
  | "stop-loss"
  | "trailing-stop"
  | "time-exit"
  | "rug-pull"
  | "window-end"
  | "written-off";

export interface SimTrade {
  poolAddress: string;
  tokenMint: string;
  openedAt: number;
  closedAt: number;
  costUsd: number;
  proceedsUsd: number;
  pnlUsd: number;
  pnlPct: number;
  peakGainPct: number;
  /** the reason the last tokens were sold */
  exitReason: SimExitReason;
  /** every partial and final sale, in order */
  exits: Array<{ reason: SimExitReason; at: number; proceedsUsd: number }>;
}

export interface SimMetrics {
  coinsSeen: number;
  coinsPicked: number;
  trades: number;
  failedFills: number;
  skippedFull: number;
  skippedRate: number;
  skippedExposure: number;
  skippedHalted: number;
  wins: number;
  winRatePct: number;
  netPnlUsd: number;
  netPnlPct: number;
  /** the same, with the three best trades removed: what is left without luck */
  pnlExTop3Pct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  avgWinPct: number;
  avgLossPct: number;
  bestTradePct: number;
  worstTradePct: number;
  exitReasons: Partial<Record<SimExitReason, number>>;
}

export interface SimResult {
  trades: SimTrade[];
  metrics: SimMetrics;
}
