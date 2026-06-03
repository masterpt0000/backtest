"use client";

import {
  ChartIndicatorLibrarySidebar,
  ChartLibraryHeaderButton,
} from "@/components/ChartIndicatorLibrarySidebar";
import {
  ChartStrategyBuilderModal,
  type ChartStrategyBuilderDraft,
} from "@/components/ChartStrategyBuilderModal";
import {
  ChartIndicatorSettingsSidebar,
  ChartSettingsGearButton,
} from "@/components/ChartIndicatorSettingsUI";
import { ChartIndicatorToolbar } from "@/components/ChartIndicatorToolbar";
import { ChartMenuDropdown } from "@/components/ChartMenuDropdown";
import { useSetChartHeaderSlot } from "@/components/ChartHeaderSlotContext";
import { useBacktestJob } from "@/components/BacktestJobProvider";
import { LiveMarketPanel, type LiveSignal, type LiveSnapshot } from "@/components/LiveMarketPanel";
import { OhlcvChart, type CandleApiBar, type ChartIndicatorDef } from "@/components/OhlcvChart";
import { SimulationParityPanel } from "@/components/SimulationParityPanel";
import { StrategyResultsAccordion } from "@/components/StrategyResultsAccordion";
import { StrategyTesterPanel } from "@/components/StrategyTesterPanel";
import type { IChartApi, UTCTimestamp } from "lightweight-charts";
import {
  chartOverrideKey,
  effectiveMacdFast,
  effectiveMacdSignal,
  effectiveMacdSlow,
  effectiveMult,
  effectivePeriod,
  effectiveIndicatorTimeframe,
  effectiveTrendCompositeParams,
  effectiveSource,
  effectiveTalibParamsForChart,
  readIndicatorOverride,
  USER_INDICATOR_SCOPE,
  type ChartIndicatorOverride,
} from "@/lib/chartIndicatorSettings";
import {
  BUILTIN_CHART_INDICATOR_ENTRIES,
  createUserIndicatorFromTemplate,
  fetchTalibIndicatorCatalog,
  type IndicatorCatalogEntry,
} from "@/lib/indicatorCatalog";
import {
  parseStandaloneIndicatorsFromStorage,
  STANDALONE_INDICATORS_STORAGE_KEY,
  USER_INDICATORS_STORAGE_KEY,
} from "@/lib/standaloneIndicators";
import { localBuilderRowsToStrategies } from "@/lib/chartBuilderLocalStorage";
import {
  BUILDER_STRATEGY_SYNC_STORAGE_KEY,
  CHART_BUILDER_STRATEGY_SYNC_EVENT,
  type ChartBuilderStrategySyncDetail,
} from "@/lib/chartBuilderStrategyExternalSync";
import {
  parseChartBuilderSpec,
  toBuilderStrategyRowId,
} from "@/lib/chartBuilderSpec";
import {
  getStrategyById,
  NONE_STRATEGY,
  normalizeTrendCompositeParams,
  parseStrategiesPayload,
  type Strategy,
  type StrategyIndicator,
  type TrendCompositeParams,
} from "@/lib/strategies";
import {
  type BacktestChartLayer,
  parseBacktestChartLayerPayload,
  pickBacktestLayerForSymbol,
} from "@/lib/backtestChartLayer";
import {
  extractTalibArraysForParity,
  vbtIndicatorParamsFromDefs,
} from "@/lib/liveStrategy/chartSimIndicatorParams";
import { mergeChartPayloadWithStoredVbtParams, CHART_VBT_FLAT_PARAMS_EVENT } from "@/lib/chartVbtOptimizedParamsBridge";
import {
  CHART_SIM_PARITY_UPDATED_EVENT,
  readChartSimParityForChart,
} from "@/lib/chartSimParityBridge";
import {
  SIM_ENGINE_STORAGE_KEY,
  chartStrategyHasJsSimulation,
  parseSimEngineMode,
  runJsChartSimulation,
  strategyHasJsTradeEngine,
  type SimEngineMode,
} from "@/lib/liveStrategy/chartSimRegistry";
import { apiFetch } from "@/lib/apiFetch";
import { parseBarFeaturesResponse } from "@/lib/barFeaturesApi";
import {
  footprintRequestBars,
  parseFootprintResponse,
  type FootprintResponse,
  type FootprintBar,
} from "@/lib/chartFootprintApi";
import { parseChartJobStart, parseChartJobStatus } from "@/lib/chartJobsApi";
import {
  buildTaSeriesRequestBody,
  parseTaSeriesResponse,
  TA_SERIES_EVAL_REVISION,
  taHistToHistogramData,
  taPointsToLineData,
  tryTalibOutputsToMacdBundle,
  type TaSeriesResponse,
} from "@/lib/chartTaApi";
import { TIMEFRAME_OPTIONS } from "@/lib/timeframes";
import { composeIndicatorBundlesFromTaState, type ChartTaHudState } from "@/lib/chartTaBundles";
import {
  effectiveDeltaLookbackBars,
  effectiveDeltaNormalizeByPrice,
  INDICATOR_DELTA_DISPLAY_SCALE,
} from "@/lib/indicatorDeltaTransform";
import { CHART_FACT_SERIES } from "@/lib/chartFactSeriesCatalog";
import {
  aggregateFeat1mFeaturesToBars,
  buildMinuteOpensForFeatBase,
  feat1mCacheKey,
  featBundlesMatchBarsLength,
  getCachedFeat1m,
  getCachedFeatExact,
  medianBarSpacingSec,
  setCachedFeat1m,
  setCachedFeatExact,
  shouldUseOneMinuteFeatBase,
} from "@/lib/barFeatClientCache";

const CHART_FEAT_CHART_VISIBILITY_KEY = "chart-feat-chart-visibility-v1";

function loadFeatChartVisibility(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(CHART_FEAT_CHART_VISIBILITY_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

type SymbolRow = { symbol_id: number; code: string };

const INITIAL_TARGET_POINTS = 5600;
const OLDER_TARGET_POINTS = 3200;

const CHART_RESULTS_SPLIT_STORAGE_KEY = "chart-results-split-height-px";
const CHART_SPLIT_MIN_PX = 140;
/** Espaço mínimo a deixar para o painel Live ao arrastar o split (sem acordeão). */
const CHART_LIVE_PANEL_RESERVE_PX = 280;
/** Sem estratégia e sem Live: reserva para a zona vazia por baixo do gráfico. */
const CHART_IDLE_PANE_RESERVE_PX = 100;

function chartSplitMaxPx(reserveBottom = 0): number {
  if (typeof window === "undefined") return 900;
  const pct = Math.min(Math.floor(window.innerHeight * 0.92), 1400);
  if (reserveBottom > 0) {
    return Math.max(
      CHART_SPLIT_MIN_PX + 60,
      Math.min(pct, window.innerHeight - reserveBottom),
    );
  }
  return pct;
}

function clampChartSplitPx(px: number, reserveBottom = 0): number {
  const maxPx = chartSplitMaxPx(reserveBottom);
  return Math.round(Math.max(CHART_SPLIT_MIN_PX, Math.min(maxPx, px)));
}

/** Grip fino (igual com ou sem estratégia): só linha, sem texto. */
function ChartSplitHandle({
  ariaLabel,
  valuePx,
  reserveBottom,
  onPointerDown,
  onKeyboardStep,
}: {
  ariaLabel: string;
  valuePx: number;
  reserveBottom: number;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyboardStep: (delta: number) => void;
}) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-valuemin={CHART_SPLIT_MIN_PX}
      aria-valuemax={chartSplitMaxPx(reserveBottom)}
      aria-valuenow={valuePx}
      aria-label={ariaLabel}
      className="group relative z-10 h-3 shrink-0 cursor-row-resize touch-none border-y border-zinc-800/80 bg-zinc-950/90 outline-none hover:border-violet-700/40 hover:bg-zinc-900/95 focus-visible:ring-2 focus-visible:ring-violet-600/50"
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        onKeyboardStep(e.key === "ArrowUp" ? -24 : 24);
      }}
    >
      <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-zinc-600 group-hover:bg-violet-500/90" />
    </div>
  );
}

function readInitialChartSplitPx(): number {
  if (typeof window === "undefined") return 480;
  try {
    const raw = sessionStorage.getItem(CHART_RESULTS_SPLIT_STORAGE_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return clampChartSplitPx(n);
    }
  } catch {
    /* ignore */
  }
  return clampChartSplitPx(Math.min(window.innerHeight * 0.58, 640), 0);
}

function parsePublicPollMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  const min = 200;
  const max = 120_000;
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Modo Live: velas via ``/api/live/candles`` (CCXT no Python, sem ler QuestDB).
 * Define ``NEXT_PUBLIC_LIVE_CANDLES_POLL_MS`` (ms, mín. 200).
 */
const LIVE_CANDLES_POLL_MS = parsePublicPollMs(
  process.env.NEXT_PUBLIC_LIVE_CANDLES_POLL_MS,
  1000,
);
/** Snapshot tape/livro/OI/liqs em memória. ``NEXT_PUBLIC_LIVE_SNAPSHOT_POLL_MS`` (ms). */
const LIVE_SNAPSHOT_POLL_MS = parsePublicPollMs(
  process.env.NEXT_PUBLIC_LIVE_SNAPSHOT_POLL_MS,
  500,
);
/** Sinal demo RSI+ATR. ``NEXT_PUBLIC_LIVE_SIGNAL_POLL_MS`` (ms). */
const LIVE_SIGNAL_POLL_MS = parsePublicPollMs(
  process.env.NEXT_PUBLIC_LIVE_SIGNAL_POLL_MS,
  3000,
);
const LIVE_CANDLES_LIMIT = 1000;
const CHART_SIMULATE_DEBOUNCE_MS = 450;
/** Facetas QuestDB — pedido separado; debounce menor que TA para o desenho reagir mais depressa. */
const BAR_FEATURES_DEBOUNCE_MS = 180;
const TA_CLIENT_CACHE_MAX = 32;
const FOOTPRINT_BARS_MAX = 5_000;

type ChartVisualMode = "candles" | "footprint";

function mergeByTime(older: CandleApiBar[], newer: CandleApiBar[]): CandleApiBar[] {
  const m = new Map<number, CandleApiBar>();
  for (const b of older) m.set(b.t, b);
  for (const b of newer) m.set(b.t, b);
  return Array.from(m.keys())
    .sort((a, b) => a - b)
    .map((k) => m.get(k)!);
}

function barsFingerprintForCache(bars: CandleApiBar[]): string {
  let h = 2166136261;
  for (const b of bars) {
    for (const x of [b.t, b.o, b.h, b.l, b.c, b.v]) {
      const n = Math.trunc(Number(x) * 1_000_000);
      h ^= n;
      h = Math.imul(h, 16777619);
    }
  }
  const first = bars[0]?.t ?? 0;
  const last = bars[bars.length - 1]?.t ?? 0;
  return `${bars.length}:${first}:${last}:${h >>> 0}`;
}

