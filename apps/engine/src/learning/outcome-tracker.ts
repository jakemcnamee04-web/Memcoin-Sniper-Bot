import type { OrchestratorVerdict, PoolEvent } from "@sniperbot/shared";
import { BATCH, type MarketQuote } from "../execution/market-price.js";
import { buildProfile, isSyntheticPool, liquidityAt, priceAt } from "../execution/price-simulator.js";
import { childLogger } from "../utils/logger.js";
import { DEAD_PRICE_RATIO, ENTRY_MAX_LAG_MS, UNPRICED_WRITE_OFF_MS } from "./constants.js";
import { unitHash } from "./rng.js";
import type { LearningStore } from "./store.js";
import { type PackedPath, priceAt as priceOf, pushSample } from "./path.js";
import type { CoinRecord, EvalThresholds, RecordedResult, TrackEndReason } from "./types.js";

const log = childLogger("outcome-tracker");

/** One request for up to 50 mints; throws when the request fails. */
export type BatchFetcher = (ids: string[]) => Promise<Map<string, MarketQuote>>;

export interface TrackerOptions {
  store: LearningStore;
  fetchBatch: BatchFetcher;
  /** the filter thresholds in force now */
  thresholds: () => EvalThresholds;
  windowMin: number;
  /** price requests per minute this tracker may spend */
  maxRpm: number;
  /** share of rejected coins to follow; bought ones are always followed */
  rejectSampleRate: number;
  now?: () => number;
  tickMs?: number;
  checkpointMs?: number;
  /** the live exit engine runs synthetic positions this much faster than the clock */
  syntheticTimeScale?: number;
}

interface Followed {
  coin: CoinRecord;
  nextDueAt: number;
  lastPriceAt: number | null;
  missesSincePrice: number;
  deadStreak: number;
  dirty: boolean;
}

/** How often a coin is priced, by age: densest while most coins live or die. */
export function pollIntervalMs(ageMs: number): number {
  if (ageMs < 5 * 60_000) return 10_000;
  if (ageMs < 20 * 60_000) return 30_000;
  return 60_000;
}

const RETRY_MS = 5_000;

/**
 * The numbers and flags a filter measured, without addresses or text: what a
 * replay or a future check needs, at a fraction of the size.
 */
