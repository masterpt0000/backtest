"use client";

import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type UTCTimestamp,
  ColorType,
  CrosshairMode,
  LineStyle,
} from "lightweight-charts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { LiveSnapshot } from "@/components/LiveMarketPanel";
import {
  barsAsSourceSeries,
  bollingerSeries,
  emaSeries,
  rsiSeries,
} from "@/lib/indicatorsFromBars";
import { bucketHeatColor, tapeBuyRatioBuckets } from "@/lib/liveTapeHeat";
import { effectiveRsiLineColor } from "@/lib/indicatorLineColors";
import {
  LiquidationMicroCandlesPrimitive,
  type LiquidationMicroCandle,
} from "@/lib/liquidationMicroCandlesPrimitive";
import type { IndicatorSource } from "@/lib/strategies";

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

export type ChartIndicatorDef = {
  id: string;
  kind: "ema" | "bollinger" | "rsi";
  /** Rótulo na UI (ex. cabeçalho do painel RSI). */
  label?: string;
  period?: number;
  mult?: number;
  /** Campo OHLC (ou composto) usado no cálculo. */
  source?: IndicatorSource;
  /** EMA / RSI */
  color?: string;
  /** Bollinger: bandas superior / média / inferior */
  colorUpper?: string;
  colorMid?: string;
  colorLower?: string;
  /** Espessura da linha (1–4). */
  lineWidth?: 1 | 2 | 3 | 4;
};

/** Quando o índice lógico esquerdo fica abaixo disto, pede velas mais antigas. */
const LOAD_MORE_WHEN_FROM = 80;

const EMPTY_DEFS: ChartIndicatorDef[] = [];
const EMPTY_VIS: Record<string, boolean> = {};

/** Altura inicial e fallback quando o flex ainda não deu altura ao contentor (evita ficar preso a 400px). */
function defaultMainChartHeightPx(): number {
  if (typeof window === "undefined") return 640;
  return Math.max(400, Math.floor(window.innerHeight - 180));
}

/** Faixa dedicada ao eixo de tempo (estilo TradingView) — entre o principal e o estudo. */
const TIME_RULER_ROW_PX = 24;

/** Cabeçalho do painel de estudo (nome do indicador, período). */
const RSI_STUDY_HEADER_PX = 22;

/** Altura útil do canvas RSI (px) — um pouco maior para o estudo não parecer “escondido”. */
const RSI_PLOT_HEIGHT_PX = 112;

/** Soma das faixas fixas abaixo do gráfico principal quando o RSI está visível. */
const RSI_STACK_TOTAL_PX = TIME_RULER_ROW_PX + RSI_STUDY_HEADER_PX + RSI_PLOT_HEIGHT_PX;