function taRequestCacheKey(req: ReturnType<typeof buildTaSeriesRequestBody>): string {
  return `${TA_SERIES_EVAL_REVISION}:${barsFingerprintForCache(req.bars)}:${JSON.stringify(req.indicators)}:${JSON.stringify(req.input_series ?? {})}`;
}

function lruSet<K, V>(m: Map<K, V>, k: K, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) {
    const old = m.keys().next().value as K | undefined;
    if (old === undefined) break;
    m.delete(old);
  }
}

function timeframeMinutes(tf: string): number {
  const m = /^(\d+)([mhdw])$/.exec(tf.trim());
  if (!m) return 5;
  const n = Math.max(1, Number(m[1]));
  const unit = m[2];
  if (unit === "m") return n;
  if (unit === "h") return n * 60;
  if (unit === "d") return n * 1440;
  return n * 10080;
}

function adaptiveInitialLimit(tf: string): number {
  const mins = timeframeMinutes(tf);
  if (mins <= 1) return 4000;
  if (mins <= 5) return 5600;
  if (mins <= 60) return 7200;
  return 9000;
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function denseLineValuesByBars(
  bars: CandleApiBar[],
  line: { time: UTCTimestamp; value: number }[] | undefined,
): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (!line?.length || !bars.length) return out;
  const sorted = [...line].sort((a, b) => Number(a.time) - Number(b.time));
  let j = 0;
  let last: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const bt = Number(bars[i]!.t);
    while (j < sorted.length && Number(sorted[j]!.time) <= bt) {
      const v = Number(sorted[j]!.value);
      last = Number.isFinite(v) ? v : null;
      j++;
    }
    out[i] = last;
  }
  return out;
}

function addCsvSeries(
  columns: Map<string, (number | null)[]>,
  name: string,
  values: (number | null)[],
): void {
  const safe = name.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "series";
  let key = safe;
  let n = 2;
  while (columns.has(key)) {
    key = `${safe}_${n}`;
    n++;
  }
  columns.set(key, values);
}

function addDeltaCsvSeries(
  columns: Map<string, (number | null)[]>,
  bars: CandleApiBar[],
  baseName: string,
  values: (number | null)[],
  def: ChartIndicatorDef,
): void {
  const lb = effectiveDeltaLookbackBars(def);
  if (lb < 1) return;
  const norm = effectiveDeltaNormalizeByPrice(def);
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = lb; i < values.length; i++) {
    const v = values[i];
    const v0 = values[i - lb];
    if (v == null || v0 == null || !Number.isFinite(v) || !Number.isFinite(v0)) continue;
    let d = v - v0;
    if (norm) {
      const c = bars[i]?.c;
      if (!Number.isFinite(c) || c === 0) continue;
      d /= c;
    }
    out[i] = d * INDICATOR_DELTA_DISPLAY_SCALE;
  }
  addCsvSeries(columns, `${baseName}_delta`, out);
}

function buildIndicatorDebugCsv(args: {
  bars: CandleApiBar[];
  indicatorDefs: ChartIndicatorDef[];
  taServerLines: Record<string, { time: UTCTimestamp; value: number }[]>;
  taServerMacd: Record<
    string,
    {
      macd: { time: UTCTimestamp; value: number }[];
      signal: { time: UTCTimestamp; value: number }[];
      histogram: { time: UTCTimestamp; value: number; color: string }[];
    }
  >;
  taServerTalibMulti: Record<string, Record<string, { time: UTCTimestamp; value: number }[]>>;
}): string {
  const maxRows = 2000;
  const allBars = args.bars.slice(-maxRows);
  const offset = Math.max(0, args.bars.length - allBars.length);
  const columns = new Map<string, (number | null)[]>();

  const addLine = (def: ChartIndicatorDef, name: string, line: { time: UTCTimestamp; value: number }[] | undefined) => {
    const denseAll = denseLineValuesByBars(args.bars, line);
    const dense = denseAll.slice(offset);
    addCsvSeries(columns, name, dense);
    addDeltaCsvSeries(columns, allBars, name, dense, def);
  };

  for (const def of args.indicatorDefs) {
    const id = def.id;
    addLine(def, id, args.taServerLines[id]);
    const macd = args.taServerMacd[id];
    if (macd) {
      addLine(def, `${id}_macd`, macd.macd);
      addLine(def, `${id}_signal`, macd.signal);
      addLine(def, `${id}_histogram`, macd.histogram);
    }
    const multi = args.taServerTalibMulti[id];
    if (multi) {
      for (const [key, line] of Object.entries(multi)) {
        addLine(def, `${id}_${key}`, line);
      }
    }
  }

  const headers = ["timestamp", "unix", "open", "high", "low", "close", "volume", ...columns.keys()];
  const rows = [headers.map(csvCell).join(",")];
  for (let i = 0; i < allBars.length; i++) {
    const b = allBars[i]!;
    const vals: unknown[] = [
      new Date(b.t * 1000).toISOString(),
      b.t,
      b.o,
      b.h,
      b.l,
      b.c,
      b.v,
    ];
    for (const col of columns.values()) vals.push(col[i]);
    rows.push(vals.map(csvCell).join(","));
  }
  return rows.join("\n");
}

function builderSpecUsesFeatures(spec: unknown): boolean {
  if (!spec || typeof spec !== "object") return false;
  try {
    return JSON.stringify(spec).includes("feat_");
  } catch {
    return false;
  }
}

function indicatorDefsUseFeatures(defs: ChartIndicatorDef[]): boolean {
  try {
    return JSON.stringify(defs).includes("feat_");
  } catch {
    return false;
  }
}

function expandRecentFeatureScalars(
  allBars: CandleApiBar[],
  requestBars: CandleApiBar[],
  features: Record<string, number[]>,
): Record<string, number[]> {
  if (requestBars.length === allBars.length) return features;
  const offset = Math.max(0, allBars.length - requestBars.length);
  const out: Record<string, number[]> = {};
  for (const [key, arr] of Object.entries(features)) {
    if (!Array.isArray(arr)) continue;
    const full = new Array<number>(allBars.length).fill(0);
    for (let i = 0; i < Math.min(arr.length, requestBars.length); i++) {
      const v = Number(arr[i]);
      full[offset + i] = Number.isFinite(v) ? v : 0;
    }
    out[key] = full;
  }
  return out;
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const id = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });
}

async function postJsonOrThrow(url: string, body: unknown, signal: AbortSignal, timeoutMs: number) {
  const r = await apiFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
    timeoutMs,
  );
  const j: unknown = await r.json();
  if (!r.ok) {
    const err = j && typeof j === "object" && "error" in j ? (j as { error?: string }).error : undefined;
    throw new Error(typeof err === "string" ? err : r.statusText);
  }
  return j;
}

async function runChartJobOrFallback<T>(
  opts: {
    startUrl: string;
    statusUrl: (jobId: string) => string;
    fallbackUrl: string;
    body: unknown;
    parseResult: (raw: unknown) => T | null;
    signal: AbortSignal;
    onStatus?: (label: string) => void;
  },
): Promise<T> {
  try {
    const startRaw = await postJsonOrThrow(opts.startUrl, opts.body, opts.signal, 10_000);
    const started = parseChartJobStart(startRaw, opts.parseResult);
    if (!started) throw new Error("Resposta job inválida");
    if (started.result) return started.result;
    opts.onStatus?.(`job ${started.status}`);
    for (let i = 0; i < 240 && !opts.signal.aborted; i++) {
      await sleepWithAbort(i < 8 ? 500 : 1000, opts.signal);
      if (opts.signal.aborted) break;
      const r = await apiFetch(opts.statusUrl(started.job_id), { cache: "no-store", signal: opts.signal }, 10_000);
      const j: unknown = await r.json();
      if (!r.ok) throw new Error(typeof j === "object" && j && "error" in j ? String((j as { error?: unknown }).error) : r.statusText);
      const st = parseChartJobStatus(j, opts.parseResult);
      if (!st) throw new Error("Status job inválido");
      opts.onStatus?.(`${st.status}${typeof st.progress === "number" ? ` ${st.progress}%` : ""}`);
      if (st.status === "finished" && st.result) return st.result;
      if (st.status === "failed" || st.status === "missing") throw new Error(st.error ?? "Job falhou");
    }
    throw new Error("Job cancelado ou timeout");
  } catch (e) {
    if (opts.signal.aborted) throw e;
    opts.onStatus?.("RQ indisponível; fallback síncrono…");
    const raw = await postJsonOrThrow(opts.fallbackUrl, opts.body, opts.signal, 120_000);
    const parsed = opts.parseResult(raw);
    if (!parsed) throw new Error("Resposta fallback inválida");
    return parsed;
  }
}

