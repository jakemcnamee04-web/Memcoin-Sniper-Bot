import {
  LAMPORTS_PER_SOL,
  NETWORK_FEE_LAMPORTS,
  SOL_USD_ESTIMATE,
  estimateSlippagePct,
} from "../execution/paper-executor.js";
import {
  DEFAULT_ENTRY_PREMIUM,
  ENTRY_MAX_LAG_MS,
  FAILED_FILL_RATE,
  RUG_EXIT_PENALTY,
  RUG_TIP_MULTIPLIER,
  SANDWICH_PENALTY,
  SANDWICH_RATE,
  TIME_EXIT_PEAK_GUARD_PCT,
  UNPRICED_WRITE_OFF_MS,
} from "./constants.js";
import { judgeCoin } from "./judge.js";
import { liqAt, priceAt, sampleCount, tAt } from "./path.js";
import { unitHash } from "./rng.js";
import type { CoinRecord, SimExitReason, SimMetrics, SimResult, SimTrade, StrategyConfig } from "./types.js";

/**
 * Replays recorded coins under one version: which it would have bought, and
 * how each position would have exited on the recorded prices. Deterministic:
 * the same coins and the same version always give the same trades, so
 * versions can be compared fairly and a result can be checked by re-running.
 *
 * It follows the live trader's gates (circuit, open slots, buys per minute,
 * exposure) — but bets a flat share of the starting bankroll — and the exit engine's order (rug, stop-loss, trailing stop,
 * take-profit, time exit). Where the recording is coarser than the live
 * 3-second poll it errs against the version: a take-profit fills at its
 * level, not at a higher sampled price, and a stop fills at the sampled price
 * that crossed it.
 */

export interface SimOptions {
  startingBalanceUsd: number;
  jitoTipLamports: number;
  /** liquidity drop from the first reading that counts as a rug */
  rugDropPct: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_HALT_MS = DAY_MS;
const WEEKLY_HALT_MS = 3 * DAY_MS;
const CONSECUTIVE_HALT_MS = DAY_MS;

interface Open {
  coin: CoinRecord;
  /** index of the next sample to process */
  cursor: number;
  entryT: number;
  entryPx: number;
  entryLiq: number | null;
  initialTokens: number;
  remaining: number;
  sizeUsd: number;
  buyFeeUsd: number;
  proceedsUsd: number;
  peakPx: number;
  peakGainPct: number;
  armed: boolean;
  tpHit: boolean[];
  exits: SimTrade["exits"];
}

const feeUsd = (lamports: number) => (lamports / LAMPORTS_PER_SOL) * SOL_USD_ESTIMATE;

export function simulate(cfg: StrategyConfig, coins: readonly CoinRecord[], opts: SimOptions): SimResult {
  const { sizing, exits, filters } = cfg;
  const buyFee = feeUsd(opts.jitoTipLamports + NETWORK_FEE_LAMPORTS);

  let realized = 0;
  let peakEquity = 0;
  let maxDrawdownUsd = 0;
  const trades: SimTrade[] = [];
  const open: Open[] = [];
  const recentEntries: number[] = [];
  const closedHistory: Array<{ at: number; pnl: number }> = [];
  let consecutiveLosses = 0;
  let haltUntil = 0;

  const counts = { coinsSeen: 0, coinsPicked: 0, failedFills: 0, skippedFull: 0, skippedRate: 0, skippedExposure: 0, skippedHalted: 0 };

  const balance = () => opts.startingBalanceUsd + realized;
  const bookEquity = () => {
    if (realized > peakEquity) peakEquity = realized;
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peakEquity - realized);
  };

  const sell = (p: Open, tokens: number, px: number, liq: number | null, reason: SimExitReason, at: number) => {
    const rug = reason === "rug-pull";
    const value = tokens * px;
    const slip = estimateSlippagePct(value, Math.max(1000, liq ?? p.entryLiq ?? 0)) / 100;
    const eff = Math.max(0, px * (1 - slip - (rug ? RUG_EXIT_PENALTY : 0)));
    const fee = feeUsd(NETWORK_FEE_LAMPORTS + opts.jitoTipLamports * (rug ? RUG_TIP_MULTIPLIER : 1));
    const proceeds = tokens * eff - fee;
    const costBasis = (tokens / p.initialTokens) * p.sizeUsd;
    p.remaining = Math.max(0, p.remaining - tokens);
    p.proceedsUsd += proceeds;
    p.exits.push({ reason, at, proceedsUsd: proceeds });
    // a take-profit is money back in the bankroll now, as in the live position store
    realized += proceeds - costBasis;
    bookEquity();
  };

