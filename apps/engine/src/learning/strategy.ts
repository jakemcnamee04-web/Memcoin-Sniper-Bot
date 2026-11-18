import {
  FILTER_ORDER,
  formatTpLadder,
  type FilterConfigDelta,
  type FilterId,
  type TpRung,
  type TradingSettings,
} from "@sniperbot/shared";
import type { ResolvedFilterConfig } from "../config/filter-config.js";
import type { Rng } from "./rng.js";
import type { StrategyConfig, StrategyFilters } from "./types.js";

/**
 * Checks the tuner may never switch off. They guard against coins that cannot
 * be sold or can be printed or frozen by their creator; a version that "wins"
 * by skipping them has only been lucky.
 */
export const SAFETY_FILTERS: ReadonlySet<FilterId> = new Set<FilterId>([
  "honeypot-sim",
  "mint-authority",
  "freeze-authority",
  "lp-locked",
]);

/** Live exits support four take-profit rungs (tp1–tp4). */
export const MAX_TP_RUNGS = 4;

export const BOUNDS = {
  minFilterScore: [0, 95],
  liquidityMinUsd: [0, 50_000],
  liquidityMaxUsd: [5_000, 5_000_000],
  topHolderMaxPct: [3, 60],
  top10HoldersMaxPct: [10, 90],
  devRugRateMax: [0, 1],
  maxSellTaxPct: [1, 30],
  stopLossPct: [-90, -10],
  trailingStopPct: [5, 80],
  trailingStopActivationPct: [20, 2_000],
  timeExitMin: [3, 600],
  tpGainPct: [10, 5_000],
  tpSellPct: [5, 100],
} as const satisfies Record<string, readonly [number, number]>;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
const round = (v: number, step: number) => Math.round(v / step) * step;
const tidy = (v: number, digits = 2) => Number(v.toFixed(digits));

export function strategyFromLive(
  filters: ResolvedFilterConfig,
  settings: Readonly<TradingSettings>,
  ladder: TpRung[],
): StrategyConfig {
  const enabled = Object.fromEntries(FILTER_ORDER.map((id) => [id, filters.enabled(id)])) as Record<
    FilterId,
    boolean
  >;
  return {
    filters: {
      enabled,
      minFilterScore: filters.minFilterScore,
      liquidityMinUsd: filters.liquidityMinUsd,
      liquidityMaxUsd: filters.liquidityMaxUsd,
      topHolderMaxPct: filters.topHolderMaxPct,
      top10HoldersMaxPct: filters.top10HoldersMaxPct,
      devRugRateMax: filters.devRugRateMax,
      maxSellTaxPct: filters.maxSellTaxPct,
      lpLockedRequired: filters.lpLockedRequired,
      mintAuthRenounced: filters.mintAuthRenounced,
      freezeAuthRenounced: filters.freezeAuthRenounced,
      honeypotSimRequired: filters.honeypotSimRequired,
      bundledLaunchReject: filters.bundledLaunchReject,
    },
    exits: {
      stopLossPct: settings.stopLossPct,
      tpLadder: ladder.map((r) => ({ ...r })),
      trailingStopPct: settings.trailingStopPct,
      trailingStopActivationPct: settings.trailingStopActivationPct,
      timeExitMin: settings.timeExitMin,
    },
    sizing: {
      positionSizePct: settings.positionSizePct,
      maxConcurrentPositions: settings.maxConcurrentPositions,
      maxTotalExposurePct: settings.maxTotalExposurePct,
      maxPositionPerMin: settings.maxPositionPerMin,
      dailyDrawdownLimitPct: settings.dailyDrawdownLimitPct,
      weeklyDrawdownLimitPct: settings.weeklyDrawdownLimitPct,
      haltOnConsecutiveLosses: settings.haltOnConsecutiveLosses,
    },
  };
}

