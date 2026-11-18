import { formatTpLadder, type FilterId } from "@sniperbot/shared";
import { ENTRY_MAX_LAG_MS } from "./constants.js";
import { judgeCoin } from "./judge.js";
import { priceAt, sampleCount, tAt } from "./path.js";
import { simulate, type SimOptions } from "./simulator.js";
import type { TunerRunRecord } from "./store.js";
import { measuredFilters, scoreOf, type TunerPlan } from "./tuner.js";
import type { CoinRecord, SimMetrics, StrategyConfig } from "./types.js";

const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "—");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;

export function describeStrategy(cfg: StrategyConfig): string {
  const f = cfg.filters;
  const e = cfg.exits;
  const off = Object.entries(f.enabled)
    .filter(([, on]) => !on)
    .map(([id]) => id);
  return [
    `min score ${f.minFilterScore}, liquidity $${f.liquidityMinUsd}–$${f.liquidityMaxUsd}, top holder ≤${f.topHolderMaxPct}%, top 10 ≤${f.top10HoldersMaxPct}%, dev rug rate ≤${f.devRugRateMax}, sell tax ≤${f.maxSellTaxPct}%`,
    `stop ${e.stopLossPct}%, take-profits ${formatTpLadder(e.tpLadder)}, trailing ${e.trailingStopPct}% after +${e.trailingStopActivationPct}%, time exit ${e.timeExitMin} min`,
    off.length ? `filters off: ${off.join(", ")}` : "all filters on",
  ].join("\n");
}

function metricsRow(name: string, m: SimMetrics, score: number): string {
  return `| ${name} | ${m.trades} | ${f1(m.winRatePct)}% | ${f1(m.netPnlPct)}% | ${f1(m.pnlExTop3Pct)}% | ${f1(m.maxDrawdownPct)}% | ${f1(score)} |`;
}

export function nightlyMarkdown(plan: TunerPlan, ctx: { applied: boolean; promotedLive: boolean; championConfig: StrategyConfig; candidateConfig: StrategyConfig | null; extraNotes: string[] }): string {
  const lines: string[] = [];
  lines.push(`# Nightly tuner — ${day(plan.ranAt)}`, "");
  lines.push(
    `Data: ${plan.data.coins} coins from ${day(plan.window.from)} to ${day(plan.window.to)} — ${plan.data.selectionCoins} to rank on, ${plan.data.holdoutCoins} held out (since ${day(plan.window.holdoutFrom)}).`,
    "",
  );
  const p = plan.promotion;
  if (p.promote) {
    lines.push(`## Promoted: ${p.to}${ctx.promotedLive ? "" : " (recommended only — live settings left unchanged)"}`, "", ...p.changes.map((c) => `- ${c}`), "");
  } else {
    lines.push(`## No promotion — live version stays ${plan.champion}`, "");
  }
  if (p.checks.length) {
    lines.push("| Check | Result | Detail |", "|---|---|---|");
    for (const c of p.checks) lines.push(`| ${c.check} | ${c.ok ? "pass" : "FAIL"} | ${c.detail} |`);
    lines.push("");
  }
  lines.push("## Ranking (selection window)", "", "| Version | Trades | Win rate | Net P&L | P&L without top 3 | Max drawdown | Score |", "|---|---|---|---|---|---|---|");
  for (const e of plan.evals) {
    const tag = e.isChampion ? " (live)" : e.name === plan.candidate ? " (challenger)" : "";
    lines.push(metricsRow(`${e.rank}. ${e.name}${tag}${e.eligible ? "" : " *"}`, e.selection, e.selectionScore));
  }
  lines.push("", "`*` fewer trades than the minimum: not ranked on score.", "");
  lines.push("## Holdout (most recent days)", "", "| Version | Trades | Win rate | Net P&L | P&L without top 3 | Max drawdown | Score |", "|---|---|---|---|---|---|---|");
  for (const e of plan.evals.filter((x) => x.isChampion || x.name === plan.candidate)) {
    lines.push(metricsRow(`${e.name}${e.isChampion ? " (live)" : " (challenger)"}`, e.holdout, e.holdoutScore));
  }
  lines.push("", "## Live version", "", "```", describeStrategy(ctx.championConfig), "```", "");
  if (ctx.candidateConfig && plan.candidate) lines.push(`## Challenger ${plan.candidate}`, "", "```", describeStrategy(ctx.candidateConfig), "```", "");
  if (plan.retire.length || plan.create.length) {
    lines.push("## Evolution", "");
    if (plan.retire.length) lines.push(`Retired: ${plan.retire.join(", ")}`);
    if (plan.create.length) lines.push(`New: ${plan.create.map((v) => `${v.name} (from ${v.parentName})`).join(", ")}`);
    lines.push("");
  }
  const notes = [...plan.notes, ...ctx.extraNotes];
  if (notes.length) lines.push("## Notes", "", ...notes.map((n) => `- ${n}`), "");
  if (!ctx.applied) lines.push("_Dry run: nothing above was saved._", "");
  return lines.join("\n");
}