  const close = (p: Open, px: number, liq: number | null, reason: SimExitReason, at: number) => {
    if (p.remaining > 0) sell(p, p.remaining, px, liq, reason, at);
    const cost = p.sizeUsd + p.buyFeeUsd;
    const pnl = p.proceedsUsd - cost;
    trades.push({
      poolAddress: p.coin.poolAddress,
      tokenMint: p.coin.tokenMint,
      openedAt: p.coin.decidedAt + p.entryT,
      closedAt: at,
      costUsd: cost,
      proceedsUsd: p.proceedsUsd,
      pnlUsd: pnl,
      pnlPct: (pnl / cost) * 100,
      peakGainPct: p.peakGainPct,
      exitReason: reason,
      exits: p.exits,
    });
    open.splice(open.indexOf(p), 1);
    onClosed(at, pnl);
  };

  // drawdown circuit, as risk/drawdown-circuit.ts
  const onClosed = (at: number, pnl: number) => {
    closedHistory.push({ at, pnl });
    consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0;
    if (at < haltUntil) return;
    const bank = balance();
    if (bank <= 0) return;
    const lossSince = (ms: number) =>
      closedHistory.reduce((s, r) => (r.at >= at - ms && r.pnl < 0 ? s - r.pnl : s), 0);
    if (consecutiveLosses >= sizing.haltOnConsecutiveLosses) haltUntil = at + CONSECUTIVE_HALT_MS;
    else if ((lossSince(DAY_MS) / bank) * 100 >= sizing.dailyDrawdownLimitPct) haltUntil = at + DAILY_HALT_MS;
    else if ((lossSince(7 * DAY_MS) / bank) * 100 >= sizing.weeklyDrawdownLimitPct) haltUntil = at + WEEKLY_HALT_MS;
  };

  /** One recorded price for one position; mirrors ExitEngine.evaluate. Returns true when the position closed. */
  const tick = (p: Open, t: number, px: number, liq: number | null): boolean => {
    const at = p.coin.decidedAt + t;
    if (px > p.peakPx) {
      p.peakPx = px;
      p.peakGainPct = (px / p.entryPx - 1) * 100;
    }
    const pnlPct = (px / p.entryPx - 1) * 100;
    if (!p.armed && p.peakGainPct >= exits.trailingStopActivationPct) p.armed = true;

    if (p.entryLiq === null && liq !== null) p.entryLiq = liq;
    const rugged = p.entryLiq !== null && liq !== null && liq <= p.entryLiq * (1 - opts.rugDropPct / 100);
    if (rugged && (!p.coin.synthetic || pnlPct < -50)) {
      close(p, px, liq, "rug-pull", at);
      return true;
    }
    if (pnlPct <= exits.stopLossPct) {
      close(p, px, liq, "stop-loss", at);
      return true;
    }
    if (p.armed && ((p.peakPx - px) / p.peakPx) * 100 >= exits.trailingStopPct) {
      close(p, px, liq, "trailing-stop", at);
      return true;
    }
    const ladder = exits.tpLadder;
    for (let i = ladder.length - 1; i >= 0; i--) {
      const rung = ladder[i]!;
      if (p.tpHit[i] || pnlPct < rung.gainPct) continue;
      const reason = `tp${i + 1}` as SimExitReason;
      const level = p.entryPx * (1 + rung.gainPct / 100);
      const tokens = Math.min((p.initialTokens * rung.sellPct) / 100, p.remaining);
      p.tpHit[i] = true;
      const restHit = p.tpHit.slice(i + 1).every(Boolean);
      if (restHit && tokens >= p.remaining * 0.95) {
        close(p, level, liq, reason, at);
        return true;
      }
      sell(p, tokens, level, liq, reason, at);
      if (p.remaining <= 1e-12) {
        close(p, level, liq, reason, at);
        return true;
      }
      return false; // one take-profit per tick, as live
    }
    const ageMs = (t - p.entryT) * p.coin.timeScale;
    if (ageMs >= exits.timeExitMin * 60_000 && p.peakGainPct < TIME_EXIT_PEAK_GUARD_PCT) {
      close(p, px, liq, "time-exit", at);
      return true;
    }
    return false;
  };

  /** Run every open position forward to `until` (epoch ms), oldest event first. */
  const advance = (until: number) => {
    for (;;) {
      let next: Open | null = null;
      let nextAt = Infinity;
      for (const p of open) {
        const at = p.cursor < sampleCount(p.coin.path) ? p.coin.decidedAt + tAt(p.coin.path, p.cursor) : endOfPath(p);
        if (at < nextAt) {
          nextAt = at;
          next = p;
        }
      }
      if (!next || nextAt > until) return;
      const path = next.coin.path;
      if (next.cursor < sampleCount(path)) {
        const i = next.cursor++;
        tick(next, tAt(path, i), priceAt(path, i), liqAt(path, i));
      } else {
        finish(next, nextAt);
      }
    }
  };

  const last = (p: Open) => sampleCount(p.coin.path) - 1;
  const endOfPath = (p: Open) =>
    p.coin.decidedAt + tAt(p.coin.path, last(p)) + (p.coin.endReason === "unpriced" ? UNPRICED_WRITE_OFF_MS : 0);