/**
 * Mesmos valores no gráfico principal e no RSI para o eixo X coincidir.
 * `fixRightEdge` impede pan/zoom para além da última vela (o RSI de linha deixava de parecer prolongar-se no vazio).
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
  if (a >= 1) return x.toFixed(4);
  return x.toFixed(6);
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

function buildIndicatorHudLines(
  bars: CandleApiBar[],
  defs: ChartIndicatorDef[],
  vis: Record<string, boolean>,
  idx: number,
): { key: string; label: string; value: string; color?: string }[] {
  if (idx < 0 || idx >= bars.length) return [];
  const out: { key: string; label: string; value: string; color?: string }[] = [];
  const barT = bars[idx].t as import("lightweight-charts").UTCTimestamp;

  for (const d of defs) {
    if (vis[d.id] === false) continue;
    const src = d.source ?? "close";
    const bs = barsAsSourceSeries(bars, src);

    if (d.kind === "ema") {
      const period = d.period ?? 14;
      const pts = emaSeries(bs, period);
      const v = pts[idx]?.value;
      if (v == null || !Number.isFinite(v)) continue;
      out.push({
        key: d.id,
        label: d.label?.trim() || "EMA",
        value: fmtPx(v),
        color: d.color,
      });
    } else if (d.kind === "bollinger") {
      const period = d.period ?? 20;
      const mult = d.mult ?? 2;
      const { upper, mid, lower } = bollingerSeries(bs, period, mult);
      const u = upper.find((p) => p.time === barT)?.value;
      const m = mid.find((p) => p.time === barT)?.value;
      const l = lower.find((p) => p.time === barT)?.value;
      const base = d.label?.trim() || "BB";
      const cU = d.colorUpper ?? "#71717a";
      const cM = d.colorMid ?? "#a1a1aa";
      const cL = d.colorLower ?? "#71717a";
      if (u != null && Number.isFinite(u))
        out.push({ key: `${d.id}_u`, label: `${base} sup`, value: fmtPx(u), color: cU });
      if (m != null && Number.isFinite(m))
        out.push({ key: `${d.id}_m`, label: `${base}`, value: fmtPx(m), color: cM });
      if (l != null && Number.isFinite(l))
        out.push({ key: `${d.id}_l`, label: `${base} inf`, value: fmtPx(l), color: cL });
    } else if (d.kind === "rsi") {
      const period = d.period ?? 14;
      const pts = rsiSeries(bs, period);
      const v = pts.find((p) => p.time === barT)?.value;
      if (v == null || !Number.isFinite(v)) continue;
      const base = d.label?.trim() || "RSI";
      out.push({
        key: d.id,
        label: `${base} ${period}`,
        value: v.toFixed(1),
        color: effectiveRsiLineColor(d.id, d.color),
      });
    }
  }
  return out;
}

function formatVisibleTime(t: unknown): string {
  if (t == null) return "—";
  if (typeof t === "number") {
    const d = new Date(t * 1000);
    return Number.isNaN(d.getTime())
      ? "—"
      : d.toLocaleDateString("pt-PT", { month: "short", day: "numeric", year: "numeric" });
  }
  if (typeof t === "string") return t;
  if (typeof t === "object" && t !== null && "year" in t && "month" in t && "day" in t) {
    const b = t as { year: number; month: number; day: number };
    return `${String(b.day).padStart(2, "0")}/${String(b.month).padStart(2, "0")}/${b.year}`;
  }
  return "—";
}

function clampVisibleRangeToLastBar(
  tr: { from: unknown; to: unknown },
  lastBarTimeSec: number | null,
): { from: unknown; to: unknown } {
  if (lastBarTimeSec == null) return tr;
  const to = tr.to;
  if (typeof to === "number" && to > lastBarTimeSec) {
    return { ...tr, to: lastBarTimeSec };
  }
  return tr;
}

/**
 * Copia o intervalo de tempo visível entre gráficos.
 * O lightweight-charts pode lançar se o alvo ainda não tiver dados para esse intervalo (ex.: RSI começa mais tarde).
 * Sem fitContent no alvo: evita intervalo estreito no RSI e eco RSI→principal que zoomava o gráfico principal.
 *
 * `lastBarTimeSec`: último timestamp de vela (s); corta `to` se o intervalo incluir “futuro” sem candles
 * (senão a linha do RSI prolongava-se na área vazia à direita).
 */
function safeCopyVisibleTimeRange(
  source: IChartApi,
  target: IChartApi | null | undefined,
  lastBarTimeSec: number | null = null,
): void {
  if (!target) return;
  let tr: { from?: unknown; to?: unknown } | null = null;
  try {
    tr = source.timeScale().getVisibleRange() as { from?: unknown; to?: unknown } | null;
  } catch {
    return;
  }
  if (tr == null || tr.from == null || tr.to == null) return;
  const clamped = clampVisibleRangeToLastBar(
    tr as { from: unknown; to: unknown },
    lastBarTimeSec,
  );
  try {
    // TimeRange (BusinessDay | UTCTimestamp); o tipo público varia entre versões
    target.timeScale().setVisibleRange(clamped as never);
  } catch {
    /* ignorar — fitContent aqui desencadeava zoom agressivo no principal */
  }
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
};