export function nightlyTelegram(plan: TunerPlan, promotedLive: boolean): string {
  const champ = plan.evals.find((e) => e.isChampion);
  const cand = plan.evals.find((e) => e.name === plan.candidate);
  const lines = [`<b>Nightly tuner — ${day(plan.ranAt)}</b>`, `${plan.data.coins} coins replayed across ${plan.evals.length} versions`];
  if (champ) lines.push(`Live (${champ.name}): ${champ.selection.trades} trades, ${f1(champ.selection.netPnlPct)}% net, ${f1(champ.selection.pnlExTop3Pct)}% without top 3`);
  if (cand) lines.push(`Best challenger (${cand.name}): ${cand.selection.trades} trades, ${f1(cand.selection.netPnlPct)}% net, ${f1(cand.selection.pnlExTop3Pct)}% without top 3`);
  if (plan.promotion.promote) {
    lines.push(promotedLive ? `<b>Promoted ${plan.promotion.to}</b>` : `<b>${plan.promotion.to} qualifies</b> — auto-promote is off`);
    lines.push(...plan.promotion.changes.slice(0, 8).map((c) => `• ${c}`));
  } else {
    const failed = plan.promotion.checks.find((c) => !c.ok);
    lines.push(`No promotion${failed ? `: ${failed.check} (${failed.detail})` : ""}`);
  }
  if (plan.notes[0]) lines.push(plan.notes[0]);
  return lines.join("\n");
}

/** What a coin's price did after its verdict, within a horizon of exit time. */
export function outcomeOf(coin: CoinRecord, horizonMin: number): { buyable: boolean; maxGainPct: number; minPct: number; died: boolean } {
  const n = sampleCount(coin.path);
  if (n === 0) return { buyable: false, maxGainPct: 0, minPct: 0, died: coin.endReason === "unpriced" };
  const horizon = horizonMin * 60_000;
  const t0 = tAt(coin.path, 0);
  const p0 = priceAt(coin.path, 0);
  let max = p0;
  let min = p0;
  for (let i = 0; i < n; i++) {
    if ((tAt(coin.path, i) - t0) * coin.timeScale > horizon) break;
    const p = priceAt(coin.path, i);
    if (p > max) max = p;
    if (p < min) min = p;
  }
  const minPct = (min / p0 - 1) * 100;
  return {
    buyable: t0 <= ENTRY_MAX_LAG_MS,
    maxGainPct: (max / p0 - 1) * 100,
    minPct,
    died: minPct <= -70 || coin.endReason === "dead" || coin.endReason === "unpriced",
  };
}

