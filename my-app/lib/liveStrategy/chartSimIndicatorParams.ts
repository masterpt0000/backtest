import type { CandleApiBar, ChartIndicatorDef } from "@/components/OhlcvChart";
import {
  flattenedParityArraysFromBundles,
  type ChartTaHudState,
} from "@/lib/chartTaBundles";
import type { MinimalRsiStairsSimParams } from "@/lib/liveStrategy/minimalRsiStairs";

/** Normaliza stem vectorbt (sem sufixo ``_vbt``). */
export function normalizeVbtStem(spec: string): string {
  let t = spec.trim();
  if (t.includes(".")) {
    const last = t.split(".").pop() ?? t;
    t = last;
  }
  return t.replace(/_vbt$/i, "").toLowerCase();
}

function talibNamed(defs: ChartIndicatorDef[], name: string): ChartIndicatorDef | undefined {
  return defs.find(
    (d) => d.kind === "talib" && (d.talibFunction ?? "").trim().toUpperCase() === name,
  );
}

/** Período RSI a partir de uma definição TA-Lib RSI (ou campo ``period`` legacy). */
function rsiPeriodFromChartDef(d: ChartIndicatorDef): number | undefined {
  const fn = (d.talibFunction ?? "").trim().toUpperCase();
  if (d.kind !== "talib" || fn !== "RSI") return undefined;
  const tpRaw = d.talibParams?.timeperiod ?? d.period;
  if (tpRaw == null || !Number.isFinite(Number(tpRaw))) return undefined;
  return Math.max(2, Math.min(500, Math.round(Number(tpRaw))));
}

function numFromParams(pr: Record<string, number> | undefined, k: string): number | undefined {
  if (!pr) return undefined;
  const v = pr[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Alinha ``ChartIndicatorDef.trendComposite`` às chaves ``tc_*`` do ``get_strategy_parameters`` desta estratégia. */
export function trendCompositeGateParamsFromDefs(defs: ChartIndicatorDef[]): Record<string, number> {
  const d = defs.find((x) => x.kind === "trend_composite");
  const tc = d?.trendComposite;
  if (!tc) return {};
  const out: Record<string, number> = {
    tc_norm_window: tc.normWindow,
    tc_clip: tc.clip,
    tc_output_scale: tc.outputScale,
  };
  const weightKeyByCid: Record<string, string> = {
    dir: "tc_w_dir",
    macd: "tc_w_macd",
    rsi: "tc_w_rsi",
    dmi: "tc_w_dmi",
  };
  for (const comp of tc.components ?? []) {
    const wk = weightKeyByCid[comp.cid];
    if (wk != null && typeof comp.weight === "number" && Number.isFinite(comp.weight)) {
      out[wk] = comp.weight;
    }
    const pr = comp.params;
    if (!pr) continue;
    if (comp.preset === "price_vs_sma_atr") {
      const sp = numFromParams(pr, "sma_period");
      const ap = numFromParams(pr, "atr_period");
      if (sp != null) out.tc_sma_period = sp;
      if (ap != null) out.tc_atr_period = ap;
    } else if (comp.preset === "macd_hist_zscore") {
      const f = numFromParams(pr, "fast");
      const s = numFromParams(pr, "slow");
      const g = numFromParams(pr, "signal");
      if (f != null) out.tc_macd_fast = f;
      if (s != null) out.tc_macd_slow = s;
      if (g != null) out.tc_macd_signal = g;
    } else if (comp.preset === "rsi_zscore") {
      const r = numFromParams(pr, "rsi_period");
      if (r != null) out.tc_rsi_period = r;
    } else if (comp.preset === "plus_di_minus_di") {
      const p = numFromParams(pr, "period");
      if (p != null) out.tc_adx_period = p;
    }
  }
  return out;
}

/**
 * Mapeia sliders do gráfico para chaves ``get_strategy_parameters`` / ``compute_indicators``.
 */
export function vbtIndicatorParamsFromDefs(
  vbtStrategy: string,
  defs: ChartIndicatorDef[],
): Record<string, number> {
  const stem = normalizeVbtStem(vbtStrategy);

  if (stem === "dual_rsi_regime") {
    const slow = defs.find((d) => d.id === "rsi_slow");
    const fast = defs.find((d) => d.id === "rsi_fast");
    const out: Record<string, number> = {};
    const sp = slow ? rsiPeriodFromChartDef(slow) : undefined;
    const fp = fast ? rsiPeriodFromChartDef(fast) : undefined;
    if (sp != null) out.rsi_slow_length = sp;
    if (fp != null) out.rsi_fast_length = fp;
    return out;
  }

  if (stem === "trend_composite_gate") {
    return trendCompositeGateParamsFromDefs(defs);
  }

  const rsi = talibNamed(defs, "RSI");
  const tpRaw = rsi?.talibParams?.timeperiod ?? rsi?.period;
  if (tpRaw == null || !Number.isFinite(Number(tpRaw))) return {};
  const period = Math.max(2, Math.min(200, Math.round(Number(tpRaw))));
  if (stem === "minimal_rsi_stairs") return { rsi_period: period };
  if (stem === "lateral_market_rsi") return { rsi_close_length: period };
  return {};
}

export function minimalStairsParamsFromDefs(defs: ChartIndicatorDef[]): MinimalRsiStairsSimParams {
  const rsi = talibNamed(defs, "RSI");
  const tpRaw = rsi?.talibParams?.timeperiod ?? rsi?.period ?? 14;
  return {
    rsiPeriod: Math.max(2, Math.min(200, Math.round(Number(tpRaw)))),
    source: rsi?.source ?? "close",
    longCross: 40,
    shortCross: 60,
    exitMid: 50,
  };
}

/** Paridade: séries já alinhadas às velas vindas do ``/api/chart/ta-series``. */
export function extractTalibArraysForParity(
  bars: CandleApiBar[],
  defs: ChartIndicatorDef[],
  ta: ChartTaHudState | null,
): Record<string, (number | null)[]> | null {
  return flattenedParityArraysFromBundles(bars, defs, ta);
}

export type IndicatorDiffRow = {
  key: string;
  comparedBars: number;
  mae: number;
  maxAbsDelta: number;
  pctBad: number;
  firstBadTime: number | null;
};

export function compareAlignedIndicatorSeries(
  left: Record<string, (number | null)[]>,
  vbt: Record<string, (number | null)[]>,
  barTimes: number[],
  eps: number,
): IndicatorDiffRow[] {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(vbt)])].filter(
    (k) =>
      Object.prototype.hasOwnProperty.call(left, k) &&
      Object.prototype.hasOwnProperty.call(vbt, k),
  );
  const rows: IndicatorDiffRow[] = [];
  for (const key of keys) {
    const a = left[key]!;
    const b = vbt[key]!;
    const m = Math.min(a.length, b.length, barTimes.length);
    let sum = 0;
    let cnt = 0;
    let maxD = 0;
    let bad = 0;
    let firstT: number | null = null;
    for (let i = 0; i < m; i++) {
      const x = a[i];
      const y = b[i];
      if (x == null || y == null) continue;
      const d = Math.abs(x - y);
      cnt++;
      sum += d;
      if (d > maxD) maxD = d;
      if (d > eps) {
        bad++;
        if (firstT == null) firstT = barTimes[i] ?? null;
      }
    }
    rows.push({
      key,
      comparedBars: cnt,
      mae: cnt ? sum / cnt : 0,
      maxAbsDelta: maxD,
      pctBad: cnt ? (100 * bad) / cnt : 0,
      firstBadTime: firstT,
    });
  }
  return rows.sort((x, y) => x.key.localeCompare(y.key));
}
