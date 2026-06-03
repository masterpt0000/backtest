"use client";

import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  ColorType,
  CrosshairMode,
} from "lightweight-charts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { LiveSnapshot } from "@/components/LiveMarketPanel";
import {
  denseValuesByBarIndex,
  deltaHistogramColor,
  effectiveDeltaLookbackBars,
  effectiveDeltaNormalizeByPrice,
  fmtIndicatorDeltaHud,
  forwardFillSparseLineToBars,
  indicatorDeltaHudSuffix,
  indicatorDeltaValueAtBarIndex,
  maybeApplyIndicatorDeltaSeries,
} from "@/lib/indicatorDeltaTransform";
import { bucketHeatColor, tapeBuyRatioBuckets } from "@/lib/liveTapeHeat";
import {
  LiquidationMicroCandlesPrimitive,
  type LiquidationMicroCandle,
} from "@/lib/liquidationMicroCandlesPrimitive";
import { StrategyShadingBandsPrimitive } from "@/lib/strategyShadingBandsPrimitive";
import { VolumeFootprintPrimitive } from "@/lib/volumeFootprintPrimitive";
import type { BacktestChartLayer } from "@/lib/backtestChartLayer";
import { CHART_FACT_SERIES, formatFeatHudValue } from "@/lib/chartFactSeriesCatalog";
import type { IndicatorSource, IndicatorTimeframe, TrendCompositeParams } from "@/lib/strategies";
import type { FootprintBar } from "@/lib/chartFootprintApi";

export type CandleApiBar = { t: number; o: number; h: number; l: number; c: number; v: number };

/** Um ``t`` por barra, ordenado — exigido pelo lightweight-charts. */
function barsSortedUniqueByTime(bars: CandleApiBar[]): CandleApiBar[] {
  const m = new Map<number, CandleApiBar>();
  for (const b of bars) {
    const t = Math.trunc(Number(b.t));
    if (!Number.isFinite(t)) continue;
    m.set(t, { ...b, t });
  }
  return [...m.keys()]
    .sort((a, b) => a - b)
    .map((k) => m.get(k)!);
}

/**
 * lightweight-charts exige ``time`` estritamente crescente (sem duplicados).
 * Agrupa por segundo UNIX truncado; mantém o **último** ponto por tempo.
 */
function chartTimeSeriesSortedUniqueByTime<T extends { time: UTCTimestamp; value: number }>(
  pts: readonly T[],
): T[] {
  if (!pts.length) return [];
  const byTime = new Map<number, T>();
  for (const p of pts) {
    const t = Math.trunc(Number(p.time));
    if (!Number.isFinite(t)) continue;
    byTime.set(t, { ...p, time: t as UTCTimestamp });
  }
  return [...byTime.keys()].sort((a, b) => a - b).map((k) => byTime.get(k)!);
}

function barsDataFingerprint(bars: CandleApiBar[]): string {
  let h = 2166136261;
  for (const b of bars) {
    for (const x of [b.t, b.o, b.h, b.l, b.c, b.v]) {
      h ^= Math.trunc(Number(x) * 1_000_000);
      h = Math.imul(h, 16777619);
    }
  }
  return `${bars.length}:${bars[0]?.t ?? 0}:${bars[bars.length - 1]?.t ?? 0}:${h >>> 0}`;
}

export type ChartIndicatorDef = {
  id: string;
  kind: "sma" | "atr" | "macd" | "talib" | "derived" | "trend_composite";
  /** Da estratégia: overlay vs estudo (ex. RSI TA-Lib estudos num painel partilhado). */
  group?: "overlays" | "studies";
  /** Rótulo na UI (ex. cabeçalho do painel RSI). */
  label?: string;
  period?: number;
  mult?: number;
  fast?: number;
  slow?: number;
  signal?: number;
  /** TA-Lib: nome da função (ex. ``RSI``). */
  talibFunction?: string;
  /** Parâmetros opcionais passados ao TA-Lib (ex. ``timeperiod``). */
  talibParams?: Record<string, number>;
  /** Campo OHLC (ou composto) usado no cálculo. */
  source?: IndicatorSource;
  /** Timeframe usado no cálculo; "chart" = timeframe actual do gráfico. */
  timeframe?: IndicatorTimeframe;
  /** Indicador composto criado pelo user. */
  derived?: {
    mode: "chain" | "formula";
    inputRef?: string;
    transform?: "ema" | "sma" | "rsi" | "delta" | "roc" | "abs" | "normalize";
    params?: Record<string, number>;
    formula?: string;
  };
  /** Bloco servidor-only; série única no painel de estudos. */
  trendComposite?: TrendCompositeParams;
  /** Cor principal / palette base. */
  color?: string;
  /** TA-Lib multi-saída (ex. BBANDS): bandas. */
  colorUpper?: string;
  colorMid?: string;
  colorLower?: string;
  /** Espessura da linha (1–4). */
  lineWidth?: 1 | 2 | 3 | 4;
  /** Diferença em N barras (valor − há N barras); 0 / omissão = série sem Δ. */
  deltaLookbackBars?: number;
  /** Se não for ``false``, o Δ divide-se pelo fecho na vela (escala versus preço). */
  deltaNormalizeByPrice?: boolean;
};

/** Quando o índice lógico esquerdo fica abaixo disto, pede velas mais antigas. */
const LOAD_MORE_WHEN_FROM = 80;

/** Ignora pedidos automáticos de histórico logo após reposicionar o timeScale (evita rajadas). */
const AUTO_OLDER_SUPPRESS_MS = 1200;

/**
 * Troca de par/TF: em vez de ``fitContent()`` em todo o dataset (índice esquerdo ~0 → pedidos encadeados),
 * focamos as últimas barras — mais velas «visíveis» e menos triggers espúrios.
 */
const FIRST_VIEW_VISIBLE_LOGICAL_BARS = 1600;

/** Com menos barras que isto, ``fitContent()`` continua a fazer sentido. */
const FIRST_VIEW_FULL_FIT_MAX_BARS = 140;

const EMPTY_DEFS: ChartIndicatorDef[] = [];
const EMPTY_VIS: Record<string, boolean> = {};

/** Altura mínima do canvas (velas+RSI no mesmo chart); abaixo disto o layout ainda funciona mas fica apertado. */
const CHART_VIEWPORT_MIN_PX = 120;

/** Altura inicial e fallback quando o flex ainda não deu altura ao contentor (evita ficar preso a 400px). */
function defaultMainChartHeightPx(): number {
  if (typeof window === "undefined") return 640;
  return Math.max(400, Math.floor(window.innerHeight - 180));
}

/** Cabeçalho acima do canvas (legenda RSI) — o RSI desenha-se no 2.º painel do mesmo gráfico. */
const RSI_STUDY_HEADER_PX = 22;

/** Espaço reservado fora do canvas quando há RSI (só legenda; eixo X é único no chart). */
const RSI_CHROME_ABOVE_CHART_PX = RSI_STUDY_HEADER_PX + 6;

/**
 * Eixo temporal único (painel de velas + RSI no mesmo ``createChart``).
 * `fixRightEdge` evita pan para além da última vela sem dados.
 */
const LINKED_TIME_SCALE = {
  fixRightEdge: true,
  rightOffset: 4,
} as const;

/** Fundo do canvas (principal + RSI) — mais escuro que zinc-950. */
const CHART_BG = "#050506";
const CHART_GRID = "#1a1a1f";
const CHART_BORDER = "#25252b";

const CHART_INTERACTION = {
  /** Sem zoom com a roda (deixa a página fazer scroll; pinch no trackpad ainda pode escalar). */
  handleScale: { mouseWheel: true as const },
  handleScroll: { mouseWheel: true as const },
} as const;

/** Margens da escala de preço do gráfico principal (velas) — alinhar com createChart e com o reset. */
const MAIN_PRICE_SCALE_MARGINS = { top: 0.04, bottom: 0.14 } as const;
/** Histograma de volume no fundo do painel principal (alinhado com bottom da escala de preço). */
const VOL_SCALE_MARGINS = { top: 0.86, bottom: 0 } as const;
const RSI_PRICE_SCALE_MARGINS = { top: 0.12, bottom: 0.12 } as const;

function IconFitTime({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"
      />
    </svg>
  );
}

function IconFitPrice({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"
      />
    </svg>
  );
}

type CrosshairHud = {
  dateStr: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  changePct: number;
  lines: { key: string; label: string; value: string; color?: string }[];
};

function fmtPx(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1000) return x.toFixed(2);
  if (a >= 100) return x.toFixed(2);
  if (a >= 10) return x.toFixed(3);
  if (a >= 1) return x.toFixed(4);
  if (a >= 0.1) return x.toFixed(7);
  if (a >= 0.01) return x.toFixed(8);
  return x.toFixed(8);
}

