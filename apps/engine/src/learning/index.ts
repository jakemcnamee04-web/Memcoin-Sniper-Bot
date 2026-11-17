import { TelegramClient } from "../alerts/telegram.js";
import { filterConfig } from "../config/filter-config.js";
import { env, isPaperMode } from "../config/env.js";
import { saveTradingSettings, startingBalanceUsd, tpLadder, tradingSettings } from "../config/trading-settings.js";
import { activatePreset, savePreset } from "../state/filter-presets.js";
import { childLogger } from "../utils/logger.js";
import type { NightlyDeps } from "./nightly.js";
import type { SimOptions } from "./simulator.js";
import type { LearningStore } from "./store.js";
import { strategyFromLive, toPresetDelta, toSettingsPatch } from "./strategy.js";
import type { TunerParams } from "./tuner.js";
import type { EvalThresholds, StrategyConfig } from "./types.js";

const log = childLogger("learning");

/** The preset the tuner writes and activates; the dashboard shows it like any other. */
export const TUNED_PRESET_NAME = "Auto-tuned";

export function tunerParamsFromEnv(): TunerParams {
  return {
    lookbackDays: env.TUNER_LOOKBACK_DAYS,
    holdoutDays: env.TUNER_HOLDOUT_DAYS,
    minTrades: env.TUNER_MIN_TRADES,
    minHoldoutTrades: env.TUNER_MIN_HOLDOUT_TRADES,
    promoteMarginPct: env.TUNER_PROMOTE_MARGIN_PCT,
    cooldownDays: env.TUNER_PROMOTE_COOLDOWN_DAYS,
    populationSize: env.TUNER_POPULATION,
    cullCount: Math.min(env.TUNER_CULL, Math.max(1, env.TUNER_POPULATION - 3)),
    // leave room after the time exit for the sale itself to be recorded
    maxTimeExitMin: env.TRACK_WINDOW_MIN - 5,
  };
}

export function simOptionsFromEnv(): SimOptions {
  return {
    startingBalanceUsd: startingBalanceUsd(),
    jitoTipLamports: env.JITO_TIP_LAMPORTS,
    rugDropPct: env.RUG_DETECTION_LP_DROP_PCT,
  };
}

export function liveStrategy(): StrategyConfig {
  return strategyFromLive(filterConfig.resolve(), tradingSettings(), tpLadder());
}

export function evalThresholdsNow(): EvalThresholds {
  const c = filterConfig.resolve();
  return {
    liquidityMinUsd: c.liquidityMinUsd,
    liquidityMaxUsd: c.liquidityMaxUsd,
    topHolderMaxPct: c.topHolderMaxPct,
    top10HoldersMaxPct: c.top10HoldersMaxPct,
    devRugRateMax: c.devRugRateMax,
    maxSellTaxPct: c.maxSellTaxPct,
    minFilterScore: c.minFilterScore,
  };
}

/**
 * Switches the live paper bot to a version: its filters as the active
 * "Auto-tuned" preset, its exits as the dashboard trading settings. Sizing and
 * risk limits are left as they are. Refuses outside paper mode.
 */
export async function promoteLive(cfg: StrategyConfig, name: string): Promise<void> {
  if (!isPaperMode) throw new Error("the tuner only changes settings in paper mode");
  const preset = await savePreset({
    name: TUNED_PRESET_NAME,
    description: `Set by the nightly tuner: version ${name}. Activate another preset to take over by hand.`,
    config: toPresetDelta(cfg),
  });
  await activatePreset(preset.id);
  await saveTradingSettings(toSettingsPatch(cfg));
  log.warn({ version: name }, "live paper settings switched to a tuned version");
}

export function telegramNotifier(): ((html: string) => Promise<void>) | null {
  const token = env.TELEGRAM_BOT_TOKEN.trim();
  const chatId = env.TELEGRAM_CHAT_ID.trim();
  if (!token || !chatId) return null;
  const client = new TelegramClient({ token, chatId });
  return async (html) => {
    const out = await client.sendMessage(html, { html: true });
    if (out.kind !== "ok") log.warn({ outcome: out.kind }, "Telegram did not take the nightly summary");
  };
}

export function nightlyDeps(store: LearningStore, opts: { apply: boolean; promote: boolean; notify: boolean; now?: number }): NightlyDeps {
  return {
    store,
    now: opts.now ?? Date.now(),
    live: liveStrategy,
    params: tunerParamsFromEnv(),
    sim: simOptionsFromEnv(),
    retentionDays: env.TRACK_RETENTION_DAYS,
    maxCoins: env.TUNER_MAX_COINS,
    apply: opts.apply,
    promoteLive: opts.promote && isPaperMode ? promoteLive : null,
    reportsDir: env.LEARNING_REPORTS_DIR,
    notify: opts.notify ? telegramNotifier() : null,
  };
}
