import type { Decision, FilterId, FilterStatus } from "@sniperbot/shared";
import { allFilters } from "../filters/registry.js";
import type { CoinRecord, EvalThresholds, RecordedResult, StrategyFilters } from "./types.js";

/**
 * Re-judges a recorded coin under any version's filter settings, with the
 * orchestrator's own scoring: weighted score over the filters that ran,
 * reject on any fail, reject below the minimum score.
 *
 * Filters whose verdict is a measured number (liquidity, top holders, dev rug
 * rate, sell tax) are judged again from that number. Every other filter keeps
 * the answer it gave live. A filter that did not run live is treated as off:
 * nothing was measured, so no version can use it for that coin.
 */

const FILTERS = allFilters.filter((f) => f.enabled).map((f) => ({ id: f.id, weight: f.weight }));

export interface Judgement {
  decision: Decision;
  scorePct: number;
  failed: FilterId[];
  /** each enabled, measured filter's answer under this version */
  statuses: Partial<Record<FilterId, FilterStatus>>;
}

type Judged = { status: FilterStatus; score: number };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * True when a recorded fail cannot be explained by the measured number under
 * the thresholds in force at the time — e.g. a honeypot ("cannot sell") that
 * also carried a low tax. Such a fail is about something else and stands.
 */
function failedForAnotherReason(r: RecordedResult, passedAtEval: boolean): boolean {
  return r.status === "fail" && passedAtEval;
}

function rejudge(r: RecordedResult, cfg: StrategyFilters, at: EvalThresholds): Judged {
  const kept = { status: r.status, score: r.score };
  if (r.status !== "pass" && r.status !== "fail") return kept;
  const m = r.metadata ?? {};

  switch (r.filterId) {
    case "liquidity-min": {
      const liq = num(m.liquidityUsd);
      if (liq === null) return kept;
      if (failedForAnotherReason(r, liq >= at.liquidityMinUsd && liq <= at.liquidityMaxUsd)) return kept;
      const pass = liq >= cfg.liquidityMinUsd && liq <= cfg.liquidityMaxUsd;
      return { status: pass ? "pass" : "fail", score: pass ? 100 : 0 };
    }
    case "top-holders": {
      const top1 = num(m.top1);
      const top10 = num(m.top10);
      if (top1 === null || top10 === null) return kept;
      if (failedForAnotherReason(r, top1 <= at.topHolderMaxPct && top10 <= at.top10HoldersMaxPct)) return kept;
      const pass = top1 <= cfg.topHolderMaxPct && top10 <= cfg.top10HoldersMaxPct;
      return { status: pass ? "pass" : "fail", score: pass ? 100 : 0 };
    }
    case "dev-wallet": {
      const rate = num(m.rugRate);
      if (rate === null) return kept; // unknown wallet: its neutral pass stands
      if (failedForAnotherReason(r, rate <= at.devRugRateMax)) return kept;
      const pass = rate <= cfg.devRugRateMax;
      return { status: pass ? "pass" : "fail", score: pass ? 100 : 0 };
    }
    case "honeypot-sim": {
      // a sell that cannot happen at all is not a tax: no limit undoes it
      if (m.honeypotSafe === false) return kept;
      const tax = num(m.roundTripLossPct) ?? num(m.sellTaxPct);
      if (tax === null) return kept;
      if (failedForAnotherReason(r, tax <= at.maxSellTaxPct)) return kept;
      const pass = tax <= cfg.maxSellTaxPct;
      return { status: pass ? "pass" : "fail", score: pass ? 100 : 0 };
    }
    default:
      return kept;
  }
}

/** A required-check switched off answers "skip", as the live filter does. */
function switchedOff(id: FilterId, cfg: StrategyFilters): boolean {
  switch (id) {
    case "lp-locked":
      return !cfg.lpLockedRequired;
    case "mint-authority":
      return !cfg.mintAuthRenounced;
    case "freeze-authority":
      return !cfg.freezeAuthRenounced;
    case "honeypot-sim":
      return !cfg.honeypotSimRequired;
    case "bundled-launch":
      return !cfg.bundledLaunchReject;
    default:
      return false;
  }
}

export function judgeCoin(
  coin: Pick<CoinRecord, "results" | "evalThresholds">,
  cfg: StrategyFilters,
): Judgement {
  const byId = new Map<FilterId, RecordedResult>();
  for (const r of coin.results) byId.set(r.filterId, r);

  let total = 0;
  let max = 0;
  const failed: FilterId[] = [];
  const statuses: Judgement["statuses"] = {};

  for (const f of FILTERS) {
    if (!cfg.enabled[f.id]) continue;
    const r = byId.get(f.id);
    if (!r) continue;
    max += 100 * f.weight;
    if (switchedOff(f.id, cfg)) {
      statuses[f.id] = "skip";
      continue;
    }
    const j = rejudge(r, cfg, coin.evalThresholds);
    statuses[f.id] = j.status;
    if (j.status === "skip" || j.status === "error") continue;
    total += j.score * f.weight;
    if (j.status === "fail") failed.push(f.id);
  }

  const scorePct = max > 0 ? Math.round((total / max) * 100) : 0;
  const decision: Decision = failed.length > 0 || scorePct < cfg.minFilterScore ? "reject" : "snipe";
  return { decision, scorePct, failed, statuses };
}
