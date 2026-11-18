import { unitHash } from "./rng.js";
import type { CoinRecord, StrategyVersion } from "./types.js";

/** The fixed draw that decides whether a coin is in a sample of the given rate. */
export const inSample = (poolAddress: string, keepRate: number): boolean => keepRate >= 1 || unitHash(`${poolAddress}:tune`) < keepRate;

export type CoinStatus = "tracking" | "done";

export interface TunerRunRecord {
  ranAt: number;
  applied: boolean;
  promoted: string | null;
  report: unknown;
}

/**
 * Where the learning loop keeps its data. The Prisma store is the real one;
 * the memory store lets the whole loop run in tests without a database.
 */
export interface LearningStore {
  saveCoin(coin: CoinRecord, status: CoinStatus): Promise<void>;
  /** Coins left "tracking" by a crash or restart: their recording ends where it stopped. */
  closeInterrupted(): Promise<number>;
  countCoins(since: number, until: number): Promise<number>;
  /**
   * Finished coins judged in [since, until), oldest first. With keepRate < 1,
   * an even sample: each coin is kept or not by a fixed draw on its address.
   */
  loadCoins(since: number, until?: number, keepRate?: number): Promise<CoinRecord[]>;
  deleteCoinsBefore(before: number): Promise<number>;

  /** Every version still competing. */
  loadVersions(): Promise<StrategyVersion[]>;
  saveVersion(v: StrategyVersion): Promise<void>;
  retireVersions(names: string[], at: number): Promise<void>;
  setChampion(name: string): Promise<void>;

  saveRun(run: TunerRunRecord): Promise<void>;
  loadRuns(since: number): Promise<TunerRunRecord[]>;
}

export class MemoryLearningStore implements LearningStore {
  readonly coins = new Map<string, { coin: CoinRecord; status: CoinStatus }>();
  readonly versions = new Map<string, StrategyVersion & { retiredAt: number | null }>();
  readonly runs: TunerRunRecord[] = [];

  async saveCoin(coin: CoinRecord, status: CoinStatus): Promise<void> {
    this.coins.set(coin.poolAddress, { coin: structuredClone(coin), status });
  }

  async closeInterrupted(): Promise<number> {
    let n = 0;
    for (const row of this.coins.values()) {
      if (row.status !== "tracking") continue;
      row.status = "done";
      row.coin.endReason = "shutdown";
      n++;
    }
    return n;
  }

  async countCoins(since: number, until: number): Promise<number> {
    return [...this.coins.values()].filter((r) => r.status === "done" && r.coin.decidedAt >= since && r.coin.decidedAt < until).length;
  }

  async loadCoins(since: number, until = Infinity, keepRate = 1): Promise<CoinRecord[]> {
    return [...this.coins.values()]
      .filter((r) => r.status === "done" && r.coin.decidedAt >= since && r.coin.decidedAt < until && inSample(r.coin.poolAddress, keepRate))
      .map((r) => structuredClone(r.coin))
      .sort((a, b) => a.decidedAt - b.decidedAt);
  }

  async deleteCoinsBefore(before: number): Promise<number> {
    let n = 0;
    for (const [k, r] of this.coins) {
      if (r.coin.decidedAt < before) {
        this.coins.delete(k);
        n++;
      }
    }
    return n;
  }

  async loadVersions(): Promise<StrategyVersion[]> {
    return [...this.versions.values()]
      .filter((v) => v.retiredAt === null)
      .map(({ retiredAt: _r, ...v }) => structuredClone(v));
  }

  async saveVersion(v: StrategyVersion): Promise<void> {
    this.versions.set(v.name, { ...structuredClone(v), retiredAt: this.versions.get(v.name)?.retiredAt ?? null });
  }

  async retireVersions(names: string[], at: number): Promise<void> {
    for (const n of names) {
      const v = this.versions.get(n);
      if (v && !v.isChampion) v.retiredAt = at;
    }
  }

  async setChampion(name: string): Promise<void> {
    if (!this.versions.has(name)) throw new Error(`no version ${name}`);
    for (const v of this.versions.values()) v.isChampion = v.name === name;
  }

  async saveRun(run: TunerRunRecord): Promise<void> {
    this.runs.push(structuredClone(run));
  }

  async loadRuns(since: number): Promise<TunerRunRecord[]> {
    return this.runs.filter((r) => r.ranAt >= since).sort((a, b) => a.ranAt - b.ranAt);
  }
}
