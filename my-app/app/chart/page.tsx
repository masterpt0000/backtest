"use client";

import {
  ChartIndicatorLibrarySidebar,
  ChartLibraryHeaderButton,
} from "@/components/ChartIndicatorLibrarySidebar";
import {
  ChartIndicatorSettingsSidebar,
  ChartSettingsGearButton,
} from "@/components/ChartIndicatorSettingsUI";
import { ChartIndicatorToolbar } from "@/components/ChartIndicatorToolbar";
import { ChartMenuDropdown } from "@/components/ChartMenuDropdown";
import { useSetChartHeaderSlot } from "@/components/ChartHeaderSlotContext";
import { LiveMarketPanel, type LiveSignal, type LiveSnapshot } from "@/components/LiveMarketPanel";
import { OhlcvChart, type CandleApiBar, type ChartIndicatorDef } from "@/components/OhlcvChart";
import {
  chartOverrideKey,
  effectiveSource,
  readIndicatorOverride,
  USER_INDICATOR_SCOPE,
  type ChartIndicatorOverride,
} from "@/lib/chartIndicatorSettings";
import { createUserIndicatorFromTemplate } from "@/lib/indicatorCatalog";
import {
  parseStandaloneIndicatorsFromStorage,
  STANDALONE_INDICATORS_STORAGE_KEY,
  USER_INDICATORS_STORAGE_KEY,
} from "@/lib/standaloneIndicators";
import {
  getStrategyById,
  NONE_STRATEGY,
  parseStrategiesPayload,
  type Strategy,
  type StrategyIndicator,
} from "@/lib/strategies";
import { apiFetch } from "@/lib/apiFetch";
import { TIMEFRAME_OPTIONS } from "@/lib/timeframes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SymbolRow = { symbol_id: number; code: string };

const INITIAL_LIMIT = 5000;
const OLDER_CHUNK = 2500;

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

function mergeByTime(older: CandleApiBar[], newer: CandleApiBar[]): CandleApiBar[] {
  const m = new Map<number, CandleApiBar>();
  for (const b of older) m.set(b.t, b);
  for (const b of newer) m.set(b.t, b);
  return Array.from(m.keys())
    .sort((a, b) => a - b)
    .map((k) => m.get(k)!);
}

export default function ChartPage() {
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
  const [indicatorVisibility, setIndicatorVisibility] = useState<Record<string, boolean>>({});
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

  const strategy = useMemo(
    () => getStrategyById(strategiesList, strategyId),
    [strategiesList, strategyId],
  );

  const userIndicatorIdSet = useMemo(
    () => new Set(userIndicators.map((i) => i.id)),
    [userIndicators],
  );

  const chartIndicators = useMemo(() => {
    if (!strategyId) return userIndicators;
    return [...strategy.indicators, ...userIndicators];
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

  const addUserIndicatorFromCatalog = useCallback((templateId: string) => {
    const ind = createUserIndicatorFromTemplate(templateId);
    if (ind) setUserIndicators((prev) => [...prev, ind]);
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
      const key = userIndicatorIdSet.has(indicatorId)
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
    [strategyId, userIndicatorIdSet],
  );

  const resetIndicatorParams = useCallback(
    (indicatorId: string) => {
      const key = userIndicatorIdSet.has(indicatorId)
        ? chartOverrideKey(USER_INDICATOR_SCOPE, indicatorId)
        : chartOverrideKey(strategyId, indicatorId);
      setIndicatorOverrides((prev) => {
        const cur = prev[key];
        if (!cur) return prev;
        const rest = { ...cur };
        delete rest.period;
        delete rest.mult;
        delete rest.source;
        const next = { ...prev };
        if (Object.keys(rest).length === 0) delete next[key];
        else next[key] = rest;
        return next;
      });
    },
    [strategyId, userIndicatorIdSet],
  );

  const resetIndicatorStyle = useCallback(
    (indicatorId: string) => {
      const key = userIndicatorIdSet.has(indicatorId)
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
    [strategyId, userIndicatorIdSet],
  );

  const settingsOverridesByIndicatorId = useMemo(() => {
    const out: Record<string, ChartIndicatorOverride | undefined> = {};
    for (const i of chartIndicators) {
      out[i.id] = readIndicatorOverride(
        indicatorOverrides,
        strategyId,
        i.id,
        userIndicatorIdSet.has(i.id),
      );
    }
    return out;
  }, [chartIndicators, indicatorOverrides, strategyId, userIndicatorIdSet]);

  const indicatorDefs = useMemo((): ChartIndicatorDef[] => {
    return chartIndicators.map((i) => {
      const o = readIndicatorOverride(
        indicatorOverrides,
        strategyId,
        i.id,
        userIndicatorIdSet.has(i.id),
      );
      return {
        id: i.id,
        kind: i.kind,
        label: i.label,
        period: o?.period ?? i.params?.period,
        mult: o?.mult ?? i.params?.mult,
        source: effectiveSource(i, o),
        color: o?.color,
        colorUpper: o?.colorUpper,
        colorMid: o?.colorMid,
        colorLower: o?.colorLower,
        lineWidth: o?.lineWidth,
      };
    });
  }, [chartIndicators, indicatorOverrides, strategyId, userIndicatorIdSet]);

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
        setStrategiesList(parseStrategiesPayload(j));
      } catch {
        if (!cancelled) setStrategiesList([NONE_STRATEGY]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleIndicator = useCallback((id: string) => {
    setIndicatorVisibility((v) => ({ ...v, [id]: v[id] === false }));
  }, []);

  useEffect(() => {
    setChartHeaderSlot(
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 sm:flex-nowrap sm:gap-3">
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
    indicatorSettingsOpen,
    indicatorLibraryOpen,
    chartIndicators.length,
    liveOn,
    liveBusy,
    toggleLive,
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
        u.searchParams.set("limit", String(INITIAL_LIMIT));
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
      u.searchParams.set("limit", String(OLDER_CHUNK));
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

  const liveLayout = liveOn && symbolId != null;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden px-0 pb-0 pt-0">
      <div
        className={
          "flex min-h-0 min-w-0 flex-row gap-2 overflow-hidden " +
          (liveLayout ? "max-h-[min(52vh,calc(100dvh-14rem))] flex-1" : "flex-1")
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
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
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
            />
          </div>
        </div>
        {indicatorLibraryOpen ? (
          <div className="h-full min-h-0 w-[min(18rem,calc(100vw-3rem))] shrink-0 overflow-hidden sm:w-80">
            <ChartIndicatorLibrarySidebar
              strategies={strategiesList}
              selectedStrategyId={strategyId}
              onSelectStrategy={setStrategyId}
              onAddTemplate={addUserIndicatorFromCatalog}
              onClose={() => setIndicatorLibraryOpen(false)}
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
              onClose={() => setIndicatorSettingsOpen(false)}
            />
          </div>
        ) : null}
      </div>

      {liveLayout ? (
        <div className="flex min-h-[min(42vh,20rem)] min-w-0 flex-1 flex-col overflow-hidden border-t border-zinc-800/80">
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
    </div>
  );
}
