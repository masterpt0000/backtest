/**
 * Motores nas velas do gráfico — séries de indicadores do ``/api/chart/ta-series`` (TA-Lib / pandas).
 */
import type { ChartIndicatorDef } from "@/components/OhlcvChart";
import type { IndicatorSeriesBundle } from "@/lib/chartTaBundles";
import type { OhlcBarLike } from "@/lib/indicatorsFromBars";
import type { BacktestChartLayer } from "@/lib/backtestChartLayer";
import { buildMinimalRsiStairsFromBars } from "@/lib/liveStrategy/minimalRsiStairs";
import { emptyQuadSignals, runQuadSignalSimulation } from "@/lib/liveStrategy/chartSimBarByBar";
import { minimalStairsParamsFromDefs } from "@/lib/liveStrategy/chartSimIndicatorParams";

export const EMA_CROSS_LONG_ONLY_VBT_ID = "ema_cross_long_only" as const;
export const RSI_LEVEL_FLIP_VBT_ID = "rsi_level_flip" as const;
export const BOLLINGER_MEAN_REVERT_VBT_ID = "bollinger_mean_revert" as const;
export const LATERAL_MARKET_RSI_VBT_ID = "lateral_market_rsi" as const;

/** Defaults ``lateral_market_rsi_vbt``. */
const LATERAL_RSI_OVER_SOLD = 25;
const LATERAL_RSI_OVER_BOUGHT = 75;

function effTp(d: ChartIndicatorDef): number {
  if (d.kind === "talib" && d.talibParams?.timeperiod != null && Number.isFinite(d.talibParams.timeperiod))
    return Math.round(Number(d.talibParams.timeperiod));
  if (d.period != null && Number.isFinite(d.period)) return Math.round(Number(d.period));
  return 0;
}

/** EMA 9/21 long-only — igual a ``ema_cross_long_only_vbt``. */
export function buildEmaCrossLongOnlyFromBars(
  bars: OhlcBarLike[],
  defs: ChartIndicatorDef[],
  bundles: Map<string, IndicatorSeriesBundle>,
): BacktestChartLayer | null {
  const emas = defs
    .filter((d) => d.kind === "talib" && (d.talibFunction ?? "").trim().toUpperCase() === "EMA")
    .sort((a, b) => effTp(a) - effTp(b));

  const scalar = (id: string | undefined) => (id ? bundles.get(id)?.scalar : undefined);
  let ef = scalar(defs.find((d) => d.id === "ema_fast")?.id);
  let es = scalar(defs.find((d) => d.id === "ema_slow")?.id);
  if (!ef?.length || !es?.length) {
    if (emas.length >= 2) {
      ef = scalar(emas[0]!.id);
      es = scalar(emas[emas.length - 1]!.id);
    }
  }
  if (
    !ef?.length ||
    !es?.length ||
    ef.length !== bars.length ||
    es.length !== bars.length
  )
    return null;

  const slowTp = Math.max(...emas.map((e) => effTp(e) || 1), 1);
  if (bars.length < slowTp + 2) return null;

  const n = bars.length;
  const sig = emptyQuadSignals(n);

  for (let i = 0; i < n; i++) {
    const pf = i > 0 ? ef[i - 1]! : ef[i]!;
    const ps = i > 0 ? es[i - 1]! : es[i]!;
    const ok = [ef[i], es[i], pf, ps].every((x) => typeof x === "number" && Number.isFinite(x));
    sig.longEntry[i] = ok && ef[i]! > es[i]! && pf <= ps;
    sig.longExit[i] = ok && ef[i]! < es[i]! && pf >= ps;
  }

  return runQuadSignalSimulation(bars, sig);
}