/** ``precision`` / ``minMove`` para o eixo OHLC — mais casas em activos sub-dollar. */
function mainChartPriceFormatFromBars(bars: CandleApiBar[]): {
  type: "price";
  precision: number;
  minMove: number;
} {
  if (!bars.length) return { type: "price", precision: 2, minMove: 0.01 };
  const tail = bars.length > 500 ? bars.slice(-500) : bars;
  const closes = tail
    .map((b) => Math.abs(Number(b.c)))
    .filter((x) => Number.isFinite(x) && x > 0);
  if (!closes.length) return { type: "price", precision: 2, minMove: 0.01 };
  const sorted = [...closes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? sorted[0]!;

  if (median >= 1000) return { type: "price", precision: 2, minMove: 0.01 };
  if (median >= 100) return { type: "price", precision: 2, minMove: 0.01 };
  if (median >= 10) return { type: "price", precision: 3, minMove: 0.001 };
  if (median >= 1) return { type: "price", precision: 4, minMove: 0.0001 };
  if (median >= 0.1) return { type: "price", precision: 7, minMove: 1e-7 };
  if (median >= 0.01) return { type: "price", precision: 8, minMove: 1e-8 };
  return { type: "price", precision: 8, minMove: 1e-8 };
}

/** ``precision`` / ``minMove`` para linhas/histogramas em painéis de estudo (RSI, derivados, Δ, MACD). */
function studyPriceFormatFromNumericSamples(samples: readonly number[]): {
  type: "price";
  precision: number;
  minMove: number;
} {
  const vals = samples.map((x) => Math.abs(Number(x))).filter((x) => Number.isFinite(x));
  if (!vals.length) return { type: "price", precision: 6, minMove: 1e-6 };
  const maxV = Math.max(...vals);
  const positives = vals.filter((x) => x > 0);
  const minPos = positives.length ? Math.min(...positives) : maxV;
  const ref = maxV > 0 ? Math.max(maxV, minPos) : minPos;
  if (!Number.isFinite(ref) || ref === 0)
    return { type: "price", precision: 8, minMove: 1e-8 };

  if (ref >= 100) return { type: "price", precision: 2, minMove: 0.01 };
  if (ref >= 10) return { type: "price", precision: 3, minMove: 0.001 };
  if (ref >= 1) return { type: "price", precision: 4, minMove: 0.0001 };
  if (ref >= 0.1) return { type: "price", precision: 5, minMove: 1e-5 };
  if (ref >= 0.01) return { type: "price", precision: 6, minMove: 1e-6 };
  if (ref >= 1e-3) return { type: "price", precision: 7, minMove: 1e-7 };
  return { type: "price", precision: 8, minMove: 1e-8 };
}

function applyStudyPriceFormatFromValues(
  ser: {
    applyOptions: (o: {
      priceFormat?: { type: "price"; precision: number; minMove: number };
    }) => void;
  },
  values: readonly number[],
): void {
  if (!values.length) return;
  try {
    ser.applyOptions({ priceFormat: studyPriceFormatFromNumericSamples(values) });
  } catch {
    /* série ou gráfico já descartados */
  }
}

function fmtVolCompact(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

function crosshairTimeToUnix(t: unknown): number | null {
  if (typeof t === "number" && Number.isFinite(t)) return t;
  return null;
}

function lineValueAtOrBeforeBarT(
  pts: { time: UTCTimestamp; value: number }[],
  barT: UTCTimestamp,
): number | undefined {
  if (pts.length === 0) return undefined;
  let best: number | undefined;
  for (const p of pts) {
    if (Number(p.time) <= Number(barT)) best = p.value;
    else break;
  }
  return best;
}

type TaServerHud = {
  lines: Record<string, { time: UTCTimestamp; value: number }[]>;
  macd: Record<
    string,
    {
      macd: { time: UTCTimestamp; value: number }[];
      signal: { time: UTCTimestamp; value: number }[];
      histogram: { time: UTCTimestamp; value: number; color?: string }[];
    }
  >;
  talibMulti: Record<string, Record<string, { time: UTCTimestamp; value: number }[]>>;
};

function buildIndicatorHudLines(
  bars: CandleApiBar[],
  defs: ChartIndicatorDef[],
  vis: Record<string, boolean>,
  idx: number,
  ta: TaServerHud | null,
): { key: string; label: string; value: string; color?: string }[] {
  if (idx < 0 || idx >= bars.length) return [];
  const out: { key: string; label: string; value: string; color?: string }[] = [];
  const barT = bars[idx].t as import("lightweight-charts").UTCTimestamp;

  for (const d of defs) {
    if (vis[d.id] === false) continue;
    const lb = effectiveDeltaLookbackBars(d);
    const du = lb >= 1;
    const norm = effectiveDeltaNormalizeByPrice(d);

    const pushDeltaHud = (
      key: string,
      linePts: { time: UTCTimestamp; value: number }[],
      labelStem: string,
      clr: string | undefined,
    ) => {
      const dense = denseValuesByBarIndex(bars, forwardFillSparseLineToBars(bars, linePts));
      const dv = indicatorDeltaValueAtBarIndex(bars, dense, idx, lb, norm);
      if (dv == null || !Number.isFinite(dv)) return;
      out.push({
        key: `${key}__delta`,
        label: `${labelStem.trim()}${indicatorDeltaHudSuffix(d)}`,
        value: fmtIndicatorDeltaHud(dv),
        color: clr,
      });
    };

    if (d.kind === "sma" && ta) {
      const pts = ta.lines[d.id];
      if (!pts?.length) continue;
      const rv = lineValueAtOrBeforeBarT(pts, barT);
      if (rv == null || !Number.isFinite(rv)) continue;
      out.push({
        key: d.id,
        label: d.label?.trim() || `SMA ${d.period ?? 20}`,
        value: fmtPx(rv),
        color: d.color ?? "#c4b5fd",
      });
      if (du)
        pushDeltaHud(
          d.id,
          pts,
          d.label?.trim() || `SMA ${d.period ?? 20}`,
          d.color ?? "#c4b5fd",
        );
    } else if (d.kind === "atr" && ta) {
      const pts = ta.lines[d.id];
      if (!pts?.length) continue;
      const rv = lineValueAtOrBeforeBarT(pts, barT);
      if (rv == null || !Number.isFinite(rv)) continue;
      out.push({
        key: d.id,
        label: d.label?.trim() || `ATR ${d.period ?? 14}`,
        value: fmtPx(rv),
        color: d.color ?? "#fb923c",
      });
      if (du)
        pushDeltaHud(
          d.id,
          pts,
          d.label?.trim() || `ATR ${d.period ?? 14}`,
          d.color ?? "#fb923c",
        );
    } else if ((d.kind === "macd" || (d.kind === "talib" && d.talibFunction?.toUpperCase() === "MACD")) && ta) {
      const m = ta.macd[d.id];
      if (!m) continue;
      const base = d.label?.trim() || "MACD";
      const rows: {
        hk: string;
        raw: number | undefined;
        linePts: { time: UTCTimestamp; value: number }[];
        lab: string;
        clr: string;
      }[] = [
        {
          hk: `${d.id}_m`,
          raw: lineValueAtOrBeforeBarT(m.macd, barT),
          linePts: m.macd,
          lab: `${base}`,
          clr: d.color ?? "#22d3ee",
        },
        {
          hk: `${d.id}_s`,
          raw: lineValueAtOrBeforeBarT(m.signal, barT),
          linePts: m.signal,
          lab: `${base} sig`,
          clr: "#a78bfa",
        },
        {
          hk: `${d.id}_h`,
          raw: lineValueAtOrBeforeBarT(
            m.histogram as { time: UTCTimestamp; value: number }[],
            barT,
          ),
          linePts: m.histogram.map((h) => ({ time: h.time, value: h.value })),
          lab: `${base} hist`,
          clr: "#94a3b8",
        },
      ];
      for (const row of rows) {
        if (row.raw == null || !Number.isFinite(row.raw)) continue;
        out.push({
          key: row.hk,
          label: row.lab,
          value: fmtPx(row.raw),
          color: row.clr,
        });
        if (du) pushDeltaHud(row.hk, row.linePts, row.lab, row.clr);
      }
    } else if (d.kind === "trend_composite" && ta) {
      const pts = ta.lines[d.id];
      if (!pts?.length) continue;
      const rv = lineValueAtOrBeforeBarT(pts, barT);
      if (rv == null || !Number.isFinite(rv)) continue;
      out.push({
        key: d.id,
        label: d.label?.trim() || "Trend composite",
        value: rv.toFixed(2),
        color: d.color ?? "#10b981",
      });
      if (du)
        pushDeltaHud(
          d.id,
          pts,
          d.label?.trim() || "Trend composite",
          d.color ?? "#10b981",
        );
    } else if (d.kind === "derived" && ta) {
      const pts = ta.lines[d.id];
      if (!pts?.length) continue;
      const rv = lineValueAtOrBeforeBarT(pts, barT);
      if (rv == null || !Number.isFinite(rv)) continue;
      out.push({
        key: d.id,
        label: d.label?.trim() || "Derivado",
        value: fmtPx(rv),
        color: d.color ?? "#f472b6",
      });
      if (du) pushDeltaHud(d.id, pts, d.label?.trim() || "Derivado", d.color ?? "#f472b6");
    } else if (d.kind === "talib" && ta) {
      const multi = ta.talibMulti[d.id];
      if (multi) {
        for (const [oname, pts] of Object.entries(multi)) {
          const rv = lineValueAtOrBeforeBarT(pts, barT);
          if (rv == null || !Number.isFinite(rv)) continue;
          const base = d.label?.trim() || d.talibFunction || "TA";
          const k = `${d.id}_${oname}`;
          out.push({
            key: k,
            label: `${base} ${oname}`,
            value: fmtPx(rv),
            color: d.color,
          });
          if (du) pushDeltaHud(k, pts, `${base} ${oname}`, d.color);
        }
      } else {
        const pts = ta.lines[d.id];
        if (!pts?.length) continue;
        const rv = lineValueAtOrBeforeBarT(pts, barT);
        if (rv == null || !Number.isFinite(rv)) continue;
        out.push({
          key: d.id,
          label: d.label?.trim() || d.talibFunction || "TA-Lib",
          value: fmtPx(rv),
          color: d.color ?? "#38bdf8",
        });
        if (du)
          pushDeltaHud(
            d.id,
            pts,
            d.label?.trim() || d.talibFunction || "TA-Lib",
            d.color ?? "#38bdf8",
          );
      }
    }
  }
  return out;
}

function featSeriesPriceFormat(id: string) {
  if (id === "feat_funding_rate") return { type: "price" as const, precision: 8, minMove: 1e-8 };
  if (id === "feat_tick_imbalance" || id === "feat_ob_imb_snap")
    return { type: "price" as const, precision: 4, minMove: 0.0001 };
  if (id === "feat_tick_buy_sell_ratio")
    return { type: "price" as const, precision: 2, minMove: 0.01 };
  if (
    id === "feat_mark_px" ||
    id === "feat_index_px" ||
    id.endsWith("_px")
  )
    return { type: "price" as const, precision: 4, minMove: 0.0001 };
  return { type: "price" as const, precision: 2, minMove: 0.01 };
}

function buildFeatHudLines(
  idx: number,
  bars: CandleApiBar[],
  visibility: Record<string, boolean>,
  series: Record<string, { time: UTCTimestamp; value: number }[]>,
): { key: string; label: string; value: string; color?: string }[] {
  if (idx < 0 || idx >= bars.length) return [];
  const out: { key: string; label: string; value: string; color?: string }[] = [];
  for (const e of CHART_FACT_SERIES) {
    if (visibility[e.id] !== true) continue;
    const pts = series[e.id];
    if (!pts?.length || idx >= pts.length) continue;
    const v = pts[idx]!.value;
    if (!Number.isFinite(v)) continue;
    out.push({
      key: `feat:${e.id}`,
      label: e.label,
      value: formatFeatHudValue(e.id, v),
      color: e.color,
    });
  }
  return out;
}

type Props = {
  bars: CandleApiBar[];
  loadingOlder?: boolean;
  error?: string | null;
  hasMoreOlder: boolean;
  onNeedOlder: () => void | Promise<void>;
  resetKey: number;
  indicatorDefs?: ChartIndicatorDef[];
  indicatorVisibility?: Record<string, boolean>;
  /** Dados live: linhas no gráfico, micro-velas de liquidação no preço, heat do tape. */
  liveSnapshot?: LiveSnapshot | null;
  /**
   * Resultado de backtest (vectorbt) para o par actual: B/S no preço, curva de equity noutro painel.
   * Preenchido em ``app/chart`` quando o job em contexto tiver ``chart_overlay`` para este símbolo.
   */
  backtestChart?: BacktestChartLayer | null;
  /** Nome da estratégia do gráfico (faixa de métricas do backtest). */
  backtestStrategyLabel?: string | null;
  /** `live` = simulação nas velas; `questdb` = resultado de job. */
  backtestOverlayMode?: "live" | "questdb" | null;
  /**
   * Se falso, o equity fica fora (ex. ``StrategyTesterPanel``) e o painel extra do chart não é criado.
   * Por omissão: integrado (segundo painel) — mantém compat.
   */
  embedBacktestEquityInChart?: boolean;
  /** Se falso, esconde a faixa de KPI no topo; usar quando a métrica estiver noutro painel. */
  backtestKpiInChart?: boolean;
  /** Chamado com o `IChartApi` principal (velas) para sincronizar eixo de tempo. */
  onMainChartApi?: (api: IChartApi | null) => void;
  /** Séries SMA/ATR calculadas no FastAPI (pandas). */
  taServerLines?: Record<string, { time: UTCTimestamp; value: number }[]>;
  /** MACD (3 séries) do servidor; desenhadas no painel de estudo. */
  taServerMacd?: Record<
    string,
    {
      macd: { time: UTCTimestamp; value: number }[];
      signal: { time: UTCTimestamp; value: number }[];
      histogram: { time: UTCTimestamp; value: number; color?: string }[];
    }
  >;
  /** TA-Lib multi-output (ex. bandas): várias linhas no preço. */
  taServerTalibMulti?: Record<string, Record<string, { time: UTCTimestamp; value: number }[]>>;
  /** Séries facetas QuestDB (`feat_*`) vindas da API Python; mesmo eixo temporal que as velas. */
  featSeries?: Record<string, { time: UTCTimestamp; value: number }[]>;
  /** Mostrar/ocultar linhas facetas por id (checklist na biblioteca). */
  featVisibility?: Record<string, boolean>;
  /** Volume footprint agregado por candle/preço; desenhado por cima das velas quando activo. */
  footprintBars?: FootprintBar[] | null;
};

/**
 * TA-Lib no painel de preço: MACD vai para painel MACD; RSI etc. para o painel de estudos.
 * BBANDS (e bandas de preço) desenham-se sempre sobre as velas, mesmo que ``group`` na estratégia seja ``studies``.
 */
function talibDrawsOnMainPricePane(d: ChartIndicatorDef): boolean {
  if (d.kind !== "talib") return true;
  const fn = d.talibFunction?.trim().toUpperCase() ?? "";
  if (fn === "MACD") return false;
  if (fn === "BBANDS") return true;
  return d.group !== "studies";
}

/** Estudos RSI/MACD/osciladores no segundo painel — BBANDS não (escala = preço). */
function talibInRsiStudyPane(d: ChartIndicatorDef): boolean {
  if (d.kind === "trend_composite" && d.group === "studies") return true;
  if (d.kind !== "talib" || d.group !== "studies") return false;
  const fn = d.talibFunction?.trim().toUpperCase() ?? "";
  return fn !== "MACD" && fn !== "BBANDS";
}

function medianFinite(values: number[]): number | null {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.floor(xs.length / 2)] ?? null;
}

function rangeFinite(values: number[]): number | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of values) {
    if (!Number.isFinite(x)) continue;
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return lo <= hi ? hi - lo : null;
}

function derivedLooksPriceScaled(
  d: ChartIndicatorDef,
  bars: CandleApiBar[],
  data: { time: UTCTimestamp; value: number }[] | undefined,
): boolean {
  if (d.kind !== "derived") return true;
  if (d.group === "studies") return false;

  const priceMedian = medianFinite(bars.map((b) => b.c));
  if (priceMedian == null || Math.abs(priceMedian) < 1e-12) return false;

  if (!data?.length) {
    const base = d.derived?.inputRef?.trim().toLowerCase() ?? "";
    const tr = d.derived?.transform?.trim().toLowerCase() ?? "";
    return d.derived?.mode === "chain" && ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"].includes(base) && ["ema", "sma"].includes(tr);
  }

  const vals = data.map((p) => p.value);
  const valueMedian = medianFinite(vals.map((x) => Math.abs(x)));
  if (valueMedian == null) return false;
  const ratio = valueMedian / Math.abs(priceMedian);
  if (ratio < 0.2 || ratio > 5) return false;

  const priceRange = rangeFinite(bars.map((b) => b.c));
  const valueRange = rangeFinite(vals);
  if (priceRange != null && valueRange != null && priceRange > 1e-12 && valueRange / priceRange > 8) {
    return false;
  }
  return true;
}

/** Chaves de linhas só no gráfico principal (sem RSI — RSI tem painel próprio). */
function collectMainLineKeys(
  defs: ChartIndicatorDef[],
  vis: Record<string, boolean>,
  talibMulti: Record<string, Record<string, unknown>> | undefined,
  derivedStudyIds: Set<string>,
): Set<string> {
  const want = new Set<string>();
  for (const d of defs) {
    if (d.kind === "macd") continue;
    if (d.kind === "trend_composite" && d.group === "studies") continue;
    if (d.kind === "talib" && !talibDrawsOnMainPricePane(d)) continue;
    if (d.kind === "derived" && derivedStudyIds.has(d.id)) continue;
    if (vis[d.id] === false) continue;
    if (d.kind === "talib") {
      const sub = talibMulti?.[d.id];
      if (sub && Object.keys(sub).length > 0) {
        for (const k of Object.keys(sub)) {
          want.add(`${d.id}__${k}`);
        }
      } else {
        want.add(d.id);
      }
    } else {
      want.add(d.id);
    }
  }
  return want;
}

