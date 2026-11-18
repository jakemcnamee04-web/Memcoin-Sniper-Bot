import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BankrollSnapshot, Position } from "@sniperbot/shared";
import type { SystemStatus } from "../api/socket-server.js";
import { getPrisma } from "../state/db.js";
import { childLogger } from "../utils/logger.js";
import { ENTRY_MAX_LAG_MS } from "./constants.js";
import type { OutcomeTracker } from "./outcome-tracker.js";

const log = childLogger("live-status");

/**
 * A small file the engine rewrites every couple of minutes with how the bot
 * is doing: engine state, the paper account, recent trades, an equity curve,
 * hourly activity and the learning loop's progress. Anything that can read a
 * file on this computer — the Claude dashboard refresh, a phone sync folder —
 * can show it without reaching the database or the engine.
 */

export const LIVE_STATUS_FILE = "live-status.json";
const WINDOW_DAYS = 7;
const HOURS = 48;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClosedRow {
  closedAt: Date;
  openedAt: Date;
  tokenMint: string;
  entrySizeUsd: number;
  realizedPnlUsd: number;
  peakGainPct: number;
  closeReason: string | null;
}

export interface LearningRow {
  recordedTotal: number;
  recorded24h: number;
  buyable24h: number;
  endReasons24h: Array<{ reason: string; count: number }>;
  coinsByHour: Array<{ hour: Date; count: number }>;
  versions: number;
  champion: string | null;
  lastRun: { ranAt: Date; promoted: string | null; summary: string } | null;
}

export interface LiveStatusInputs {
  now: number;
  status: SystemStatus;
  trading: boolean;
  bankroll: BankrollSnapshot;
  open: Position[];
  closed: ClosedRow[];
  learning: LearningRow | null;
  tracker: ReturnType<OutcomeTracker["getStats"]> | null;
}

