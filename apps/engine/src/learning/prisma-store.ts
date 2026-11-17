import type { DexSource } from "@sniperbot/shared";
import { getPrisma } from "../state/db.js";
import { inSample, type CoinStatus, type LearningStore, type TunerRunRecord } from "./store.js";
import { type PackedPath, sampleCount } from "./path.js";
import type { CoinRecord, EvalThresholds, RecordedResult, StrategyConfig, StrategyVersion, TrackEndReason } from "./types.js";

interface CoinRow {
  poolAddress: string;
  tokenMint: string;
  source: string;
  synthetic: boolean;
  decidedAt: Date;
  decision: "snipe" | "reject";
  initialLiquidityUsd: number;
  results: unknown;
  evalThresholds: unknown;
  path: unknown;
  timeScale: number;
  endReason: string | null;
}

function rowToCoin(r: CoinRow): CoinRecord {
  return {
    poolAddress: r.poolAddress,
    tokenMint: r.tokenMint,
    source: r.source as DexSource,
    synthetic: r.synthetic,
    decidedAt: r.decidedAt.getTime(),
    decision: r.decision,
    initialLiquidityUsd: r.initialLiquidityUsd,
    results: r.results as RecordedResult[],
    evalThresholds: r.evalThresholds as EvalThresholds,
    path: r.path as PackedPath,
    timeScale: r.timeScale,
    endReason: r.endReason as TrackEndReason | null,
  };
}

export class PrismaLearningStore implements LearningStore {
  async saveCoin(coin: CoinRecord, status: CoinStatus): Promise<void> {
    const data = {
      tokenMint: coin.tokenMint,
      source: coin.source,
      synthetic: coin.synthetic,
      decidedAt: new Date(coin.decidedAt),
      decision: coin.decision,
      initialLiquidityUsd: coin.initialLiquidityUsd,
      results: coin.results as unknown as object,
      evalThresholds: coin.evalThresholds as unknown as object,
      path: coin.path as unknown as object,
      timeScale: coin.timeScale,
      status,
      endReason: coin.endReason,
      sampleCount: sampleCount(coin.path),
    };
    await getPrisma().trackedCoin.upsert({
      where: { poolAddress: coin.poolAddress },
      create: { poolAddress: coin.poolAddress, ...data },
      update: data,
    });
  }

  async closeInterrupted(): Promise<number> {
    const out = await getPrisma().trackedCoin.updateMany({
      where: { status: "tracking" },
      data: { status: "done", endReason: "shutdown" },
    });
    return out.count;
  }

  async countCoins(since: number, until: number): Promise<number> {
    return getPrisma().trackedCoin.count({ where: { status: "done", decidedAt: { gte: new Date(since), lt: new Date(until) } } });
  }

  /** Read in pages, so a sample of a large window never holds the whole window in memory. */
  async loadCoins(since: number, until?: number, keepRate = 1): Promise<CoinRecord[]> {
    const where = {
      status: "done",
      decidedAt: { gte: new Date(since), ...(until !== undefined ? { lt: new Date(until) } : {}) },
    };
    const out: CoinRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const rows = await getPrisma().trackedCoin.findMany({
        where,
        orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
        take: 2_000,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      for (const r of rows) if (inSample(r.poolAddress, keepRate)) out.push(rowToCoin(r));
      if (rows.length < 2_000) return out;
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async deleteCoinsBefore(before: number): Promise<number> {
    const out = await getPrisma().trackedCoin.deleteMany({ where: { decidedAt: { lt: new Date(before) } } });
    return out.count;
  }

  async loadVersions(): Promise<StrategyVersion[]> {
    const rows = await getPrisma().strategyVersion.findMany({ where: { retiredAt: null }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => ({
      name: r.name,
      parentName: r.parentName,
      generation: r.generation,
      config: r.config as unknown as StrategyConfig,
      isChampion: r.isChampion,
      createdAt: r.createdAt.getTime(),
    }));
  }

  async saveVersion(v: StrategyVersion): Promise<void> {
    const data = {
      parentName: v.parentName,
      generation: v.generation,
      config: v.config as unknown as object,
      isChampion: v.isChampion,
    };
    await getPrisma().strategyVersion.upsert({
      where: { name: v.name },
      create: { name: v.name, createdAt: new Date(v.createdAt), ...data },
      update: data,
    });
  }

  async retireVersions(names: string[], at: number): Promise<void> {
    if (names.length === 0) return;
    await getPrisma().strategyVersion.updateMany({
      where: { name: { in: names }, isChampion: false },
      data: { retiredAt: new Date(at) },
    });
  }

  async setChampion(name: string): Promise<void> {
    const prisma = getPrisma();
    await prisma.$transaction([
      prisma.strategyVersion.updateMany({ where: { isChampion: true }, data: { isChampion: false } }),
      prisma.strategyVersion.update({ where: { name }, data: { isChampion: true, retiredAt: null } }),
    ]);
  }

  async saveRun(run: TunerRunRecord): Promise<void> {
    await getPrisma().tunerRun.create({
      data: { ranAt: new Date(run.ranAt), applied: run.applied, promoted: run.promoted, report: run.report as object },
    });
  }

  async loadRuns(since: number): Promise<TunerRunRecord[]> {
    const rows = await getPrisma().tunerRun.findMany({ where: { ranAt: { gte: new Date(since) } }, orderBy: { ranAt: "asc" } });
    return rows.map((r) => ({ ranAt: r.ranAt.getTime(), applied: r.applied, promoted: r.promoted, report: r.report }));
  }
}