  /** The recording ended with the position still open. */
  const finish = (p: Open, at: number) => {
    if (p.coin.endReason === "unpriced") close(p, 0, 0, "written-off", at);
    else close(p, priceAt(p.coin.path, last(p)), liqAt(p.coin.path, last(p)), "window-end", at);
  };

  for (const coin of coins) {
    const now = coin.decidedAt;
    advance(now);
    counts.coinsSeen++;
    if (judgeCoin(coin, filters).decision !== "snipe") continue;
    counts.coinsPicked++;

    if (now < haltUntil) {
      counts.skippedHalted++;
      continue;
    }
    if (open.length >= sizing.maxConcurrentPositions) {
      counts.skippedFull++;
      continue;
    }
    while (recentEntries.length && now - recentEntries[0]! > 60_000) recentEntries.shift();
    if (recentEntries.length >= sizing.maxPositionPerMin) {
      counts.skippedRate++;
      continue;
    }
    const bank = balance();
    const exposure = open.reduce((s, p) => s + (p.remaining / p.initialTokens) * p.sizeUsd, 0);
    if (bank <= 0 || (exposure / bank) * 100 >= sizing.maxTotalExposurePct) {
      counts.skippedExposure++;
      continue;
    }

    if (sampleCount(coin.path) === 0 || tAt(coin.path, 0) > ENTRY_MAX_LAG_MS) continue; // live: no market price, no buy

    if (unitHash(`${coin.poolAddress}:fill`) < FAILED_FILL_RATE) {
      counts.failedFills++;
      realized -= buyFee;
      bookEquity();
      continue;
    }

    // Flat bets: a share of the STARTING bankroll. The live bot sizes off its
    // current bankroll, but compounding would let whichever version got lucky
    // first snowball, and the comparison would measure the order of wins.
    const sizeUsd = opts.startingBalanceUsd * (sizing.positionSizePct / 100);
    const t0 = tAt(coin.path, 0);
    const p0 = priceAt(coin.path, 0);
    const liq0 = liqAt(coin.path, 0);
    const premium = liq0 === null ? DEFAULT_ENTRY_PREMIUM : estimateSlippagePct(sizeUsd, liq0) / 100;
    const mev = unitHash(`${coin.poolAddress}:mev`) < SANDWICH_RATE ? SANDWICH_PENALTY : 0;
    const entryPx = p0 * (1 + premium) * (1 + mev);
    const tokens = sizeUsd / entryPx;

    recentEntries.push(now);
    realized -= buyFee;
    bookEquity();
    const pos: Open = {
      coin,
      cursor: 1,
      entryT: t0,
      entryPx,
      entryLiq: liq0,
      initialTokens: tokens,
      remaining: tokens,
      sizeUsd,
      buyFeeUsd: buyFee,
      proceedsUsd: 0,
      peakPx: entryPx,
      peakGainPct: 0,
      armed: false,
      tpHit: exits.tpLadder.map(() => false),
      exits: [],
    };
    open.push(pos);
    // the price it was bought at is also its first tick, as the live position store sees it
    tick(pos, t0, p0, liq0);
  }
  advance(Infinity);

  return { trades, metrics: metricsOf(trades, counts, opts.startingBalanceUsd, realized, maxDrawdownUsd) };
}

function metricsOf(
  trades: SimTrade[],
  counts: Pick<SimMetrics, "coinsSeen" | "coinsPicked" | "failedFills" | "skippedFull" | "skippedRate" | "skippedExposure" | "skippedHalted">,
  start: number,
  realized: number,
  maxDrawdownUsd: number,
): SimMetrics {
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnlUsd, 0);
  const top3 = [...trades]
    .sort((a, b) => b.pnlUsd - a.pnlUsd)
    .slice(0, 3)
    .reduce((s, t) => s + Math.max(0, t.pnlUsd), 0);
  const avg = (xs: SimTrade[]) => (xs.length ? xs.reduce((s, t) => s + t.pnlPct, 0) / xs.length : 0);
  const exitReasons: SimMetrics["exitReasons"] = {};
  for (const t of trades) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  const pct = (usd: number) => (usd / start) * 100;
  return {
    ...counts,
    trades: trades.length,
    wins: wins.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    netPnlUsd: realized,
    netPnlPct: pct(realized),
    pnlExTop3Pct: pct(realized - top3),
    maxDrawdownPct: pct(maxDrawdownUsd),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgWinPct: avg(wins),
    avgLossPct: avg(losses),
    bestTradePct: trades.length ? Math.max(...trades.map((t) => t.pnlPct)) : 0,
    worstTradePct: trades.length ? Math.min(...trades.map((t) => t.pnlPct)) : 0,
    exitReasons,
  };
}
