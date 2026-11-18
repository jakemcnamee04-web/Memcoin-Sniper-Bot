/**
 * pnpm learning:tune             run tonight's tuner now, as a dry run: report only
 * pnpm learning:tune --apply     save the new versions and the run
 * pnpm learning:tune --apply --promote
 *                                also switch the live paper settings if a version qualifies
 *                                (a running engine picks them up on its next start)
 * pnpm learning:export [--days 7]
 *                                write the weekly review data to the reports folder
 * pnpm learning:status           what has been recorded so far
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env, isPaperMode } from "../config/env.js";
import { loadSettings } from "../config/trading-settings.js";
import { disconnectPrisma, getPrisma } from "../state/db.js";
import { bootstrapPresets } from "../state/filter-presets.js";
import { liveStrategy, nightlyDeps, simOptionsFromEnv } from "./index.js";
import { runNightly } from "./nightly.js";
import { PrismaLearningStore } from "./prisma-store.js";
import { weeklyData, weeklyMarkdown } from "./report.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function tune(args: string[]): Promise<void> {
  const apply = args.includes("--apply");
  const promote = args.includes("--promote");
  if (promote && !apply) throw new Error("--promote needs --apply");
  if (promote && !isPaperMode) throw new Error("the tuner only changes settings in paper mode");
  const result = await runNightly(nightlyDeps(new PrismaLearningStore(), { apply, promote, notify: false }));
  console.log(result.summary);
  if (result.reportPath) console.log(`report: ${path.resolve(result.reportPath)}`);
  if (!apply) console.log("dry run: nothing was saved (add --apply to save)");
  if (result.promotedLive) console.log("live settings changed in the database: restart the engine to load them");
}

async function exportWeekly(args: string[]): Promise<void> {
  const i = args.indexOf("--days");
  const days = i >= 0 ? Number(args[i + 1]) : 7;
  if (!(days > 0)) throw new Error("--days must be a positive number");
  const store = new PrismaLearningStore();
  const to = Date.now();
  const from = to - days * DAY_MS;
  const total = await store.countCoins(from, to);
  const keepRate = env.TUNER_MAX_COINS > 0 && total > env.TUNER_MAX_COINS ? env.TUNER_MAX_COINS / total : 1;
  const coins = await store.loadCoins(from, to, keepRate);
  const champion = (await store.loadVersions()).find((v) => v.isChampion) ?? { name: "live settings", config: liveStrategy() };
  const data = weeklyData({ coins, champion, runs: await store.loadRuns(from), sim: simOptionsFromEnv(), from, to });
  await mkdir(env.LEARNING_REPORTS_DIR, { recursive: true });
  const base = path.join(env.LEARNING_REPORTS_DIR, `weekly-${new Date(to).toISOString().slice(0, 10)}`);
  await writeFile(`${base}.md`, weeklyMarkdown(data));
  await writeFile(`${base}.json`, JSON.stringify(data, null, 2));
  console.log(`weekly review data: ${path.resolve(`${base}.md`)} (${coins.length} coins, ${data.champion.metrics.trades} replayed trades)`);
}

async function status(): Promise<void> {
  const prisma = getPrisma();
  const since = new Date(Date.now() - DAY_MS);
  const [total, lastDay, tracking, versions, champion, lastRun] = await Promise.all([
    prisma.trackedCoin.count(),
    prisma.trackedCoin.count({ where: { decidedAt: { gte: since } } }),
    prisma.trackedCoin.count({ where: { status: "tracking" } }),
    prisma.strategyVersion.count({ where: { retiredAt: null } }),
    prisma.strategyVersion.findFirst({ where: { isChampion: true } }),
    prisma.tunerRun.findFirst({ orderBy: { ranAt: "desc" } }),
  ]);
  console.log(`coins recorded: ${total} (${lastDay} in the last 24h, ${tracking} still being followed)`);
  console.log(`versions competing: ${versions}; live version: ${champion?.name ?? "none yet (set on the first nightly run)"}`);
  console.log(`last tuner run: ${lastRun ? `${lastRun.ranAt.toISOString()}${lastRun.promoted ? `, promoted ${lastRun.promoted}` : ""}` : "never"}`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  await getPrisma().$queryRaw`SELECT 1`;
  await bootstrapPresets();
  await loadSettings();
  if (cmd === "tune") await tune(args);
  else if (cmd === "export") await exportWeekly(args);
  else if (cmd === "status") await status();
  else throw new Error("usage: cli.ts tune [--apply [--promote]] | export [--days N] | status");
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