/** Chaves de linhas só no gráfico principal (sem RSI — RSI tem painel próprio). */
function collectMainLineKeys(defs: ChartIndicatorDef[], vis: Record<string, boolean>): Set<string> {
  const want = new Set<string>();
  for (const d of defs) {
    if (d.kind === "rsi") continue;
    if (vis[d.id] === false) continue;
    if (d.kind === "bollinger") {
      want.add(`${d.id}_upper`);
      want.add(`${d.id}_mid`);
      want.add(`${d.id}_lower`);
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

function emaColor(id: string): string {
  if (id === "ema8") return "#f59e0b";
  if (id === "ema21") return "#38bdf8";
  return "#94a3b8";
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
}: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const mainWrapRef = useRef<HTMLDivElement>(null);
  const rsiStackRef = useRef<HTMLDivElement>(null);
  const rsiPlotWrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const liveMidLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const liveOiLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const liveSpreadHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const liveLiqHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const liqMicroPrimitiveRef = useRef<LiquidationMicroCandlesPrimitive | null>(null);
  const rsiLineMapRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const indLineRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const prevBarsRef = useRef<CandleApiBar[]>([]);
  const prevResetKeyRef = useRef(resetKey);
  /** Evita que um ajuste programático principal→RSI dispare RSI→principal e altere o zoom do principal. */
  const ignoreRsiToMainRef = useRef(false);
  const [dims, setDims] = useState({ w: 800, mainH: 600 });
  const [timeStrip, setTimeStrip] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const timeStripPrevRef = useRef({ from: "", to: "" });
  const [crosshairHud, setCrosshairHud] = useState<CrosshairHud | null>(null);

  const barsRef = useRef(bars);
  const indicatorDefsRef = useRef(indicatorDefs);
  const indicatorVisibilityRef = useRef(indicatorVisibility);
  barsRef.current = bars;
  indicatorDefsRef.current = indicatorDefs;
  indicatorVisibilityRef.current = indicatorVisibility;

  /** lightweight-charts dispara o crosshair muitas vezes por segundo; sem isto o React re-renderiza em loop e dispara RAM/CPU (pior com Turbopack). */
  const crosshairRafRef = useRef<number | null>(null);
  const crosshairLatestParamRef = useRef<{
    time?: unknown;
    point?: { x: number; y: number } | null;
  } | null>(null);
  const crosshairHudKeyRef = useRef<string>("");
  const indicatorHudEpochRef = useRef(0);

  const processCrosshairRef = useRef<() => void>(() => {});
  processCrosshairRef.current = () => {
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
    const lines = buildIndicatorHudLines(
      list,
      indicatorDefsRef.current,
      indicatorVisibilityRef.current,
      idx,
    );
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
  };

  const crosshairCbRef = useRef<
    (param: { time?: unknown; point?: { x: number; y: number } | null }) => void
  >(() => {});
  crosshairCbRef.current = (param) => {
    crosshairLatestParamRef.current = param;
    if (crosshairRafRef.current != null) return;
    crosshairRafRef.current = requestAnimationFrame(() => {
      crosshairRafRef.current = null;
      processCrosshairRef.current();
    });
  };

  useEffect(() => {
    indicatorHudEpochRef.current += 1;
    crosshairHudKeyRef.current = "";
    const p = crosshairLatestParamRef.current;
    if (p?.point != null) {
      processCrosshairRef.current();
    }
  }, [indicatorDefs, indicatorVisibility]);

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

  const showRsiPane = useMemo(
    () => indicatorDefs.some((d) => d.kind === "rsi" && indicatorVisibility[d.id] !== false),
    [indicatorDefs, indicatorVisibility],
  );

  const visibleRsiDefs = useMemo(
    () => indicatorDefs.filter((d) => d.kind === "rsi" && indicatorVisibility[d.id] !== false),
    [indicatorDefs, indicatorVisibility],
  );

  const fitTimeScale = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      chart.timeScale().fitContent();
    } catch {
      /* ignore */
    }
    queueMicrotask(() => {
      const rsi = rsiChartRef.current;
      if (!rsi || !showRsiPane) return;
      const br = barsRef.current;
      const lastT = br.length ? br[br.length - 1].t : null;
      ignoreRsiToMainRef.current = true;
      try {
        safeCopyVisibleTimeRange(chart, rsi, lastT);
      } finally {
        window.setTimeout(() => {
          ignoreRsiToMainRef.current = false;
        }, 0);
      }
    });
  }, [showRsiPane]);

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
    const rsi = rsiChartRef.current;
    if (!rsi || !showRsiPane) return;
    try {
      rsi.priceScale("right").applyOptions({
        autoScale: true,
        scaleMargins: { ...RSI_PRICE_SCALE_MARGINS },
      });
    } catch {
      /* ignore */
    }
  }, [showRsiPane]);

  useEffect(() => {
    if (bars.length === 0) setCrosshairHud(null);
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
      mainH = Math.max(200, Math.floor(wrap.clientHeight));
    } else if (box) {
      w = Math.max(280, Math.floor(box.clientWidth));
      const totalH = Math.floor(box.clientHeight);
      if (totalH < 48) return;
      let studyStrip = 0;
      if (showRsiPane) {
        const stack = rsiStackRef.current;
        studyStrip = stack
          ? Math.ceil(stack.getBoundingClientRect().height)
          : RSI_STACK_TOTAL_PX;
      }
      mainH = Math.max(200, totalH - studyStrip);
    } else {
      return;
    }

    setDims((prev) => (prev.w === w && prev.mainH === mainH ? prev : { w, mainH }));
  }, [showRsiPane]);

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
    const stack = rsiStackRef.current;
    if (stack) ro.observe(stack);
    window.addEventListener("resize", measure);
    const raf = requestAnimationFrame(() => measure());
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, showRsiPane, visibleRsiDefs.length]);

  useEffect(() => {
    const el = mainWrapRef.current;
    if (!el) return;

    const w = Math.max(280, Math.floor(el.clientWidth)) || 800;
    const rawH = Math.floor(el.clientHeight);
    const h = Math.max(200, rawH >= 32 ? rawH : defaultMainChartHeightPx());

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
      ...CHART_INTERACTION,
    });

    const candle = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });

    const liqMicro = new LiquidationMicroCandlesPrimitive();
    candle.attachPrimitive(liqMicro);
    liqMicroPrimitiveRef.current = liqMicro;

    const vol = chart.addHistogramSeries({
      color: "#5c6bc0",
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { ...VOL_SCALE_MARGINS } });

    chartRef.current = chart;
    seriesRef.current = candle;
    volRef.current = vol;

    const onRange = (range: LogicalRange | null) => {
      if (!range || range.from == null) return;
      if (!hasMoreRef.current || loadingOlderRef.current) return;
      if (range.from > LOAD_MORE_WHEN_FROM) return;
      if (debounceTRef.current) clearTimeout(debounceTRef.current);
      debounceTRef.current = setTimeout(() => {
        debounceTRef.current = null;
        void onNeedOlderRef.current();
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

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      if (debounceTRef.current) clearTimeout(debounceTRef.current);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      const liqPrim = liqMicroPrimitiveRef.current;
      const candleSer = seriesRef.current;
      if (liqPrim && candleSer) {
        try {
          candleSer.detachPrimitive(liqPrim);
        } catch {
          /* ignore */
        }
      }
      liqMicroPrimitiveRef.current = null;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot do mapa de séries ao desmontar o gráfico
      const map = indLineRef.current;
      for (const s of map.values()) {
        try {
          chart.removeSeries(s);
        } catch {
          /* ignore */
        }
      }
      map.clear();
      liveMidLineRef.current = null;
      liveOiLineRef.current = null;
      liveSpreadHistRef.current = null;
      liveLiqHistRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({ width: dims.w, height: dims.mainH });
    chartRef.current?.timeScale().applyOptions({
      visible: !showRsiPane,
      ...LINKED_TIME_SCALE,
    });
  }, [dims.w, dims.mainH, showRsiPane]);

  useEffect(() => {
    if (!showRsiPane) {
      setTimeStrip({ from: "", to: "" });
      timeStripPrevRef.current = { from: "", to: "" };
      return;
    }
    const chart = chartRef.current;
    if (!chart) return;

    const updateStrip = (range: { from: unknown; to: unknown } | null) => {
      if (range == null || range.from == null || range.to == null) {
        const empty = { from: "", to: "" };
        if (timeStripPrevRef.current.from !== "" || timeStripPrevRef.current.to !== "") {
          timeStripPrevRef.current = empty;
          setTimeStrip(empty);
        }
        return;
      }
      const from = formatVisibleTime(range.from);
      const to = formatVisibleTime(range.to);
      if (from === timeStripPrevRef.current.from && to === timeStripPrevRef.current.to) return;
      timeStripPrevRef.current = { from, to };
      setTimeStrip({ from, to });
    };

    chart.timeScale().subscribeVisibleTimeRangeChange(updateStrip);
    queueMicrotask(() => {
      try {
        updateStrip(chart.timeScale().getVisibleRange() as { from: unknown; to: unknown } | null);
      } catch {
        updateStrip(null);
      }
    });

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(updateStrip);
    };
  }, [showRsiPane, bars.length]);

  useEffect(() => {
    if (!showRsiPane) {
      const rc = rsiChartRef.current;
      if (rc) {
        try {
          rc.remove();
        } catch {
          /* ignore */
        }
        rsiChartRef.current = null;
        rsiLineMapRef.current.clear();
      }
      return;
    }

    const el = rsiPlotWrapRef.current;
    if (!el) return;

    const cw = Math.floor(el.clientWidth);
    const w = cw > 0 ? Math.max(280, cw) : 800;
    const h = RSI_PLOT_HEIGHT_PX;

    const rsiChart = createChart(el, {
      width: w,
      height: h,
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: "#9a9a9e",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: CHART_GRID },
        horzLines: { color: CHART_GRID },
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: {
        visible: false,
        timeVisible: true,
        secondsVisible: false,
        borderColor: CHART_BORDER,
        ...LINKED_TIME_SCALE,
      },
      rightPriceScale: { borderColor: CHART_BORDER, scaleMargins: { ...RSI_PRICE_SCALE_MARGINS } },
      ...CHART_INTERACTION,
    });

    rsiChartRef.current = rsiChart;

    const main = chartRef.current;
    let lock = false;
    let clearIgnoreRsiToMainT: number | null = null;

    const lastBarT = () => {
      const br = barsRef.current;
      return br.length ? br[br.length - 1].t : null;
    };

    const pushMainToRsi = () => {
      if (lock) return;
      const m = chartRef.current;
      const rInst = rsiChartRef.current;
      if (!m || !rInst) return;
      if (clearIgnoreRsiToMainT != null) window.clearTimeout(clearIgnoreRsiToMainT);
      ignoreRsiToMainRef.current = true;
      lock = true;
      try {
        safeCopyVisibleTimeRange(m, rInst, lastBarT());
      } finally {
        lock = false;
        clearIgnoreRsiToMainT = window.setTimeout(() => {
          ignoreRsiToMainRef.current = false;
          clearIgnoreRsiToMainT = null;
        }, 0);
      }
    };

    const pushRsiToMain = () => {
      if (lock) return;
      if (ignoreRsiToMainRef.current) return;
      const m = chartRef.current;
      const rInst = rsiChartRef.current;
      if (!m || !rInst) return;
      lock = true;
      try {
        safeCopyVisibleTimeRange(rInst, m, lastBarT());
      } finally {
        lock = false;
      }
    };

    const onRsiCrosshairMove = (param: {
      time?: unknown;
      point?: { x: number; y: number } | null;
    }) => {
      crosshairCbRef.current(param);
    };
    rsiChart.subscribeCrosshairMove(onRsiCrosshairMove);

    if (main) {
      main.timeScale().subscribeVisibleTimeRangeChange(pushMainToRsi);
      rsiChart.timeScale().subscribeVisibleTimeRangeChange(pushRsiToMain);
      queueMicrotask(() => {
        pushMainToRsi();
      });
    }

    return () => {
      if (clearIgnoreRsiToMainT != null) window.clearTimeout(clearIgnoreRsiToMainT);
      ignoreRsiToMainRef.current = false;
      try {
        rsiChart.unsubscribeCrosshairMove(onRsiCrosshairMove);
      } catch {
        /* ignore */
      }
      const m = chartRef.current;
      try {
        m?.timeScale().unsubscribeVisibleTimeRangeChange(pushMainToRsi);
        rsiChart.timeScale().unsubscribeVisibleTimeRangeChange(pushRsiToMain);
      } catch {
        /* ignore */
      }
      try {
        rsiChart.remove();
      } catch {
        /* ignore */
      }
      rsiChartRef.current = null;
      rsiLineMapRef.current.clear();
    };
  }, [showRsiPane]);

  useEffect(() => {
    if (!showRsiPane) return;
    rsiChartRef.current?.applyOptions({ width: dims.w, height: RSI_PLOT_HEIGHT_PX });
    rsiChartRef.current?.timeScale().applyOptions({ ...LINKED_TIME_SCALE });
  }, [dims.w, showRsiPane]);

  useEffect(() => {
    if (resetKey !== prevResetKeyRef.current) {
      prevResetKeyRef.current = resetKey;
      prevBarsRef.current = [];
    }
  }, [resetKey]);

  useEffect(() => {
    const candle = seriesRef.current;
    const vol = volRef.current;
    const chart = chartRef.current;
    if (!candle || !vol || !chart) return;

    const seriesBars = barsSortedUniqueByTime(bars);

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

    if (isPrepend) {
      const lr = chart.timeScale().getVisibleLogicalRange();
      candle.setData(cdata);
      vol.setData(vdata);
      if (lr) {
        const delta = seriesBars.length - prevSeries.length;
        chart.timeScale().setVisibleLogicalRange({
          from: lr.from + delta,
          to: lr.to + delta,
        });
      }
    } else {
      const sameHistoryStart =
        prevSeries.length > 0 &&
        seriesBars.length > 0 &&
        seriesBars[0].t === prevSeries[0].t;
      candle.setData(cdata);
      vol.setData(vdata);
      /** Atualizações live (cauda / mesma vela): não resetar zoom com fitContent. */
      if (!sameHistoryStart) {
        chart.timeScale().fitContent();
      }
    }

    const rsiC = rsiChartRef.current;
    if (rsiC) {
      const lastT = seriesBars.length ? seriesBars[seriesBars.length - 1].t : null;
      ignoreRsiToMainRef.current = true;
      try {
        safeCopyVisibleTimeRange(chart, rsiC, lastT);
      } finally {
        window.setTimeout(() => {
          ignoreRsiToMainRef.current = false;
        }, 0);
      }
    }

    prevBarsRef.current = seriesBars;
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
        candle.setMarkers([]);
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
        liveMidLineRef.current = chart.addLineSeries({
          color: "#22d3ee",
          lineWidth: 2,
          priceScaleId: "right",
          lastValueVisible: true,
          priceLineVisible: false,
          title: "Mid",
        });
      }
      liveMidLineRef.current.applyOptions({ color: "#22d3ee", title: "Mid" });
      liveMidLineRef.current.setData(midForSet);
    } else {
      const mk = Number(liveSnapshot.funding?.mark_price);
      if (Number.isFinite(mk) && liveSnapshot.funding) {
        const markRaw = [
          { time: liveSnapshot.funding.t as UTCTimestamp, value: mk },
        ];
        const markForSet = resampleLiveScalarToBarTimes(barList, markRaw);
        if (markForSet.length > 0) {
          if (!liveMidLineRef.current) {
            liveMidLineRef.current = chart.addLineSeries({
              color: "#fbbf24",
              lineWidth: 2,
              priceScaleId: "right",
              lastValueVisible: true,
              priceLineVisible: false,
              title: "Mark",
            });
          }
          liveMidLineRef.current.applyOptions({ color: "#fbbf24", title: "Mark" });
          liveMidLineRef.current.setData(markForSet);
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
        liveOiLineRef.current = chart.addLineSeries({
          color: "#c084fc",
          lineWidth: 1,
          priceScaleId: "left",
          lastValueVisible: true,
          priceLineVisible: false,
          title: "OI",
        });
      }
      liveOiLineRef.current.setData(oiForSet);
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
        liveSpreadHistRef.current = chart.addHistogramSeries({
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
      liveSpreadHistRef.current.setData(spForSet);
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
      candle.setMarkers([]);
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
    const want = collectMainLineKeys(defs, vis);

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

    for (const d of defs) {
      if (d.kind === "rsi" || vis[d.id] === false) continue;

      const barSeries = barsAsSourceSeries(bars, d.source ?? "close");

      if (d.kind === "ema") {
        const period = d.period ?? 14;
        const lineColor = d.color ?? emaColor(d.id);
        const lineWidth = d.lineWidth ?? 2;
        let ser = map.get(d.id);
        if (!ser) {
          ser = chart.addLineSeries({
            color: lineColor,
            lineWidth,
            priceScaleId: "right",
            lastValueVisible: true,
            priceLineVisible: false,
          });
          map.set(d.id, ser);
        }
        ser.applyOptions({ color: lineColor, lineWidth });
        ser.setData(emaSeries(barSeries, period));
      } else if (d.kind === "bollinger") {
        const period = d.period ?? 20;
        const mult = d.mult ?? 2;
        const { upper, mid, lower } = bollingerSeries(barSeries, period, mult);

        const ensure = (
          key: string,
          opts: {
            color: string;
            lineWidth: 1 | 2 | 3 | 4;
            lineStyle?: LineStyle;
          },
        ) => {
          let ser = map.get(key);
          if (!ser) {
            ser = chart.addLineSeries({
              color: opts.color,
              lineWidth: opts.lineWidth,
              lineStyle: opts.lineStyle ?? LineStyle.Solid,
              priceScaleId: "right",
              lastValueVisible: false,
              priceLineVisible: false,
            });
            map.set(key, ser);
          }
          return ser;
        };

        const cU = d.colorUpper ?? "#71717a";
        const cM = d.colorMid ?? "#a1a1aa";
        const cL = d.colorLower ?? "#71717a";
        const lineWidth = d.lineWidth ?? 1;

        const sU = ensure(`${d.id}_upper`, { color: cU, lineWidth, lineStyle: LineStyle.Dashed });
        sU.applyOptions({ color: cU, lineWidth, lineStyle: LineStyle.Dashed });
        sU.setData(upper);

        const sM = ensure(`${d.id}_mid`, { color: cM, lineWidth });
        sM.applyOptions({ color: cM, lineWidth, lineStyle: LineStyle.Solid });
        sM.setData(mid);

        const sL = ensure(`${d.id}_lower`, { color: cL, lineWidth, lineStyle: LineStyle.Dashed });
        sL.applyOptions({ color: cL, lineWidth, lineStyle: LineStyle.Dashed });
        sL.setData(lower);
      }
    }

    chart.priceScale("right").applyOptions({
      scaleMargins: { ...MAIN_PRICE_SCALE_MARGINS },
    });
  }, [bars, indicatorDefs, indicatorVisibility]);

  useEffect(() => {
    if (!showRsiPane) return;
    const rsiChart = rsiChartRef.current;
    if (!rsiChart) return;

    const map = rsiLineMapRef.current;
    const defs = indicatorDefs.filter((d) => d.kind === "rsi" && indicatorVisibility[d.id] !== false);
    const want = new Set(defs.map((d) => d.id));

    for (const [id, ser] of [...map.entries()]) {
      if (!want.has(id)) {
        try {
          rsiChart.removeSeries(ser);
        } catch {
          /* ignore */
        }
        map.delete(id);
      }
    }

    defs.forEach((d) => {
      const period = d.period ?? 14;
      const lineColor = effectiveRsiLineColor(d.id, d.color);
      const lineWidth = d.lineWidth ?? 2;
      const barSeries = barsAsSourceSeries(bars, d.source ?? "close");
      let ser = map.get(d.id);
      if (!ser) {
        ser = rsiChart.addLineSeries({
          color: lineColor,
          lineWidth,
          lastValueVisible: true,
          priceLineVisible: false,
        });
        map.set(d.id, ser);
      }
      ser.applyOptions({ color: lineColor, lineWidth });
      ser.setData(rsiSeries(barSeries, period));
    });

    queueMicrotask(() => {
      const main = chartRef.current;
      const rsi = rsiChartRef.current;
      if (!main || !rsi) return;
      const lastT = bars.length ? bars[bars.length - 1].t : null;
      ignoreRsiToMainRef.current = true;
      try {
        safeCopyVisibleTimeRange(main, rsi, lastT);
      } finally {
        window.setTimeout(() => {
          ignoreRsiToMainRef.current = false;
        }, 0);
      }
    });
  }, [bars, indicatorDefs, indicatorVisibility, showRsiPane]);

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
        {showRsiPane ? (
          <div ref={rsiStackRef} className="flex shrink-0 flex-col">
            <div
              className="flex shrink-0 items-center border-y border-zinc-800/80 bg-[#030304] px-2 text-[10px] tabular-nums text-zinc-500"
              style={{ height: TIME_RULER_ROW_PX, paddingRight: "52px" }}
              aria-hidden
            >
              <span className="min-w-0 flex-1 truncate text-zinc-400">{timeStrip.from || "—"}</span>
              <span className="mx-2 shrink-0 text-zinc-600">·</span>
              <span className="min-w-0 flex-1 truncate text-right text-zinc-400">{timeStrip.to || "—"}</span>
            </div>
            <div className="flex shrink-0 flex-col border-t border-zinc-800/70 bg-[#050506] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]">
              <div
                className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-800/90 px-2.5 py-1"
                style={{ minHeight: RSI_STUDY_HEADER_PX }}
              >
                {visibleRsiDefs.length === 0 ? (
                  <span className="text-xs font-semibold tracking-tight text-zinc-500">RSI</span>
                ) : (
                  visibleRsiDefs.map((d) => {
                    const period = d.period ?? 14;
                    const c = effectiveRsiLineColor(d.id, d.color);
                    const lab = d.label?.trim() || "RSI";
                    return (
                      <span
                        key={d.id}
                        className="inline-flex items-baseline gap-1 text-xs font-semibold tracking-tight"
                        style={{ color: c }}
                      >
                        <span className="truncate">{lab}</span>
                        <span className="text-[10px] font-medium text-zinc-500">{period}</span>
                      </span>
                    );
                  })
                )}
              </div>
              <div
                ref={rsiPlotWrapRef}
                className="shrink-0"
                style={{ height: RSI_PLOT_HEIGHT_PX }}
              />
            </div>
          </div>
        ) : null}
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