export interface WeeklyData {
  from: number;
  to: number;
  champion: { name: string; config: StrategyConfig; metrics: SimMetrics; score: number };
  health: { coins: number; buyable: number; perDay: Record<string, number>; endReasons: Record<string, number>; medianSamples: number };
  filters: Array<{ filterId: FilterId; failed: number; failedRanPct: number; failedDiedPct: number; passed: number; passedRanPct: number; passedDiedPct: number }>;
  missedWinners: Array<{ pool: string; mint: string; source: string; at: number; maxGainPct: number; scorePct: number; failed: FilterId[] }>;
  worstTrades: Array<{ pool: string; mint: string; at: number; pnlPct: number; exitReason: string; peakGainPct: number; results: string }>;
  runs: Array<{ day: string; promoted: string | null; applied: boolean; summary: string }>;
}

/** The week's evidence for the weekly review: where the live version lost money and where its filters cost it winners. */
export function weeklyData(input: {
  coins: readonly CoinRecord[];
  champion: { name: string; config: StrategyConfig };
  runs: readonly TunerRunRecord[];
  sim: SimOptions;
  from: number;
  to: number;
}): WeeklyData {
  const { coins, champion, sim } = input;
  const cfg = champion.config;
  const horizon = cfg.exits.timeExitMin;
  const replay = simulate(cfg, coins, sim);

  const perDay: Record<string, number> = {};
  const endReasons: Record<string, number> = {};
  const samples: number[] = [];
  const judged = coins.map((c) => {
    perDay[day(c.decidedAt)] = (perDay[day(c.decidedAt)] ?? 0) + 1;
    endReasons[c.endReason ?? "unknown"] = (endReasons[c.endReason ?? "unknown"] ?? 0) + 1;
    samples.push(sampleCount(c.path));
    return { coin: c, j: judgeCoin(c, cfg.filters), o: outcomeOf(c, horizon) };
  });
  samples.sort((a, b) => a - b);
  const buyable = judged.filter((x) => x.o.buyable);

  const filters = measuredFilters(coins).map((id) => {
    const failed = buyable.filter((x) => x.j.statuses[id] === "fail");
    const passed = buyable.filter((x) => x.j.statuses[id] === "pass");
    const share = (xs: typeof buyable, pred: (x: (typeof buyable)[number]) => boolean) => (xs.length ? (xs.filter(pred).length / xs.length) * 100 : 0);
    const ran = (x: (typeof buyable)[number]) => x.o.maxGainPct >= 100;
    const died = (x: (typeof buyable)[number]) => x.o.died;
    return {
      filterId: id,
      failed: failed.length,
      failedRanPct: share(failed, ran),
      failedDiedPct: share(failed, died),
      passed: passed.length,
      passedRanPct: share(passed, ran),
      passedDiedPct: share(passed, died),
    };
  });

  const missedWinners = buyable
    .filter((x) => x.j.decision === "reject" && x.o.maxGainPct >= 100)
    .sort((a, b) => b.o.maxGainPct - a.o.maxGainPct)
    .slice(0, 15)
    .map((x) => ({ pool: x.coin.poolAddress, mint: x.coin.tokenMint, source: x.coin.source, at: x.coin.decidedAt, maxGainPct: x.o.maxGainPct, scorePct: x.j.scorePct, failed: x.j.failed }));

  const byPool = new Map(coins.map((c) => [c.poolAddress, c]));
  const worstTrades = [...replay.trades]
    .sort((a, b) => a.pnlPct - b.pnlPct)
    .slice(0, 15)
    .map((t) => {
      const c = byPool.get(t.poolAddress);
      const results = (c?.results ?? []).map((r) => `${r.filterId}:${r.status}`).join(" ");
      return { pool: t.poolAddress, mint: t.tokenMint, at: t.openedAt, pnlPct: t.pnlPct, exitReason: t.exitReason, peakGainPct: t.peakGainPct, results };
    });

  const runs = input.runs.map((r) => {
    const rep = r.report as { summary?: string } | null;
    return { day: day(r.ranAt), promoted: r.promoted, applied: r.applied, summary: rep?.summary ?? "" };
  });

  return {
    from: input.from,
    to: input.to,
    champion: { name: champion.name, config: cfg, metrics: replay.metrics, score: scoreOf(replay.metrics) },
    health: { coins: coins.length, buyable: buyable.length, perDay, endReasons, medianSamples: samples[Math.floor(samples.length / 2)] ?? 0 },
    filters,
    missedWinners,
    worstTrades,
    runs,
  };
}

