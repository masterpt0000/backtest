import type { UTCTimestamp } from "lightweight-charts";

import type { CandleApiBar, ChartIndicatorDef } from "@/components/OhlcvChart";

/** Alinhar com ``TA_EVAL_REVISION`` no FastAPI; aumentar quando mudar semântica das fórmulas TA (invalida LRU no browser). */
export const TA_SERIES_EVAL_REVISION = 5;

export type TaIndicatorPayload =
  | {
      id: string;
      kind: "sma";
      period: number;
      source: string;
      timeframe?: string;
      deltaLookbackBars?: number;
      deltaNormalizeByPrice?: boolean;
    }
  | {
      id: string;
      kind: "atr";
      period: number;
      timeframe?: string;
      deltaLookbackBars?: number;
      deltaNormalizeByPrice?: boolean;
    }
  | {
      id: string;
      kind: "macd";
      fast: number;
      slow: number;
      signal: number;
      source: string;
      timeframe?: string;
      deltaLookbackBars?: number;
      deltaNormalizeByPrice?: boolean;
    }
  | {
      id: string;
      kind: "talib";
      function: string;
      params: Record<string, number>;
      /** OHLC/composto aplicado onde a TA-Lib usa o input ``real`` (ex. fecho da série no gráfico). */
      source: string;
      timeframe?: string;
      deltaLookbackBars?: number;
      deltaNormalizeByPrice?: boolean;
    }
  | {
      id: string;
      kind: "derived";
      mode: "chain" | "formula";
      inputRef?: string;
      transform?: string;
      params: Record<string, number>;
      formula?: string;
      timeframe?: string;
      deltaLookbackBars?: number;
      deltaNormalizeByPrice?: boolean;
    }
  | {
      id: string;
      kind: "trend_composite";
      normWindow: number;
      clip: number;
      outputScale: number;
      components: Array<{
        cid: string;
        weight: number;
        preset: string;
        params: Record<string, number>;
      }>;
      timeframe?: string;
      deltaLookbackBars?: number;
      deltaNormalizeByPrice?: boolean;
    };

/**
 * @param vis omitir ou usar `{}` para calcular todas as séries (recomendado para simulação/backends);
 *   `vis[id] === false` exclui esse id do POST (economia só quando não precisas dos dados para nada mais).
 */
export function buildTaSeriesRequestBody(
  bars: CandleApiBar[],
  defs: ChartIndicatorDef[],
  vis: Record<string, boolean>,
  inputSeries?: Record<string, number[]> | null,
): { bars: CandleApiBar[]; indicators: TaIndicatorPayload[]; input_series?: Record<string, (number | null)[]> } {
  const indicators: TaIndicatorPayload[] = [];

  const deltaOpts = (d: ChartIndicatorDef): { deltaLookbackBars?: number; deltaNormalizeByPrice?: boolean } => {
    const lb = d.deltaLookbackBars;
    if (lb == null || !Number.isFinite(Number(lb)) || Number(lb) < 1) return {};
    const deltaLookbackBars = Math.max(1, Math.min(500, Math.round(Number(lb))));
    if (d.deltaNormalizeByPrice === false) return { deltaLookbackBars, deltaNormalizeByPrice: false };
    return { deltaLookbackBars };
  };

  for (const d of defs) {
    if (vis[d.id] === false) continue;
    if (d.kind === "sma") {
      indicators.push({
        id: d.id,
        kind: "sma",
        period: Math.max(1, Math.min(500, Math.round(d.period ?? 20))),
        source: d.source ?? "close",
        ...(d.timeframe && d.timeframe !== "chart" ? { timeframe: d.timeframe } : {}),
        ...deltaOpts(d),
      });
    } else if (d.kind === "atr") {
      indicators.push({
        id: d.id,
        kind: "atr",
        period: Math.max(1, Math.min(500, Math.round(d.period ?? 14))),
        ...(d.timeframe && d.timeframe !== "chart" ? { timeframe: d.timeframe } : {}),
        ...deltaOpts(d),
      });
    } else if (d.kind === "macd") {
      indicators.push({
        id: d.id,
        kind: "macd",
        fast: Math.max(1, Math.min(200, Math.round(d.fast ?? 12))),
        slow: Math.max(1, Math.min(500, Math.round(d.slow ?? 26))),
        signal: Math.max(1, Math.min(200, Math.round(d.signal ?? 9))),
        source: d.source ?? "close",
        ...(d.timeframe && d.timeframe !== "chart" ? { timeframe: d.timeframe } : {}),
        ...deltaOpts(d),
      });
    } else if (d.kind === "talib" && d.talibFunction?.trim()) {
      indicators.push({
        id: d.id,
        kind: "talib",
        function: d.talibFunction.trim(),
        params: { ...(d.talibParams ?? {}) },
        source: d.source ?? "close",
        ...(d.timeframe && d.timeframe !== "chart" ? { timeframe: d.timeframe } : {}),
        ...deltaOpts(d),
      });
    } else if (d.kind === "derived" && d.derived) {
      indicators.push({
        id: d.id,
        kind: "derived",
        mode: d.derived.mode,
        ...(d.derived.inputRef ? { inputRef: d.derived.inputRef } : {}),
        ...(d.derived.transform ? { transform: d.derived.transform } : {}),
        params: { ...(d.derived.params ?? {}) },
        ...(d.derived.formula ? { formula: d.derived.formula } : {}),
        ...(d.timeframe && d.timeframe !== "chart" ? { timeframe: d.timeframe } : {}),
        ...deltaOpts(d),
      });
    } else if (d.kind === "trend_composite" && d.trendComposite) {
      const tc = d.trendComposite;
      indicators.push({
        id: d.id,
        kind: "trend_composite",
        normWindow: Math.max(5, Math.min(500, Math.round(tc.normWindow ?? 60))),
        clip: Math.min(12, Math.max(0.25, Number(tc.clip ?? 2))),
        outputScale: Math.min(500, Math.max(1, Number(tc.outputScale ?? 100))),
        components: tc.components.map((c) => ({
          cid: String(c.cid || "c"),
          weight: Math.min(100, Math.max(0, Number(c.weight))),
          preset: String(c.preset),
          params: { ...(c.params ?? {}) },
        })),
        ...(d.timeframe && d.timeframe !== "chart" ? { timeframe: d.timeframe } : {}),
        ...deltaOpts(d),
      });
    }
  }
  const input_series: Record<string, (number | null)[]> = {};
  if (inputSeries) {
    for (const [k, vals] of Object.entries(inputSeries)) {
      input_series[k] = vals.slice(0, bars.length).map((x) => (Number.isFinite(x) ? Number(x) : null));
    }
  }
  return Object.keys(input_series).length ? { bars, indicators, input_series } : { bars, indicators };
}