/** The filter preset that makes the live bot judge like this version. */
export function toPresetDelta(cfg: StrategyConfig): FilterConfigDelta {
  const f = cfg.filters;
  return {
    enabled: { ...f.enabled },
    thresholds: {
      minFilterScore: f.minFilterScore,
      liquidityMinUsd: f.liquidityMinUsd,
      liquidityMaxUsd: f.liquidityMaxUsd,
      topHolderMaxPct: f.topHolderMaxPct,
      top10HoldersMaxPct: f.top10HoldersMaxPct,
      devRugRateMax: f.devRugRateMax,
      maxSellTaxPct: f.maxSellTaxPct,
      lpLockedRequired: f.lpLockedRequired,
      mintAuthRenounced: f.mintAuthRenounced,
      freezeAuthRenounced: f.freezeAuthRenounced,
      honeypotSimRequired: f.honeypotSimRequired,
      bundledLaunchReject: f.bundledLaunchReject,
    },
  };
}

/** The exit settings this version changes. Sizing and risk are never touched. */
export function toSettingsPatch(cfg: StrategyConfig): Partial<TradingSettings> {
  const e = cfg.exits;
  return {
    stopLossPct: e.stopLossPct,
    tpLadder: formatTpLadder(e.tpLadder),
    trailingStopPct: e.trailingStopPct,
    trailingStopActivationPct: e.trailingStopActivationPct,
    timeExitMin: e.timeExitMin,
  };
}

/** Only what the tuner can change: two versions that agree here trade identically. */
export function tunedKey(cfg: StrategyConfig): string {
  const f = cfg.filters;
  return JSON.stringify({
    enabled: FILTER_ORDER.map((id) => (f.enabled[id] ? 1 : 0)).join(""),
    t: [f.minFilterScore, f.liquidityMinUsd, f.liquidityMaxUsd, f.topHolderMaxPct, f.top10HoldersMaxPct, f.devRugRateMax, f.maxSellTaxPct],
    e: [cfg.exits.stopLossPct, formatTpLadder(cfg.exits.tpLadder), cfg.exits.trailingStopPct, cfg.exits.trailingStopActivationPct, cfg.exits.timeExitMin],
  });
}

export function sameTuning(a: StrategyConfig, b: StrategyConfig): boolean {
  return tunedKey(a) === tunedKey(b);
}

/** Ascending gains, sells within bounds, at most 100% sold, at most four rungs. */
export function normalizeLadder(rungs: TpRung[]): TpRung[] {
  const sorted = rungs
    .map((r) => ({ gainPct: round(clamp(r.gainPct, BOUNDS.tpGainPct), 5), sellPct: round(clamp(r.sellPct, BOUNDS.tpSellPct), 5) }))
    .sort((a, b) => a.gainPct - b.gainPct);
  const out: TpRung[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (prev && r.gainPct <= prev.gainPct) r.gainPct = prev.gainPct + 5;
    if (r.gainPct > BOUNDS.tpGainPct[1]) break;
    out.push(r);
    if (out.length === MAX_TP_RUNGS) break;
  }
  if (out.length === 0) out.push({ gainPct: 100, sellPct: 50 });
  const total = out.reduce((s, r) => s + r.sellPct, 0);
  if (total > 100) {
    const scale = 100 / total;
    let left = 100;
    for (const r of out) {
      r.sellPct = Math.max(BOUNDS.tpSellPct[0], Math.floor((r.sellPct * scale) / 5) * 5);
      left -= r.sellPct;
    }
    // flooring can only undershoot; a negative remainder means the floors pushed it over
    if (left < 0) out[out.length - 1]!.sellPct = Math.max(BOUNDS.tpSellPct[0], out[out.length - 1]!.sellPct + left);
  }
  return out;
}