export function measuredOnly(meta: Record<string, unknown> | undefined): RecordedResult["metadata"] {
  if (!meta) return undefined;
  const out: Record<string, number | boolean | string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Number(v.toPrecision(6));
    else if (typeof v === "boolean") out[k] = v;
    // short labels like source: "rugcheck" or status: "bonding-curve"; never addresses
    else if (typeof v === "string" && v.length <= 16) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Follows the price of every coin the bot judges — bought or rejected — for
 * a fixed window after its verdict, within a request budget, and stores the
 * recording with what the filters measured. That recording is what lets the
 * tuner ask "what would a different version have done?" without guessing.
 *
 * When there are more coins than budget, polls run late rather than being
 * skipped, oldest-due first, with unpriced newcomers ahead of everything:
 * a version can only buy a coin whose first price was seen promptly.
 */
export class OutcomeTracker {
  private readonly opts: Required<TrackerOptions>;
  private readonly pools = new Map<string, { pool: PoolEvent; at: number }>();
  private readonly followed = new Map<string, Followed>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tokens: number;
  private lastRefill: number;
  private lastCheckpoint: number;
  private readonly stats = {
    registered: 0,
    sampledOut: 0,
    missingPool: 0,
    requests: 0,
    requestErrors: 0,
    maxLagMs: 0,
    ended: {} as Partial<Record<TrackEndReason, number>>,
  };

  constructor(opts: TrackerOptions) {
    this.opts = {
      now: () => Date.now(),
      tickMs: 1_000,
      checkpointMs: 120_000,
      syntheticTimeScale: 30,
      ...opts,
    };
    this.tokens = this.burst();
    this.lastRefill = this.opts.now();
    this.lastCheckpoint = this.opts.now();
  }

  private burst(): number {
    return Math.max(2, this.opts.maxRpm / 10);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
    log.info({ windowMin: this.opts.windowMin, maxRpm: this.opts.maxRpm, rejectSampleRate: this.opts.rejectSampleRate }, "outcome tracker started");
  }

  /** Stops polling and stores what is being followed, cut short. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pending = [...this.followed.values()];
    await Promise.all(pending.map((f) => this.finish(f, "shutdown")));
  }

  getStats() {
    return { following: this.followed.size, ...this.stats, ended: { ...this.stats.ended } };
  }

  /** Remember a pool until its verdict arrives; the verdict carries only the address. */
  notePool(pool: PoolEvent): void {
    const now = this.opts.now();
    this.pools.set(pool.poolAddress, { pool, at: now });
    if (this.pools.size > 5_000) {
      for (const [k, v] of this.pools) if (now - v.at > 15 * 60_000) this.pools.delete(k);
    }
  }

  onVerdict(v: OrchestratorVerdict): void {
    const held = this.pools.get(v.poolAddress);
    if (!held) {
      this.stats.missingPool++;
      return;
    }
    this.pools.delete(v.poolAddress);
    if (this.followed.has(v.poolAddress)) return;
    if (v.decision === "reject" && unitHash(`${v.poolAddress}:sample`) >= this.opts.rejectSampleRate) {
      this.stats.sampledOut++;
      return;
    }
    const pool = held.pool;
    const synthetic = isSyntheticPool(pool);
    const coin: CoinRecord = {
      poolAddress: pool.poolAddress,
      tokenMint: pool.tokenMint,
      source: pool.source,
      synthetic,
      decidedAt: v.decidedAt,
      decision: v.decision,
      initialLiquidityUsd: pool.initialLiquidityUsd,
      results: v.results.map((r) => ({ filterId: r.filterId, status: r.status, score: r.score, metadata: measuredOnly(r.metadata) })),
      evalThresholds: this.opts.thresholds(),
      path: [],
      timeScale: synthetic ? this.opts.syntheticTimeScale : 1,
      endReason: null,
    };
    this.stats.registered++;

    if (synthetic) {
      const { path, endReason } = this.syntheticPath(pool, v.decidedAt);
      coin.path = path;
      coin.endReason = endReason;
      this.bump(endReason);
      void this.opts.store.saveCoin(coin, "done").catch((err) => log.warn({ err: (err as Error).message }, "could not store synthetic coin"));
      return;
    }
    this.followed.set(v.poolAddress, {
      coin,
      nextDueAt: this.opts.now(),
      lastPriceAt: null,
      missesSincePrice: 0,
      deadStreak: 0,
      dirty: true,
    });
  }

  /** A synthetic pool's whole future is known at once: sample its simulated price, as the exit engine would see it. */
  private syntheticPath(pool: PoolEvent, decidedAt: number): { path: PackedPath; endReason: TrackEndReason } {
    const scale = this.opts.syntheticTimeScale;
    const profile = buildProfile(pool, decidedAt, pool.initialPriceUsd);
    const path: PackedPath = [];
    const windowSim = this.opts.windowMin * 60_000;
    for (let simT = 0; simT <= windowSim; simT += 10_000) {
      const price = priceAt(profile, simT);
      pushSample(path, simT / scale, price, liquidityAt(profile, simT));
      if (price <= priceOf(path, 0) * DEAD_PRICE_RATIO) return { path, endReason: "dead" };
    }
    return { path, endReason: "window" };
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.opts.now();
      const windowMs = this.opts.windowMin * 60_000;
      for (const f of [...this.followed.values()]) {
        if (now - f.coin.decidedAt >= windowMs) await this.finish(f, "window");
      }

      this.tokens = Math.min(this.burst(), this.tokens + ((now - this.lastRefill) / 60_000) * this.opts.maxRpm);
      this.lastRefill = now;

      // coins still waiting for their first price go first: a late first price makes a coin unbuyable
      const due = [...this.followed.values()]
        .filter((f) => f.nextDueAt <= now)
        .sort((a, b) => (a.coin.path.length === 0 ? 0 : 1) - (b.coin.path.length === 0 ? 0 : 1) || a.nextDueAt - b.nextDueAt);
      if (due.length > 0) this.stats.maxLagMs = Math.max(this.stats.maxLagMs, now - due[due.length - 1]!.nextDueAt);

      while (this.tokens >= 1 && due.length > 0) {
        const batch: Followed[] = [];
        const mints = new Set<string>();
        while (due.length > 0 && (mints.size < BATCH || mints.has(due[0]!.coin.tokenMint))) {
          const f = due.shift()!;
          batch.push(f);
          mints.add(f.coin.tokenMint);
        }
        this.tokens -= 1;
        this.stats.requests++;
        let quotes: Map<string, MarketQuote>;
        try {
          quotes = await this.opts.fetchBatch([...mints]);
        } catch (err) {
          // Jupiter down is not "no price": try again soon and count nothing against the coins
          this.stats.requestErrors++;
          for (const f of batch) f.nextDueAt = now + RETRY_MS;
          log.warn({ err: (err as Error).message, count: mints.size }, "price batch failed");
          break;
        }
        const at = this.opts.now();
        for (const f of batch) await this.record(f, quotes.get(f.coin.tokenMint), at);
      }

      if (now - this.lastCheckpoint >= this.opts.checkpointMs) {
        this.lastCheckpoint = now;
        await this.checkpoint();
      }
    } finally {
      this.ticking = false;
    }
  }

  private async record(f: Followed, q: MarketQuote | undefined, now: number): Promise<void> {
    const t = now - f.coin.decidedAt;
    f.dirty = true;
    if (q) {
      pushSample(f.coin.path, t, q.priceUsd, q.liquidityUsd);
      f.lastPriceAt = now;
      f.missesSincePrice = 0;
      const first = priceOf(f.coin.path, 0);
      f.deadStreak = q.priceUsd <= first * DEAD_PRICE_RATIO ? f.deadStreak + 1 : 0;
      if (f.deadStreak >= 2) return this.finish(f, "dead");
      f.nextDueAt = now + pollIntervalMs(t);
      return;
    }
    f.missesSincePrice++;
    if (f.coin.path.length === 0) {
      if (t > ENTRY_MAX_LAG_MS) return this.finish(f, "no-price");
      f.nextDueAt = now + RETRY_MS;
      return;
    }
    if (now - (f.lastPriceAt ?? now) >= UNPRICED_WRITE_OFF_MS && f.missesSincePrice >= 3) return this.finish(f, "unpriced");
    f.nextDueAt = now + pollIntervalMs(t);
  }

  private bump(reason: TrackEndReason): void {
    this.stats.ended[reason] = (this.stats.ended[reason] ?? 0) + 1;
  }

  private async finish(f: Followed, reason: TrackEndReason): Promise<void> {
    if (!this.followed.delete(f.coin.poolAddress)) return;
    f.coin.endReason = reason;
    this.bump(reason);
    try {
      await this.opts.store.saveCoin(f.coin, "done");
    } catch (err) {
      log.warn({ err: (err as Error).message, pool: f.coin.poolAddress.slice(0, 8) }, "could not store tracked coin");
    }
  }

  /** Saves coins still being followed, so a crash loses minutes rather than the hour. */
  private async checkpoint(): Promise<void> {
    for (const f of this.followed.values()) {
      if (!f.dirty) continue;
      f.dirty = false;
      try {
        await this.opts.store.saveCoin(f.coin, "tracking");
      } catch (err) {
        f.dirty = true;
        log.warn({ err: (err as Error).message }, "tracker checkpoint failed");
        return;
      }
    }
  }
}