export type TaPoint = { t: number; v: number };

export type TaMacdBundleApi = {
  macd: TaPoint[];
  signal: TaPoint[];
  histogram: TaPoint[];
};

export type TaSeriesResponse = {
  compute_ms: number;
  series: Record<string, TaPoint[] | TaMacdBundleApi | Record<string, TaPoint[]>>;
};

function isTaPoint(x: unknown): x is TaPoint {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.t === "number" && typeof o.v === "number" && Number.isFinite(o.t) && Number.isFinite(o.v);
}

function isMacdBundle(x: unknown): x is TaMacdBundleApi {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  const m = o.macd;
  const s = o.signal;
  const h = o.histogram;
  return Array.isArray(m) && Array.isArray(s) && Array.isArray(h);
}

/** Várias linhas nomeadas (saída TA-Lib multi-output), excluindo o formato MACD do servidor pandas. */
export function isNamedTalibOutputs(x: unknown): x is Record<string, TaPoint[]> {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length < 2) return false;
  if ("macd" in o && "signal" in o && "histogram" in o) return false;
  for (const v of Object.values(o)) {
    if (!Array.isArray(v)) return false;
    if (v.length > 0 && !isTaPoint(v[0])) return false;
  }
  return true;
}

/** Mapeia nomes típicos TA-Lib MACD → formato do gráfico. */
export function tryTalibOutputsToMacdBundle(named: Record<string, TaPoint[]>): TaMacdBundleApi | null {
  const lower: Record<string, TaPoint[]> = {};
  for (const [k, v] of Object.entries(named)) {
    lower[k.toLowerCase()] = v;
  }
  const macd = lower["macd"] ?? lower["macdline"];
  const signal = lower["macdsignal"] ?? lower["signal"];
  const histogram = lower["macdhist"] ?? lower["histogram"] ?? lower["hist"];
  if (macd?.length && signal?.length && histogram?.length) {
    return { macd, signal, histogram };
  }
  return null;
}

export function parseTaSeriesResponse(raw: unknown): TaSeriesResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const cms = o.compute_ms;
  const ser = o.series;
  if (typeof cms !== "number" || !Number.isFinite(cms)) return null;
  if (!ser || typeof ser !== "object") return null;
  const series: Record<string, TaPoint[] | TaMacdBundleApi | Record<string, TaPoint[]>> = {};
  for (const [k, v] of Object.entries(ser as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      const pts = v.filter(isTaPoint);
      series[k] = pts;
    } else if (isMacdBundle(v)) {
      series[k] = {
        macd: v.macd.filter(isTaPoint),
        signal: v.signal.filter(isTaPoint),
        histogram: v.histogram.filter(isTaPoint),
      };
    } else if (isNamedTalibOutputs(v)) {
      const cleaned: Record<string, TaPoint[]> = {};
      for (const [nk, nv] of Object.entries(v)) {
        cleaned[nk] = (nv as unknown[]).filter(isTaPoint);
      }
      series[k] = cleaned;
    }
  }
  return { compute_ms: cms, series };
}

export function taPointsToLineData(pts: TaPoint[]): { time: UTCTimestamp; value: number }[] {
  return pts.map((p) => ({ time: p.t as UTCTimestamp, value: p.v }));
}

export function taHistToHistogramData(
  pts: TaPoint[],
): { time: UTCTimestamp; value: number; color: string }[] {
  return pts.map((p) => ({
    time: p.t as UTCTimestamp,
    value: p.v,
    color: p.v >= 0 ? "rgba(74, 222, 128, 0.85)" : "rgba(248, 113, 113, 0.85)",
  }));
}