/** Pulls every tuned value into its bounds and keeps related values consistent. */
export function normalizeStrategy(cfg: StrategyConfig, maxTimeExitMin: number): StrategyConfig {
  const f = cfg.filters;
  const e = cfg.exits;
  const liquidityMinUsd = round(clamp(f.liquidityMinUsd, BOUNDS.liquidityMinUsd), 100);
  const topHolderMaxPct = tidy(clamp(f.topHolderMaxPct, BOUNDS.topHolderMaxPct), 1);
  return {
    filters: {
      ...f,
      enabled: { ...f.enabled },
      minFilterScore: Math.round(clamp(f.minFilterScore, BOUNDS.minFilterScore)),
      liquidityMinUsd,
      liquidityMaxUsd: round(Math.max(liquidityMinUsd + 1_000, clamp(f.liquidityMaxUsd, BOUNDS.liquidityMaxUsd)), 1_000),
      topHolderMaxPct,
      top10HoldersMaxPct: tidy(Math.max(topHolderMaxPct, clamp(f.top10HoldersMaxPct, BOUNDS.top10HoldersMaxPct)), 1),
      devRugRateMax: tidy(clamp(f.devRugRateMax, BOUNDS.devRugRateMax), 2),
      maxSellTaxPct: tidy(clamp(f.maxSellTaxPct, BOUNDS.maxSellTaxPct), 1),
    },
    exits: {
      stopLossPct: Math.round(clamp(e.stopLossPct, BOUNDS.stopLossPct)),
      tpLadder: normalizeLadder(e.tpLadder),
      trailingStopPct: Math.round(clamp(e.trailingStopPct, BOUNDS.trailingStopPct)),
      trailingStopActivationPct: round(clamp(e.trailingStopActivationPct, BOUNDS.trailingStopActivationPct), 5),
      timeExitMin: Math.round(clamp(e.timeExitMin, [BOUNDS.timeExitMin[0], Math.min(BOUNDS.timeExitMin[1], maxTimeExitMin)])),
    },
    sizing: { ...cfg.sizing },
  };
}

export interface MutateOptions {
  /** filters the tuner may switch on or off: measured in the data and not a safety check */
  tunableFilters: FilterId[];
  maxTimeExitMin: number;
  /** chance each value changes */
  rate?: number;
}

/**
 * A nearby version: a few values nudged by a random factor, sometimes a
 * filter switched or a take-profit rung added or dropped. Always differs from
 * its parent in what it trades on.
 */
export function mutate(parent: StrategyConfig, rng: Rng, opts: MutateOptions): StrategyConfig {
  const rate = opts.rate ?? 0.35;
  const base = normalizeStrategy(parent, opts.maxTimeExitMin);
  for (let attempt = 0; attempt < 20; attempt++) {
    const child = structuredClone(base);
    const f = child.filters;
    const e = child.exits;
    const scale = (v: number, sigma = 0.25) => v * Math.exp(sigma * rng.normal());
    const maybe = () => rng.next() < rate;

    if (maybe()) f.minFilterScore += 8 * rng.normal();
    if (maybe()) f.liquidityMinUsd = scale(Math.max(f.liquidityMinUsd, 500));
    if (maybe()) f.liquidityMaxUsd = scale(f.liquidityMaxUsd);
    if (maybe()) f.topHolderMaxPct = scale(f.topHolderMaxPct);
    if (maybe()) f.top10HoldersMaxPct = scale(f.top10HoldersMaxPct);
    if (maybe()) f.devRugRateMax += 0.08 * rng.normal();
    if (maybe()) f.maxSellTaxPct = scale(f.maxSellTaxPct);
    for (const id of opts.tunableFilters) {
      if (SAFETY_FILTERS.has(id)) continue;
      if (rng.next() < rate / 4) f.enabled[id] = !f.enabled[id];
    }

    if (maybe()) e.stopLossPct = -scale(Math.abs(e.stopLossPct), 0.2);
    if (maybe()) e.trailingStopPct = scale(e.trailingStopPct, 0.2);
    if (maybe()) e.trailingStopActivationPct = scale(e.trailingStopActivationPct, 0.3);
    if (maybe()) e.timeExitMin = scale(e.timeExitMin, 0.3);
    for (const r of e.tpLadder) {
      if (maybe()) r.gainPct = scale(r.gainPct, 0.25);
      if (maybe()) r.sellPct += 6 * rng.normal();
    }
    if (rng.next() < rate / 3) {
      if (e.tpLadder.length > 1 && rng.next() < 0.5) {
        e.tpLadder.splice(Math.floor(rng.next() * e.tpLadder.length), 1);
      } else if (e.tpLadder.length < MAX_TP_RUNGS) {
        const top = e.tpLadder[e.tpLadder.length - 1];
        e.tpLadder.push({ gainPct: (top?.gainPct ?? 50) * 2, sellPct: 15 });
      }
    }

    const out = normalizeStrategy(child, opts.maxTimeExitMin);
    if (!sameTuning(out, base)) return out;
  }
  // a parent pinned at every bound: move the one value that always has room
  const forced = structuredClone(base);
  forced.exits.stopLossPct = forced.exits.stopLossPct <= -50 ? forced.exits.stopLossPct + 5 : forced.exits.stopLossPct - 5;
  return normalizeStrategy(forced, opts.maxTimeExitMin);
}

