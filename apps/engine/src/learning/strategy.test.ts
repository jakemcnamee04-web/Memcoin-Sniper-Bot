import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FILTER_ORDER, parseTpLadder, validateSettingsPatch } from "@sniperbot/shared";
import type { ResolvedFilterConfig } from "../config/filter-config.js";
import { tpLadder, tradingSettings } from "../config/trading-settings.js";
import { createRng } from "./rng.js";
import {
  BOUNDS,
  MAX_TP_RUNGS,
  SAFETY_FILTERS,
  mutate,
  normalizeLadder,
  sameTuning,
  strategyFromLive,
  toPresetDelta,
  toSettingsPatch,
} from "./strategy.js";
import { baseStrategy } from "./test-helpers.js";

const tunable = FILTER_ORDER.filter((id) => !SAFETY_FILTERS.has(id));

describe("strategy versions", () => {
  test("mutations stay in bounds, never touch safety checks, sizing or risk, and always change something", () => {
    const rng = createRng("bounds");
    let parent = baseStrategy();
    for (let i = 0; i < 500; i++) {
      const child = mutate(parent, rng, { tunableFilters: [...tunable, ...SAFETY_FILTERS], maxTimeExitMin: 55 });
      assert.ok(!sameTuning(child, parent), "differs from its parent");
      const f = child.filters;
      const e = child.exits;
      for (const id of SAFETY_FILTERS) assert.equal(f.enabled[id], true, `${id} stays on`);
      assert.deepEqual(child.sizing, parent.sizing);
      const within = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi;
      assert.ok(within(f.minFilterScore, BOUNDS.minFilterScore));
      assert.ok(within(f.topHolderMaxPct, BOUNDS.topHolderMaxPct) && f.top10HoldersMaxPct >= f.topHolderMaxPct);
      assert.ok(f.liquidityMaxUsd > f.liquidityMinUsd);
      assert.ok(within(f.devRugRateMax, BOUNDS.devRugRateMax));
      assert.ok(within(e.stopLossPct, BOUNDS.stopLossPct));
      assert.ok(e.timeExitMin >= 3 && e.timeExitMin <= 55);
      assert.ok(e.tpLadder.length >= 1 && e.tpLadder.length <= MAX_TP_RUNGS);
      assert.ok(e.tpLadder.reduce((s, r) => s + r.sellPct, 0) <= 100);
      for (let k = 1; k < e.tpLadder.length; k++) assert.ok(e.tpLadder[k]!.gainPct > e.tpLadder[k - 1]!.gainPct);
      parent = child;
    }
  });

  test("a version's exits are valid dashboard settings", () => {
    const rng = createRng("settings");
    let cfg = baseStrategy();
    for (let i = 0; i < 200; i++) {
      cfg = mutate(cfg, rng, { tunableFilters: tunable, maxTimeExitMin: 55 });
      const checked = validateSettingsPatch(toSettingsPatch(cfg));
      assert.ok(checked.ok, checked.ok ? "" : checked.error);
    }
  });

  test("promoting a version makes the live settings equal to it", () => {
    let cfg = baseStrategy();
    const rng = createRng("roundtrip");
    for (let i = 0; i < 50; i++) cfg = mutate(cfg, rng, { tunableFilters: tunable, maxTimeExitMin: 55 });
    // what filterConfig.resolve() returns once the preset is active
    const delta = toPresetDelta(cfg);
    const t = delta.thresholds!;
    const resolved: ResolvedFilterConfig = {
      enabled: (id) => delta.enabled?.[id] ?? true,
      liquidityMinUsd: t.liquidityMinUsd!,
      liquidityMaxUsd: t.liquidityMaxUsd!,
      lpLockedRequired: t.lpLockedRequired!,
      mintAuthRenounced: t.mintAuthRenounced!,
      freezeAuthRenounced: t.freezeAuthRenounced!,
      topHolderMaxPct: t.topHolderMaxPct!,
      top10HoldersMaxPct: t.top10HoldersMaxPct!,
      devRugRateMax: t.devRugRateMax!,
      honeypotSimRequired: t.honeypotSimRequired!,
      maxSellTaxPct: t.maxSellTaxPct!,
      bundledLaunchReject: t.bundledLaunchReject!,
      minFilterScore: t.minFilterScore!,
    };
    const settings = { ...tradingSettings(), ...toSettingsPatch(cfg) };
    const live = strategyFromLive(resolved, settings, parseTpLadder(settings.tpLadder)!);
    assert.ok(sameTuning(live, cfg));
    assert.ok(tpLadder().length > 0);
  });

  test("ladders are sorted, capped at four rungs and never sell more than everything", () => {
    const l = normalizeLadder([
      { gainPct: 300, sellPct: 60 },
      { gainPct: 50, sellPct: 60 },
      { gainPct: 50, sellPct: 10 },
      { gainPct: 900, sellPct: 40 },
      { gainPct: 2000, sellPct: 40 },
    ]);
    assert.equal(l.length, 4);
    assert.ok(l.reduce((s, r) => s + r.sellPct, 0) <= 100);
    assert.deepEqual(l.map((r) => r.gainPct), [50, 55, 300, 900]);
  });
});