const round = (n: number, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const short = (mint: string) => `${mint.slice(0, 6)}…${mint.slice(-4)}`;
const hourKey = (ms: number) => new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();

/** Pure: everything the file holds, from what the engine and database said. */
export function assembleLiveStatus(i: LiveStatusInputs) {
  const b = i.bankroll;
  const closed = [...i.closed].sort((a, z) => a.closedAt.getTime() - z.closedAt.getTime());

  // the balance after each close, ending at today's balance
  const windowPnl = closed.reduce((s, c) => s + c.realizedPnlUsd, 0);
  let running = b.balanceUsd - windowPnl;
  const equity = [{ at: new Date(closed[0]?.closedAt ?? i.now).toISOString(), balanceUsd: round(running) }];
  for (const c of closed) {
    running += c.realizedPnlUsd;
    equity.push({ at: c.closedAt.toISOString(), balanceUsd: round(running) });
  }

  const hours = new Map<string, { hour: string; coinsRecorded: number; tradesClosed: number; pnlUsd: number }>();
  for (let h = HOURS - 1; h >= 0; h--) {
    const key = hourKey(i.now - h * 3_600_000);
    hours.set(key, { hour: key, coinsRecorded: 0, tradesClosed: 0, pnlUsd: 0 });
  }
  for (const c of closed) {
    const row = hours.get(hourKey(c.closedAt.getTime()));
    if (row) {
      row.tradesClosed++;
      row.pnlUsd = round(row.pnlUsd + c.realizedPnlUsd)!;
    }
  }
  for (const r of i.learning?.coinsByHour ?? []) {
    const row = hours.get(hourKey(r.hour.getTime()));
    if (row) row.coinsRecorded = r.count;
  }

  const trades = [...closed]
    .reverse()
    .slice(0, 50)
    .map((c) => ({
      closedAt: c.closedAt.toISOString(),
      token: short(c.tokenMint),
      mint: c.tokenMint,
      sizeUsd: round(c.entrySizeUsd),
      pnlUsd: round(c.realizedPnlUsd),
      pnlPct: round(c.entrySizeUsd > 0 ? (c.realizedPnlUsd / c.entrySizeUsd) * 100 : 0, 1),
      peakGainPct: round(c.peakGainPct, 1),
      exit: c.closeReason ?? "unknown",
      heldMin: round((c.closedAt.getTime() - c.openedAt.getTime()) / 60_000, 1),
    }));

  const open = i.open.map((p) => ({
    openedAt: new Date(p.openedAt).toISOString(),
    token: short(p.tokenMint),
    mint: p.tokenMint,
    sizeUsd: round(p.entrySizeUsd),
    unrealizedPnlUsd: round(p.unrealizedPnlUsd),
    unrealizedPnlPct: round(p.unrealizedPnlPct, 1),
    peakGainPct: round(p.peakGainPct, 1),
  }));

  const l = i.learning;
  const s = i.status;
  const summary = {
    generatedAt: new Date(i.now).toISOString(),
    mode: s.mode,
    botOn: s.botOn,
    trading: i.trading,
    feedLive: s.feedLive,
    activePreset: s.activePreset ?? "custom",
    uptimeMin: round(s.uptime / 60_000, 0),
    rpcRequests: s.rpcRequests,
    coinsSeen: s.detectedTotal,
    snipes: s.snipes,
    rejects: s.rejects,
    halted: s.circuit.halted,
    haltReason: s.circuit.haltReason ?? null,
    startingBalanceUsd: round(b.startingBalanceUsd),
    balanceUsd: round(b.balanceUsd),
    realizedPnlUsd: round(b.realizedPnlUsd),
    unrealizedPnlUsd: round(b.unrealizedPnlUsd),
    returnPct: round(b.startingBalanceUsd > 0 ? ((b.balanceUsd - b.startingBalanceUsd) / b.startingBalanceUsd) * 100 : 0),
    openPositions: b.openPositionCount,
    openExposureUsd: round(b.openExposureUsd),
    tradesClosed: b.totalTrades,
    wins: b.wins,
    losses: b.losses,
    winRatePct: round(b.winRatePct, 1),
    avgWinPct: round(b.avgWinPct, 1),
    avgLossPct: round(b.avgLossPct, 1),
    profitFactor: Number.isFinite(b.profitFactor) ? round(b.profitFactor) : null,
    trackerFollowing: i.tracker?.following ?? 0,
    coinsRecordedTotal: l?.recordedTotal ?? 0,
    coinsRecorded24h: l?.recorded24h ?? 0,
    buyable24hPct: l && l.recorded24h > 0 ? round((l.buyable24h / l.recorded24h) * 100, 1) : null,
    versionsCompeting: l?.versions ?? 0,
    liveVersion: l?.champion ?? null,
    lastTunerRunAt: l?.lastRun?.ranAt.toISOString() ?? null,
    lastTunerSummary: l?.lastRun?.summary ?? null,
    lastPromotion: l?.lastRun?.promoted ?? null,
  };

  return {
    summary,
    equity,
    hourly: [...hours.values()],
    trades,
    open,
    recordingEnds: (l?.endReasons24h ?? []).map((r) => ({ reason: r.reason, count: r.count })),
  };
}

export type LiveStatus = ReturnType<typeof assembleLiveStatus>;

/** What the database knows; the learning part is null on a database without the learning tables. */
export async function queryLiveStatusDb(now: number, mode: string): Promise<{ closed: ClosedRow[]; learning: LearningRow | null }> {
  const prisma = getPrisma();
  const since = new Date(now - WINDOW_DAYS * DAY_MS);
  const closed = (await prisma.position.findMany({
    where: { status: "closed", mode: mode as "paper" | "live", closedAt: { gte: since } },
    select: { closedAt: true, openedAt: true, tokenMint: true, entrySizeUsd: true, realizedPnlUsd: true, peakGainPct: true, closeReason: true },
    orderBy: { closedAt: "asc" },
  })) as ClosedRow[];

  let learning: LearningRow | null = null;
  try {
    const day = new Date(now - DAY_MS);
    const [recordedTotal, ends, byHour, buyable, versions, champion, lastRun] = await Promise.all([
      prisma.trackedCoin.count({ where: { status: "done" } }),
      prisma.trackedCoin.groupBy({ by: ["endReason"], where: { status: "done", decidedAt: { gte: day } }, _count: { _all: true } }),
      prisma.$queryRaw<Array<{ hour: Date; count: bigint }>>`
        SELECT date_trunc('hour', "decidedAt") AS hour, count(*) AS count
        FROM "TrackedCoin"
        WHERE status = 'done' AND "decidedAt" >= ${new Date(now - HOURS * 3_600_000)}
        GROUP BY 1`,
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM "TrackedCoin"
        WHERE status = 'done' AND "decidedAt" >= ${day}
          AND jsonb_array_length(path) > 0 AND (path->>0)::float <= ${ENTRY_MAX_LAG_MS}`,
      prisma.strategyVersion.count({ where: { retiredAt: null } }),
      prisma.strategyVersion.findFirst({ where: { isChampion: true }, select: { name: true } }),
      prisma.tunerRun.findFirst({ orderBy: { ranAt: "desc" } }),
    ]);
    const endReasons24h = ends.map((e) => ({ reason: e.endReason ?? "unknown", count: e._count._all }));
    learning = {
      recordedTotal,
      recorded24h: endReasons24h.reduce((s, e) => s + e.count, 0),
      buyable24h: Number(buyable[0]?.count ?? 0),
      endReasons24h,
      coinsByHour: byHour.map((r) => ({ hour: new Date(r.hour), count: Number(r.count) })),
      versions,
      champion: champion?.name ?? null,
      lastRun: lastRun
        ? { ranAt: lastRun.ranAt, promoted: lastRun.promoted, summary: (lastRun.report as { summary?: string } | null)?.summary ?? "" }
        : null,
    };
  } catch (err) {
    log.debug({ err: (err as Error).message }, "learning tables unavailable for live status");
  }
  return { closed, learning };
}

export interface LiveStatusWriterOptions {
  dir: string;
  mode: string;
  status: () => SystemStatus;
  trading: () => boolean;
  bankroll: () => BankrollSnapshot;
  open: () => Position[];
  tracker: () => ReturnType<OutcomeTracker["getStats"]> | null;
  intervalMs?: number;
}

/** Rewrites the file on a timer, atomically, so a reader never sees half of one. */
export class LiveStatusWriter {
  private timer: NodeJS.Timeout | null = null;
  private writing = false;

  constructor(private readonly opts: LiveStatusWriterOptions) {}

  get file(): string {
    return path.join(this.opts.dir, LIVE_STATUS_FILE);
  }

  start(): void {
    if (this.timer) return;
    void this.write();
    this.timer = setInterval(() => void this.write(), this.opts.intervalMs ?? 120_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.write();
  }

  async write(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      const now = Date.now();
      const db = await queryLiveStatusDb(now, this.opts.mode);
      const body = assembleLiveStatus({
        now,
        status: this.opts.status(),
        trading: this.opts.trading(),
        bankroll: this.opts.bankroll(),
        open: this.opts.open(),
        closed: db.closed,
        learning: db.learning,
        tracker: this.opts.tracker(),
      });
      await mkdir(this.opts.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(body, null, 2));
      await rename(tmp, this.file);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "live status not written");
    } finally {
      this.writing = false;
    }
  }
}