/**
 * Alinha pontos live ao fecho de cada vela (`bars[].t`). Sem isto, milhares de
 * timestamps sub-minuto nas linhas Mid/OI/spread dilatam o eixo X e as velas
 * parecem linhas finas muito separadas.
 */
function resampleLiveScalarToBarTimes(
  bars: CandleApiBar[],
  points: { time: UTCTimestamp; value: number }[],
): { time: UTCTimestamp; value: number }[] {
  if (bars.length === 0 || points.length === 0) return [];
  const pts = [...points].sort((a, b) => Number(a.time) - Number(b.time));
  let j = 0;
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (const b of bars) {
    const bt = b.t;
    while (j < pts.length && Number(pts[j].time) <= bt) {
      j++;
    }
    if (j === 0) continue;
    out.push({ time: bt as UTCTimestamp, value: pts[j - 1].value });
  }
  return out;
}

function resampleSpreadHistToBarTimes(
  bars: CandleApiBar[],
  points: { time: UTCTimestamp; value: number; color: string }[],
): { time: UTCTimestamp; value: number; color: string }[] {
  if (bars.length === 0 || points.length === 0) return [];
  const pts = [...points].sort((a, b) => Number(a.time) - Number(b.time));
  let j = 0;
  const out: { time: UTCTimestamp; value: number; color: string }[] = [];
  for (const b of bars) {
    const bt = b.t;
    while (j < pts.length && Number(pts[j].time) <= bt) {
      j++;
    }
    if (j === 0) continue;
    const last = pts[j - 1];
    out.push({ time: bt as UTCTimestamp, value: last.value, color: last.color });
  }
  return out;
}

function LiveTapeHeatStrip({ ticks }: { ticks: LiveSnapshot["ticks"] }) {
  const ratios = useMemo(() => tapeBuyRatioBuckets(ticks, 40, 40 * 60), [ticks]);
  return (
    <div
      className="flex h-3 w-full min-w-0 gap-px rounded-sm border border-zinc-800/80 bg-zinc-950 px-px py-px"
      title="Heatmap do tape: 40 minutos × 1 min — verde mais compra agressiva, vermelho mais venda"
      aria-hidden
    >
      {ratios.map((r, i) => (
        <div
          key={i}
          className="min-w-0 flex-1 rounded-[1px]"
          style={{ backgroundColor: bucketHeatColor(r) }}
        />
      ))}
    </div>
  );
}

