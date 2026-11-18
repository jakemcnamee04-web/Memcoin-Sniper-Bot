import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { BankrollSnapshot, Position } from "@sniperbot/shared";
import type { SystemStatus } from "../api/socket-server.js";
import { assembleLiveStatus, type ClosedRow } from "./live-status.js";

const NOW = Date.UTC(2026, 10, 18, 3, 30);
const status = {
  mode: "paper", botOn: true, feedLive: true, activePreset: "Safe Sniper", uptime: 90 * 60_000, rpcRequests: 2400,
  detectedTotal: 700, snipes: 24, rejects: 600, circuit: { halted: false, haltReason: null },
} as unknown as SystemStatus;
const bankroll = {
  startingBalanceUsd: 10_000, balanceUsd: 9_950, realizedPnlUsd: -50, unrealizedPnlUsd: 3, openExposureUsd: 100, openPositionCount: 1,
  totalTrades: 3, wins: 1, losses: 2, winRatePct: 33.33, avgWinPct: 40, avgLossPct: -35, profitFactor: 0.6, totalInvestedUsd: 300,
  totalGrossWinUsd: 40, totalGrossLossUsd: 90, takenAt: NOW,
} as BankrollSnapshot;
const closed = (minAgo: number, pnl: number): ClosedRow => ({
  closedAt: new Date(NOW - minAgo * 60_000), openedAt: new Date(NOW - (minAgo + 20) * 60_000), tokenMint: `Mint${minAgo}xxxxxxxxxxpump`,
  entrySizeUsd: 100, realizedPnlUsd: pnl, peakGainPct: 12, closeReason: "stop-loss",
});

describe("live status file", () => {
  test("equity ends at today's balance; hours, trades and learning are filled", () => {
    const s = assembleLiveStatus({
      now: NOW, status, trading: true, bankroll,
      open: [{ tokenMint: "OpenMintxxxxxxxxpump", openedAt: NOW - 60_000, entrySizeUsd: 100, unrealizedPnlUsd: 3, unrealizedPnlPct: 3, peakGainPct: 5 } as Position],
      closed: [closed(100, -45), closed(50, 40), closed(10, -45)],
      learning: {
        recordedTotal: 900, recorded24h: 670, buyable24h: 498,
        endReasons24h: [{ reason: "window", count: 476 }, { reason: "no-price", count: 172 }, { reason: "dead", count: 22 }],
        coinsByHour: [{ hour: new Date(Date.UTC(2026, 10, 18, 2)), count: 300 }], versions: 20, champion: "baseline-x", lastRun: null,
      },
      tracker: { following: 40 } as never,
    });
    assert.equal(s.equity.at(-1)!.balanceUsd, 9_950);
    assert.equal(s.equity[0]!.balanceUsd, 10_000);
    assert.equal(s.hourly.length, 48);
    assert.equal(s.hourly.find((h) => h.hour === "2026-11-18T02:00:00.000Z")!.coinsRecorded, 300);
    assert.equal(s.hourly.reduce((n, h) => n + h.tradesClosed, 0), 3);
    assert.equal(s.trades[0]!.pnlUsd, -45, "newest first");
    assert.equal(s.trades[0]!.pnlPct, -45);
    assert.equal(s.summary.buyable24hPct, 74.3);
    assert.equal(s.summary.returnPct, -0.5);
    assert.equal(s.summary.trackerFollowing, 40);
    assert.equal(s.open.length, 1);
    assert.equal(s.recordingEnds.length, 3);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)));
  });

  test("a fresh engine with no trades and no learning tables still writes a file", () => {
    const s = assembleLiveStatus({ now: NOW, status, trading: false, bankroll: { ...bankroll, totalTrades: 0 }, open: [], closed: [], learning: null, tracker: null });
    assert.equal(s.equity.length, 1);
    assert.equal(s.summary.coinsRecorded24h, 0);
    assert.equal(s.summary.buyable24hPct, null);
    assert.equal(s.trades.length, 0);
  });
});
