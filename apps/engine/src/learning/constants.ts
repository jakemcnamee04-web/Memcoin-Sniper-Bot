/**
 * Numbers the outcome tracker and the replay simulator must agree on. The
 * cost figures mirror execution/paper-executor.ts, with each random draw
 * replaced by a fixed per-coin draw or its average so every version is
 * charged the same for the same coin.
 */

/** A version buys only if a price was seen this soon after the verdict, as the live trader buys at once or not at all. */
export const ENTRY_MAX_LAG_MS = 30_000;

/** paper-executor: 10% of buys fail and burn the fee */
export const FAILED_FILL_RATE = 0.1;
/** paper-executor: 30% of buys are sandwiched for 0.5–3% */
export const SANDWICH_RATE = 0.3;
export const SANDWICH_PENALTY = 0.0175;
/** paper-executor: a rug exit pays 5–20% extra */
export const RUG_EXIT_PENALTY = 0.125;
/** paper-executor: a rug exit tips 5× to win the race out */
export const RUG_TIP_MULTIPLIER = 5;
/**
 * When Jupiter gives no liquidity figure, the entry premium a real buy paid
 * on a thin curve (market-price.ts notes ~3% on a $100 pump.fun buy).
 */
export const DEFAULT_ENTRY_PREMIUM = 0.03;
/** exit-engine: the time exit fires only on a position that never reached +50% */
export const TIME_EXIT_PEAK_GUARD_PCT = 50;
/** exit-engine: a priced-then-unquoted token is written off this long after its last price */
export const UNPRICED_WRITE_OFF_MS = 3 * 60_000;
/** Below this fraction of its first price a coin is dead: every allowed stop-loss (≥ -90%) has fired. */
export const DEAD_PRICE_RATIO = 0.05;