/** A built-in preset's thresholds laid over a base version, safety checks left as the base has them. */
export function withPreset(base: StrategyConfig, delta: FilterConfigDelta, maxTimeExitMin: number): StrategyConfig {
  const next = structuredClone(base);
  const f: StrategyFilters = next.filters;
  for (const [id, on] of Object.entries(delta.enabled ?? {}) as Array<[FilterId, boolean]>) {
    if (!SAFETY_FILTERS.has(id)) f.enabled[id] = on;
  }
  const t = delta.thresholds ?? {};
  if (t.minFilterScore !== undefined) f.minFilterScore = t.minFilterScore;
  if (t.liquidityMinUsd !== undefined) f.liquidityMinUsd = t.liquidityMinUsd;
  if (t.liquidityMaxUsd !== undefined) f.liquidityMaxUsd = t.liquidityMaxUsd;
  if (t.topHolderMaxPct !== undefined) f.topHolderMaxPct = t.topHolderMaxPct;
  if (t.top10HoldersMaxPct !== undefined) f.top10HoldersMaxPct = t.top10HoldersMaxPct;
  if (t.devRugRateMax !== undefined) f.devRugRateMax = t.devRugRateMax;
  if (t.maxSellTaxPct !== undefined) f.maxSellTaxPct = t.maxSellTaxPct;
  return normalizeStrategy(next, maxTimeExitMin);
}

/** One line per difference from another version, for reports. */
export function describeChanges(from: StrategyConfig, to: StrategyConfig): string[] {
  const out: string[] = [];
  const pairs: Array<[string, unknown, unknown]> = [
    ["min filter score", from.filters.minFilterScore, to.filters.minFilterScore],
    ["min liquidity $", from.filters.liquidityMinUsd, to.filters.liquidityMinUsd],
    ["max liquidity $", from.filters.liquidityMaxUsd, to.filters.liquidityMaxUsd],
    ["top holder max %", from.filters.topHolderMaxPct, to.filters.topHolderMaxPct],
    ["top 10 holders max %", from.filters.top10HoldersMaxPct, to.filters.top10HoldersMaxPct],
    ["dev rug rate max", from.filters.devRugRateMax, to.filters.devRugRateMax],
    ["max sell tax %", from.filters.maxSellTaxPct, to.filters.maxSellTaxPct],
    ["stop-loss %", from.exits.stopLossPct, to.exits.stopLossPct],
    ["take-profit ladder", formatTpLadder(from.exits.tpLadder), formatTpLadder(to.exits.tpLadder)],
    ["trailing stop %", from.exits.trailingStopPct, to.exits.trailingStopPct],
    ["trailing stop arms at %", from.exits.trailingStopActivationPct, to.exits.trailingStopActivationPct],
    ["time exit min", from.exits.timeExitMin, to.exits.timeExitMin],
  ];
  for (const [label, a, b] of pairs) if (a !== b) out.push(`${label}: ${a} → ${b}`);
  for (const id of FILTER_ORDER) {
    if (from.filters.enabled[id] !== to.filters.enabled[id]) {
      out.push(`${id}: ${from.filters.enabled[id] ? "on" : "off"} → ${to.filters.enabled[id] ? "on" : "off"}`);
    }
  }
  return out;
}