export default function ChartPage() {
  const {
    status: backtestStatus,
    results: backtestResults,
    run: backtestRun,
  } = useBacktestJob();
  const [symbols, setSymbols] = useState<SymbolRow[]>([]);
  const [symbolId, setSymbolId] = useState<number | null>(null);
  const [timeframe, setTimeframe] = useState("5m");
  const [bars, setBars] = useState<CandleApiBar[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [strategyId, setStrategyId] = useState("");
  const [strategiesList, setStrategiesList] = useState<Strategy[]>([NONE_STRATEGY]);
  const [strategyRefreshKey, setStrategyRefreshKey] = useState(0);
  const [strategyResultsOpen, setStrategyResultsOpen] = useState(false);
  const [chartResultsSplitPx, setChartResultsSplitPx] = useState(480);
  const chartSplitHydrated = useRef(false);
  const chartSplitDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const chartSplitActivePointerIdRef = useRef<number | null>(null);
  const chartSplitCaptureElRef = useRef<HTMLElement | null>(null);
  const chartSplitReserveBottomRef = useRef(0);
  const [builderPostgres, setBuilderPostgres] = useState<"ok" | "disabled" | "unknown">("unknown");
  const [builderModalOpen, setBuilderModalOpen] = useState(false);
  const [builderDraft, setBuilderDraft] = useState<ChartStrategyBuilderDraft | null>(null);
  const [indicatorVisibility, setIndicatorVisibility] = useState<Record<string, boolean>>({});
  /** `{}` na 1ª render (SSR = cliente evita hydration mismatch); depois efecto cliente lê LS. */
  const [featChartVisibility, setFeatChartVisibility] = useState<Record<string, boolean>>({});
  const [featChartVisibilityHydrated, setFeatChartVisibilityHydrated] = useState(false);

  useEffect(() => {
    setFeatChartVisibility(loadFeatChartVisibility());
    setFeatChartVisibilityHydrated(true);
  }, []);

  useEffect(() => {
    if (!featChartVisibilityHydrated) return;
    try {
      localStorage.setItem(CHART_FEAT_CHART_VISIBILITY_KEY, JSON.stringify(featChartVisibility));
    } catch {
      /* ignore */
    }
  }, [featChartVisibility, featChartVisibilityHydrated]);
  const [indicatorOverrides, setIndicatorOverrides] = useState<
    Record<string, ChartIndicatorOverride>
  >({});
  const [indicatorSettingsOpen, setIndicatorSettingsOpen] = useState(false);
  const [indicatorLibraryOpen, setIndicatorLibraryOpen] = useState(false);
  const [userIndicators, setUserIndicators] = useState<StrategyIndicator[]>([]);
  const skipUserIndicatorsSaveOnce = useRef(true);
  const [liveOn, setLiveOn] = useState(false);
  const [liveSnap, setLiveSnap] = useState<LiveSnapshot | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveSignal, setLiveSignal] = useState<LiveSignal | null>(null);
  const [liveSignalErr, setLiveSignalErr] = useState<string | null>(null);
  const [liveSignalLoading, setLiveSignalLoading] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [storeRunning, setStoreRunning] = useState(false);
  const [storePid, setStorePid] = useState<number | null>(null);
  const [serverSimLayer, setServerSimLayer] = useState<BacktestChartLayer | null>(null);
  const [serverSimErr, setServerSimErr] = useState<string | null>(null);
  const [serverSimLoading, setServerSimLoading] = useState(false);
  const [taServerLines, setTaServerLines] = useState<
    Record<string, { time: UTCTimestamp; value: number }[]>
  >({});
  const [taServerMacd, setTaServerMacd] = useState<
    Record<
      string,
      {
        macd: { time: UTCTimestamp; value: number }[];
        signal: { time: UTCTimestamp; value: number }[];
        histogram: { time: UTCTimestamp; value: number; color: string }[];
      }
    >
  >({});
  const [taServerTalibMulti, setTaServerTalibMulti] = useState<
    Record<string, Record<string, { time: UTCTimestamp; value: number }[]>>
  >({});
  const [talibCatalog, setTalibCatalog] = useState<IndicatorCatalogEntry[]>([]);
  const chartIndicatorLibraryCatalog = useMemo(
    () => [...BUILTIN_CHART_INDICATOR_ENTRIES, ...talibCatalog],
    [talibCatalog],
  );
  const [taComputeMs, setTaComputeMs] = useState<number | null>(null);
  const [taErr, setTaErr] = useState<string | null>(null);
  const [taLoading, setTaLoading] = useState(false);
  /** Séries facetas QuestDB (`feat_*`) alinhadas a ``bars``, para condições do construtor. */
  const [barFeatScalars, setBarFeatScalars] = useState<Record<string, number[]> | null>(null);
  const [chartVisualMode, setChartVisualMode] = useState<ChartVisualMode>("candles");
  const [footprintBars, setFootprintBars] = useState<FootprintBar[] | null>(null);
  const [footprintInfo, setFootprintInfo] = useState<string | null>(null);
  const [simEngineMode, setSimEngineMode] = useState<SimEngineMode>(() =>
    typeof window === "undefined"
      ? "js"
      : parseSimEngineMode(localStorage.getItem(SIM_ENGINE_STORAGE_KEY)),
  );

  useEffect(() => {
    try {
      localStorage.setItem(SIM_ENGINE_STORAGE_KEY, simEngineMode);
    } catch {
      /* ignore */
    }
  }, [simEngineMode]);

  useEffect(() => {
    void fetchTalibIndicatorCatalog().then(setTalibCatalog);
  }, []);

  const strategy = useMemo(
    () => getStrategyById(strategiesList, strategyId),
    [strategiesList, strategyId],
  );

  const strategyIdRef = useRef(strategyId);
  strategyIdRef.current = strategyId;

  const lastHandledBuilderSyncAtRef = useRef(0);
  const backtestFromJob = useMemo(
    () =>
      backtestStatus === "completed" && backtestResults?.length
        ? pickBacktestLayerForSymbol(
            backtestResults,
            symbolId == null
              ? null
              : (symbols.find((s) => s.symbol_id === symbolId)?.code ?? null),
            {
              jobVbtStrategy: backtestRun?.vbt_strategy ?? null,
              chartVbt: strategy.vbt_strategy ?? null,
            },
          )
        : null,
    [
      backtestStatus,
      backtestResults,
      symbolId,
      symbols,
      backtestRun?.vbt_strategy,
      strategy.vbt_strategy,
    ],
  );

  const [mainChartApi, setMainChartApi] = useState<IChartApi | null>(null);
  const lastBarTimeSec = useMemo(
    () => (bars.length ? (bars[bars.length - 1]!.t as number) : null),
    [bars],
  );

  /** Invalida pedidos TA anteriores (ex. mudança de fonte/params antes do debounce resolver). */
  const taSeriesReqGenRef = useRef(0);
  const barFeatReqGenRef = useRef(0);
  const taClientCacheRef = useRef(new Map<string, TaSeriesResponse>());

  const userIndicatorIdSet = useMemo(
    () => new Set(userIndicators.map((i) => i.id)),
    [userIndicators],
  );

  /** Com estratégia: overrides em ``strategyId::id``. Sem estratégia: ``__user__::id`` — nunca misturar com ids da biblioteca só por coincidência de string. */
  const indicatorOverridesAreUserScoped = !strategyId.trim();

  const chartIndicators = useMemo(() => {
    if (!strategyId) return userIndicators;
    return strategy.indicators;
  }, [strategyId, strategy.indicators, userIndicators]);

  const settingsStrategy = useMemo(
    (): Strategy => ({
      id: strategy.id,
      label: strategy.label,
      indicators: chartIndicators,
    }),
    [strategy.id, strategy.label, chartIndicators],
  );

  useEffect(() => {
    try {
      const next = localStorage.getItem(USER_INDICATORS_STORAGE_KEY);
      if (next) {
        const parsed = parseStandaloneIndicatorsFromStorage(JSON.parse(next) as unknown);
        if (parsed.length) {
          setUserIndicators(parsed);
          return;
        }
      }
      const legacy = localStorage.getItem(STANDALONE_INDICATORS_STORAGE_KEY);
      if (legacy) {
        const parsed = parseStandaloneIndicatorsFromStorage(JSON.parse(legacy) as unknown);
        if (parsed.length) setUserIndicators(parsed);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (skipUserIndicatorsSaveOnce.current) {
      skipUserIndicatorsSaveOnce.current = false;
      return;
    }
    try {
      localStorage.setItem(USER_INDICATORS_STORAGE_KEY, JSON.stringify(userIndicators));
    } catch {
      /* ignore */
    }
  }, [userIndicators]);

  const addUserIndicatorFromCatalog = useCallback(
    (templateId: string) => {
      setUserIndicators((prev) => {
        const ind = createUserIndicatorFromTemplate(templateId, prev, chartIndicatorLibraryCatalog);
        if (!ind) return prev;
        return [...prev, ind];
      });
    },
    [chartIndicatorLibraryCatalog],
  );

  const patchUserTrendComposite = useCallback((indicatorId: string, tc: TrendCompositeParams) => {
    setUserIndicators((prev) =>
      prev.map((ind) =>
        ind.id === indicatorId && ind.kind === "trend_composite"
          ? { ...ind, params: { ...ind.params, trendComposite: tc } }
          : ind,
      ),
    );
  }, []);

  const removeUserIndicator = useCallback((indicatorId: string) => {
    setUserIndicators((prev) => prev.filter((x) => x.id !== indicatorId));
    setIndicatorOverrides((prev) => {
      const next = { ...prev };
      delete next[chartOverrideKey(USER_INDICATOR_SCOPE, indicatorId)];
      delete next[chartOverrideKey("", indicatorId)];
      return next;
    });
  }, []);

  const patchIndicatorOverride = useCallback(
    (indicatorId: string, patch: Partial<ChartIndicatorOverride> | null) => {
      const key = indicatorOverridesAreUserScoped
        ? chartOverrideKey(USER_INDICATOR_SCOPE, indicatorId)
        : chartOverrideKey(strategyId, indicatorId);
      setIndicatorOverrides((prev) => {
        const next = { ...prev };
        if (patch == null) {
          delete next[key];
          return next;
        }
        next[key] = { ...next[key], ...patch };
        return next;
      });
    },
    [indicatorOverridesAreUserScoped, strategyId],
  );

  const commitTrendComposite = useCallback(
    (indicatorId: string, tc: TrendCompositeParams) => {
      const norm = normalizeTrendCompositeParams(tc);
      if (!strategyId.trim()) {
        patchUserTrendComposite(indicatorId, norm);
        return;
      }
      const o = readIndicatorOverride(indicatorOverrides, strategyId, indicatorId, false);
      patchIndicatorOverride(indicatorId, { ...(o ?? {}), trendComposite: norm });
    },
    [indicatorOverrides, patchIndicatorOverride, patchUserTrendComposite, strategyId],
  );

  const resetIndicatorParams = useCallback(
    (indicatorId: string) => {
      const key = indicatorOverridesAreUserScoped
        ? chartOverrideKey(USER_INDICATOR_SCOPE, indicatorId)
        : chartOverrideKey(strategyId, indicatorId);
      setIndicatorOverrides((prev) => {
        const cur = prev[key];
        if (!cur) return prev;
        const rest = { ...cur };
        delete rest.period;
        delete rest.mult;
        delete rest.source;
        delete rest.timeframe;
        delete rest.fast;
        delete rest.slow;
        delete rest.signal;
        delete rest.lciInputs;
        delete rest.deltaLookbackBars;
        delete rest.deltaNormalizeByPrice;
        delete rest.talibParams;
        delete rest.trendComposite;
        const next = { ...prev };
        if (Object.keys(rest).length === 0) delete next[key];
        else next[key] = rest;
        return next;
      });
    },
    [indicatorOverridesAreUserScoped, strategyId],
  );

  /**
   * Backtests gravam o spec na BD/localStorage; o chart mantinha lista e overrides antigos.
   * - Refetch da lista (strategyRefreshKey).
   * - Remove overrides de parâmetros dos indicadores tocados para o spec gravado voltar a aparecer em «Definições».
   */
  useEffect(() => {
    const parsePayload = (raw: string | null): ChartBuilderStrategySyncDetail | null => {
      if (!raw) return null;
      try {
        const o = JSON.parse(raw) as Record<string, unknown>;
        const uuid = typeof o.uuid === "string" ? o.uuid : "";
        const at = typeof o.at === "number" ? o.at : 0;
        const indicatorIds = Array.isArray(o.indicatorIds)
          ? o.indicatorIds.filter((x): x is string => typeof x === "string")
          : [];
        if (!uuid || !at) return null;
        return { uuid, at, indicatorIds };
      } catch {
        return null;
      }
    };

    const handleSync = (detail: ChartBuilderStrategySyncDetail) => {
      if (detail.at <= lastHandledBuilderSyncAtRef.current) return;
      lastHandledBuilderSyncAtRef.current = detail.at;
      const rowId = toBuilderStrategyRowId(detail.uuid);
      const curSid = strategyIdRef.current;

      setIndicatorOverrides((prev) => {
        if (curSid !== rowId || detail.indicatorIds.length === 0) return prev;
        const next = { ...prev };
        for (const indId of detail.indicatorIds) {
          const key = chartOverrideKey(rowId, indId);
          const curOv = next[key];
          if (!curOv) continue;
          const rest = { ...curOv };
          delete rest.period;
          delete rest.mult;
          delete rest.source;
          delete rest.timeframe;
          delete rest.fast;
          delete rest.slow;
          delete rest.signal;
          delete rest.lciInputs;
          delete rest.deltaLookbackBars;
          delete rest.deltaNormalizeByPrice;
          delete rest.talibParams;
          delete rest.trendComposite;
          if (Object.keys(rest).length === 0) delete next[key];
          else next[key] = rest;
        }
        return next;
      });
      setStrategyRefreshKey((k) => k + 1);
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== BUILDER_STRATEGY_SYNC_STORAGE_KEY || e.newValue == null) return;
      const p = parsePayload(e.newValue);
      if (p) handleSync(p);
    };

    const onCustom = (e: Event) => {
      const ce = e as CustomEvent<ChartBuilderStrategySyncDetail>;
      const d = ce.detail;
      if (d?.uuid && typeof d.at === "number") handleSync(d);
    };

    const checkLocal = () => {
      const p = parsePayload(
        typeof window !== "undefined"
          ? window.localStorage.getItem(BUILDER_STRATEGY_SYNC_STORAGE_KEY)
          : null,
      );
      if (p) handleSync(p);
    };

    checkLocal();
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHART_BUILDER_STRATEGY_SYNC_EVENT, onCustom as EventListener);
    window.addEventListener("focus", checkLocal);
    const onVis = () => {
      if (document.visibilityState === "visible") checkLocal();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHART_BUILDER_STRATEGY_SYNC_EVENT, onCustom as EventListener);
      window.removeEventListener("focus", checkLocal);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const resetIndicatorStyle = useCallback(
    (indicatorId: string) => {
      const key = indicatorOverridesAreUserScoped
        ? chartOverrideKey(USER_INDICATOR_SCOPE, indicatorId)
        : chartOverrideKey(strategyId, indicatorId);
      setIndicatorOverrides((prev) => {
        const cur = prev[key];
        if (!cur) return prev;
        const rest = { ...cur };
        delete rest.color;
        delete rest.colorUpper;
        delete rest.colorMid;
        delete rest.colorLower;
        delete rest.lineWidth;
        const next = { ...prev };
        if (Object.keys(rest).length === 0) delete next[key];
        else next[key] = rest;
        return next;
      });
    },
    [indicatorOverridesAreUserScoped, strategyId],
  );

  const settingsOverridesByIndicatorId = useMemo(() => {
    const out: Record<string, ChartIndicatorOverride | undefined> = {};
    for (const i of chartIndicators) {
      out[i.id] = readIndicatorOverride(
        indicatorOverrides,
        strategyId,
        i.id,
        indicatorOverridesAreUserScoped,
      );
    }
    return out;
  }, [chartIndicators, indicatorOverrides, strategyId, indicatorOverridesAreUserScoped]);

  const indicatorDefs = useMemo((): ChartIndicatorDef[] => {
    return chartIndicators.map((i) => {
      const o = readIndicatorOverride(
        indicatorOverrides,
        strategyId,
        i.id,
        indicatorOverridesAreUserScoped,
      );
      return {
        id: i.id,
        kind: i.kind,
        label: i.label,
        group: i.group,
        period: effectivePeriod(i, o),
        mult: effectiveMult(i, o),
        fast: effectiveMacdFast(i, o),
        slow: effectiveMacdSlow(i, o),
        signal: effectiveMacdSignal(i, o),
        source: effectiveSource(i, o),
        timeframe: effectiveIndicatorTimeframe(i, o),
        talibFunction: i.kind === "talib" ? i.params?.talibFunction : undefined,
        talibParams: effectiveTalibParamsForChart(i, o),
        derived: i.kind === "derived" ? i.params?.derived : undefined,
        trendComposite:
          i.kind === "trend_composite"
            ? effectiveTrendCompositeParams(i, o)
            : undefined,
        color: o?.color,
        colorUpper: o?.colorUpper,
        colorMid: o?.colorMid,
        colorLower: o?.colorLower,
        lineWidth: o?.lineWidth,
        deltaLookbackBars:
          o?.deltaLookbackBars != null && Number.isFinite(Number(o.deltaLookbackBars))
            ? Math.max(0, Math.min(120, Math.round(Number(o.deltaLookbackBars))))
            : i.params?.deltaLookbackBars != null && Number.isFinite(Number(i.params.deltaLookbackBars))
              ? Math.max(0, Math.min(120, Math.round(Number(i.params.deltaLookbackBars))))
              : undefined,
        deltaNormalizeByPrice: o?.deltaNormalizeByPrice ?? i.params?.deltaNormalizeByPrice,
      };
    });
  }, [chartIndicators, indicatorOverrides, strategyId, indicatorOverridesAreUserScoped]);

  /** Sempre pedir todas as séries TA: a visibilidade (`indicatorVisibility`) só afecta linhas/HUD no gráfico, não esta API — assim esconder um indicador não quebra bundles da simulação (trades, sombreado). */
  const taRequest = useMemo(
    () => buildTaSeriesRequestBody(bars, indicatorDefs, {}, barFeatScalars),
    [bars, indicatorDefs, barFeatScalars],
  );

  const exportIndicatorDebugCsv = useCallback(() => {
    if (!bars.length) return;
    const csv = buildIndicatorDebugCsv({
      bars,
      indicatorDefs,
      taServerLines,
      taServerMacd,
      taServerTalibMulti,
    });
    const symbol = symbolId == null ? "symbol" : (symbols.find((s) => s.symbol_id === symbolId)?.code ?? String(symbolId));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chart-indicators-${symbol.replace(/[^A-Za-z0-9_.-]+/g, "_")}-${timeframe}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [bars, indicatorDefs, symbolId, symbols, taServerLines, taServerMacd, taServerTalibMulti, timeframe]);

  const builderNeedsBarFeatures = useMemo(
    () => builderSpecUsesFeatures(strategy.builderSpec),
    [strategy.builderSpec],
  );

  const needsBarFeatures = useMemo(
    () =>
      Object.values(featChartVisibility).some(Boolean) ||
      builderNeedsBarFeatures ||
      indicatorDefsUseFeatures(indicatorDefs),
    [featChartVisibility, builderNeedsBarFeatures, indicatorDefs],
  );

  useEffect(() => {
    if (taRequest.indicators.length === 0 || bars.length === 0) {
      taSeriesReqGenRef.current += 1;
      setTaServerLines({});
      setTaServerMacd({});
      setTaServerTalibMulti({});
      setTaComputeMs(null);
      setTaErr(null);
      setTaLoading(false);
      return;
    }
    const reqGen = (taSeriesReqGenRef.current += 1);
    const ac = new AbortController();
    const cacheKey = taRequestCacheKey(taRequest);
    const applyParsed = (parsed: TaSeriesResponse) => {
      const lines: Record<string, { time: UTCTimestamp; value: number }[]> = {};
      const macd: Record<
        string,
        {
          macd: { time: UTCTimestamp; value: number }[];
          signal: { time: UTCTimestamp; value: number }[];
          histogram: { time: UTCTimestamp; value: number; color: string }[];
        }
      > = {};
      const talibMulti: Record<string, Record<string, { time: UTCTimestamp; value: number }[]>> = {};
      const defById = new Map(indicatorDefs.map((d) => [d.id, d]));
      for (const [id, ser] of Object.entries(parsed.series)) {
        if (Array.isArray(ser)) {
          lines[id] = taPointsToLineData(ser);
        } else if (ser && typeof ser === "object" && "macd" in ser && "signal" in ser && "histogram" in ser) {
          macd[id] = {
            macd: taPointsToLineData(ser.macd),
            signal: taPointsToLineData(ser.signal),
            histogram: taHistToHistogramData(ser.histogram),
          };
        } else if (ser && typeof ser === "object" && !Array.isArray(ser)) {
          const named = ser as Record<string, { t: number; v: number }[]>;
          const def = defById.get(id);
          const asMacd = tryTalibOutputsToMacdBundle(named);
          if (
            asMacd &&
            def?.kind === "talib" &&
            def.talibFunction?.toUpperCase() === "MACD"
          ) {
            macd[id] = {
              macd: taPointsToLineData(asMacd.macd),
              signal: taPointsToLineData(asMacd.signal),
              histogram: taHistToHistogramData(asMacd.histogram),
            };
          } else {
            const out: Record<string, { time: UTCTimestamp; value: number }[]> = {};
            for (const [k, pts] of Object.entries(named)) {
              out[k] = taPointsToLineData(pts);
            }
            talibMulti[id] = out;
          }
        }
      }
      setTaComputeMs(parsed.compute_ms);
      setTaServerLines(lines);
      setTaServerMacd(macd);
      setTaServerTalibMulti(talibMulti);
    };
    const timer = window.setTimeout(() => {
      void (async () => {
        setTaLoading(true);
        setTaErr(null);
        try {
          const cached = taClientCacheRef.current.get(cacheKey);
          if (cached) {
            taClientCacheRef.current.delete(cacheKey);
            taClientCacheRef.current.set(cacheKey, cached);
            if (reqGen !== taSeriesReqGenRef.current || ac.signal.aborted) return;
            applyParsed({ ...cached, compute_ms: 0 });
            return;
          }
          const r = await apiFetch(
            "/api/chart/ta-series",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(taRequest),
              signal: ac.signal,
            },
            120_000,
          );
          const j: unknown = await r.json();
          if (!r.ok) {
            const err = j && typeof j === "object" && "error" in j ? (j as { error?: string }).error : undefined;
            throw new Error(typeof err === "string" ? err : r.statusText);
          }
          if (ac.signal.aborted) return;
          if (reqGen !== taSeriesReqGenRef.current) return;
          const parsed = parseTaSeriesResponse(j);
          if (!parsed) throw new Error("Resposta TA inválida");
          if (reqGen !== taSeriesReqGenRef.current) return;
          lruSet(taClientCacheRef.current, cacheKey, parsed, TA_CLIENT_CACHE_MAX);
          applyParsed(parsed);
        } catch (e) {
          if (ac.signal.aborted) return;
          if (reqGen !== taSeriesReqGenRef.current) return;
          setTaServerLines({});
          setTaServerMacd({});
          setTaServerTalibMulti({});
          setTaComputeMs(null);
          setTaErr(e instanceof Error ? e.message : String(e));
        } finally {
          if (!ac.signal.aborted && reqGen === taSeriesReqGenRef.current) setTaLoading(false);
        }
      })();
    }, CHART_SIMULATE_DEBOUNCE_MS);
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [taRequest, indicatorDefs, bars.length]);

  useEffect(() => {
    if (!bars.length || symbolId == null || !needsBarFeatures) {
      barFeatReqGenRef.current += 1;
      setBarFeatScalars(null);
      return;
    }
    const reqGen = (barFeatReqGenRef.current += 1);
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const requestBars = bars;
          const spacing = medianBarSpacingSec(requestBars);

          const exactHit = getCachedFeatExact(symbolId, bars);
          if (exactHit) {
            if (reqGen !== barFeatReqGenRef.current || ac.signal.aborted) return;
            setBarFeatScalars(exactHit);
            return;
          }

          if (shouldUseOneMinuteFeatBase(timeframe, requestBars.length)) {
            const { opens, stubBars } = buildMinuteOpensForFeatBase(requestBars, spacing);
            if (opens.length > 0) {
              const k1 = feat1mCacheKey(symbolId, opens);
              if (k1) {
                const hit1 = getCachedFeat1m(k1);
                if (
                  hit1 &&
                  hit1.minuteOpenTimes.length === opens.length &&
                  featBundlesMatchBarsLength(opens.length, hit1.features)
                ) {
                  const agg = aggregateFeat1mFeaturesToBars(
                    hit1.features,
                    opens,
                    requestBars,
                    spacing,
                  );
                  const expanded = expandRecentFeatureScalars(bars, requestBars, agg);
                  if (
                    featBundlesMatchBarsLength(bars.length, expanded) &&
                    reqGen === barFeatReqGenRef.current &&
                    !ac.signal.aborted
                  ) {
                    setBarFeatScalars(expanded);
                    setCachedFeatExact(symbolId, bars, expanded);
                  }
                  return;
                }
              }

              const parsed1 = await runChartJobOrFallback({
                startUrl: "/api/chart/bar-features/jobs",
                statusUrl: (id) => `/api/chart/bar-features/jobs/${encodeURIComponent(id)}`,
                fallbackUrl: "/api/chart/bar-features",
                body: { symbol_id: symbolId, bars: stubBars },
                parseResult: parseBarFeaturesResponse,
                signal: ac.signal,
              });
              if (ac.signal.aborted) return;
              if (reqGen !== barFeatReqGenRef.current) return;
              const feats1m = parsed1?.features ?? {};
              if (k1 && stubBars.length && featBundlesMatchBarsLength(stubBars.length, feats1m)) {
                setCachedFeat1m(k1, { minuteOpenTimes: opens, features: feats1m });
              }
              const agg = aggregateFeat1mFeaturesToBars(feats1m, opens, requestBars, spacing);
              const expanded = expandRecentFeatureScalars(bars, requestBars, agg);
              if (
                featBundlesMatchBarsLength(bars.length, expanded) &&
                reqGen === barFeatReqGenRef.current &&
                !ac.signal.aborted
              ) {
                setBarFeatScalars(expanded);
                setCachedFeatExact(symbolId, bars, expanded);
              } else if (reqGen === barFeatReqGenRef.current && !ac.signal.aborted) {
                setBarFeatScalars({});
              }
              return;
            }
          }

          const parsed = await runChartJobOrFallback({
            startUrl: "/api/chart/bar-features/jobs",
            statusUrl: (id) => `/api/chart/bar-features/jobs/${encodeURIComponent(id)}`,
            fallbackUrl: "/api/chart/bar-features",
            body: { symbol_id: symbolId, bars: requestBars },
            parseResult: parseBarFeaturesResponse,
            signal: ac.signal,
          });
          if (ac.signal.aborted) return;
          if (reqGen !== barFeatReqGenRef.current) return;
          const raw = parsed?.features ?? {};
          const expanded = expandRecentFeatureScalars(bars, requestBars, raw);
          setBarFeatScalars(expanded);
          if (featBundlesMatchBarsLength(bars.length, expanded)) {
            setCachedFeatExact(symbolId, bars, expanded);
          }
        } catch {
          if (ac.signal.aborted) return;
          if (reqGen !== barFeatReqGenRef.current) return;
          setBarFeatScalars({});
        }
      })();
    }, BAR_FEATURES_DEBOUNCE_MS);
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [symbolId, bars, timeframe, needsBarFeatures, builderNeedsBarFeatures]);

  useEffect(() => {
    if (chartVisualMode !== "footprint" || symbolId == null || bars.length === 0) {
      setFootprintBars(null);
      setFootprintInfo(null);
      return;
    }
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const reqBars = footprintRequestBars(bars, FOOTPRINT_BARS_MAX);
        try {
          setFootprintInfo(`Footprint: a carregar tape para ${reqBars.length} candles…`);
          const body = {
            symbol_id: symbolId,
            bars: reqBars,
            max_levels_per_bar: 18,
            tick_limit: 1_000_000,
          };
          const parsed: FootprintResponse = await runChartJobOrFallback({
            startUrl: "/api/chart/footprint/jobs",
            statusUrl: (id) => `/api/chart/footprint/jobs/${encodeURIComponent(id)}`,
            fallbackUrl: "/api/chart/footprint",
            body,
            parseResult: parseFootprintResponse,
            signal: ac.signal,
            onStatus: (label) => {
              setFootprintInfo(`Footprint: ${label}`);
            },
          });
          if (ac.signal.aborted) return;
          setFootprintBars(parsed.bars);
          setFootprintInfo(
            `Footprint · ${parsed.bars.length}/${reqBars.length} candles · ${parsed.compute_ms.toFixed(
              1,
            )} ms · step ${parsed.price_step.toPrecision(4)}${parsed.truncated ? " · truncado" : ""}`,
          );
        } catch (e) {
          if (ac.signal.aborted) return;
          setFootprintBars(null);
          setFootprintInfo(e instanceof Error ? `Footprint: ${e.message}` : "Footprint indisponível");
        }
      })();
    }, 250);
    return () => {
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [chartVisualMode, symbolId, bars]);

  /** Séries `feat_*` com `{ time, value }` por vela para o painel facetas no gráfico. */
  const barFeatLineSeries = useMemo(() => {
    if (!barFeatScalars || bars.length === 0) return {};
    const out: Record<string, { time: UTCTimestamp; value: number }[]> = {};
    for (const { id } of CHART_FACT_SERIES) {
      const arr = barFeatScalars[id];
      if (!Array.isArray(arr) || arr.length !== bars.length) continue;
      out[id] = bars.map((b, i) => {
        const raw = Number(arr[i]);
        return {
          time: b.t as UTCTimestamp,
          value: Number.isFinite(raw) ? raw : 0,
        };
      });
    }
    return out;
  }, [bars, barFeatScalars]);

  const taHudState = useMemo<ChartTaHudState>(
    () => ({
      lines: taServerLines,
      macd: taServerMacd,
      talibMulti: taServerTalibMulti,
    }),
    [taServerLines, taServerMacd, taServerTalibMulti],
  );

  const taBundlesForSim = useMemo(
    () => composeIndicatorBundlesFromTaState(bars, indicatorDefs, taHudState),
    [bars, indicatorDefs, taHudState],
  );

  const jsSimLayer = useMemo(() => {
    if (simEngineMode === "vbt") return null;
    const builderSpec = strategy.isBuilderStrategy ? strategy.builderSpec ?? null : null;
    return runJsChartSimulation(
      strategy.vbt_strategy,
      bars,
      indicatorDefs,
      builderSpec,
      taBundlesForSim,
      barFeatScalars,
    );
  }, [
    simEngineMode,
    strategy.vbt_strategy,
    strategy.isBuilderStrategy,
    strategy.builderSpec,
    bars,
    indicatorDefs,
    taBundlesForSim,
    barFeatScalars,
  ]);

  const [chartSimInputRev, setChartSimInputRev] = useState(0);

  useEffect(() => {
    const bump = () => setChartSimInputRev((n) => n + 1);
    window.addEventListener(CHART_VBT_FLAT_PARAMS_EVENT, bump);
    window.addEventListener(CHART_SIM_PARITY_UPDATED_EVENT, bump);
    return () => {
      window.removeEventListener(CHART_VBT_FLAT_PARAMS_EVENT, bump);
      window.removeEventListener(CHART_SIM_PARITY_UPDATED_EVENT, bump);
    };
  }, []);

  const indicatorParamsPayload = useMemo(() => {
    const base = vbtIndicatorParamsFromDefs(strategy.vbt_strategy ?? "", indicatorDefs);
    return mergeChartPayloadWithStoredVbtParams(strategy.vbt_strategy ?? "", base);
  }, [strategy.vbt_strategy, indicatorDefs, chartSimInputRev]);

  useEffect(() => {
    const vbt = strategy.vbt_strategy?.trim();
    const needServer =
      (simEngineMode === "vbt" || simEngineMode === "both") && Boolean(vbt) && bars.length > 0;
    if (!needServer) {
      setServerSimLayer(null);
      setServerSimErr(null);
      setServerSimLoading(false);
      return;
    }
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setServerSimLoading(true);
        setServerSimErr(null);
        try {
          const parity = readChartSimParityForChart();
          const body: Record<string, unknown> = {
            vbt_strategy: vbt,
            timeframe,
            bars,
            min_trades: parity?.min_trades ?? 1,
            initial_cash: parity?.initial_cash ?? 10_000,
          };
          if (parity) {
            body.exec_fee_pct_per_fill = parity.exec_fee_pct_per_fill;
            body.exec_slippage_pct = parity.exec_slippage_pct;
            body.exec_half_spread_pct = parity.exec_half_spread_pct;
          }
          if (Object.keys(indicatorParamsPayload).length > 0) {
            body.indicator_params = indicatorParamsPayload;
          }
          const r = await apiFetch(
            "/api/chart/simulate-bars",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: ac.signal,
            },
            120_000,
          );
          const j = (await r.json()) as { error?: string; backtest?: unknown };
          if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : r.statusText);
          if (ac.signal.aborted) return;
          const layer = parseBacktestChartLayerPayload(j.backtest);
          setServerSimLayer(layer);
          if (!layer) {
            setServerSimErr(
              "Sem simulação (poucas velas, sem trades com o mínimo definido, ou estratégia falhou).",
            );
          }
        } catch (e) {
          if (ac.signal.aborted) return;
          setServerSimLayer(null);
          setServerSimErr(e instanceof Error ? e.message : String(e));
        } finally {
          if (!ac.signal.aborted) setServerSimLoading(false);
        }
      })();
    }, CHART_SIMULATE_DEBOUNCE_MS);
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [simEngineMode, strategy.vbt_strategy, timeframe, bars, indicatorParamsPayload, chartSimInputRev]);

  const chartTaIndicatorSeries = useMemo(() => {
    if (simEngineMode !== "both" || !bars.length) return null;
    return extractTalibArraysForParity(bars, indicatorDefs, taHudState);
  }, [simEngineMode, bars, indicatorDefs, taHudState]);

  const chartBacktest = useMemo(() => {
    if (simEngineMode === "js") {
      return jsSimLayer ?? backtestFromJob;
    }
    if (simEngineMode === "vbt") {
      return serverSimLayer ?? backtestFromJob;
    }
    return serverSimLayer ?? jsSimLayer ?? backtestFromJob;
  }, [simEngineMode, jsSimLayer, serverSimLayer, backtestFromJob]);

  const backtestOverlayMode = useMemo((): "live" | "questdb" | null => {
    if (simEngineMode === "js") {
      if (jsSimLayer) return "live";
      if (backtestFromJob) return "questdb";
      return null;
    }
    if (simEngineMode === "vbt") {
      if (serverSimLayer) return "live";
      if (backtestFromJob) return "questdb";
      return null;
    }
    if (serverSimLayer || jsSimLayer) return "live";
    if (backtestFromJob) return "questdb";
    return null;
  }, [simEngineMode, jsSimLayer, serverSimLayer, backtestFromJob]);

  const showResultsAccordion =
    chartBacktest != null || (simEngineMode === "both" && Boolean(strategy.vbt_strategy));

  const liveLayout = liveOn && symbolId != null;
  /** Sem acordeão: par seleccionado mas Live desligado — reparte gráfico vs zona vazia por baixo. */
  const showIdleChartSplit =
    !showResultsAccordion && !liveLayout && symbolId != null;
  const chartSplitReserveBottom =
    liveLayout && !showResultsAccordion
      ? CHART_LIVE_PANEL_RESERVE_PX
      : showIdleChartSplit
        ? CHART_IDLE_PANE_RESERVE_PX
        : 0;
  const useFixedChartHeightSplit =
    showResultsAccordion || liveLayout || showIdleChartSplit;
  chartSplitReserveBottomRef.current = chartSplitReserveBottom;

  const symbolMenuOptions = useMemo(
    () => symbols.map((s) => ({ value: String(s.symbol_id), label: s.code })),
    [symbols],
  );

  const liveSymbolCode = useMemo(() => {
    if (symbolId == null) return null;
    return symbols.find((s) => s.symbol_id === symbolId)?.code ?? null;
  }, [symbols, symbolId]);

  const timeframeMenuOptions = useMemo(
    () => TIMEFRAME_OPTIONS.map((tf) => ({ value: tf, label: tf })),
    [],
  );

  const chartVisualModeOptions = useMemo(
    () => [
      { value: "candles", label: "Candles" },
      { value: "footprint", label: "Footprint" },
    ],
    [],
  );

  const fetchingOlderRef = useRef(false);
  const barsRef = useRef(bars);
  barsRef.current = bars;
  const hasMoreOlderRef = useRef(hasMoreOlder);
  hasMoreOlderRef.current = hasMoreOlder;
  const loadingOlderRef = useRef(loadingOlder);
  loadingOlderRef.current = loadingOlder;
  const symbolIdRef = useRef(symbolId);
  symbolIdRef.current = symbolId;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;

  const setChartHeaderSlot = useSetChartHeaderSlot();

  const toggleLive = useCallback(async () => {
    if (symbolId == null) return;
    setLiveBusy(true);
    setLiveErr(null);
    try {
      if (!liveOn) {
        const r = await apiFetch("/api/live/store/start", { method: "POST" }, 45_000);
        const j = (await r.json()) as { error?: string; running?: boolean; pid?: number };
        if (!r.ok) throw new Error(j.error ?? r.statusText);
        setStoreRunning(Boolean(j.running));
        setStorePid(typeof j.pid === "number" ? j.pid : null);
        setLiveSignalLoading(true);
        setLiveOn(true);
      } else {
        await apiFetch("/api/live/store/stop", { method: "POST" }, 15_000).catch(() => null);
        setLiveOn(false);
        setStoreRunning(false);
        setStorePid(null);
        setLiveSnap(null);
        setLiveSignal(null);
        setLiveSignalErr(null);
      }
    } catch (e) {
      setLiveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLiveBusy(false);
    }
  }, [liveOn, symbolId]);

  useEffect(() => {
    if (!liveOn) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await apiFetch("/api/live/store/status", { cache: "no-store" });
        const j = (await r.json()) as { running?: boolean; pid?: number | null };
        if (!cancelled && r.ok) {
          setStoreRunning(Boolean(j.running));
          setStorePid(typeof j.pid === "number" ? j.pid : null);
        }
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [liveOn]);

  useEffect(() => {
    setLiveSnap(null);
    setLiveSignal(null);
    setLiveSignalErr(null);
  }, [symbolId]);

  useEffect(() => {
    if (!liveOn || symbolId == null || !liveSymbolCode) return;
    let cancelled = false;
    const poll = async () => {
      setLiveLoading(true);
      try {
        const u = new URL("/api/live/snapshot", window.location.origin);
        u.searchParams.set("symbol_id", String(symbolId));
        u.searchParams.set("code", liveSymbolCode);
        u.searchParams.set("liq_limit", "500");
        const r = await apiFetch(u.toString(), { cache: "no-store" }, 25_000);
        const j = (await r.json()) as LiveSnapshot & { error?: string };
        if (!r.ok) throw new Error(j.error ?? r.statusText);
        if (!cancelled) {
          setLiveSnap(j);
          setLiveErr(null);
        }
      } catch (e) {
        if (!cancelled) setLiveErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLiveLoading(false);
      }
    };
    poll();
    const id = setInterval(poll, LIVE_SNAPSHOT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [liveOn, symbolId, liveSymbolCode]);

  useEffect(() => {
    if (!liveOn || symbolId == null || !liveSymbolCode) return;
    let cancelled = false;
    const pollCandles = async () => {
      if (cancelled) return;
      try {
        const u = new URL("/api/live/candles", window.location.origin);
        u.searchParams.set("symbol_id", String(symbolId));
        u.searchParams.set("code", liveSymbolCode);
        u.searchParams.set("timeframe", timeframe);
        u.searchParams.set("limit", String(LIVE_CANDLES_LIMIT));
        const r = await apiFetch(u.toString(), { cache: "no-store" }, 60_000);
        const j = (await r.json()) as { bars?: CandleApiBar[]; error?: string };
        if (!r.ok || cancelled) return;
        const chunk = j.bars ?? [];
        if (chunk.length === 0) return;
        setBars((prev) => mergeByTime(prev, chunk));
      } catch {
        /* falhas pontuais não limpam o gráfico */
      }
    };
    void pollCandles();
    const id = window.setInterval(() => void pollCandles(), LIVE_CANDLES_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [liveOn, symbolId, liveSymbolCode, timeframe]);

  useEffect(() => {
    if (!liveOn || symbolId == null || !liveSymbolCode) return;
    let cancelled = false;
    const pollSignal = async () => {
      setLiveSignalLoading(true);
      try {
        const u = new URL("/api/live/signal", window.location.origin);
        u.searchParams.set("symbol_id", String(symbolId));
        u.searchParams.set("code", liveSymbolCode);
        u.searchParams.set("timeframe", timeframe);
        u.searchParams.set("limit", "220");
        u.searchParams.set("strategy", "scalp");
        const r = await apiFetch(u.toString(), { cache: "no-store" }, 60_000);
        const j = (await r.json()) as LiveSignal & { error?: string };
        if (!r.ok) throw new Error(j.error ?? r.statusText);
        if (!cancelled) {
          setLiveSignal(j);
          setLiveSignalErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setLiveSignalErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLiveSignalLoading(false);
      }
    };
    void pollSignal();
    const id = window.setInterval(() => void pollSignal(), LIVE_SIGNAL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [liveOn, symbolId, liveSymbolCode, timeframe]);

  useEffect(() => {
    setIndicatorVisibility((prev) => {
      const next: Record<string, boolean> = {};
      for (const i of chartIndicators) {
        next[i.id] = prev[i.id] !== false;
      }
      const pk = Object.keys(prev);
      const nk = Object.keys(next);
      if (pk.length === nk.length) {
        let same = true;
        for (const k of nk) {
          if (prev[k] !== next[k]) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
  }, [chartIndicators]);

  useEffect(() => {
    if (strategyId && !strategiesList.some((s) => s.id === strategyId)) {
      setStrategyId("");
    }
  }, [strategiesList, strategyId]);

  useEffect(() => {
    setIndicatorSettingsOpen(false);
  }, [strategyId]);

  useEffect(() => {
    setStrategyResultsOpen(false);
  }, [strategyId]);

  useLayoutEffect(() => {
    if (chartSplitHydrated.current) return;
    chartSplitHydrated.current = true;
    setChartResultsSplitPx(readInitialChartSplitPx());
  }, []);

  useEffect(() => {
    if (!chartSplitHydrated.current) return;
    setChartResultsSplitPx((h) => clampChartSplitPx(h, chartSplitReserveBottom));
  }, [chartSplitReserveBottom]);

  useEffect(() => {
    const onResize = () => {
      setChartResultsSplitPx((h) =>
        clampChartSplitPx(h, chartSplitReserveBottomRef.current),
      );
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const applyMove = (clientY: number) => {
      const d = chartSplitDragRef.current;
      if (!d) return;
      setChartResultsSplitPx(
        clampChartSplitPx(
          d.startH + (clientY - d.startY),
          chartSplitReserveBottomRef.current,
        ),
      );
    };

    const finish = () => {
      if (chartSplitActivePointerIdRef.current === null) return;
      const pid = chartSplitActivePointerIdRef.current;
      const el = chartSplitCaptureElRef.current;
      chartSplitActivePointerIdRef.current = null;
      chartSplitCaptureElRef.current = null;
      chartSplitDragRef.current = null;
      if (el) {
        try {
          el.releasePointerCapture(pid);
        } catch {
          /* ignore */
        }
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setChartResultsSplitPx((h) => {
        const c = clampChartSplitPx(h, chartSplitReserveBottomRef.current);
        try {
          sessionStorage.setItem(CHART_RESULTS_SPLIT_STORAGE_KEY, String(c));
        } catch {
          /* ignore */
        }
        return c;
      });
    };

    const onPointerMove = (e: PointerEvent) => {
      if (chartSplitActivePointerIdRef.current === null) return;
      if (e.pointerId !== chartSplitActivePointerIdRef.current) return;
      applyMove(e.clientY);
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (chartSplitActivePointerIdRef.current === null) return;
      if (e.pointerId !== chartSplitActivePointerIdRef.current) return;
      finish();
    };

    const onWindowBlur = () => {
      if (chartSplitActivePointerIdRef.current !== null) finish();
    };

    const opts: AddEventListenerOptions = { capture: true };
    document.addEventListener("pointermove", onPointerMove, opts);
    document.addEventListener("pointerup", onPointerEnd, opts);
    document.addEventListener("pointercancel", onPointerEnd, opts);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("pointermove", onPointerMove, opts);
      document.removeEventListener("pointerup", onPointerEnd, opts);
      document.removeEventListener("pointercancel", onPointerEnd, opts);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  const onChartSplitPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      const el = e.currentTarget;
      chartSplitActivePointerIdRef.current = e.pointerId;
      chartSplitCaptureElRef.current = el;
      chartSplitDragRef.current = {
        startY: e.clientY,
        startH: chartResultsSplitPx,
      };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [chartResultsSplitPx],
  );

  const onChartSplitKeyboardStep = useCallback(
    (delta: number) => {
      setChartResultsSplitPx((h) => {
        const n = clampChartSplitPx(h + delta, chartSplitReserveBottom);
        try {
          sessionStorage.setItem(CHART_RESULTS_SPLIT_STORAGE_KEY, String(n));
        } catch {
          /* ignore */
        }
        return n;
      });
    },
    [chartSplitReserveBottom],
  );

  useEffect(() => {
    if (!indicatorSettingsOpen && !indicatorLibraryOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIndicatorSettingsOpen(false);
        setIndicatorLibraryOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [indicatorSettingsOpen, indicatorLibraryOpen]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch("/api/strategies", { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? r.statusText);
        if (cancelled) return;
        const errs = j.load_errors as string[] | undefined;
        if (errs?.length) {
          console.warn("[strategies]", errs.join("; "));
        }
        const base = parseStrategiesPayload(j);

        const built: Strategy[] = [];
        try {
          const br = await apiFetch("/api/chart/builder-strategies", { cache: "no-store" });
          const bj = (await br.json()) as {
            strategies?: { id: string; name: string }[];
            postgres?: string;
            error?: string;
          };
          const pgOk = br.ok && bj.postgres === "ok";
          if (!cancelled) {
            setBuilderPostgres(pgOk ? "ok" : "disabled");
          }
          const rows = pgOk && Array.isArray(bj.strategies) ? bj.strategies : [];
          if (pgOk) {
            for (const row of rows) {
              const dr = await apiFetch(`/api/chart/builder-strategies/${row.id}`, {
                cache: "no-store",
              });
              const dj = (await dr.json()) as { spec?: unknown; error?: string };
              if (!dr.ok || dj.spec == null) continue;
              const parsed = parseChartBuilderSpec(dj.spec);
              if (!parsed.ok) continue;
              built.push({
                id: toBuilderStrategyRowId(row.id),
                label: row.name?.trim() || parsed.spec.name,
                indicators: parsed.spec.indicators,
                isBuilderStrategy: true,
                builderSpec: parsed.spec,
              });
            }
          } else {
            built.push(...localBuilderRowsToStrategies());
          }
        } catch {
          if (!cancelled) setBuilderPostgres("disabled");
          built.length = 0;
          built.push(...localBuilderRowsToStrategies());
        }

        if (cancelled) return;
        setStrategiesList([...base, ...built]);
      } catch {
        if (!cancelled) {
          setBuilderPostgres("disabled");
          setStrategiesList([NONE_STRATEGY, ...localBuilderRowsToStrategies()]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [strategyRefreshKey]);

  const openBuilderCreate = useCallback(() => {
    setBuilderDraft({ mode: "create" });
    setBuilderModalOpen(true);
  }, []);

  const openBuilderEdit = useCallback(
    (uuid: string) => {
      const rowId = toBuilderStrategyRowId(uuid);
      const s = strategiesList.find((x) => x.id === rowId);
      if (!s?.isBuilderStrategy || !s.builderSpec) return;
      setBuilderDraft({ mode: "edit", uuid, spec: s.builderSpec });
      setBuilderModalOpen(true);
    },
    [strategiesList],
  );

  const toggleIndicator = useCallback((id: string) => {
    setIndicatorVisibility((v) => ({ ...v, [id]: v[id] === false }));
  }, []);

  useEffect(() => {
    setChartHeaderSlot(
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 sm:flex-nowrap sm:gap-3">
        <select
          id="chart-sim-engine"
          aria-label="Motor de simulação"
          title="JS: simulação no browser. VBT: vectorbt no servidor. Both: comparar indicadores e métricas."
          value={simEngineMode}
          onChange={(e) => setSimEngineMode(parseSimEngineMode(e.target.value))}
          className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900/90 px-2 py-1.5 text-xs font-medium text-zinc-200"
        >
          <option value="js">Sim: JS</option>
          <option value="vbt">Sim: VBT</option>
          <option value="both">Sim: Both</option>
        </select>

        <button
          type="button"
          disabled={symbolId == null || liveBusy}
          onClick={() => void toggleLive()}
          title={
            symbolId == null
              ? "Escolhe um par primeiro"
              : liveOn
                ? "Parar store e fechar painel live"
                : "Arrancar store.py e mostrar tape, funding, OI, livro e liquidações"
          }
          className={
            "shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 " +
            (liveOn
              ? "bg-emerald-600/95 text-white shadow-sm shadow-emerald-950/50"
              : "bg-zinc-800/90 text-zinc-200 hover:bg-zinc-700")
          }
        >
          {liveBusy ? "…" : "Live"}
        </button>

        <ChartMenuDropdown
          id="chart-symbol"
          ariaLabel="Par / moeda"
          badge="Par"
          options={symbolMenuOptions}
          value={symbolId != null ? String(symbolId) : ""}
          onChange={(v) => setSymbolId(v ? Number(v) : null)}
          className="min-w-0 max-w-[min(12rem,calc(100vw-9rem))] sm:max-w-[14rem]"
          menuMinWidth="wide"
        />

        <ChartMenuDropdown
          id="chart-tf"
          ariaLabel="Timeframe"
          badge="TF"
          options={timeframeMenuOptions}
          value={timeframe}
          onChange={setTimeframe}
          className="w-[4.75rem] shrink-0 sm:w-[6.25rem]"
        />

        <ChartMenuDropdown
          id="chart-visual-mode"
          ariaLabel="Tipo de candles"
          badge="Tipo"
          options={chartVisualModeOptions}
          value={chartVisualMode}
          onChange={(v) => setChartVisualMode(v === "footprint" ? "footprint" : "candles")}
          className="w-[7.5rem] shrink-0"
        />

        <div className="flex min-w-0 max-w-full items-center gap-1.5 sm:gap-2">
          <ChartLibraryHeaderButton
            open={indicatorLibraryOpen}
            onOpenChange={(v) => {
              setIndicatorLibraryOpen(v);
              if (v) setIndicatorSettingsOpen(false);
            }}
          />
          <ChartSettingsGearButton
            open={indicatorSettingsOpen}
            onOpenChange={(v) => {
              setIndicatorSettingsOpen(v);
              if (v) setIndicatorLibraryOpen(false);
            }}
            disabled={chartIndicators.length === 0}
          />
        </div>

        {loadingOlder ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-400/90 sm:text-[11px]">
            <span className="h-1 w-1 animate-pulse rounded-full bg-sky-400" />
            Histórico
          </span>
        ) : null}

        <button
          type="button"
          disabled={!bars.length}
          onClick={exportIndicatorDebugCsv}
          className="shrink-0 rounded-lg bg-zinc-800/90 px-2.5 py-1.5 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-40"
          title="Exportar CSV dos últimos 2000 candles com OHLCV e indicadores TA alinhados"
        >
          CSV ind.
        </button>

        <button
          type="button"
          onClick={() => {
            setIndicatorLibraryOpen(false);
            setIndicatorSettingsOpen(false);
            openBuilderCreate();
          }}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-900/90 text-zinc-400 shadow-inner shadow-black/20 transition-colors hover:border-emerald-600/50 hover:text-emerald-200 focus:border-emerald-600/70 focus:outline-none focus:ring-2 focus:ring-emerald-600/25"
          title="Nova estratégia (builder)"
          aria-label="Nova estratégia (builder)"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
            <path strokeWidth="2" strokeLinecap="round" d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>,
    );
    return () => setChartHeaderSlot(null);
  }, [
    loadingOlder,
    setChartHeaderSlot,
    symbolId,
    symbolMenuOptions,
    timeframe,
    timeframeMenuOptions,
    chartVisualMode,
    chartVisualModeOptions,
    indicatorSettingsOpen,
    indicatorLibraryOpen,
    chartIndicators.length,
    liveOn,
    liveBusy,
    toggleLive,
    simEngineMode,
    bars.length,
    exportIndicatorDebugCsv,
    openBuilderCreate,
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch("/api/symbols", { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? r.statusText);
        const list = (j.symbols ?? []) as SymbolRow[];
        if (cancelled) return;
        setSymbols(list);
        setSymbolId((prev) => (prev == null && list.length ? list[0].symbol_id : prev));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (symbolId == null) return;
    setResetKey((k) => k + 1);
    fetchingOlderRef.current = false;
    let cancelled = false;
    (async () => {
      setError(null);
      setBars([]);
      setHasMoreOlder(false);
      try {
        const u = new URL("/api/candles", window.location.origin);
        u.searchParams.set("symbol_id", String(symbolId));
        u.searchParams.set("timeframe", timeframe);
        u.searchParams.set("before_ms", String(Date.now()));
        const initialLimit = adaptiveInitialLimit(timeframe);
        u.searchParams.set("limit", String(initialLimit));
        u.searchParams.set("target_points", String(initialLimit));
        const r = await apiFetch(u.toString(), { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? r.statusText);
        if (cancelled) return;
        setBars(mergeByTime([], (j.bars ?? []) as CandleApiBar[]));
        setHasMoreOlder(Boolean(j.has_more_older));
      } catch (e) {
        if (!cancelled) {
          setBars([]);
          setHasMoreOlder(false);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbolId, timeframe]);

  /** Refs em vez de deps em `bars` — evita nova função a cada vela e menos trabalho no OhlcvChart (menos churn em dev). */
  const onNeedOlder = useCallback(async () => {
    if (
      fetchingOlderRef.current ||
      loadingOlderRef.current ||
      !hasMoreOlderRef.current ||
      symbolIdRef.current == null ||
      barsRef.current.length === 0
    ) {
      return;
    }
    const sid = symbolIdRef.current;
    const tf = timeframeRef.current;
    fetchingOlderRef.current = true;
    setLoadingOlder(true);
    setError(null);
    const oldestMs = barsRef.current[0].t * 1000;
    try {
      const u = new URL("/api/candles", window.location.origin);
      u.searchParams.set("symbol_id", String(sid));
      u.searchParams.set("timeframe", tf);
      u.searchParams.set("before_ms", String(oldestMs));
      u.searchParams.set("limit", String(OLDER_TARGET_POINTS));
      u.searchParams.set("target_points", String(OLDER_TARGET_POINTS));
      const r = await apiFetch(u.toString(), { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      const chunk = (j.bars ?? []) as CandleApiBar[];
      setHasMoreOlder(Boolean(j.has_more_older));
      if (chunk.length === 0) {
        setHasMoreOlder(false);
      } else {
        setBars((prev) => mergeByTime(chunk, prev));
      }
    } catch (e) {
      setHasMoreOlder(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
      fetchingOlderRef.current = false;
    }
  }, []);

  const backtestOverlayHint = useMemo(() => {
    if (!strategyId || chartBacktest) return null;
    if (strategy.isBuilderStrategy && (simEngineMode === "vbt" || simEngineMode === "both")) {
      return "Estratégia builder: só simulação JS (vectorbt não aplicável). Escolhe «Sim: JS» no motor.";
    }
    if (!strategy.vbt_strategy && !strategy.isBuilderStrategy) return null;
    const vbt = String(strategy.vbt_strategy ?? "");
    if (simEngineMode === "js" && !chartStrategyHasJsSimulation(strategy)) {
      return "Motor JS: esta estratégia ainda não tem port em TypeScript — escolhe VBT ou Both, ou adiciona um motor em lib/liveStrategy/chartSimStrategies.ts.";
    }
    if (simEngineMode === "js" && chartStrategyHasJsSimulation(strategy) && bars.length < 24) {
      return "Simulação JS: carrega mais velas (histórico) para indicadores e trades estáveis; ou corre Backtests para overlay QuestDB.";
    }
    if (simEngineMode === "vbt" || simEngineMode === "both") {
      if (serverSimLoading) {
        return "A simular a estratégia nas velas do gráfico no servidor (vectorbt)…";
      }
      if (serverSimErr) {
        return `Simulação no servidor: ${serverSimErr}`;
      }
    }
    if (simEngineMode !== "js") return null;
    const chartCode =
      symbolId == null ? null : (symbols.find((s) => s.symbol_id === symbolId)?.code ?? null);
    const prologue =
      "Com simulação JS nas velas carregadas; com backtest concluído no mesmo par e estratégia, também podes ver overlay QuestDB. ";
    if (!chartCode) {
      return prologue + "Escolhe um par no seletor do gráfico.";
    }
    if (backtestStatus === "running") {
      return prologue + "Aguarda o job a terminar na barra de progresso.";
    }
    if (backtestStatus !== "completed" || !backtestResults?.length) {
      return (
        prologue +
        `Para overlay só QuestDB: Backtests, inclui o par ${chartCode}, min. de trades baixo, inicia. Recarregar mantém o resultado (sessionStorage) se o job tiver concluído.`
      );
    }
    return (
      prologue +
      `Há backtest concluído, mas nenhum overlay QuestDB para ${chartCode} (ou chart_overlay em falta). Inclui o par no job ou reduz o mín. de trades.`
    );
  }, [
    strategyId,
    strategy.vbt_strategy,
    strategy.isBuilderStrategy,
    chartBacktest,
    bars.length,
    symbolId,
    symbols,
    backtestStatus,
    backtestResults?.length,
    serverSimLoading,
    serverSimErr,
    simEngineMode,
  ]);

  return (
    <div
      className={
        "flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden px-0 pb-0 pt-0 transition-[padding] duration-200 " +
        (builderModalOpen ? "pl-[min(100vw,28rem)] sm:pl-[min(100vw,36rem)]" : "")
      }
    >
      <div
        className={
          "flex min-h-0 min-w-0 flex-row gap-2 overflow-hidden " +
          (liveLayout
            ? showResultsAccordion
              ? "max-h-[min(52vh,calc(100dvh-14rem))] flex-1"
              : "shrink-0"
            : showIdleChartSplit
              ? "min-h-0 flex-1"
              : "flex-1")
        }
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-0">
          <ChartIndicatorToolbar
            strategy={settingsStrategy}
            visibility={indicatorVisibility}
            onToggle={toggleIndicator}
            removableUserIndicatorIds={userIndicatorIdSet}
            onRemoveUserIndicator={removeUserIndicator}
          />
          {taRequest.indicators.length > 0 ? (
            <p
              className="shrink-0 border-b border-zinc-800/40 bg-zinc-950/40 px-2 py-0.5 text-[10px] text-zinc-500"
              role="status"
            >
              {taErr ? (
                <span className="text-red-400/90">TA servidor: {taErr}</span>
              ) : (
                <>
                  Indicadores TA (pandas no backend via API)
                  {taLoading
                    ? " · a calcular…"
                    : taComputeMs != null
                      ? ` · ${taComputeMs.toFixed(2)} ms`
                      : null}
                </>
              )}
            </p>
          ) : null}
          {backtestOverlayHint ? (
            <p
              className="shrink-0 border-b border-amber-500/25 bg-amber-950/25 px-2 py-1.5 text-[11px] leading-snug text-amber-100/90"
              role="status"
            >
              {backtestOverlayHint}
            </p>
          ) : null}
          {chartVisualMode === "footprint" && footprintInfo ? (
            <p
              className="shrink-0 border-b border-cyan-500/20 bg-cyan-950/20 px-2 py-1 text-[10px] text-cyan-100/80"
              role="status"
            >
              {footprintInfo} · faz zoom para ler buy/sell por nível
            </p>
          ) : null}
          <div
            className={
              showResultsAccordion
                ? "app-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain"
                : liveLayout && !showResultsAccordion
                  ? "flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden"
                  : showIdleChartSplit
                    ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                    : "min-h-0 min-w-0 flex-1 overflow-hidden"
            }
          >
            <div
              className={
                useFixedChartHeightSplit
                  ? "flex shrink-0 flex-col overflow-hidden"
                  : "min-h-0 flex-1"
              }
              style={
                useFixedChartHeightSplit
                  ? { height: chartResultsSplitPx, minHeight: 0 }
                  : undefined
              }
            >
              <OhlcvChart
                bars={bars}
                loadingOlder={loadingOlder}
                error={error}
                hasMoreOlder={liveOn ? false : hasMoreOlder}
                onNeedOlder={liveOn ? () => {} : onNeedOlder}
                resetKey={resetKey}
                indicatorDefs={indicatorDefs}
                indicatorVisibility={indicatorVisibility}
                liveSnapshot={liveOn ? liveSnap : null}
                backtestChart={chartBacktest}
                backtestStrategyLabel={strategyId ? strategy.label : null}
                backtestOverlayMode={backtestOverlayMode}
                embedBacktestEquityInChart={!chartBacktest}
                backtestKpiInChart={!chartBacktest}
                onMainChartApi={setMainChartApi}
                taServerLines={taServerLines}
                taServerMacd={taServerMacd}
                taServerTalibMulti={taServerTalibMulti}
                featSeries={barFeatLineSeries}
                featVisibility={featChartVisibility}
                footprintBars={chartVisualMode === "footprint" ? footprintBars : null}
              />
            </div>
            {showResultsAccordion ? (
              <ChartSplitHandle
                ariaLabel="Arrastar para ajustar a altura do gráfico em relação aos resultados"
                valuePx={chartResultsSplitPx}
                reserveBottom={chartSplitReserveBottom}
                onPointerDown={onChartSplitPointerDown}
                onKeyboardStep={onChartSplitKeyboardStep}
              />
            ) : null}
            {(liveLayout && !showResultsAccordion) || showIdleChartSplit ? (
              <ChartSplitHandle
                ariaLabel={
                  liveLayout
                    ? "Arrastar para ajustar a altura do gráfico em relação ao painel em tempo real"
                    : "Arrastar para ajustar a altura do gráfico em relação à área abaixo"
                }
                valuePx={chartResultsSplitPx}
                reserveBottom={chartSplitReserveBottom}
                onPointerDown={onChartSplitPointerDown}
                onKeyboardStep={onChartSplitKeyboardStep}
              />
            ) : null}
            {showIdleChartSplit ? (
              <div className="min-h-0 min-w-0 flex-1 bg-zinc-950" aria-hidden />
            ) : null}
            {showResultsAccordion ? (
              <StrategyResultsAccordion
                open={strategyResultsOpen}
                onOpenChange={setStrategyResultsOpen}
                strategyLabel={strategyId ? strategy.label : null}
              >
                {simEngineMode === "both" && strategy.vbt_strategy ? (
                  <SimulationParityPanel
                    jsLayer={jsSimLayer}
                    vbtLayer={serverSimLayer}
                    jsIndicators={chartTaIndicatorSeries}
                    barTimes={bars.map((b) => b.t)}
                    serverLoading={serverSimLoading}
                    serverErr={serverSimErr}
                    hasJsTradeEngine={chartStrategyHasJsSimulation(strategy)}
                  />
                ) : null}
                {chartBacktest ? (
                  <StrategyTesterPanel
                    backtest={chartBacktest}
                    strategyLabel={strategyId ? strategy.label : null}
                    overlayMode={backtestOverlayMode}
                    mainChart={mainChartApi}
                    lastBarTimeSec={lastBarTimeSec}
                  />
                ) : null}
              </StrategyResultsAccordion>
            ) : null}
          </div>
        </div>
        {indicatorLibraryOpen ? (
          <div className="h-full min-h-0 w-[min(18rem,calc(100vw-3rem))] shrink-0 overflow-hidden sm:w-80">
            <ChartIndicatorLibrarySidebar
              strategies={strategiesList}
              selectedStrategyId={strategyId}
              onSelectStrategy={setStrategyId}
              onAddTemplate={addUserIndicatorFromCatalog}
              talibCatalog={chartIndicatorLibraryCatalog}
              onClose={() => setIndicatorLibraryOpen(false)}
              builderPostgres={builderPostgres}
              onOpenBuilder={openBuilderCreate}
              onEditBuilder={openBuilderEdit}
              featVisibility={featChartVisibility}
              onToggleFeatVisibility={(id, next) =>
                setFeatChartVisibility((prev) => ({
                  ...prev,
                  [id]: next,
                }))
              }
            />
          </div>
        ) : indicatorSettingsOpen && chartIndicators.length > 0 ? (
          <div className="h-full min-h-0 w-[min(18rem,calc(100vw-3rem))] shrink-0 overflow-hidden sm:w-72">
            <ChartIndicatorSettingsSidebar
              strategy={settingsStrategy}
              overrides={settingsOverridesByIndicatorId}
              onPatch={patchIndicatorOverride}
              onResetParams={resetIndicatorParams}
              onResetStyle={resetIndicatorStyle}
              onTrendCompositeChange={commitTrendComposite}
              onClose={() => setIndicatorSettingsOpen(false)}
            />
          </div>
        ) : null}
      </div>

      {liveLayout ? (
        <div
          className={
            "flex min-h-[min(42vh,20rem)] min-w-0 flex-1 flex-col overflow-hidden border-zinc-800/80 " +
            (showResultsAccordion ? "border-t" : "")
          }
        >
          <LiveMarketPanel
            snapshot={liveSnap}
            loading={liveLoading}
            error={liveErr}
            signal={liveSignal}
            signalLoading={liveSignalLoading}
            signalError={liveSignalErr}
            storeRunning={storeRunning}
            storePid={storePid}
          />
        </div>
      ) : null}

      <ChartStrategyBuilderModal
        open={builderModalOpen}
        draft={builderDraft}
        indicatorCatalog={chartIndicatorLibraryCatalog}
        indicatorOverridesForSave={settingsOverridesByIndicatorId}
        persistToLocalStorage={builderPostgres === "disabled"}
        onClose={() => {
          setBuilderModalOpen(false);
          setBuilderDraft(null);
        }}
        onSaved={(saved) => {
          if (saved) {
            const rowId = toBuilderStrategyRowId(saved.uuid);
            const nextStrategy: Strategy = {
              id: rowId,
              label: saved.spec.name,
              indicators: saved.spec.indicators,
              isBuilderStrategy: true,
              builderSpec: saved.spec,
            };
            setStrategiesList((rows) => {
              const idx = rows.findIndex((x) => x.id === rowId);
              if (idx < 0) return [...rows, nextStrategy];
              const next = [...rows];
              next[idx] = nextStrategy;
              return next;
            });
            setStrategyId(rowId);
            setBuilderDraft({ mode: "edit", uuid: saved.uuid, spec: saved.spec });
          }
          setStrategyRefreshKey((k) => k + 1);
        }}
        onDeleted={(uuid) => {
          setStrategyRefreshKey((k) => k + 1);
          setStrategyId((cur) => (cur === toBuilderStrategyRowId(uuid) ? "" : cur));
        }}
      />
    </div>
  );
}