export function OhlcvChart({
  bars,
  loadingOlder,
  error,
  hasMoreOlder,
  onNeedOlder,
  resetKey,
  indicatorDefs = EMPTY_DEFS,
  indicatorVisibility = EMPTY_VIS,
  liveSnapshot = null,
  backtestChart = null,
  backtestStrategyLabel = null,
  backtestOverlayMode = null,
  embedBacktestEquityInChart = true,
  backtestKpiInChart = true,
  onMainChartApi = undefined,
  taServerLines,
  taServerMacd,
  taServerTalibMulti,
  featSeries,
  featVisibility = EMPTY_VIS,
  footprintBars = null,
}: Props) {
  const onMainChartApiRef = useRef<typeof onMainChartApi>(onMainChartApi);
  const outerRef = useRef<HTMLDivElement>(null);
  const mainWrapRef = useRef<HTMLDivElement>(null);
  const studyChromeStackRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const seriesMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const equitySeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const liveMidLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const liveOiLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const liveSpreadHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const liveLiqHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const strategyShadingPrimRef = useRef<StrategyShadingBandsPrimitive | null>(null);
  const liqMicroPrimitiveRef = useRef<LiquidationMicroCandlesPrimitive | null>(null);
  const volumeFootprintPrimitiveRef = useRef<VolumeFootprintPrimitive | null>(null);
  const rsiLineMapRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const macdMacdLineRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const macdSignalLineRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const macdHistRef = useRef<Map<string, ISeriesApi<"Histogram">>>(new Map());
  const derivedStudyLineRef = useRef<Map<string, ISeriesApi<"Line", Time>>>(new Map());
  /** Linhas Δ (painel de estudo dedicado); chave ``delta__id`` ou ``delta__id__sub``. */
  const deltaStudyLineRef = useRef<Map<string, ISeriesApi<"Line" | "Histogram", Time>>>(new Map());
  const featLineMapRef = useRef<Map<string, ISeriesApi<"Line", Time>>>(new Map());
  const featPaneHydrateRetriesRef = useRef(0);
  const featSeriesRef = useRef<Record<string, { time: UTCTimestamp; value: number }[]>>({});
  const featVisibilityRef = useRef<Record<string, boolean>>(EMPTY_VIS);
  const indLineRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const taHudRef = useRef<TaServerHud>({ lines: {}, macd: {}, talibMulti: {} });
  const prevBarsRef = useRef<CandleApiBar[]>([]);
  const prevBarsFingerprintRef = useRef("");
  const prevResetKeyRef = useRef(resetKey);
  const visibleLogicalRangeRef = useRef<LogicalRange | null>(null);
  /** Se o painel Δ ainda não existe no ``chart``, re-tenta até ``setPaneLayoutRevision`` (troca par/muda painéis). */
  const derivedPaneHydrateRetriesRef = useRef(0);
  const deltaPaneHydrateRetriesRef = useRef(0);
  const [dims, setDims] = useState({ w: 800, mainH: 600 });
  const [crosshairHud, setCrosshairHud] = useState<CrosshairHud | null>(null);

  /** Dispara novo render após sincronizar painéis no ``chart`` (mutação só-JS sem estado). */
  const [paneLayoutRevision, setPaneLayoutRevision] = useState(0);

  const barsRef = useRef(bars);
  const indicatorDefsRef = useRef(indicatorDefs);
  const indicatorVisibilityRef = useRef(indicatorVisibility);

  /** lightweight-charts dispara o crosshair muitas vezes por segundo; sem isto o React re-renderiza em loop e dispara RAM/CPU (pior com Turbopack). */
  const crosshairRafRef = useRef<number | null>(null);
  const crosshairLatestParamRef = useRef<{
    time?: unknown;
    point?: { x: number; y: number } | null;
  } | null>(null);
  const crosshairHudKeyRef = useRef<string>("");
  const indicatorHudEpochRef = useRef(0);

  const restoreVisibleLogicalRange = useCallback((range: LogicalRange | null) => {
    if (!range) return;
    requestAnimationFrame(() => {
      const chart = chartRef.current;
      if (!chart) return;
      try {
        chart.timeScale().setVisibleLogicalRange({ from: range.from, to: range.to });
      } catch {
        /* chart disposed or range invalid during pane sync */
      }
    });
  }, []);

  useEffect(() => {
    onMainChartApiRef.current = onMainChartApi;
  }, [onMainChartApi]);

  useEffect(() => {
    taHudRef.current = {
      lines: taServerLines ?? {},
      macd: taServerMacd ?? {},
      talibMulti: taServerTalibMulti ?? {},
    };
  }, [taServerLines, taServerMacd, taServerTalibMulti]);

  useEffect(() => {
    barsRef.current = bars;
    indicatorDefsRef.current = indicatorDefs;
    indicatorVisibilityRef.current = indicatorVisibility;
    featSeriesRef.current = featSeries ?? {};
    featVisibilityRef.current = featVisibility;
  }, [bars, indicatorDefs, indicatorVisibility, featSeries, featVisibility]);

  const processCrosshair = useCallback(() => {
    const param = crosshairLatestParamRef.current;
    if (!param) return;
    if (param.point === undefined || param.point === null) {
      crosshairHudKeyRef.current = "";
      setCrosshairHud(null);
      return;
    }
    const tu = crosshairTimeToUnix(param.time);
    if (tu == null) {
      crosshairHudKeyRef.current = "";
      setCrosshairHud(null);
      return;
    }
    const list = barsRef.current;
    if (list.length === 0) {
      crosshairHudKeyRef.current = "";
      setCrosshairHud(null);
      return;
    }
    const idx = list.findIndex((b) => b.t === tu);
    if (idx < 0) {
      crosshairHudKeyRef.current = "";
      setCrosshairHud(null);
      return;
    }
    const epoch = indicatorHudEpochRef.current;
    const key = `${tu}:${epoch}`;
    if (key === crosshairHudKeyRef.current) return;
    crosshairHudKeyRef.current = key;

    const b = list[idx];
    const changePct = b.o !== 0 ? ((b.c - b.o) / b.o) * 100 : 0;
    const dateStr = new Date(b.t * 1000).toLocaleDateString("pt-PT", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const hudTa = taHudRef.current;
    const lines = buildIndicatorHudLines(
      list,
      indicatorDefsRef.current,
      indicatorVisibilityRef.current,
      idx,
      hudTa,
    ).concat(buildFeatHudLines(idx, list, featVisibilityRef.current, featSeriesRef.current));
    setCrosshairHud({
      dateStr,
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
      vol: b.v,
      changePct,
      lines,
    });
  }, []);

  const processCrosshairRef = useRef<() => void>(() => {});
  useEffect(() => {
    processCrosshairRef.current = processCrosshair;
  }, [processCrosshair]);

  const crosshairCbRef = useRef<
    (param: { time?: unknown; point?: { x: number; y: number } | null }) => void
  >(() => {});
  useEffect(() => {
    crosshairCbRef.current = (param) => {
      crosshairLatestParamRef.current = param;
      if (crosshairRafRef.current != null) return;
      crosshairRafRef.current = requestAnimationFrame(() => {
        crosshairRafRef.current = null;
        processCrosshairRef.current();
      });
    };
  }, []);

  useEffect(() => {
    indicatorHudEpochRef.current += 1;
    crosshairHudKeyRef.current = "";
    const p = crosshairLatestParamRef.current;
    if (p?.point != null) {
      processCrosshairRef.current();
    }
  }, [
    indicatorDefs,
    indicatorVisibility,
    taServerLines,
    taServerMacd,
    taServerTalibMulti,
    featSeries,
    featVisibility,
  ]);

  useEffect(() => {
    return () => {
      if (crosshairRafRef.current != null) {
        cancelAnimationFrame(crosshairRafRef.current);
        crosshairRafRef.current = null;
      }
    };
  }, []);

  const hasMoreRef = useRef(hasMoreOlder);
  const loadingOlderRef = useRef(!!loadingOlder);
  const onNeedOlderRef = useRef(onNeedOlder);
  const debounceTRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const olderRequestInFlightRef = useRef(false);
  const olderLoadArmedRef = useRef(true);
  const suppressAutoOlderLoadUntilRef = useRef(0);

  const showRsiPane = useMemo(
    () =>
      indicatorDefs.some((d) => {
        if (indicatorVisibility[d.id] === false) return false;
        return talibInRsiStudyPane(d);
      }),
    [indicatorDefs, indicatorVisibility],
  );

  const visibleRsiDefs = useMemo(
    () =>
      indicatorDefs.filter((d) => {
        if (indicatorVisibility[d.id] === false) return false;
        return talibInRsiStudyPane(d);
      }),
    [indicatorDefs, indicatorVisibility],
  );

  const showMacdPane = useMemo(
    () =>
      indicatorDefs.some((d) => {
        if (indicatorVisibility[d.id] === false) return false;
        if (d.kind === "macd") return true;
        if (d.kind === "talib" && d.talibFunction?.toUpperCase() === "MACD") return true;
        return false;
      }),
    [indicatorDefs, indicatorVisibility],
  );

  const visibleMacdDefs = useMemo(
    () =>
      indicatorDefs.filter((d) => {
        if (indicatorVisibility[d.id] === false) return false;
        if (d.kind === "macd") return true;
        if (d.kind === "talib" && d.talibFunction?.toUpperCase() === "MACD") return true;
        return false;
      }),
    [indicatorDefs, indicatorVisibility],
  );

  const visibleDerivedStudyDefs = useMemo(
    () =>
      indicatorDefs.filter((d) => {
        if (indicatorVisibility[d.id] === false || d.kind !== "derived") return false;
        return !derivedLooksPriceScaled(d, bars, taServerLines?.[d.id]);
      }),
    [indicatorDefs, indicatorVisibility, bars, taServerLines],
  );

  const derivedStudyIds = useMemo(
    () => new Set(visibleDerivedStudyDefs.map((d) => d.id)),
    [visibleDerivedStudyDefs],
  );

  const showDerivedStudyPane = visibleDerivedStudyDefs.length > 0;

  const derivedStudyPaneIndex = useMemo(
    () => 1 + (showRsiPane ? 1 : 0) + (showMacdPane ? 1 : 0),
    [showRsiPane, showMacdPane],
  );

  const visibleDeltaStudyDefs = useMemo(
    () =>
      indicatorDefs.filter(
        (d) =>
          indicatorVisibility[d.id] !== false && effectiveDeltaLookbackBars(d) > 0,
      ),
    [indicatorDefs, indicatorVisibility],
  );

  const showDeltaPane = visibleDeltaStudyDefs.length > 0;

  /** Índice do painel apenas-Δ (abaixo de RSI/MACD se existirem). */
  const deltaStudyPaneIndex = useMemo(
    () => 1 + (showRsiPane ? 1 : 0) + (showMacdPane ? 1 : 0) + (showDerivedStudyPane ? 1 : 0),
    [showRsiPane, showMacdPane, showDerivedStudyPane],
  );

  const visibleFeatEntries = useMemo(
    () => CHART_FACT_SERIES.filter((e) => featVisibility[e.id] === true),
    [featVisibility],
  );

  const showFeatPane = visibleFeatEntries.length > 0;

  /** Facetas QuestDB: painel sob RSI/MACD/Δ. */
  const featStudyPaneIndex = useMemo(
    () =>
      1 +
      (showRsiPane ? 1 : 0) +
      (showMacdPane ? 1 : 0) +
      (showDerivedStudyPane ? 1 : 0) +
      (showDeltaPane ? 1 : 0),
    [showRsiPane, showMacdPane, showDerivedStudyPane, showDeltaPane],
  );

  const showStudyChrome =
    showRsiPane || showMacdPane || showDerivedStudyPane || showDeltaPane || showFeatPane;

  /** Com RSI / MACD / Δ / facetas num 2.º+ painel, não embutir equity aqui. */
  const shouldEmbedEquity =
    embedBacktestEquityInChart &&
    !showRsiPane &&
    !showMacdPane &&
    !showDerivedStudyPane &&
    !showDeltaPane &&
    !showFeatPane;

  const fitTimeScale = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      chart.timeScale().fitContent();
    } catch {
      /* ignore */
    }
  }, []);

  const fitPriceScale = useCallback(() => {
    const chart = chartRef.current;
    const candle = seriesRef.current;
    if (!chart || !candle) return;
    try {
      candle.priceScale().applyOptions({
        autoScale: true,
        scaleMargins: { ...MAIN_PRICE_SCALE_MARGINS },
      });
    } catch {
      try {
        chart.priceScale("right").applyOptions({
          autoScale: true,
          scaleMargins: { ...MAIN_PRICE_SCALE_MARGINS },
        });
      } catch {
        /* ignore */
      }
    }
    if (!showStudyChrome) return;
    try {
      const n = chart.panes().length;
      for (let pi = 1; pi < n; pi++) {
        chart.priceScale("right", pi).applyOptions({
          autoScale: true,
          scaleMargins: { ...RSI_PRICE_SCALE_MARGINS },
        });
      }
    } catch {
      /* ignore */
    }
  }, [showStudyChrome]);

  useEffect(() => {
    if (bars.length !== 0) return;
    const raf = requestAnimationFrame(() => setCrosshairHud(null));
    return () => cancelAnimationFrame(raf);
  }, [bars.length]);

  useEffect(() => {
    hasMoreRef.current = hasMoreOlder;
  }, [hasMoreOlder]);
  useEffect(() => {
    loadingOlderRef.current = !!loadingOlder;
  }, [loadingOlder]);
  useEffect(() => {
    onNeedOlderRef.current = onNeedOlder;
  }, [onNeedOlder]);

  const measure = useCallback(() => {
    const wrap = mainWrapRef.current;
    const box = outerRef.current;
    let w = 800;
    let mainH: number;

    if (wrap && wrap.clientHeight >= 32) {
      w = Math.max(280, Math.floor(wrap.clientWidth));
      mainH = Math.max(CHART_VIEWPORT_MIN_PX, Math.floor(wrap.clientHeight));
    } else if (box) {
      w = Math.max(280, Math.floor(box.clientWidth));
      const totalH = Math.floor(box.clientHeight);
      if (totalH < 48) return;
      let studyStrip = 0;
      if (showStudyChrome) {
        const stack = studyChromeStackRef.current;
        studyStrip = stack
          ? Math.ceil(stack.getBoundingClientRect().height)
          : RSI_CHROME_ABOVE_CHART_PX;
      }
      mainH = Math.max(CHART_VIEWPORT_MIN_PX, totalH - studyStrip);
    } else {
      return;
    }

    setDims((prev) => (prev.w === w && prev.mainH === mainH ? prev : { w, mainH }));
  }, [showStudyChrome]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    measure();
    const ro = new ResizeObserver(() => measure());
    const wrap = mainWrapRef.current;
    const box = outerRef.current;
    if (wrap) ro.observe(wrap);
    if (box) ro.observe(box);
    const stack = studyChromeStackRef.current;
    if (stack) ro.observe(stack);
    window.addEventListener("resize", measure);
    const raf = requestAnimationFrame(() => measure());
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [
    measure,
    showStudyChrome,
    visibleRsiDefs.length,
    visibleMacdDefs.length,
    visibleDerivedStudyDefs.length,
    visibleDeltaStudyDefs.length,
    visibleFeatEntries.length,
  ]);

  useEffect(() => {
    const el = mainWrapRef.current;
    if (!el) return;

    const w = Math.max(280, Math.floor(el.clientWidth)) || 800;
    const rawH = Math.floor(el.clientHeight);
    const h = Math.max(CHART_VIEWPORT_MIN_PX, rawH >= 32 ? rawH : defaultMainChartHeightPx());

    const chart = createChart(el, {
      width: w,
      height: h,
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: "#b4b4b8",
        // Licença: com logo oculto, mantém atribuição TradingView noutro sítio do site (ver NOTICE da lib).
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: CHART_GRID },
        horzLines: { color: CHART_GRID },
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: CHART_BORDER,
        visible: true,
        ...LINKED_TIME_SCALE,
      },
      rightPriceScale: { borderColor: CHART_BORDER, scaleMargins: { ...MAIN_PRICE_SCALE_MARGINS } },
      leftPriceScale: {
        visible: true,
        borderColor: CHART_BORDER,
        scaleMargins: { top: 0.12, bottom: 0.2 },
      },
      ...CHART_INTERACTION,
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });

    const shadingBands = new StrategyShadingBandsPrimitive();
    candle.attachPrimitive(shadingBands);
    strategyShadingPrimRef.current = shadingBands;

    const liqMicro = new LiquidationMicroCandlesPrimitive();
    candle.attachPrimitive(liqMicro);
    liqMicroPrimitiveRef.current = liqMicro;
    const footprint = new VolumeFootprintPrimitive();
    candle.attachPrimitive(footprint);
    volumeFootprintPrimitiveRef.current = footprint;
    seriesMarkersRef.current = createSeriesMarkers(candle, []);

    const vol = chart.addSeries(HistogramSeries, {
      color: "#5c6bc0",
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { ...VOL_SCALE_MARGINS } });

    chartRef.current = chart;
    seriesRef.current = candle;
    volRef.current = vol;
    try {
      onMainChartApiRef.current?.(chart);
    } catch {
      /* ignore */
    }

    const onRange = (range: LogicalRange | null) => {
      if (!range || range.from == null) return;
      visibleLogicalRangeRef.current = { from: range.from, to: range.to };
      if (Date.now() < suppressAutoOlderLoadUntilRef.current) {
        return;
      }
      if (range.from > LOAD_MORE_WHEN_FROM + 8) {
        olderLoadArmedRef.current = true;
      }
      if (!hasMoreRef.current || loadingOlderRef.current || olderRequestInFlightRef.current) return;
      if (range.from > LOAD_MORE_WHEN_FROM || !olderLoadArmedRef.current) return;
      if (debounceTRef.current) clearTimeout(debounceTRef.current);
      debounceTRef.current = setTimeout(() => {
        debounceTRef.current = null;
        if (olderRequestInFlightRef.current || loadingOlderRef.current || !hasMoreRef.current) return;
        olderLoadArmedRef.current = false;
        olderRequestInFlightRef.current = true;
        Promise.resolve(onNeedOlderRef.current()).finally(() => {
          olderRequestInFlightRef.current = false;
        });
      }, 200);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    const onCrosshairMove = (param: {
      time?: unknown;
      point?: { x: number; y: number } | null;
    }) => {
      crosshairCbRef.current(param);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    const indLineMap = indLineRef.current;
    const rsiLineMap = rsiLineMapRef.current;
    const derivedStudyLineMap = derivedStudyLineRef.current;
    const deltaStudyLineMap = deltaStudyLineRef.current;
    const macdMacdLineMap = macdMacdLineRef.current;
    const macdSignalLineMap = macdSignalLineRef.current;
    const macdHistMap = macdHistRef.current;
    const featLineMap = featLineMapRef.current;

    return () => {
      try {
        onMainChartApiRef.current?.(null);
      } catch {
        /* ignore */
      }
      if (crosshairRafRef.current != null) {
        cancelAnimationFrame(crosshairRafRef.current);
        crosshairRafRef.current = null;
      }
      crosshairLatestParamRef.current = null;
      try {
        chart.unsubscribeCrosshairMove(onCrosshairMove);
      } catch {
        /* chart already disposed */
      }
      if (debounceTRef.current) clearTimeout(debounceTRef.current);
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      } catch {
        /* chart already disposed */
      }
      const candleSerUnmount = seriesRef.current;
      const shadeUnmount = strategyShadingPrimRef.current;
      if (shadeUnmount && candleSerUnmount) {
        try {
          candleSerUnmount.detachPrimitive(shadeUnmount);
        } catch {
          /* ignore */
        }
      }
      strategyShadingPrimRef.current = null;
      const liqPrim = liqMicroPrimitiveRef.current;
      if (liqPrim && candleSerUnmount) {
        try {
          candleSerUnmount.detachPrimitive(liqPrim);
        } catch {
          /* ignore */
        }
      }
      liqMicroPrimitiveRef.current = null;
      const fpPrim = volumeFootprintPrimitiveRef.current;
      if (fpPrim && candleSerUnmount) {
        try {
          candleSerUnmount.detachPrimitive(fpPrim);
        } catch {
          /* ignore */
        }
      }
      volumeFootprintPrimitiveRef.current = null;
      const mapsToClear = [
        indLineMap,
        rsiLineMap,
        derivedStudyLineMap,
        deltaStudyLineMap,
        macdMacdLineMap,
        macdSignalLineMap,
        macdHistMap,
        featLineMap,
      ];
      for (const seriesMap of mapsToClear) {
        for (const s of seriesMap.values()) {
          try {
            chart.removeSeries(s);
          } catch {
            /* ignore */
          }
        }
        seriesMap.clear();
      }
      liveMidLineRef.current = null;
      liveOiLineRef.current = null;
      liveSpreadHistRef.current = null;
      liveLiqHistRef.current = null;
      seriesMarkersRef.current = null;
      const eq = equitySeriesRef.current;
      if (eq) {
        try {
          chart.removeSeries(eq);
        } catch {
          /* ignore */
        }
        equitySeriesRef.current = null;
      }
      while (true) {
        try {
          if (chart.panes().length <= 1) break;
          chart.removePane(chart.panes().length - 1);
        } catch {
          break;
        }
      }
      chartRef.current = null;
      seriesRef.current = null;
      volRef.current = null;
      try {
        chart.remove();
      } catch {
        /* chart already disposed */
      }
    };
  }, []);

  useEffect(() => {
    const mk = seriesMarkersRef.current;
    if (!mk) return;
    const raw = backtestChart?.overlay?.markers;
    try {
      const bt: SeriesMarker<Time>[] = !raw?.length
        ? []
        : raw.map(
            (m) =>
              ({
                time: m.time as Time,
                position: m.position,
                color: m.color,
                shape: m.shape,
                text: m.text,
              }) as SeriesMarker<Time>,
          );
      mk.setMarkers(bt);
    } catch {
      /* gráfico ou série markers já disposed (HMR / desmontagem / troca rápida) */
    }
  }, [backtestChart]);

  useEffect(() => {
    const prim = strategyShadingPrimRef.current;
    if (!prim) return;
    const sh = backtestChart?.overlay?.strategyShading;
    if (
      !sh?.length ||
      sh.length !== bars.length ||
      bars.length === 0 ||
      sh[0]!.t !== bars[0]!.t ||
      sh[sh.length - 1]!.t !== bars[bars.length - 1]!.t
    ) {
      prim.clear();
      return;
    }
    prim.setData(
      bars.map((b) => b.t),
      sh,
    );
  }, [bars, backtestChart?.overlay?.strategyShading, resetKey]);

  useEffect(() => {
    const prim = volumeFootprintPrimitiveRef.current;
    if (!prim || !footprintBars?.length || bars.length === 0) {
      prim?.clear();
      return;
    }
    prim.setData(
      bars.map((b) => b.t),
      footprintBars,
    );
  }, [bars, footprintBars, resetKey]);

  useEffect(() => {
    if (!shouldEmbedEquity) {
      const ch = chartRef.current;
      if (!ch) return;
      const clearOnly = () => {
        const keepRange = ch.timeScale().getVisibleLogicalRange() ?? visibleLogicalRangeRef.current;
        const eq = equitySeriesRef.current;
        if (eq) {
          try {
            ch.removeSeries(eq);
          } catch {
            /* ignore */
          }
          equitySeriesRef.current = null;
        }
        // Com RSI num 2.º painel, não derrubar painéis aqui — este efeito volta a correr
        // (ex.: ``backtestChart``) e apagava o painel do RSI sem o efeito do RSI voltar a criar.
        if (!showRsiPane && !showMacdPane && !showDerivedStudyPane && !showDeltaPane && !showFeatPane) {
          while (ch.panes().length > 1) {
            try {
              ch.removePane(ch.panes().length - 1);
            } catch {
              break;
            }
          }
          try {
            ch.panes()[0]?.setStretchFactor(1);
          } catch {
            /* ignore */
          }
        }
        restoreVisibleLogicalRange(keepRange);
      };
      clearOnly();
      return;
    }
    const chart = chartRef.current;
    if (!chart) return;

    const clearEquityPane = () => {
      const eq = equitySeriesRef.current;
      if (eq) {
        try {
          chart.removeSeries(eq);
        } catch {
          /* ignore */
        }
        equitySeriesRef.current = null;
      }
      while (chart.panes().length > 1) {
        try {
          chart.removePane(chart.panes().length - 1);
        } catch {
          break;
        }
      }
    };

    const eqPoints = backtestChart?.overlay?.equity;
    if (!eqPoints?.length) {
      clearEquityPane();
      return;
    }

    if (chart.panes().length < 2) {
      chart.addPane(false);
    }

    const data = chartTimeSeriesSortedUniqueByTime(
      eqPoints.map((p) => ({
        time: p.t as UTCTimestamp,
        value: p.v,
      })),
    );

    if (!equitySeriesRef.current) {
      equitySeriesRef.current = chart.addSeries(
        LineSeries,
        {
          color: "#a78bfa",
          lineWidth: 2,
          priceScaleId: "bt_equity",
          lastValueVisible: true,
          priceLineVisible: false,
          title: "Equity",
        },
        1,
      );
      try {
        chart.priceScale("bt_equity", 1).applyOptions({
          autoScale: true,
          borderColor: CHART_BORDER,
          scaleMargins: { top: 0.1, bottom: 0.08 },
        });
        const panes = chart.panes();
        if (panes[0] && panes[1]) {
          panes[0].setStretchFactor(0.68);
          panes[1].setStretchFactor(0.32);
        }
      } catch {
        /* ignore */
      }
    } else {
      try {
        const panes = chart.panes();
        if (panes[0] && panes[1]) {
          panes[0].setStretchFactor(0.68);
          panes[1].setStretchFactor(0.32);
        }
      } catch {
        /* ignore */
      }
    }
    equitySeriesRef.current?.setData(data);
  }, [
    backtestChart,
    shouldEmbedEquity,
    showRsiPane,
    showMacdPane,
    showDerivedStudyPane,
    showDeltaPane,
    showFeatPane,
  ]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const keepRange = chart.timeScale().getVisibleLogicalRange() ?? visibleLogicalRangeRef.current;
    const equityPaneWanted =
      shouldEmbedEquity && (backtestChart?.overlay?.equity?.length ?? 0) > 0;
    const studyExtras =
      (showRsiPane ? 1 : 0) +
      (showMacdPane ? 1 : 0) +
      (showDerivedStudyPane ? 1 : 0) +
      (showDeltaPane ? 1 : 0) +
      (showFeatPane ? 1 : 0);
    const want = equityPaneWanted ? 2 : 1 + studyExtras;
    try {
      while (chart.panes().length > want && chart.panes().length > 1) {
        chart.removePane(chart.panes().length - 1);
      }
      while (chart.panes().length < want) {
        chart.addPane(false);
      }
      const panes = chart.panes();
      if (!equityPaneWanted) {
        if (studyExtras === 0) {
          panes[0]?.setStretchFactor(1);
        } else if (studyExtras === 1) {
          panes[0]?.setStretchFactor(0.72);
          panes[1]?.setStretchFactor(0.28);
        } else if (studyExtras === 2) {
          panes[0]?.setStretchFactor(0.62);
          panes[1]?.setStretchFactor(0.19);
          panes[2]?.setStretchFactor(0.19);
        } else if (studyExtras === 3) {
          panes[0]?.setStretchFactor(0.55);
          panes[1]?.setStretchFactor(0.15);
          panes[2]?.setStretchFactor(0.15);
          panes[3]?.setStretchFactor(0.15);
        } else {
          panes[0]?.setStretchFactor(0.5);
          panes[1]?.setStretchFactor(0.125);
          panes[2]?.setStretchFactor(0.125);
          panes[3]?.setStretchFactor(0.125);
          panes[4]?.setStretchFactor(0.125);
        }
        for (let pi = 1; pi < panes.length; pi++) {
          chart.priceScale("right", pi).applyOptions({
            autoScale: true,
            borderColor: CHART_BORDER,
            scaleMargins: { ...RSI_PRICE_SCALE_MARGINS },
          });
        }
      }
    } catch {
      /* ignore */
    }
    queueMicrotask(() => {
      setPaneLayoutRevision((n) => n + 1);
      restoreVisibleLogicalRange(keepRange);
    });
  }, [
    resetKey,
    shouldEmbedEquity,
    backtestChart?.overlay?.equity?.length,
    showRsiPane,
    showMacdPane,
    showDerivedStudyPane,
    showDeltaPane,
    showFeatPane,
  ]);

  useEffect(() => {
    const ch = chartRef.current;
    if (!ch) return;
    try {
      const keepRange = ch.timeScale().getVisibleLogicalRange() ?? visibleLogicalRangeRef.current;
      ch.applyOptions({ width: dims.w, height: dims.mainH });
      ch.timeScale().applyOptions({
        visible: true,
        ...LINKED_TIME_SCALE,
      });
      restoreVisibleLogicalRange(keepRange);
    } catch {
      /* chart disposed */
    }
  }, [dims.w, dims.mainH]);

  /** Remove séries RSI quando o painel é desligado (layout de painéis: efeito ``sync`` acima). */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const clearRsi = () => {
      for (const [, ser] of [...rsiLineMapRef.current.entries()]) {
        try {
          chart.removeSeries(ser);
        } catch {
          /* ignore */
        }
      }
      rsiLineMapRef.current.clear();
    };
    if (!showRsiPane) {
      clearRsi();
      return;
    }
    return () => {
      clearRsi();
    };
  }, [showRsiPane]);

  useEffect(() => {
    if (resetKey !== prevResetKeyRef.current) {
      prevResetKeyRef.current = resetKey;
      prevBarsRef.current = [];
      prevBarsFingerprintRef.current = "";
      olderRequestInFlightRef.current = false;
      olderLoadArmedRef.current = true;
      suppressAutoOlderLoadUntilRef.current = 0;
      derivedPaneHydrateRetriesRef.current = 0;
      deltaPaneHydrateRetriesRef.current = 0;
      featPaneHydrateRetriesRef.current = 0;
    }
  }, [resetKey]);

  useEffect(() => {
    const candle = seriesRef.current;
    const vol = volRef.current;
    const chart = chartRef.current;
    if (!candle || !vol || !chart) return;

    const seriesBars = barsSortedUniqueByTime(bars);
    const fp = barsDataFingerprint(seriesBars);
    if (fp === prevBarsFingerprintRef.current) return;

    const cdata = seriesBars.map((b) => ({
      time: b.t as import("lightweight-charts").UTCTimestamp,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
    }));

    const vdata = seriesBars.map((b) => ({
      time: b.t as import("lightweight-charts").UTCTimestamp,
      value: b.v,
      color: b.c >= b.o ? "#26a69a55" : "#ef535055",
    }));

    const prev = prevBarsRef.current;
    const prevSeries = barsSortedUniqueByTime(prev);
    const isPrepend =
      prevSeries.length > 0 &&
      seriesBars.length > prev.length &&
      seriesBars[0].t < prevSeries[0].t;

    try {
      if (isPrepend) {
        const lr = chart.timeScale().getVisibleLogicalRange();
        candle.setData(cdata);
        vol.setData(vdata);
        const delta = seriesBars.length - prevSeries.length;
        if (lr && delta > 0) {
          chart.timeScale().setVisibleLogicalRange({
            from: lr.from + delta,
            to: lr.to + delta,
          });
        } else if (delta > 0) {
          /** Sem range antes de ``setData`` — evitar vista em 0..n (dispara histórico sem parar). */
          const vis = Math.min(FIRST_VIEW_VISIBLE_LOGICAL_BARS, Math.max(96, seriesBars.length));
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, seriesBars.length - vis),
            to: seriesBars.length - 1,
          });
        }
        suppressAutoOlderLoadUntilRef.current = Date.now() + AUTO_OLDER_SUPPRESS_MS;
      } else {
        const sameHistoryStart =
          prevSeries.length > 0 &&
          seriesBars.length > 0 &&
          seriesBars[0].t === prevSeries[0].t;
        candle.setData(cdata);
        vol.setData(vdata);
        /** Atualizações live (cauda / mesma vela): não resetar zoom com fitContent. */
        if (!sameHistoryStart) {
          const n = seriesBars.length;
          if (n <= FIRST_VIEW_FULL_FIT_MAX_BARS) {
            chart.timeScale().fitContent();
          } else {
            const vis = Math.min(
              FIRST_VIEW_VISIBLE_LOGICAL_BARS,
              Math.max(160, Math.floor(n * 0.42)),
            );
            chart.timeScale().setVisibleLogicalRange({
              from: Math.max(0, n - vis),
              to: n - 1,
            });
          }
          suppressAutoOlderLoadUntilRef.current = Date.now() + AUTO_OLDER_SUPPRESS_MS;
        }
      }
      if (seriesBars.length > 0) {
        candle.applyOptions({
          priceFormat: mainChartPriceFormatFromBars(seriesBars),
        });
      }
    } catch {
      /* Object is disposed — evitar crash durante remount/HMR */
    }

    prevBarsRef.current = seriesBars;
    prevBarsFingerprintRef.current = fp;
  }, [bars]);

  useEffect(() => {
    const chart = chartRef.current;
    const candle = seriesRef.current;
    if (!chart || !candle) return;

    const removeMid = () => {
      const s = liveMidLineRef.current;
      if (s) {
        try {
          chart.removeSeries(s);
        } catch {
          /* ignore */
        }
        liveMidLineRef.current = null;
      }
    };
    const removeOi = () => {
      const s = liveOiLineRef.current;
      if (s) {
        try {
          chart.removeSeries(s);
        } catch {
          /* ignore */
        }
        liveOiLineRef.current = null;
        try {
          chart.applyOptions({ leftPriceScale: { visible: false } });
        } catch {
          /* ignore */
        }
      }
    };
    const removeSp = () => {
      const s = liveSpreadHistRef.current;
      if (s) {
        try {
          chart.removeSeries(s);
        } catch {
          /* ignore */
        }
        liveSpreadHistRef.current = null;
      }
    };
    const removeLiqHist = () => {
      const s = liveLiqHistRef.current;
      if (s) {
        try {
          chart.removeSeries(s);
        } catch {
          /* ignore */
        }
        liveLiqHistRef.current = null;
      }
    };

    if (!liveSnapshot) {
      removeMid();
      removeOi();
      removeSp();
      removeLiqHist();
      liqMicroPrimitiveRef.current?.clear();
      try {
        seriesMarkersRef.current?.setMarkers([]);
      } catch {
        /* ignore */
      }
      return;
    }

    /** Marcadores/histograma usam o mesmo `time` que as velas; senão o lightweight-charts quase não mostra nada. */
    const nearestBarTime = (sec: number): number => {
      const list = barsRef.current;
      if (!list.length) return sec;
      let best = list[0].t;
      let bestD = Math.abs(sec - best);
      for (const b of list) {
        const d = Math.abs(sec - b.t);
        if (d < bestD) {
          bestD = d;
          best = b.t;
        }
      }
      return best;
    };

    const dedupeTimeKeepLast = (pts: { time: UTCTimestamp; value: number }[]) => {
      const m = new Map<number, number>();
      for (const p of pts) {
        m.set(p.time as number, p.value);
      }
      return Array.from(m.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([t, value]) => ({ time: t as UTCTimestamp, value }));
    };

    const barList = bars;
    const ob = liveSnapshot.order_book_series;
    const midPtsRaw = dedupeTimeKeepLast(
      ob
        .filter((r) => Number.isFinite(r.best_bid) && Number.isFinite(r.best_ask))
        .map((r) => ({
          time: r.t as UTCTimestamp,
          value: (r.best_bid + r.best_ask) / 2,
        })),
    );
    const midForSet = resampleLiveScalarToBarTimes(barList, midPtsRaw);

    if (midForSet.length > 0) {
      if (!liveMidLineRef.current) {
        liveMidLineRef.current = chart.addSeries(LineSeries, {
          color: "#22d3ee",
          lineWidth: 2,
          priceScaleId: "right",
          lastValueVisible: true,
          priceLineVisible: false,
          title: "Mid",
        });
      }
      liveMidLineRef.current.applyOptions({ color: "#22d3ee", title: "Mid" });
      liveMidLineRef.current.setData(chartTimeSeriesSortedUniqueByTime(midForSet));
    } else {
      const mk = Number(liveSnapshot.funding?.mark_price);
      if (Number.isFinite(mk) && liveSnapshot.funding) {
        const markRaw = [
          { time: liveSnapshot.funding.t as UTCTimestamp, value: mk },
        ];
        const markForSet = resampleLiveScalarToBarTimes(barList, markRaw);
        if (markForSet.length > 0) {
          if (!liveMidLineRef.current) {
            liveMidLineRef.current = chart.addSeries(LineSeries, {
              color: "#fbbf24",
              lineWidth: 2,
              priceScaleId: "right",
              lastValueVisible: true,
              priceLineVisible: false,
              title: "Mark",
            });
          }
          liveMidLineRef.current.applyOptions({ color: "#fbbf24", title: "Mark" });
          liveMidLineRef.current.setData(chartTimeSeriesSortedUniqueByTime(markForSet));
        } else {
          removeMid();
        }
      } else {
        removeMid();
      }
    }

    const oiPtsRaw = dedupeTimeKeepLast(
      liveSnapshot.open_interest_series
        .filter((r) => Number.isFinite(r.oi))
        .map((r) => ({ time: r.t as UTCTimestamp, value: r.oi })),
    );
    const oiForSet = resampleLiveScalarToBarTimes(barList, oiPtsRaw);

    if (oiForSet.length >= 2) {
      if (!liveOiLineRef.current) {
        try {
          chart.applyOptions({
            leftPriceScale: {
              visible: true,
              borderColor: CHART_BORDER,
              scaleMargins: { top: 0.1, bottom: 0.12 },
            },
          });
        } catch {
          /* ignore */
        }
        liveOiLineRef.current = chart.addSeries(LineSeries, {
          color: "#c084fc",
          lineWidth: 1,
          priceScaleId: "left",
          lastValueVisible: true,
          priceLineVisible: false,
          title: "OI",
        });
      }
      liveOiLineRef.current.setData(chartTimeSeriesSortedUniqueByTime(oiForSet));
    } else {
      removeOi();
    }

    const spPtsRaw = ob
      .filter((r) => Number.isFinite(r.spread) && r.spread >= 0)
      .map((r) => ({
        time: r.t as UTCTimestamp,
        value: r.spread,
        color: "rgba(244, 114, 182, 0.45)",
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    const spForSet = resampleSpreadHistToBarTimes(barList, spPtsRaw);

    if (spForSet.length >= 2) {
      if (!liveSpreadHistRef.current) {
        liveSpreadHistRef.current = chart.addSeries(HistogramSeries, {
          priceScaleId: "live_spread",
          priceFormat: { type: "price", precision: 8, minMove: 1e-8 },
        });
        try {
          chart.priceScale("live_spread").applyOptions({
            scaleMargins: { top: 0.82, bottom: 0.02 },
            borderColor: CHART_BORDER,
          });
        } catch {
          /* ignore */
        }
      }
      liveSpreadHistRef.current.setData(chartTimeSeriesSortedUniqueByTime(spForSet));
    } else {
      removeSp();
    }

    removeLiqHist();

    const liqRows = liveSnapshot.liquidations.filter(
      (l) => l.t != null && l.price != null && Number.isFinite(l.price),
    );

    const micro: LiquidationMicroCandle[] = [];
    for (const l of liqRows) {
      const side = String(l.side || "").toLowerCase();
      /** Long liquidado ↔ venda forçada (CCXT/Binance: ``sell`` ou texto ``long``). */
      const longLiq =
        side.includes("short") || side === "buy"
          ? false
          : side.includes("long") || side === "sell"
            ? true
            : true;
      const barT = nearestBarTime(l.t);
      const p = Number(l.price);
      if (!Number.isFinite(p)) continue;
      const c = Math.abs(Number(l.contracts) || 0) || 0.0001;
      micro.push({ barT, price: p, contracts: c, longLiq });
    }

    try {
      seriesMarkersRef.current?.setMarkers([]);
    } catch {
      /* ignore */
    }

    if (barList.length > 0 && micro.length > 0) {
      liqMicroPrimitiveRef.current?.setItems(
        barList.map((b) => b.t),
        micro,
      );
    } else {
      liqMicroPrimitiveRef.current?.clear();
    }
  }, [liveSnapshot, bars]);

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = chartRef.current;
    const map = indLineRef.current;
    const defs = indicatorDefs;
    const vis = indicatorVisibility;
    const want = collectMainLineKeys(defs, vis, taServerTalibMulti, derivedStudyIds);

    for (const [key, ser] of [...map.entries()]) {
      if (!want.has(key)) {
        try {
          chart.removeSeries(ser);
        } catch {
          /* ignore */
        }
        map.delete(key);
      }
    }

    let hasAtr = false;
    for (const d of defs) {
      if (d.kind === "macd" || vis[d.id] === false) continue;
      if (d.kind === "trend_composite" && d.group === "studies") continue;
      if (d.kind === "talib" && !talibDrawsOnMainPricePane(d)) continue;
      if (d.kind === "derived" && derivedStudyIds.has(d.id)) continue;

      if (d.kind === "sma") {
        const lineColor = d.color ?? "#c4b5fd";
        const lineWidth = d.lineWidth ?? 2;
        const data = chartTimeSeriesSortedUniqueByTime(taServerLines?.[d.id] ?? []);
        let ser = map.get(d.id);
        if (!ser) {
          ser = chart.addSeries(LineSeries, {
            color: lineColor,
            lineWidth,
            priceScaleId: "right",
            lastValueVisible: true,
            priceLineVisible: false,
          });
          map.set(d.id, ser);
        }
        ser.applyOptions({ color: lineColor, lineWidth });
        ser.setData(data);
      } else if (d.kind === "atr") {
        hasAtr = true;
        const lineColor = d.color ?? "#fb923c";
        const lineWidth = d.lineWidth ?? 2;
        const data = chartTimeSeriesSortedUniqueByTime(taServerLines?.[d.id] ?? []);
        let ser = map.get(d.id);
        if (!ser) {
          ser = chart.addSeries(LineSeries, {
            color: lineColor,
            lineWidth,
            priceScaleId: "left",
            lastValueVisible: true,
            priceLineVisible: false,
          });
          map.set(d.id, ser);
        }
        ser.applyOptions({ color: lineColor, lineWidth });
        ser.setData(data);
      } else if (d.kind === "derived") {
        const lineColor = d.color ?? "#f472b6";
        const lineWidth = d.lineWidth ?? 2;
        const data = chartTimeSeriesSortedUniqueByTime(taServerLines?.[d.id] ?? []);
        let ser = map.get(d.id);
        if (!ser) {
          ser = chart.addSeries(LineSeries, {
            color: lineColor,
            lineWidth,
            priceScaleId: "right",
            lastValueVisible: true,
            priceLineVisible: false,
          });
          map.set(d.id, ser);
        }
        ser.applyOptions({ color: lineColor, lineWidth });
        ser.setData(data);
      } else if (d.kind === "talib") {
        const palette = ["#38bdf8", "#a78bfa", "#f472b6", "#fbbf24", "#4ade80"];
        const multi = taServerTalibMulti?.[d.id];
        if (multi && Object.keys(multi).length > 0) {
          const keys = Object.keys(multi).sort();
          keys.forEach((oname, idx) => {
            const fullKey = `${d.id}__${oname}`;
            const data = chartTimeSeriesSortedUniqueByTime(multi[oname] ?? []);
            const lineColor = palette[idx % palette.length];
            const lineWidth = d.lineWidth ?? 2;
            let ser = map.get(fullKey);
            if (!ser) {
              ser = chart.addSeries(LineSeries, {
                color: lineColor,
                lineWidth,
                priceScaleId: "right",
                lastValueVisible: true,
                priceLineVisible: false,
              });
              map.set(fullKey, ser);
            }
            ser.applyOptions({ color: lineColor, lineWidth });
            ser.setData(data);
          });
        } else {
          const lineColor = d.color ?? "#38bdf8";
          const lineWidth = d.lineWidth ?? 2;
          const data = chartTimeSeriesSortedUniqueByTime(taServerLines?.[d.id] ?? []);
          let ser = map.get(d.id);
          if (!ser) {
            ser = chart.addSeries(LineSeries, {
              color: lineColor,
              lineWidth,
              priceScaleId: "right",
              lastValueVisible: true,
              priceLineVisible: false,
            });
            map.set(d.id, ser);
          }
          ser.applyOptions({ color: lineColor, lineWidth });
          ser.setData(data);
        }
      }
    }

    try {
      chart.priceScale("left").applyOptions({
        visible: hasAtr,
        autoScale: true,
        borderColor: CHART_BORDER,
        scaleMargins: { top: 0.12, bottom: 0.2 },
      });
    } catch {
      /* ignore */
    }

    chart.priceScale("right").applyOptions({
      scaleMargins: { ...MAIN_PRICE_SCALE_MARGINS },
    });
  }, [resetKey, bars, indicatorDefs, indicatorVisibility, taServerLines, taServerTalibMulti, derivedStudyIds]);

  useEffect(() => {
    if (!showRsiPane) return;
    const chart = chartRef.current;
    if (!chart) return;
    if (chart.panes().length < 2) return;

    const map = rsiLineMapRef.current;
    const defs = indicatorDefs.filter((d) => {
      if (indicatorVisibility[d.id] === false) return false;
      return talibInRsiStudyPane(d);
    });
    const want = new Set<string>();
    for (const d of defs) {
      const multi = taServerTalibMulti?.[d.id];
      if (d.kind === "talib" && multi && Object.keys(multi).length > 0) {
        for (const k of Object.keys(multi).sort()) {
          want.add(`${d.id}__${k}`);
        }
      } else {
        want.add(d.id);
      }
    }

    for (const [id, ser] of [...map.entries()]) {
      if (!want.has(id)) {
        try {
          chart.removeSeries(ser);
        } catch {
          /* ignore */
        }
        map.delete(id);
      }
    }

    const palette = ["#38bdf8", "#a78bfa", "#f472b6", "#fbbf24", "#4ade80"];
    defs.forEach((d) => {
      const lineWidth = d.lineWidth ?? 2;
      const multi = taServerTalibMulti?.[d.id];
      if (d.kind === "talib" && multi && Object.keys(multi).length > 0) {
        const keys = Object.keys(multi).sort();
        keys.forEach((oname, idx) => {
          const fullKey = `${d.id}__${oname}`;
          const data = chartTimeSeriesSortedUniqueByTime(multi[oname] ?? []);
          const lineColor = palette[idx % palette.length];
          let ser = map.get(fullKey);
          if (!ser) {
            ser = chart.addSeries(
              LineSeries,
              {
                color: lineColor,
                lineWidth,
                lastValueVisible: true,
                priceLineVisible: false,
                priceScaleId: "right",
              },
              1,
            );
            map.set(fullKey, ser);
          }
          ser.applyOptions({ color: lineColor, lineWidth });
          ser.setData(data);
          applyStudyPriceFormatFromValues(ser, data.map((p) => p.value));
        });
        return;
      }
      let ser = map.get(d.id);
      if (!ser) {
        ser = chart.addSeries(
          LineSeries,
          {
            color: "#94a3b8",
            lineWidth,
            lastValueVisible: true,
            priceLineVisible: false,
            priceScaleId: "right",
          },
          1,
        );
        map.set(d.id, ser);
      }
      const lineColor = d.color ?? "#38bdf8";
      const data = chartTimeSeriesSortedUniqueByTime(taServerLines?.[d.id] ?? []);
      ser.applyOptions({ color: lineColor, lineWidth });
      ser.setData(data);
      applyStudyPriceFormatFromValues(ser, data.map((p) => p.value));
    });
  }, [resetKey, indicatorDefs, indicatorVisibility, showRsiPane, taServerLines, taServerTalibMulti]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const dropMacdId = (id: string) => {
      const serM = macdMacdLineRef.current.get(id);
      if (serM) {
        try {
          chart.removeSeries(serM);
        } catch {
          /* ignore */
        }
        macdMacdLineRef.current.delete(id);
      }
      const serS = macdSignalLineRef.current.get(id);
      if (serS) {
        try {
          chart.removeSeries(serS);
        } catch {
          /* ignore */
        }
        macdSignalLineRef.current.delete(id);
      }
      const serH = macdHistRef.current.get(id);
      if (serH) {
        try {
          chart.removeSeries(serH);
        } catch {
          /* ignore */
        }
        macdHistRef.current.delete(id);
      }
    };

    if (!showMacdPane) {
      for (const id of [...macdMacdLineRef.current.keys()]) dropMacdId(id);
      return;
    }

    const macdPane = showRsiPane ? 2 : 1;
    if (chart.panes().length <= macdPane) return;

    const defs = indicatorDefs.filter((d) => {
      if (indicatorVisibility[d.id] === false) return false;
      if (d.kind === "macd") return true;
      if (d.kind === "talib" && d.talibFunction?.toUpperCase() === "MACD") return true;
      return false;
    });
    const want = new Set(defs.map((d) => d.id));
    for (const id of [...macdMacdLineRef.current.keys()]) {
      if (!want.has(id)) dropMacdId(id);
    }

    const bundles = taServerMacd ?? {};

    defs.forEach((d) => {
      const b = bundles[d.id];
      if (!b?.macd?.length) {
        dropMacdId(d.id);
        return;
      }
      const cM = d.color ?? "#22d3ee";
      const lw = d.lineWidth ?? 2;

      let serM = macdMacdLineRef.current.get(d.id);
      if (!serM) {
        serM = chart.addSeries(
          LineSeries,
          {
            color: cM,
            lineWidth: lw,
            lastValueVisible: true,
            priceLineVisible: false,
            priceScaleId: "right",
          },
          macdPane,
        );
        macdMacdLineRef.current.set(d.id, serM);
      }
      const macdPts = chartTimeSeriesSortedUniqueByTime(b.macd);
      const sigPts = chartTimeSeriesSortedUniqueByTime(b.signal);
      const histPts = chartTimeSeriesSortedUniqueByTime(b.histogram);
      const macdFmt = studyPriceFormatFromNumericSamples([
        ...macdPts.map((p) => p.value),
        ...sigPts.map((p) => p.value),
        ...histPts.map((p) => p.value),
      ]);

      serM.applyOptions({ color: cM, lineWidth: lw, priceFormat: macdFmt });
      serM.setData(macdPts);

      let serS = macdSignalLineRef.current.get(d.id);
      if (!serS) {
        serS = chart.addSeries(
          LineSeries,
          {
            color: "#a78bfa",
            lineWidth: lw,
            lastValueVisible: false,
            priceLineVisible: false,
            priceScaleId: "right",
          },
          macdPane,
        );
        macdSignalLineRef.current.set(d.id, serS);
      }
      serS.applyOptions({ lineWidth: lw, priceFormat: macdFmt });
      serS.setData(sigPts);

      let serH = macdHistRef.current.get(d.id);
      if (!serH) {
        serH = chart.addSeries(
          HistogramSeries,
          {
            priceScaleId: "right",
            priceFormat: macdFmt,
          },
          macdPane,
        );
        macdHistRef.current.set(d.id, serH);
      }
      serH.applyOptions({ priceFormat: macdFmt });
      serH.setData(histPts);
    });
  }, [resetKey, showMacdPane, showRsiPane, indicatorDefs, indicatorVisibility, taServerMacd]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const map = derivedStudyLineRef.current;
    if (map.size === 0) return;
    for (const ser of map.values()) {
      try {
        chart.removeSeries(ser);
      } catch {
        /* série ou painel já recriado */
      }
    }
    map.clear();
    derivedPaneHydrateRetriesRef.current = 0;
  }, [resetKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const map = derivedStudyLineRef.current;
    if (!chart) return;

    const clearAll = () => {
      for (const [, ser] of [...map.entries()]) {
        try {
          chart.removeSeries(ser);
        } catch {
          /* ignore */
        }
      }
      map.clear();
    };

    if (!showDerivedStudyPane) {
      clearAll();
      derivedPaneHydrateRetriesRef.current = 0;
      return;
    }

    if (chart.panes().length <= derivedStudyPaneIndex) {
      if (derivedPaneHydrateRetriesRef.current < 20) {
        derivedPaneHydrateRetriesRef.current += 1;
        queueMicrotask(() => {
          setPaneLayoutRevision((n) => n + 1);
        });
      }
      return;
    }
    derivedPaneHydrateRetriesRef.current = 0;

    const want = new Set(visibleDerivedStudyDefs.map((d) => d.id));
    for (const id of [...map.keys()]) {
      if (want.has(id)) continue;
      const ser = map.get(id);
      if (ser) {
        try {
          chart.removeSeries(ser);
        } catch {
          /* ignore */
        }
      }
      map.delete(id);
    }

    for (const d of visibleDerivedStudyDefs) {
      const data = chartTimeSeriesSortedUniqueByTime(taServerLines?.[d.id] ?? []);
      const lineColor = d.color ?? "#f472b6";
      const lineWidth = d.lineWidth ?? 2;
      let ser = map.get(d.id);
      if (!ser) {
        ser = chart.addSeries(
          LineSeries,
          {
            color: lineColor,
            lineWidth,
            lastValueVisible: true,
            priceLineVisible: false,
            priceScaleId: "right",
          },
          derivedStudyPaneIndex,
        );
        map.set(d.id, ser);
      }
      ser.applyOptions({ color: lineColor, lineWidth });
      ser.setData(data);
      applyStudyPriceFormatFromValues(ser, data.map((p) => p.value));
    }
  }, [
    resetKey,
    paneLayoutRevision,
    showDerivedStudyPane,
    derivedStudyPaneIndex,
    visibleDerivedStudyDefs,
    taServerLines,
  ]);

  /** Ao mudar par/reset, remove séries Δ antigas (referências inválidas depois de ``removePane`` no sync). */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const map = deltaStudyLineRef.current;
    if (map.size === 0) return;
    for (const ser of map.values()) {
      try {
        chart.removeSeries(ser);
      } catch {
        /* série ou painel já recriado */
      }
    }
    map.clear();
    deltaPaneHydrateRetriesRef.current = 0;
  }, [resetKey]);

  /** Painel apenas com linhas Δ (abaixo dos outros estudos). */
  useEffect(() => {
    const chart = chartRef.current;
    const map = deltaStudyLineRef.current;
    if (!chart) return;

    const clearOrphans = (wantKeys: Set<string>) => {
      for (const key of [...map.keys()]) {
        if (wantKeys.has(key)) continue;
        const ser = map.get(key);
        if (ser) {
          try {
            chart.removeSeries(ser);
          } catch {
            /* ignore */
          }
        }
        map.delete(key);
      }
    };

    const ensureLine = (
      key: string,
      color: string,
      lw: 1 | 2 | 3 | 4,
      paneIdx: number,
    ): ISeriesApi<"Line", Time> => {
      let ser = map.get(key);
      const st =
        ser && typeof (ser as { seriesType?: () => string }).seriesType === "function"
          ? (ser as { seriesType: () => string }).seriesType()
          : "";
      if (ser && st !== "Line") {
        try {
          chart.removeSeries(ser);
        } catch {
          /* ignore */
        }
        map.delete(key);
        ser = undefined;
      }
      if (!ser) {
        ser = chart.addSeries(
          LineSeries,
          {
            color,
            lineWidth: lw,
            priceScaleId: "right",
            lastValueVisible: true,
            priceLineVisible: false,
          },
          paneIdx,
        );
        map.set(key, ser);
      } else {
        ser.applyOptions({
          color,
          lineWidth: lw,
        } satisfies Parameters<ISeriesApi<"Line">["applyOptions"]>[0]);
      }
      return ser as ISeriesApi<"Line", Time>;
    };

    const ensureHist = (
      key: string,
      paneIdx: number,
    ): ISeriesApi<"Histogram", Time> => {
      let ser = map.get(key);
      const st =
        ser && typeof (ser as { seriesType?: () => string }).seriesType === "function"
          ? (ser as { seriesType: () => string }).seriesType()
          : "";
      if (ser && st !== "Histogram") {
        try {
          chart.removeSeries(ser);
        } catch {
          /* ignore */
        }
        map.delete(key);
        ser = undefined;
      }
      if (!ser) {
        ser = chart.addSeries(
          HistogramSeries,
          {
            priceScaleId: "right",
          },
          paneIdx,
        );
        map.set(key, ser);
      }
      return ser as ISeriesApi<"Histogram", Time>;
    };

    const wantKeys = new Set<string>();

    if (!showDeltaPane) {
      clearOrphans(wantKeys);
      return;
    }

    /** Painel Índice ``deltaStudyPaneIndex`` ainda não existe (ordem dos efeitos / ``addPane``). Re-dispara render limitado. */
    if (chart.panes().length <= deltaStudyPaneIndex) {
      if (deltaPaneHydrateRetriesRef.current < 20) {
        deltaPaneHydrateRetriesRef.current += 1;
        queueMicrotask(() => {
          setPaneLayoutRevision((n) => n + 1);
        });
      }
      return;
    }
    deltaPaneHydrateRetriesRef.current = 0;

    const dpi = deltaStudyPaneIndex;
    const defs = indicatorDefs;
    const vis = indicatorVisibility;

    try {
      for (const d of defs) {
        if (vis[d.id] === false) continue;
        if (effectiveDeltaLookbackBars(d) < 1) continue;

        const taLn = taServerLines?.[d.id];
        const taMac = taServerMacd?.[d.id];
        const taMulti = taServerTalibMulti?.[d.id];

        if (d.kind === "sma" && taLn?.length) {
          const k = `Δ::${d.id}`;
          wantKeys.add(k);
          const pts = chartTimeSeriesSortedUniqueByTime(maybeApplyIndicatorDeltaSeries(d, bars, taLn));
          const ser = ensureLine(k, d.color ?? "#c4b5fd", d.lineWidth ?? 2, dpi);
          ser.setData(pts);
          applyStudyPriceFormatFromValues(ser, pts.map((p) => p.value));
          continue;
        }

        if (d.kind === "atr" && taLn?.length) {
          const k = `Δ::${d.id}`;
          wantKeys.add(k);
          const pts = chartTimeSeriesSortedUniqueByTime(maybeApplyIndicatorDeltaSeries(d, bars, taLn));
          const ser = ensureLine(k, d.color ?? "#fb923c", d.lineWidth ?? 2, dpi);
          ser.setData(pts);
          applyStudyPriceFormatFromValues(ser, pts.map((p) => p.value));
          continue;
        }

        if (d.kind === "macd" && taMac?.macd?.length) {
          const kM = `Δ::${d.id}::m`;
          const kS = `Δ::${d.id}::s`;
          const kH = `Δ::${d.id}::h`;
          wantKeys.add(kM);
          wantKeys.add(kS);
          wantKeys.add(kH);
          const cM = d.color ?? "#22d3ee";
          const lw = d.lineWidth ?? 2;
          const ptsM = chartTimeSeriesSortedUniqueByTime(maybeApplyIndicatorDeltaSeries(d, bars, taMac.macd));
          const serM = ensureLine(kM, cM, lw, dpi);
          serM.setData(ptsM);
          applyStudyPriceFormatFromValues(serM, ptsM.map((p) => p.value));
          const ptsS = chartTimeSeriesSortedUniqueByTime(maybeApplyIndicatorDeltaSeries(d, bars, taMac.signal));
          const serS = ensureLine(kS, "#a78bfa", lw, dpi);
          serS.setData(ptsS);
          applyStudyPriceFormatFromValues(serS, ptsS.map((p) => p.value));
          const histPts = taMac.histogram.map((p) => ({ time: p.time, value: p.value }));
          const dh = chartTimeSeriesSortedUniqueByTime(maybeApplyIndicatorDeltaSeries(d, bars, histPts));
          const serH = ensureHist(kH, dpi);
          serH.setData(
            dh.map((pt) => ({
              time: pt.time,
              value: pt.value,
              color: deltaHistogramColor(pt.value),
            })),
          );
          applyStudyPriceFormatFromValues(serH, dh.map((p) => p.value));
          continue;
        }

        if (d.kind === "talib") {
          if (taMac?.macd?.length && d.talibFunction?.toUpperCase() === "MACD") {
            const kM = `Δ::${d.id}::tm`;
            const kS = `Δ::${d.id}::ts`;
            const kH = `Δ::${d.id}::th`;
            wantKeys.add(kM);
            wantKeys.add(kS);
            wantKeys.add(kH);
            const cM = d.color ?? "#22d3ee";
            const lw = d.lineWidth ?? 2;
            const ptsM = chartTimeSeriesSortedUniqueByTime(maybeApplyIndicatorDeltaSeries(d, bars, taMac.macd));
            const serM = ensureLine(kM, cM, lw, dpi);
            serM.setData(ptsM);
            applyStudyPriceFormatFromValues(serM, ptsM.map((p) => p.value));
            const ptsS = chartTimeSeriesSortedUniqueByTime(maybeApplyIndicatorDeltaSeries(d, bars, taMac.signal));
            const serS = ensureLine(kS, "#a78bfa", lw, dpi);
            serS.setData(ptsS);
            applyStudyPriceFormatFromValues(serS, ptsS.map((p) => p.value));
            const histPts = taMac.histogram.map((p) => ({ time: p.time, value: p.value }));
            const dh = chartTimeSeriesSortedUniqueByTime(maybeApplyIndicatorDeltaSeries(d, bars, histPts));
            const serH = ensureHist(kH, dpi);
            serH.setData(
              dh.map((pt) => ({
                time: pt.time,
                value: pt.value,
                color: deltaHistogramColor(pt.value),
              })),
            );
            applyStudyPriceFormatFromValues(serH, dh.map((p) => p.value));
            continue;
          }
          if (taMulti && Object.keys(taMulti).length > 0) {
            const keys = Object.keys(taMulti).sort();
            const palette = ["#38bdf8", "#a78bfa", "#f472b6", "#fbbf24", "#4ade80"];
            let idx = 0;
            for (const oname of keys) {
              const line = taMulti[oname];
              if (!line?.length) continue;
              const k = `Δ::${d.id}::${oname}`;
              wantKeys.add(k);
            const pts = chartTimeSeriesSortedUniqueByTime(maybeApplyIndicatorDeltaSeries(d, bars, line));
              const ser = ensureLine(
                k,
                palette[idx % palette.length]!,
                d.lineWidth ?? 2,
                dpi,
              );
              ser.setData(pts);
              applyStudyPriceFormatFromValues(ser, pts.map((p) => p.value));
              idx++;
            }
            continue;
          }
          if (taLn?.length) {
            const k = `Δ::${d.id}`;
            wantKeys.add(k);
            const pts = chartTimeSeriesSortedUniqueByTime(maybeApplyIndicatorDeltaSeries(d, bars, taLn));
            const ser = ensureLine(k, d.color ?? "#38bdf8", d.lineWidth ?? 2, dpi);
            ser.setData(pts);
            applyStudyPriceFormatFromValues(ser, pts.map((p) => p.value));
          }
        }
      }
      clearOrphans(wantKeys);
    } catch {
      /* erro intermédio: não limpar Δ com ``wantKeys`` incompleto */
    }
  }, [
    resetKey,
    paneLayoutRevision,
    showDeltaPane,
    deltaStudyPaneIndex,
    bars,
    indicatorDefs,
    indicatorVisibility,
    taServerLines,
    taServerMacd,
    taServerTalibMulti,
  ]);

  /** Facetas QuestDB: linhas num painel de estudo (API Python já agregou por vela). */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const clearAll = () => {
      for (const [, ser] of [...featLineMapRef.current.entries()]) {
        try {
          chart.removeSeries(ser);
        } catch {
          /* ignore */
        }
      }
      featLineMapRef.current.clear();
    };

    if (!showFeatPane) {
      clearAll();
      return;
    }

    /** Painel de facetas só existe em ``sync`` de layout; mesmo padrão que Δ. */
    if (chart.panes().length <= featStudyPaneIndex) {
      if (featPaneHydrateRetriesRef.current < 20) {
        featPaneHydrateRetriesRef.current += 1;
        queueMicrotask(() => {
          setPaneLayoutRevision((n) => n + 1);
        });
      }
      return;
    }
    featPaneHydrateRetriesRef.current = 0;

    const pi = featStudyPaneIndex;
    const map = featLineMapRef.current;
    const fs = featSeries ?? {};
    const want = new Set<string>();

    try {
      for (const e of CHART_FACT_SERIES) {
        if (featVisibility[e.id] !== true) continue;
        want.add(e.id);
        let ser = map.get(e.id);
        const pf = featSeriesPriceFormat(e.id);
        const data = chartTimeSeriesSortedUniqueByTime(fs[e.id] ?? []);
        if (!ser) {
          ser = chart.addSeries(
            LineSeries,
            {
              color: e.color,
              lineWidth: 2,
              priceScaleId: "right",
              lastValueVisible: true,
              priceLineVisible: false,
              priceFormat: pf,
            },
            pi,
          );
          map.set(e.id, ser);
        } else {
          ser.applyOptions({
            color: e.color,
            priceFormat: pf,
          } satisfies Parameters<ISeriesApi<"Line", Time>["applyOptions"]>[0]);
        }
        ser.setData(data);
      }
      for (const [fid, Ser] of [...map.entries()]) {
        if (!want.has(fid)) {
          try {
            chart.removeSeries(Ser);
          } catch {
            /* ignore */
          }
          map.delete(fid);
        }
      }
    } catch {
      /* série/painéis em estado intermédio */
    }
  }, [
    resetKey,
    paneLayoutRevision,
    showFeatPane,
    featStudyPaneIndex,
    featSeries,
    featVisibility,
  ]);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-1 overflow-hidden">
      {error ? (
        <p className="shrink-0 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      ) : null}
      <div
        ref={outerRef}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-900/95 bg-[#050506] shadow-inner shadow-black/30"
      >
        {backtestChart && backtestKpiInChart ? (
          <div className="shrink-0 border-b border-zinc-800/90 bg-gradient-to-b from-violet-950/20 to-[#08080a] px-2 py-1.5">
            <div className="flex min-h-[1.25rem] flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] leading-tight sm:text-[11px]">
              <span
                className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-violet-400/90"
                title="B/S = entradas (verde/vermelho); fechos com etiqueta C ou S = âmbar; equity abaixo"
              >
                {backtestStrategyLabel?.trim()
                  ? `${backtestStrategyLabel.trim()} — ${
                      backtestOverlayMode === "live"
                        ? "simulação (velas)"
                        : "backtest (QuestDB)"
                    }`
                  : backtestOverlayMode === "live"
                    ? "Simulação (velas do gráfico)"
                    : "Backtest (vectorbt / QuestDB)"}
              </span>
              <span className="shrink-0 text-zinc-500" title="B/S nas velas; equity no painel por baixo">
                B/S · equity
              </span>
              <span className="text-zinc-500">
                retorno{" "}
                <span
                  className="font-semibold tabular-nums text-zinc-200"
                  style={{
                    color: backtestChart.stats.return_pct >= 0 ? "#4ade80" : "#f87171",
                  }}
                >
                  {backtestChart.stats.return_pct >= 0 ? "+" : ""}
                  {backtestChart.stats.return_pct.toFixed(2)}%
                </span>
              </span>
              <span className="text-zinc-500">
                win{" "}
                <span className="font-semibold tabular-nums text-zinc-200">
                  {backtestChart.stats.win_rate.toFixed(1)}%
                </span>
              </span>
              <span className="text-zinc-500">
                trades{" "}
                <span className="font-semibold tabular-nums text-zinc-200">
                  {backtestChart.stats.trades}
                </span>
              </span>
              <span className="text-zinc-500">
                max DD{" "}
                <span className="font-semibold tabular-nums text-rose-300/90">
                  {backtestChart.stats.max_dd.toFixed(2)}%
                </span>
              </span>
              <span className="text-zinc-500">
                Sharpe{" "}
                <span className="font-semibold tabular-nums text-zinc-200">
                  {backtestChart.stats.sharpe.toFixed(2)}
                </span>
              </span>
              <span className="text-zinc-500">
                profit factor{" "}
                <span className="font-semibold tabular-nums text-zinc-200">
                  {backtestChart.stats.profit_fct.toFixed(2)}
                </span>
              </span>
            </div>
          </div>
        ) : null}
        {crosshairHud ? (
          <div
            className="pointer-events-none absolute left-2 top-2 z-30 max-w-[calc(100%-1rem)] rounded-md border border-zinc-700/50 bg-[#0a0a0c]/93 px-2.5 py-2 shadow-lg backdrop-blur-sm"
            aria-live="polite"
          >
            {/* Uma linha fixa; sem flex-wrap para o cartão não crescer quando há indicadores da estratégia. */}
            <div className="flex h-[1.25rem] flex-nowrap items-center gap-x-3 overflow-hidden text-[10px] leading-none sm:h-5 sm:text-[11px]">
              <span className="shrink-0 font-medium text-zinc-500">{crosshairHud.dateStr}</span>
              <span className="text-zinc-500">
                O{" "}
                <span className="font-semibold tabular-nums text-zinc-200">{fmtPx(crosshairHud.o)}</span>
              </span>
              <span className="text-zinc-500">
                H{" "}
                <span className="font-semibold tabular-nums text-zinc-200">{fmtPx(crosshairHud.h)}</span>
              </span>
              <span className="text-zinc-500">
                L{" "}
                <span className="font-semibold tabular-nums text-zinc-200">{fmtPx(crosshairHud.l)}</span>
              </span>
              <span className="text-zinc-500">
                C{" "}
                <span
                  className="font-semibold tabular-nums"
                  style={{
                    color: crosshairHud.c >= crosshairHud.o ? "#26a69a" : "#ef5350",
                  }}
                >
                  {fmtPx(crosshairHud.c)}
                </span>
              </span>
              <span className="text-zinc-500">
                Vol{" "}
                <span className="font-semibold tabular-nums text-zinc-200">
                  {fmtVolCompact(crosshairHud.vol)}
                </span>
              </span>
              <span
                className="shrink-0 font-semibold tabular-nums"
                style={{
                  color: crosshairHud.changePct >= 0 ? "#26a69a" : "#ef5350",
                }}
              >
                {crosshairHud.changePct >= 0 ? "▲" : "▼"}{" "}
                {crosshairHud.changePct >= 0 ? "+" : ""}
                {crosshairHud.changePct.toFixed(2)}%
              </span>
              {crosshairHud.lines.map((line) => (
                <span key={line.key} className="shrink-0 tabular-nums">
                  <span className="font-semibold" style={{ color: line.color ?? "#a1a1aa" }}>
                    {line.label}
                  </span>{" "}
                  <span className="text-zinc-200">{line.value}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {showStudyChrome ? (
          <div
            ref={studyChromeStackRef}
            className="flex shrink-0 flex-col border-b border-zinc-800/70 bg-[#050506] shadow-[inset_0_-1px_0_0_rgba(255,255,255,0.03)]"
          >
            {showRsiPane ? (
              <div
                className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1"
                style={{ minHeight: RSI_STUDY_HEADER_PX }}
              >
                {visibleRsiDefs.length === 0 ? (
                  <span className="text-xs font-semibold tracking-tight text-zinc-500">Estudos</span>
                ) : (
                  visibleRsiDefs.map((d) => {
                    const fn = d.talibFunction?.toUpperCase() ?? "TA-LIB";
                    const tp = d.talibParams?.timeperiod;
                    const c = d.color ?? "#38bdf8";
                    const lab = d.label?.trim() || fn;
                    const sub =
                      tp != null && Number.isFinite(tp) ? String(tp) : fn;
                    return (
                      <span
                        key={d.id}
                        className="inline-flex items-baseline gap-1 text-xs font-semibold tracking-tight"
                        style={{ color: c }}
                      >
                        <span className="truncate">{lab}</span>
                        <span className="text-[10px] font-medium text-zinc-500">{sub}</span>
                      </span>
                    );
                  })
                )}
              </div>
            ) : null}
            {showMacdPane ? (
              <div
                className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-zinc-800/50 px-2.5 py-1"
                style={{ minHeight: RSI_STUDY_HEADER_PX }}
              >
                {visibleMacdDefs.length === 0 ? (
                  <span className="text-xs font-semibold tracking-tight text-zinc-500">MACD</span>
                ) : (
                  visibleMacdDefs.map((d) => {
                    const c = d.color ?? "#22d3ee";
                    const lab = d.label?.trim() || "MACD";
                    if (d.kind === "talib") {
                      const fn = d.talibFunction?.toUpperCase() ?? "MACD";
                      return (
                        <span
                          key={d.id}
                          className="inline-flex items-baseline gap-1 text-xs font-semibold tracking-tight"
                          style={{ color: c }}
                        >
                          <span className="truncate">{lab}</span>
                          <span className="text-[10px] font-medium text-zinc-500">{fn}</span>
                        </span>
                      );
                    }
                    const f = d.fast ?? 12;
                    const s = d.slow ?? 26;
                    const g = d.signal ?? 9;
                    return (
                      <span
                        key={d.id}
                        className="inline-flex items-baseline gap-1 text-xs font-semibold tracking-tight"
                        style={{ color: c }}
                      >
                        <span className="truncate">{lab}</span>
                        <span className="text-[10px] font-medium text-zinc-500">
                          {f}/{s}/{g}
                        </span>
                      </span>
                    );
                  })
                )}
              </div>
            ) : null}
            {showDerivedStudyPane ? (
              <div
                className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-zinc-800/50 px-2.5 py-1"
                style={{ minHeight: RSI_STUDY_HEADER_PX }}
              >
                {visibleDerivedStudyDefs.map((d) => {
                  const c = d.color ?? "#f472b6";
                  const lab = d.label?.trim() || d.id;
                  const sub =
                    d.derived?.mode === "formula"
                      ? d.derived.formula
                      : `${d.derived?.transform?.toUpperCase() ?? "DER"}(${d.derived?.inputRef ?? "close"})`;
                  return (
                    <span
                      key={`derived-study-${d.id}`}
                      className="inline-flex min-w-0 items-baseline gap-1 text-xs font-semibold tracking-tight"
                      style={{ color: c }}
                    >
                      <span className="truncate">{lab}</span>
                      <span className="truncate text-[10px] font-medium text-zinc-500">{sub}</span>
                    </span>
                  );
                })}
              </div>
            ) : null}
            {showDeltaPane ? (
              <div
                className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-zinc-800/50 px-2.5 py-1"
                style={{ minHeight: RSI_STUDY_HEADER_PX }}
              >
                {visibleDeltaStudyDefs.length === 0 ? (
                  <span className="text-xs font-semibold tracking-tight text-zinc-500">Δ</span>
                ) : (
                  visibleDeltaStudyDefs.map((d) => {
                    const lb = effectiveDeltaLookbackBars(d);
                    const n = effectiveDeltaNormalizeByPrice(d);
                    const sub = n ? `Δ${lb} ÷ fecho` : `Δ${lb}`;
                    const lab = d.label?.trim() || d.id;
                    const col = d.color ?? "#94a3b8";
                    return (
                      <span
                        key={`dlt-${d.id}`}
                        className="inline-flex items-baseline gap-1 text-xs font-semibold tracking-tight"
                        style={{ color: col }}
                      >
                        <span className="truncate">{lab}</span>
                        <span className="text-[10px] font-medium tabular-nums text-zinc-500">{sub}</span>
                      </span>
                    );
                  })
                )}
              </div>
            ) : null}
            {showFeatPane ? (
              <div
                className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-zinc-800/50 px-2.5 py-1"
                style={{ minHeight: RSI_STUDY_HEADER_PX }}
              >
                {visibleFeatEntries.length === 0 ? (
                  <span className="text-xs font-semibold tracking-tight text-zinc-500">QuestDB</span>
                ) : (
                  visibleFeatEntries.map((e) => (
                    <span
                      key={e.id}
                      className="inline-flex items-baseline gap-1 text-xs font-semibold tracking-tight"
                      style={{ color: e.color }}
                    >
                      <span className="truncate">{e.label}</span>
                      <span className="font-mono text-[10px] font-medium tabular-nums text-zinc-500">
                        {e.id}
                      </span>
                    </span>
                  ))
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col">
          <div ref={mainWrapRef} className="min-h-0 w-full min-w-0 flex-1" />
          {liveSnapshot && liveSnapshot.ticks.length > 0 ? (
            <div className="shrink-0 border-t border-zinc-800/60 bg-[#050506] px-2 py-1 pr-[52px]">
              <div className="mb-0.5 text-[9px] font-medium uppercase tracking-wide text-zinc-600">
                Tape · heat 40m
              </div>
              <LiveTapeHeatStrip ticks={liveSnapshot.ticks} />
            </div>
          ) : null}
          <div
            className="pointer-events-none absolute bottom-2 left-2 z-20 flex flex-col gap-1"
            role="toolbar"
            aria-label="Ajuste do gráfico"
          >
            <button
              type="button"
              title="Ajustar tempo — mostrar todas as velas"
              aria-label="Ajustar eixo do tempo"
              onClick={fitTimeScale}
              className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-900/90 text-zinc-400 shadow-sm hover:border-zinc-600 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-500"
            >
              <IconFitTime className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Auto-escala do preço"
              aria-label="Auto-escala vertical do preço"
              onClick={fitPriceScale}
              className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-900/90 text-zinc-400 shadow-sm hover:border-zinc-600 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-500"
            >
              <IconFitPrice className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="sr-only">
          Gráficos: Lightweight Charts (TradingView).{" "}
          <a href="https://www.tradingview.com/" className="underline">
            tradingview.com
          </a>
        </p>
      </div>
    </div>
  );
}