export function weeklyMarkdown(w: WeeklyData): string {
  const m = w.champion.metrics;
  const lines = [
    `# Weekly review data — ${day(w.from)} to ${day(w.to)}`,
    "",
    "Input for the weekly Claude review (REVIEW_PLAYBOOK.md). All P&L is replayed paper P&L.",
    "",
    `## Live version: ${w.champion.name}`,
    "",
    "```",
    describeStrategy(w.champion.config),
    "```",
    "",
    `${m.trades} trades, win rate ${f1(m.winRatePct)}%, net ${f1(m.netPnlPct)}% of bankroll, ${f1(m.pnlExTop3Pct)}% without the top 3, max drawdown ${f1(m.maxDrawdownPct)}%, score ${f1(w.champion.score)}.`,
    `Exits: ${Object.entries(m.exitReasons).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}. Skipped: ${m.skippedFull} full, ${m.skippedRate} rate, ${m.skippedExposure} exposure, ${m.skippedHalted} halted; ${m.failedFills} failed fills.`,
    "",
    "## Data health",
    "",
    `${w.health.coins} coins recorded, ${w.health.buyable} with a price in time to buy, median ${w.health.medianSamples} price samples each.`,
    `Per day: ${Object.entries(w.health.perDay).map(([d, n]) => `${d} ${n}`).join(", ") || "none"}.`,
    `How recordings ended: ${Object.entries(w.health.endReasons).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`,
    "",
    "## Filters under the live version (buyable coins only)",
    "",
    "\"Ran\" = reached +100% within the time-exit window. \"Died\" = fell 70% or stopped trading. A filter is doing its job when the coins it fails die more often than the ones it passes, and run less often.",
    "",
    "| Filter | Failed | of those ran | of those died | Passed | of those ran | of those died |",
    "|---|---|---|---|---|---|---|",
    ...w.filters.map((f) => `| ${f.filterId} | ${f.failed} | ${f1(f.failedRanPct)}% | ${f1(f.failedDiedPct)}% | ${f.passed} | ${f1(f.passedRanPct)}% | ${f1(f.passedDiedPct)}% |`),
    "",
    "## Missed winners (rejected, then reached +100%)",
    "",
    "| When | Mint | Source | Peak | Score | Failed filters |",
    "|---|---|---|---|---|---|",
    ...w.missedWinners.map((x) => `| ${new Date(x.at).toISOString().slice(0, 16)} | ${short(x.mint)} | ${x.source} | +${f1(x.maxGainPct)}% | ${x.scorePct} | ${x.failed.join(", ") || "(score below minimum)"} |`),
    "",
    "## Worst trades of the live version",
    "",
    "| When | Mint | P&L | Exit | Peak | Filter answers |",
    "|---|---|---|---|---|---|",
    ...w.worstTrades.map((t) => `| ${new Date(t.at).toISOString().slice(0, 16)} | ${short(t.mint)} | ${f1(t.pnlPct)}% | ${t.exitReason} | +${f1(t.peakGainPct)}% | ${t.results} |`),
    "",
    "## Nightly tuner runs",
    "",
    ...(w.runs.length ? w.runs.map((r) => `- ${r.day}: ${r.promoted ? `promoted ${r.promoted}` : "no promotion"}${r.applied ? "" : " (dry run)"}. ${r.summary}`) : ["- none"]),
    "",
  ];
  return lines.join("\n");
}