/** RSI 30/55 · 70/45 — ``rsi_level_flip_vbt``. */
export function buildRsiLevelFlipFromBars(
  bars: OhlcBarLike[],
  defs: ChartIndicatorDef[],
  bundles: Map<string, IndicatorSeriesBundle>,
): BacktestChartLayer | null {
  const rsiDef = defs.find(
    (d) => d.kind === "talib" && (d.talibFunction ?? "").trim().toUpperCase() === "RSI",
  );
  const rsi = rsiDef?.id ? bundles.get(rsiDef.id)?.scalar : undefined;

  const period = rsiDef?.kind === "talib" ? rsiDef.talibParams?.timeperiod ?? 14 : 14;

  const LONG_ENTRY = 30;
  const LONG_EXIT = 55;
  const SHORT_ENTRY = 70;
  const SHORT_EXIT = 45;

  if (
    bars.length < Math.max(2, Math.round(period)) + 2 ||
    !rsi?.length ||
    rsi.length !== bars.length
  )
    return null;

  const n = bars.length;
  const sig = emptyQuadSignals(n);
  const skipBar = new Array<boolean>(n).fill(false);

  for (let i = 0; i < n; i++) {
    const r = rsi[i];
    const rp = i > 0 ? rsi[i - 1] : undefined;
    if (typeof r !== "number" || !Number.isFinite(r) || typeof rp !== "number" || !Number.isFinite(rp)) {
      skipBar[i] = true;
      continue;
    }
    sig.longEntry[i] = r < LONG_ENTRY && rp >= LONG_ENTRY;
    sig.longExit[i] = r > LONG_EXIT && rp <= LONG_EXIT;
    sig.shortEntry[i] = r > SHORT_ENTRY && rp <= SHORT_ENTRY;
    sig.shortExit[i] = r < SHORT_EXIT && rp >= SHORT_EXIT;
  }

  return runQuadSignalSimulation(bars, sig, skipBar);
}

/** BBANDS reverso à média — ``bollinger_mean_revert_vbt``. */
export function buildBollingerMeanRevertFromBars(
  bars: OhlcBarLike[],
  defs: ChartIndicatorDef[],
  bundles: Map<string, IndicatorSeriesBundle>,
): BacktestChartLayer | null {
  const bb = defs.find(
    (d) => d.kind === "talib" && (d.talibFunction ?? "").trim().toUpperCase() === "BBANDS",
  );
  const bun = bb?.id ? bundles.get(bb.id) : undefined;
  const mid = bun?.mid;
  const upper = bun?.upper;
  const lower = bun?.lower;
  const period = bb?.kind === "talib" ? bb.talibParams?.timeperiod ?? 20 : 20;

  if (
    !mid?.length ||
    !upper?.length ||
    !lower?.length ||
    mid.length !== bars.length ||
    bars.length < Math.max(2, Math.round(period)) + 2
  )
    return null;

  const n = bars.length;
  const sig = emptyQuadSignals(n);

  for (let i = 0; i < n; i++) {
    const cl = bars[i]!.c;
    const pc = i > 0 ? bars[i - 1]!.c : cl;
    const m = mid[i]!;
    const u = upper[i]!;
    const l = lower[i]!;
    const pm = i > 0 ? mid[i - 1]! : m;
    const pu = i > 0 ? upper[i - 1]! : u;
    const pl = i > 0 ? lower[i - 1]! : l;
    const ok = [cl, m, u, l, pc, pm, pu, pl].every((x) => Number.isFinite(x));
    sig.longEntry[i] = ok && cl <= l && pc > pl;
    sig.longExit[i] = ok && cl >= m && pc < pm;
    sig.shortEntry[i] = ok && cl >= u && pc < pu;
    sig.shortExit[i] = ok && cl <= m && pc > pm;
  }

  return runQuadSignalSimulation(bars, sig);
}

/** Lateral RSI — ``lateral_market_rsi_vbt``. */
export function buildLateralMarketRsiFromBars(
  bars: OhlcBarLike[],
  defs: ChartIndicatorDef[],
  bundles: Map<string, IndicatorSeriesBundle>,
): BacktestChartLayer | null {
  const rsiDef = defs.find(
    (d) => d.kind === "talib" && (d.talibFunction ?? "").trim().toUpperCase() === "RSI",
  );
  const length = rsiDef?.kind === "talib" ? rsiDef.talibParams?.timeperiod ?? 9 : 9;

  const rsi = rsiDef?.id ? bundles.get(rsiDef.id)?.scalar : undefined;

  if (
    bars.length < Math.max(2, Math.round(length ?? 9)) + 2 ||
    !rsi?.length ||
    rsi.length !== bars.length
  )
    return null;

  const n = bars.length;
  const sig = emptyQuadSignals(n);

  for (let i = 0; i < n; i++) {
    let r = rsi[i];
    let rp = i > 0 ? rsi[i - 1] : undefined;
    if (typeof r !== "number" || !Number.isFinite(r)) r = 50;
    if (typeof rp !== "number" || !Number.isFinite(rp)) rp = 50;
    sig.longEntry[i] = r < LATERAL_RSI_OVER_SOLD && rp >= LATERAL_RSI_OVER_SOLD;
    sig.shortEntry[i] = r > LATERAL_RSI_OVER_BOUGHT && rp <= LATERAL_RSI_OVER_BOUGHT;
    sig.longExit[i] = r > 50 && rp <= 50;
    sig.shortExit[i] = r < 50 && rp >= 50;
  }

  return runQuadSignalSimulation(bars, sig);
}

/** ``trend_composite_gate_vbt`` — bundles devem incluir série do indicador ``kind: trend_composite``. */
export function buildTrendCompositeGateFromBars(
  bars: OhlcBarLike[],
  defs: ChartIndicatorDef[],
  bundles: Map<string, IndicatorSeriesBundle>,
): BacktestChartLayer | null {
  const tcDef = defs.find((d) => d.kind === "trend_composite");
  const sc = tcDef?.id ? bundles.get(tcDef.id)?.scalar : undefined;
  if (!sc?.length || sc.length !== bars.length || bars.length < 3) return null;

  const LONG_TH = 25;
  const SHORT_TH = -25;
  const n = bars.length;
  const sig = emptyQuadSignals(n);
  for (let i = 0; i < n; i++) {
    const s = sc[i];
    const sp = i > 0 ? sc[i - 1]! : s;
    if (typeof s !== "number" || !Number.isFinite(s) || typeof sp !== "number" || !Number.isFinite(sp)) {
      continue;
    }
    sig.longEntry[i] = s > LONG_TH && sp <= LONG_TH;
    sig.shortEntry[i] = s < SHORT_TH && sp >= SHORT_TH;
    sig.longExit[i] = s < 0 && sp >= 0;
    sig.shortExit[i] = s > 0 && sp <= 0;
  }
  return runQuadSignalSimulation(bars, sig);
}

export function runJsStrategyByStem(
  stem: string,
  bars: OhlcBarLike[],
  defs: ChartIndicatorDef[],
  bundles: Map<string, IndicatorSeriesBundle>,
): BacktestChartLayer | null {
  switch (stem) {
    case "minimal_rsi_stairs": {
      const params = minimalStairsParamsFromDefs(defs);
      const rsiTalib = defs.find(
        (d) => d.kind === "talib" && (d.talibFunction ?? "").trim().toUpperCase() === "RSI",
      );
      const rsiArr = rsiTalib?.id ? bundles.get(rsiTalib.id)?.scalar ?? null : null;
      return buildMinimalRsiStairsFromBars(bars, params, rsiArr);
    }
    case "ema_cross_long_only":
      return buildEmaCrossLongOnlyFromBars(bars, defs, bundles);
    case "rsi_level_flip":
      return buildRsiLevelFlipFromBars(bars, defs, bundles);
    case "bollinger_mean_revert":
      return buildBollingerMeanRevertFromBars(bars, defs, bundles);
    case "lateral_market_rsi":
      return buildLateralMarketRsiFromBars(bars, defs, bundles);
    case "trend_composite_gate":
      return buildTrendCompositeGateFromBars(bars, defs, bundles);
    default:
      return null;
  }
}
