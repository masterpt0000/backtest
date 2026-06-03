"use client";

import { useBacktestJob } from "@/components/BacktestJobProvider";
import { BacktestMultiTrialCharts } from "@/components/BacktestMultiTrialCharts";
import { apiFetch } from "@/lib/apiFetch";
import type { BacktestPresetParamsV1, StrategyPresetRow } from "@/lib/backtestPresetTypes";
import { isPresetParamsV1 } from "@/lib/backtestPresetTypes";
import type { BacktestRangePreset, BacktestRunPayload, BacktestValidationFramework } from "@/lib/backtestTypes";
import { collectBuilderDriftKeys, driftTripletPreview } from "@/lib/builderDriftKeys";
import {
  applyOptimizedParamsToBuilderSpec,
  pickRowOptimizedParams,
} from "@/lib/applyOptimizedParamsToBuilderSpec";
import { persistChartSimParityFromBacktests } from "@/lib/chartSimParityBridge";
import { storeOptimizedVbtParamsForChart } from "@/lib/chartVbtOptimizedParamsBridge";
import { parseChartBuilderSpec } from "@/lib/chartBuilderSpec";
import { upsertLocalBuilderStrategy } from "@/lib/chartBuilderLocalStorage";
import { notifyChartBuilderStrategySynced } from "@/lib/chartBuilderStrategyExternalSync";
import { TIMEFRAME_OPTIONS, isValidTimeframe } from "@/lib/timeframes";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

type SymbolRow = { symbol_id: number; code: string };

type VbtStrategyRow = { id: string; module: string; label: string };
type BuilderStrategyRow = { id: string; name: string; updated_at?: string | null };

const RANGE_OPTIONS: { value: BacktestRangePreset; label: string }[] = [
  { value: "7d", label: "Últimos 7 dias" },
  { value: "30d", label: "Últimos 30 dias" },
  { value: "90d", label: "Últimos 90 dias" },
  { value: "1y", label: "Último ano" },
  { value: "max", label: "Máximo disponível" },
];

const BEST_BY_OPTIONS = [
  { value: "return_pct", label: "Retorno %" },
  { value: "profit_fct", label: "Profit factor" },
  { value: "win_rate", label: "Win rate" },
  { value: "sharpe", label: "Sharpe" },
  { value: "expectancy", label: "Expectancy" },
  { value: "max_dd", label: "Drawdown (menor abs)" },
  { value: "trades", label: "Nº trades" },
] as const;

function toRangePreset(x: string): BacktestRangePreset {
  const ok: BacktestRangePreset[] = ["7d", "30d", "90d", "1y", "max"];
  return ok.includes(x as BacktestRangePreset) ? (x as BacktestRangePreset) : "30d";
}

/** Clamp custos/exec % ao mesmo intervalo que o backend (0–2%). */
function clampExecPctPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(2, Math.max(0, n));
}

const UI_MODE_STORAGE_KEY = "backtests:uiMode";

function diagNum(d: Record<string, unknown> | null | undefined, key: string): number {
  if (!d) return 0;
  const v = d[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }
  return 0;
}

/** Mensagem quando o job termina sem linhas na tabela de resultados. */
function zeroResultsExplanation(jobDiagnostics: Record<string, unknown> | null): string {
  const parts: string[] = [];
  const skipNd = diagNum(jobDiagnostics, "skip_no_data");
  const skipShort = diagNum(jobDiagnostics, "skip_short_series");
  const trials = diagNum(jobDiagnostics, "trials_executed");
  const below = diagNum(jobDiagnostics, "trials_below_min_trades");
  const minF = diagNum(jobDiagnostics, "min_trades_filter");

  if (skipNd > 0) {
    parts.push(
      `${skipNd} combinação(ões) par×timeframe sem barras na QuestDB (verifica símbolo e TF).`,
    );
  }
  if (skipShort > 0) {
    parts.push(
      `${skipShort} combinação(ões) com série demasiado curta (o motor precisa de pelo menos max(50, mín. trades) velas).`,
    );
  }
  if (trials > 0 && below >= trials) {
    parts.push(
      `Todos os ${trials} trial(s) executados tiveram menos de ${minF > 0 ? minF : 1} trade(s) (filtro mín. trades). Tenta baixar «Mín. trades», desactivar stress de parâmetros, ou rever a grelha.`,
    );
  } else if (trials > 0 && below > 0) {
    parts.push(
      `${below} de ${trials} trial(s) ficaram abaixo do mínimo de trades (${minF}).`,
    );
  }
  if (parts.length === 0) {
    const te = diagNum(jobDiagnostics, "trials_executed");
    if (te === 0) {
      return (
        "Nenhum trial chegou a correr para as combinações par×timeframe (série vazia na QuestDB, pré-filtro 1m, ou poucas velas vs. mínimo). " +
        "Experimenta menos timeframes de uma vez (ex. só 5m), um par mais líquido, ou verifica ingest."
      );
    }
    return (
      `Foram executados ${te} sweep(s) de indicadores mas não há linhas que passem filtros ou ranking. ` +
      `Para Trend composite gate, o mínimo de 50 trades por coluna vectorbt elimina muitos resultados — prova 10–20 primeiro; ` +
      `aumenta também Max tries se optimizares muitos parâmetros (várias chaves tc_*).`
    );
  }
  return parts.join(" ");
}

/** Ícone de informação: usa span (não button) para poder ficar dentro de botões sem HTML inválido. Tooltip = title ao hover. */
function FieldInfo({ title: tip }: { title: string }) {
  return (
    <span
      tabIndex={0}
      className="inline-flex size-[14px] shrink-0 cursor-help items-center justify-center rounded-full border border-zinc-600/80 bg-zinc-900 text-[9px] font-semibold leading-none text-zinc-500 transition-colors hover:border-emerald-600/35 hover:text-emerald-300/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/70"
      aria-label={tip}
      title={tip}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") e.preventDefault();
      }}
    >
      i
    </span>
  );
}

/** Rótulo de campo + ícone de informação alinhados. */
function LabelWithInfo({ children, info }: { children: ReactNode; info: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      <FieldInfo title={info} />
    </span>
  );
}

type ResultRow = {
  symbol?: string;
  timeframe?: string;
  optimize_rank?: number;
  return_pct?: number;
  win_rate?: number;
  trades?: number;
  max_dd?: number;
  sharpe?: number;
  profit_fct?: number;
  expectancy?: number;
  n_valid?: number;
  best_params?: Record<string, unknown>;
  /** Builder: parâmetros efectivos (inclui indicadores); preferir para UI vs grelha só. */
  resolved_params?: Record<string, unknown>;
  oos_return_pct?: number | null;
  oos_trades?: number | null;
  oos_sharpe?: number | null;
  oos_max_dd?: number | null;
};

function formatBestParamsLines(bp: Record<string, unknown> | undefined): string {
  if (!bp || typeof bp !== "object") return "";
  const keys = Object.keys(bp).sort((a, b) => a.localeCompare(b));
  if (!keys.length) return "";
  return keys.map((k) => `${k}: ${JSON.stringify(bp[k])}`).join("\n");
}

/** Parâmetros da linha de resultado: snapshot completo builder ou só grelha. */
function BestParamsCell({
  resolved,
  gridSubset,
}: {
  resolved?: Record<string, unknown>;
  gridSubset?: Record<string, unknown>;
}) {
  const primary = resolved && Object.keys(resolved).length > 0 ? resolved : gridSubset;
  const text = formatBestParamsLines(primary);
  const n = primary && typeof primary === "object" ? Object.keys(primary).length : 0;
  if (!text) {
    return <span className="text-zinc-600">—</span>;
  }
  const hint =
    resolved && Object.keys(resolved).length > 0
      ? "Parâmetros efectivos desta linha (risco, zonas e todos os números dos indicadores)."
      : "Só variáveis da grelha de optimização (activa «Stress de parâmetros» para optimizar também indicadores).";
  return (
    <details className="max-w-[min(22rem,55vw)]">
      <summary className="cursor-pointer select-none text-emerald-400/90 hover:text-emerald-300" title={hint}>
        Ver ({n})
      </summary>
      <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-md border border-zinc-800/90 bg-zinc-950/90 p-2 font-mono text-[10px] leading-snug text-zinc-400">
        {text}
      </pre>
    </details>
  );
}

export default function BacktestsPage() {
  const {
    status,
    progress,
    phase,
    run,
    error,
    results,
    trialBatches,
    walkForward,
    monteCarlo,
    jobDiagnostics,
    startBacktest,
    cancelBacktest,
    dismissCompleted,
  } = useBacktestJob();

  const [tab, setTab] = useState<"single" | "optimize">("single");

  /** Igual no servidor e no 1.º paint no cliente — session só depois em ``useEffect`` (evita hydration mismatch). */
  const [uiMode, setUiMode] = useState<"simple" | "advanced">("simple");

  useEffect(() => {
    try {
      const v = window.sessionStorage.getItem(UI_MODE_STORAGE_KEY);
      if (v === "advanced") setUiMode("advanced");
      else if (v === "simple") setUiMode("simple");
    } catch {
      /* ignore */
    }
  }, []);

  const persistUiMode = useCallback((mode: "simple" | "advanced") => {
    setUiMode(mode);
    try {
      window.sessionStorage.setItem(UI_MODE_STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, []);

  const [vbtStrategies, setVbtStrategies] = useState<VbtStrategyRow[]>([]);
  const [builderStrategies, setBuilderStrategies] = useState<BuilderStrategyRow[]>([]);
  const [symbols, setSymbols] = useState<SymbolRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [strategySource, setStrategySource] = useState<"vbt" | "builder">("builder");
  const [vbtStrategyId, setVbtStrategyId] = useState("");
  const [builderStrategyId, setBuilderStrategyId] = useState("");
  const [builderSpec, setBuilderSpec] = useState<Record<string, unknown> | null>(null);
  const [paramsApplyFeedback, setParamsApplyFeedback] = useState<string | null>(null);
  const [paramsApplyError, setParamsApplyError] = useState<string | null>(null);
  const [copyParamsBusyKey, setCopyParamsBusyKey] = useState<string | null>(null);
  const [selectedTimeframes, setSelectedTimeframes] = useState<Set<string>>(() => new Set(["5m"]));
  const [rangePreset, setRangePreset] = useState<BacktestRangePreset>("30d");
  const [initialCash, setInitialCash] = useState(10_000);
  const [numTests, setNumTests] = useState(50);
  const [maxTries, setMaxTries] = useState(500);
  const [bestBy, setBestBy] = useState<string>("return_pct");
  const [minTrades, setMinTrades] = useState(50);
  const [optimizeSeed, setOptimizeSeed] = useState("");
  const [gridSample, setGridSample] = useState<"lhs" | "random">("lhs");
  const [optimizeTopK, setOptimizeTopK] = useState(5);
  const [holdoutPct, setHoldoutPct] = useState(0);
  const [includeUiCharts, setIncludeUiCharts] = useState(false);
  const [execFeePctPerFill, setExecFeePctPerFill] = useState(0);
  const [execSlippagePct, setExecSlippagePct] = useState(0);
  const [execHalfSpreadPct, setExecHalfSpreadPct] = useState(0);
  useEffect(() => {
    persistChartSimParityFromBacktests({
      exec_fee_pct_per_fill: clampExecPctPct(execFeePctPerFill),
      exec_slippage_pct: clampExecPctPct(execSlippagePct),
      exec_half_spread_pct: clampExecPctPct(execHalfSpreadPct),
      min_trades: Math.min(5000, Math.max(1, Math.floor(minTrades))),
      initial_cash: Number.isFinite(initialCash) && initialCash > 0 ? initialCash : 10_000,
    });
  }, [execFeePctPerFill, execSlippagePct, execHalfSpreadPct, minTrades, initialCash]);

  const [validationFrameworks, setValidationFrameworks] = useState<Set<BacktestValidationFramework>>(
    () => new Set(["standard"]),
  );
  const [wfNSplits, setWfNSplits] = useState(5);
  const [wfMinSegBars, setWfMinSegBars] = useState(80);
  const [mcRuns, setMcRuns] = useState(800);
  const [mcSeed, setMcSeed] = useState("");
  const [paramDriftEnabled, setParamDriftEnabled] = useState(false);
  const [paramDriftPct, setParamDriftPct] = useState<Record<string, number>>({});
  const [presetName, setPresetName] = useState("");
  const [presetNotes, setPresetNotes] = useState("");
  const [presetTiePair, setPresetTiePair] = useState(true);
  const [presets, setPresets] = useState<StrategyPresetRow[]>([]);
  const [presetListErr, setPresetListErr] = useState<string | null>(null);
  const [presetActionErr, setPresetActionErr] = useState<string | null>(null);
  const [presetLoading, setPresetLoading] = useState(false);
  const [presetApplyId, setPresetApplyId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [symbolFilter, setSymbolFilter] = useState("");

  const filteredSymbols = useMemo(() => {
    const q = symbolFilter.trim().toLowerCase();
    if (!q) return symbols;
    return symbols.filter((s) => s.code.toLowerCase().includes(q));
  }, [symbols, symbolFilter]);

  const resolvedTimeframes = useMemo(() => {
    const arr = [...selectedTimeframes].filter((tf) => isValidTimeframe(tf));
    return arr.length ? arr : ["5m"];
  }, [selectedTimeframes]);

  const driftKeyRows = useMemo(() => {
    if (strategySource !== "builder" || !builderSpec) return [];
    const pr = parseChartBuilderSpec(builderSpec);
    if (!pr.ok) return [];
    return collectBuilderDriftKeys(pr.spec);
  }, [strategySource, builderSpec]);

  useEffect(() => {
    if (!driftKeyRows.length) return;
    setParamDriftPct((prev) => {
      const next = { ...prev };
      for (const r of driftKeyRows) {
        if (!(r.key in next)) next[r.key] = 0;
      }
      return next;
    });
  }, [driftKeyRows]);

  const toggleTimeframe = useCallback((tf: string) => {
    setSelectedTimeframes((prev) => {
      const n = new Set(prev);
      if (n.has(tf)) {
        if (n.size <= 1) return n;
        n.delete(tf);
      } else {
        n.add(tf);
      }
      return n;
    });
  }, []);

  const toggleValidationFw = useCallback((fw: BacktestValidationFramework) => {
    setValidationFrameworks((prev) => {
      const n = new Set(prev);
      if (n.has(fw)) {
        if (n.size <= 1) return n;
        n.delete(fw);
      } else {
        n.add(fw);
      }
      return n;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rv, rb, sy] = await Promise.all([
          apiFetch("/api/backtest/vbt-strategies", { cache: "no-store" }),
          apiFetch("/api/chart/builder-strategies", { cache: "no-store" }),
          apiFetch("/api/symbols", { cache: "no-store" }),
        ]);
        const jv = await rv.json();
        const jb = await rb.json();
        const jy = await sy.json();
        if (!rv.ok) throw new Error(jv.error ?? rv.statusText);
        if (!rb.ok) throw new Error(jb.error ?? rb.statusText);
        if (!sy.ok) throw new Error(jy.error ?? sy.statusText);
        if (cancelled) return;
        setVbtStrategies((jv.strategies ?? []) as VbtStrategyRow[]);
        setBuilderStrategies((jb.strategies ?? []) as BuilderStrategyRow[]);
        setSymbols((jy.symbols ?? []) as SymbolRow[]);
        setLoadErr(null);
      } catch (e) {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (strategySource !== "builder" || !builderStrategyId) {
      setBuilderSpec(null);
      return;
    }
    void (async () => {
      try {
        const r = await apiFetch(`/api/chart/builder-strategies/${encodeURIComponent(builderStrategyId)}`, {
          cache: "no-store",
        });
        const j = (await r.json()) as { spec?: Record<string, unknown>; error?: string };
        if (cancelled) return;
        if (!r.ok) throw new Error(j.error ?? r.statusText);
        setBuilderSpec(j.spec ?? null);
      } catch (e) {
        if (!cancelled) {
          setBuilderSpec(null);
          setLoadErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [strategySource, builderStrategyId]);

  useEffect(() => {
    if (!paramsApplyFeedback && !paramsApplyError) return;
    const t = window.setTimeout(() => {
      setParamsApplyFeedback(null);
      setParamsApplyError(null);
    }, 5200);
    return () => window.clearTimeout(t);
  }, [paramsApplyFeedback, paramsApplyError]);

  useEffect(() => {
    let cancelled = false;
    if (strategySource !== "vbt" || !vbtStrategyId) {
      setPresets([]);
      setPresetListErr(null);
      setPresetLoading(false);
      return;
    }
    const q = new URLSearchParams({ vbt_strategy_id: vbtStrategyId });
    if (selectedIds.size === 1) {
      q.set("symbol_id", String([...selectedIds][0]));
    }
    setPresetLoading(true);
    void (async () => {
      try {
        const r = await apiFetch(`/api/presets?${q.toString()}`, { cache: "no-store" });
        const j = (await r.json()) as { presets?: StrategyPresetRow[]; error?: string };
        if (cancelled) return;
        if (!r.ok) throw new Error(j.error ?? r.statusText);
        setPresets(j.presets ?? []);
        setPresetListErr(null);
      } catch (e) {
        if (!cancelled) setPresetListErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setPresetLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [strategySource, vbtStrategyId, selectedIds]);

  useEffect(() => {
    if (!presetApplyId) return;
    const id = Number(presetApplyId);
    if (!presets.some((p) => p.id === id)) setPresetApplyId("");
  }, [presets, presetApplyId]);

  const buildCurrentParamsV1 = useCallback((): BacktestPresetParamsV1 => {
    const vfs = [...validationFrameworks];
    const driftSend =
      paramDriftEnabled && strategySource === "builder"
        ? Object.fromEntries(Object.entries(paramDriftPct).filter(([, v]) => v > 0))
        : {};
    return {
      version: 1,
      tab,
      timeframe: resolvedTimeframes[0] ?? "5m",
      timeframes: [...resolvedTimeframes],
      range_preset: rangePreset,
      initial_cash: initialCash,
      num_tests: numTests,
      max_tries: maxTries,
      best_by: bestBy,
      min_trades: minTrades,
      optimize_seed: optimizeSeed,
      grid_sample: gridSample,
      optimize_top_k: optimizeTopK,
      holdout_pct: holdoutPct,
      symbol_ids: Array.from(selectedIds).sort((a, b) => a - b),
      include_ui_charts: includeUiCharts,
      validation_framework: vfs[0] ?? "standard",
      validation_frameworks: vfs,
      wf_n_splits: wfNSplits,
      wf_min_segment_bars: wfMinSegBars,
      mc_runs: mcRuns,
      mc_seed: mcSeed,
      ...(strategySource === "builder"
        ? {
            param_drift_enabled: paramDriftEnabled,
            ...(paramDriftEnabled ? { param_drift_pct_by_key: driftSend } : {}),
          }
        : {}),
      exec_fee_pct_per_fill: clampExecPctPct(execFeePctPerFill),
      exec_slippage_pct: clampExecPctPct(execSlippagePct),
      exec_half_spread_pct: clampExecPctPct(execHalfSpreadPct),
    };
  }, [
    tab,
    resolvedTimeframes,
    rangePreset,
    initialCash,
    numTests,
    maxTries,
    bestBy,
    minTrades,
    optimizeSeed,
    gridSample,
    optimizeTopK,
    holdoutPct,
    selectedIds,
    includeUiCharts,
    execFeePctPerFill,
    execSlippagePct,
    execHalfSpreadPct,
    validationFrameworks,
    wfNSplits,
    wfMinSegBars,
    mcRuns,
    mcSeed,
    strategySource,
    paramDriftEnabled,
    paramDriftPct,
  ]);

  const applySelectedPreset = useCallback(() => {
    setPresetActionErr(null);
    const id = Number(presetApplyId);
    if (!id) {
      setPresetActionErr("Escolhe um preset na lista.");
      return;
    }
    const row = presets.find((p) => p.id === id);
    if (!row) return;
    if (row.vbt_strategy_id !== vbtStrategyId) {
      setPresetActionErr("Este preset pertence a outra estratégia.");
      return;
    }
    const p = row.params;
    if (!isPresetParamsV1(p)) {
      setPresetActionErr("Formato de preset inválido (esperado version 1).");
      return;
    }
    setTab(p.tab);
    const rawTfs = p.timeframes?.filter((tf) => isValidTimeframe(tf));
    if (rawTfs && rawTfs.length > 0) {
      setSelectedTimeframes(new Set(rawTfs));
    } else {
      const one = isValidTimeframe(p.timeframe) ? p.timeframe : "5m";
      setSelectedTimeframes(new Set([one]));
    }
    setRangePreset(toRangePreset(p.range_preset));
    setInitialCash(Math.max(100, p.initial_cash));
    setNumTests(Math.min(5000, Math.max(1, p.num_tests)));
    setMaxTries(Math.min(10000, Math.max(1, p.max_tries)));
    const bbOk = BEST_BY_OPTIONS.some((o) => o.value === p.best_by);
    setBestBy(bbOk ? p.best_by : "return_pct");
    setMinTrades(Math.min(5000, Math.max(1, p.min_trades)));
    setOptimizeSeed(
      typeof p.optimize_seed === "string" ? p.optimize_seed.replace(/[^\d-]/g, "") : "",
    );
    setGridSample(p.grid_sample === "random" ? "random" : "lhs");
    setOptimizeTopK(Math.min(20, Math.max(1, p.optimize_top_k)));
    setHoldoutPct(Math.min(40, Math.max(0, p.holdout_pct)));
    const known = new Set(symbols.map((s) => s.symbol_id));
    const ids = p.symbol_ids.filter((sid) => known.has(sid));
    setSelectedIds(new Set(ids));
    if (typeof p.include_ui_charts === "boolean") setIncludeUiCharts(p.include_ui_charts);
    const vfsRaw = p.validation_frameworks?.filter(
      (x): x is BacktestValidationFramework =>
        x === "standard" || x === "walk_forward" || x === "monte_carlo",
    );
    if (vfsRaw && vfsRaw.length > 0) {
      setValidationFrameworks(new Set(vfsRaw));
    } else {
      const vf = p.validation_framework;
      if (vf === "walk_forward" || vf === "monte_carlo" || vf === "standard") {
        setValidationFrameworks(new Set([vf]));
      }
    }
    if (typeof p.wf_n_splits === "number") setWfNSplits(Math.min(24, Math.max(2, p.wf_n_splits)));
    if (typeof p.wf_min_segment_bars === "number")
      setWfMinSegBars(Math.min(50_000, Math.max(30, p.wf_min_segment_bars)));
    if (typeof p.mc_runs === "number") setMcRuns(Math.min(10_000, Math.max(50, p.mc_runs)));
    setMcSeed(typeof p.mc_seed === "string" ? p.mc_seed.replace(/[^\d-]/g, "") : "");
    if (typeof p.param_drift_enabled === "boolean") setParamDriftEnabled(p.param_drift_enabled);
    if (p.param_drift_pct_by_key && typeof p.param_drift_pct_by_key === "object") {
      setParamDriftPct({ ...p.param_drift_pct_by_key });
    }
    if (typeof p.exec_fee_pct_per_fill === "number" && Number.isFinite(p.exec_fee_pct_per_fill)) {
      setExecFeePctPerFill(clampExecPctPct(p.exec_fee_pct_per_fill));
    }
    if (typeof p.exec_slippage_pct === "number" && Number.isFinite(p.exec_slippage_pct)) {
      setExecSlippagePct(clampExecPctPct(p.exec_slippage_pct));
    }
    if (typeof p.exec_half_spread_pct === "number" && Number.isFinite(p.exec_half_spread_pct)) {
      setExecHalfSpreadPct(clampExecPctPct(p.exec_half_spread_pct));
    }
  }, [presetApplyId, presets, symbols, vbtStrategyId]);

  const savePreset = useCallback(async () => {
    setPresetActionErr(null);
    if (strategySource !== "vbt" || !vbtStrategyId) {
      setPresetActionErr("Presets desta secção são para estratégias Python vectorbt.");
      return;
    }
    const name = presetName.trim();
    if (!name) {
      setPresetActionErr("Indica um nome para o preset.");
      return;
    }
    const tie = presetTiePair && selectedIds.size === 1;
    const symbol_id = tie ? [...selectedIds][0]! : null;
    const body = {
      vbt_strategy_id: vbtStrategyId,
      symbol_id,
      name,
      notes: presetNotes.trim(),
      params: buildCurrentParamsV1(),
    };
    try {
      const r = await apiFetch("/api/presets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const j = (await r.json()) as StrategyPresetRow & { error?: string; detail?: unknown };
      if (!r.ok) {
        const d = j.detail;
        const msg =
          j.error ??
          (typeof d === "string" ? d : Array.isArray(d) ? JSON.stringify(d) : r.statusText);
        throw new Error(msg);
      }
      setPresets((prev) => [j as StrategyPresetRow, ...prev]);
      setPresetName("");
    } catch (e) {
      setPresetActionErr(e instanceof Error ? e.message : String(e));
    }
  }, [
    vbtStrategyId,
    strategySource,
    presetName,
    presetNotes,
    presetTiePair,
    selectedIds,
    buildCurrentParamsV1,
  ]);

  const deletePresetById = useCallback(async (id: number) => {
    setPresetActionErr(null);
    try {
      const r = await apiFetch(`/api/presets/${id}`, { method: "DELETE", cache: "no-store" });
      const j = (await r.json()) as { error?: string; deleted?: boolean };
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setPresets((prev) => prev.filter((p) => p.id !== id));
      if (Number(presetApplyId) === id) setPresetApplyId("");
    } catch (e) {
      setPresetActionErr(e instanceof Error ? e.message : String(e));
    }
  }, [presetApplyId]);

  const toggleSymbol = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllFiltered = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const s of filteredSymbols) next.add(s.symbol_id);
      return next;
    });
  }, [filteredSymbols]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const vbtLabel = useMemo(
    () => vbtStrategies.find((v) => v.id === vbtStrategyId)?.label,
    [vbtStrategies, vbtStrategyId],
  );
  const builderLabel = useMemo(
    () => builderStrategies.find((v) => v.id === builderStrategyId)?.name,
    [builderStrategies, builderStrategyId],
  );

  const onStart = useCallback(() => {
    if (selectedIds.size === 0) return;
    if (strategySource === "vbt" && !vbtStrategyId) return;
    if (strategySource === "builder" && !builderStrategyId) return;
    const labels: Record<string, string> = {};
    for (const id of selectedIds) {
      const row = symbols.find((s) => s.symbol_id === id);
      labels[String(id)] = row?.code ?? String(id);
    }
    const seedTrim = optimizeSeed.trim();
    const parsedSeed = seedTrim === "" ? undefined : Number.parseInt(seedTrim, 10);
    const vfs = [...validationFrameworks];
    const vfPrimary = vfs[0] ?? "standard";
    const driftSend =
      strategySource === "builder" && paramDriftEnabled
        ? Object.fromEntries(Object.entries(paramDriftPct).filter(([, v]) => v > 0))
        : {};
    const payload: BacktestRunPayload = {
      mode: tab === "optimize" ? "optimize" : "single",
      strategy_source: strategySource,
      vbt_strategy: strategySource === "vbt" ? vbtStrategyId : "",
      vbt_label: strategySource === "vbt" ? vbtLabel : builderLabel,
      ...(strategySource === "builder" ? { builder_strategy_id: builderStrategyId } : {}),
      ...(strategySource === "builder" && builderSpec ? { builder_spec: builderSpec } : {}),
      symbol_ids: Array.from(selectedIds),
      symbol_labels: labels,
      timeframe: resolvedTimeframes[0] ?? "5m",
      timeframes: [...resolvedTimeframes],
      range_preset: rangePreset,
      initial_cash: initialCash,
      num_tests: numTests,
      max_tries: maxTries,
      best_by: bestBy,
      min_trades: minTrades,
      ...(Number.isFinite(parsedSeed) ? { optimize_seed: parsedSeed! } : {}),
      optimize_grid_sample: gridSample,
      ...(tab === "optimize" ? { optimize_top_k: optimizeTopK } : {}),
      ...(holdoutPct > 0 ? { optimize_holdout_ratio: holdoutPct / 100 } : {}),
      include_ui_charts: includeUiCharts,
      validation_framework: vfPrimary,
      validation_frameworks: vfs,
      ...(vfs.includes("walk_forward")
        ? { wf_n_splits: wfNSplits, wf_min_segment_bars: wfMinSegBars }
        : {}),
      ...(vfs.includes("monte_carlo")
        ? {
            mc_runs: mcRuns,
            ...(mcSeed.trim() !== "" && Number.isFinite(Number.parseInt(mcSeed.trim(), 10))
              ? { mc_seed: Number.parseInt(mcSeed.trim(), 10) }
              : {}),
          }
        : {}),
      ...(strategySource === "builder"
        ? {
            param_drift_enabled: paramDriftEnabled,
            ...(paramDriftEnabled && Object.keys(driftSend).length > 0
              ? { param_drift_pct_by_key: driftSend }
              : {}),
          }
        : {}),
      exec_fee_pct_per_fill: clampExecPctPct(execFeePctPerFill),
      exec_slippage_pct: clampExecPctPct(execSlippagePct),
      exec_half_spread_pct: clampExecPctPct(execHalfSpreadPct),
    };
    startBacktest(payload);
  }, [
    vbtStrategyId,
    builderStrategyId,
    builderSpec,
    strategySource,
    selectedIds,
    symbols,
    vbtLabel,
    builderLabel,
    tab,
    resolvedTimeframes,
    rangePreset,
    initialCash,
    numTests,
    maxTries,
    bestBy,
    minTrades,
    optimizeSeed,
    gridSample,
    optimizeTopK,
    holdoutPct,
    includeUiCharts,
    execFeePctPerFill,
    execSlippagePct,
    execHalfSpreadPct,
    validationFrameworks,
    wfNSplits,
    wfMinSegBars,
    mcRuns,
    mcSeed,
    strategySource,
    paramDriftEnabled,
    paramDriftPct,
    startBacktest,
  ]);

  const canStart =
    selectedIds.size > 0 &&
    status !== "running" &&
    ((strategySource === "vbt" && vbtStrategyId !== "") ||
      (strategySource === "builder" && builderStrategyId !== ""));

  const resultRows = (results ?? []) as ResultRow[];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-auto px-2 py-4 sm:px-4 lg:px-6">
      <div className="flex w-full min-w-0 flex-col gap-6">
        <header className="flex flex-col gap-2 border-b border-zinc-800/80 pb-4">
          <h1 className="text-lg font-semibold text-zinc-100 sm:text-xl">Backtests</h1>
          <p className="text-sm text-zinc-500">
            Motor <span className="text-zinc-400">vectorbt</span> alinhado ao{" "}
            <code className="rounded bg-zinc-800/80 px-1 text-xs">monthly_scanner_vbt.py</code> — velas
            via QuestDB. Podes sair desta página; o progresso continua na barra inferior.
          </p>
        </header>

        {loadErr ? (
          <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-200/90">
            {loadErr}
          </p>
        ) : null}

        <div className="flex gap-1 rounded-lg border border-zinc-800/90 bg-zinc-900/40 p-1">
          <button
            type="button"
            onClick={() => setTab("single")}
            disabled={status === "running"}
            className={
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors " +
              (tab === "single"
                ? "bg-emerald-600/25 text-emerald-200"
                : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200")
            }
          >
            Backtest (estratégia)
            <FieldInfo title="Um único perfil de indicadores (valores por defeito da estratégia). Testa várias combinações de thresholds em paralelo no vectorbt ou builder." />
          </button>
          <button
            type="button"
            onClick={() => setTab("optimize")}
            disabled={status === "running"}
            className={
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors " +
              (tab === "optimize"
                ? "bg-emerald-600/25 text-emerald-200"
                : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200")
            }
          >
            Optimizar parâmetros
            <FieldInfo title="Amostragem LHS ou aleatória na grelha de parâmetros. Guarda as melhores soluções por par (top-K) e permite validação na cauda da série (holdout OOS)." />
          </button>
        </div>

        <p className="text-xs text-zinc-600">
          {uiMode === "simple"
            ? tab === "single"
              ? "Um perfil de estratégia; várias combinações de thresholds em paralelo."
              : "Optimização por amostragem na grelha; mantém as melhores soluções por par (top‑K)."
            : tab === "single"
              ? "Indicadores nos valores por defeito da estratégia; só se testam combinações de thresholds (até ao número de testes que indicares), em paralelo no vectorbt."
              : "Optimização: amostragem LHS/random na grelha (sem estourar RAM), top-K soluções por par, opcional validação OOS na cauda da série."}
        </p>

        {uiMode === "advanced" ? (
        <section className="flex flex-col gap-4 rounded-xl border border-zinc-800/90 bg-zinc-900/20 p-4 sm:p-5">
          <h2 className="inline-flex flex-wrap items-center gap-1.5 text-sm font-medium text-zinc-300">
            Presets (PostgreSQL)
            <FieldInfo title="Guarda e carrega combinações de campos desta página por estratégia vectorbt na base PostgreSQL (requer DATABASE_URL)." />
          </h2>
          <p className="text-xs text-zinc-600">
            Guarda a configuração actual por estratégia. Com um único par seleccionado podes marcar
            “ligado ao par” para aparecer só quando esse par está seleccionado. Requer{" "}
            <code className="text-zinc-500">DATABASE_URL</code> no backend.
          </p>
          {presetListErr ? (
            <p className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200/90">
              {presetListErr}
            </p>
          ) : null}
          {presetActionErr ? (
            <p className="rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-xs text-red-300/90">
              {presetActionErr}
            </p>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="flex min-w-[200px] flex-1 flex-col gap-1">
              <LabelWithInfo info="Lista presets gravados na base PostgreSQL para esta estratégia vectorbt (filtrados por par quando aplicável).">
                <span className="text-xs font-medium text-zinc-500">Carregar preset</span>
              </LabelWithInfo>
              <select
                className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                value={presetApplyId}
                onChange={(e) => setPresetApplyId(e.target.value)}
                disabled={status === "running" || !vbtStrategyId || presetLoading}
              >
                <option value="">— Escolher —</option>
                {presets.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                    {p.symbol_id != null ? ` · par #${p.symbol_id}` : " · global"}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void applySelectedPreset()}
              disabled={status === "running" || !presetApplyId}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-600 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800/60 disabled:opacity-40"
            >
              Aplicar
              <FieldInfo title="Substitui os campos desta página pelos valores guardados no preset seleccionado." />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 border-t border-zinc-800/80 pt-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <LabelWithInfo info="Nome para identificar este preset quando o voltares a carregar na lista.">
                <span className="text-xs font-medium text-zinc-500">Nome (novo preset)</span>
              </LabelWithInfo>
              <input
                type="text"
                className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Ex.: BTC 5m conservador"
                disabled={status === "running"}
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <LabelWithInfo info="Campo livre para notas (hipóteses, contexto, data). Opcional.">
                <span className="text-xs font-medium text-zinc-500">Notas (opcional)</span>
              </LabelWithInfo>
              <input
                type="text"
                className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                value={presetNotes}
                onChange={(e) => setPresetNotes(e.target.value)}
                disabled={status === "running"}
              />
            </label>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              className="rounded border-zinc-600"
              checked={presetTiePair}
              onChange={(e) => setPresetTiePair(e.target.checked)}
              disabled={status === "running" || selectedIds.size !== 1}
            />
            <span className="inline-flex flex-wrap items-center gap-1.5">
              Ligar este preset ao par seleccionado (só com exactamente 1 par marcado)
              <FieldInfo title="Se activo com um único par marcado, o preset fica associado a esse símbolo na base e só surge prioritariamente quando esse par está seleccionado." />
            </span>
          </label>
          <button
            type="button"
            onClick={() => void savePreset()}
            disabled={status === "running" || strategySource !== "vbt" || !vbtStrategyId}
            className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-zinc-700 px-3 py-2 text-sm text-zinc-100 hover:bg-zinc-600 disabled:opacity-40"
          >
            Guardar preset
            <FieldInfo title="Grava na base PostgreSQL o estado actual dos campos desta página como preset da estratégia vectorbt escolhida (requer DATABASE_URL no backend)." />
          </button>
          {presets.length > 0 ? (
            <ul className="mt-1 space-y-1 border-t border-zinc-800/80 pt-3 text-xs text-zinc-500">
              {presets.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-zinc-950/40 px-2 py-1.5"
                >
                  <span className="text-zinc-400">
                    <span className="font-medium text-zinc-300">{p.name}</span>
                    {p.symbol_id != null ? ` · #${p.symbol_id}` : " · global"}
                  </span>
                  <button
                    type="button"
                    onClick={() => void deletePresetById(p.id)}
                    disabled={status === "running"}
                    className="inline-flex items-center gap-1 text-red-400/90 hover:underline disabled:opacity-40"
                  >
                    Apagar
                    <FieldInfo title="Remove este preset da base PostgreSQL (irreversível para esse registo)." />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        ) : null}

        <section className="flex flex-col gap-4 rounded-xl border border-zinc-800/90 bg-zinc-900/20 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/60 pb-3">
            <h2 className="inline-flex flex-wrap items-center gap-1.5 text-sm font-medium text-zinc-300">
              Configuração
              <FieldInfo title="Parâmetros enviados ao POST /api/backtest/jobs: estratégia, período, TF, validação, custos de execução e mercados seleccionados." />
            </h2>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
              <span className="text-zinc-500">Modo</span>
              <select
                className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-emerald-600/60"
                value={uiMode}
                onChange={(e) => persistUiMode(e.target.value === "advanced" ? "advanced" : "simple")}
                disabled={status === "running"}
              >
                <option value="simple">Simples</option>
                <option value="advanced">Avançado</option>
              </select>
              <FieldInfo title="Simples mostra só o essencial para correr jobs; Avançado inclui presets PostgreSQL, custos de execução, LHS/seed/holdout e validação walk-forward / Monte Carlo." />
            </label>
          </div>
          <label className="flex flex-col gap-1.5">
            <LabelWithInfo info="Builder usa o motor OHLC no servidor com snapshot das regras do chart. Vectorbt usa módulos Python *_vbt.py com sinais vectorizados e Portfolio.from_signals.">
              <span className="text-xs font-medium text-zinc-500">Origem da estratégia</span>
            </LabelWithInfo>
            <select
              className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
              value={strategySource}
              onChange={(e) => setStrategySource(e.target.value as "vbt" | "builder")}
              disabled={status === "running"}
            >
              <option value="builder">Estratégias criadas no builder</option>
              <option value="vbt">Estratégias Python vectorbt</option>
            </select>
          </label>

          {strategySource === "builder" ? (
            <label className="flex flex-col gap-1.5">
              <LabelWithInfo info="Estratégia criada no chart builder; indicadores, regras e risco são enviados ao job como instantâneo JSON.">
                <span className="text-xs font-medium text-zinc-500">Estratégia builder</span>
              </LabelWithInfo>
              <select
                className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                value={builderStrategyId}
                onChange={(e) => setBuilderStrategyId(e.target.value)}
                disabled={status === "running"}
              >
                <option value="">— Escolher —</option>
                {builderStrategies.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name || v.id}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex flex-col gap-1.5">
              <LabelWithInfo info="Ficheiro em my_strategies com compute_indicators e compute_signals_vectorized; o backend carrega o módulo *_vbt.py.">
                <span className="text-xs font-medium text-zinc-500">Estratégia vectorbt (*_vbt.py)</span>
              </LabelWithInfo>
            <select
              className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
              value={vbtStrategyId}
              onChange={(e) => setVbtStrategyId(e.target.value)}
              disabled={status === "running"}
            >
              <option value="">— Escolher —</option>
              {vbtStrategies.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} ({v.module})
                </option>
              ))}
            </select>
            </label>
          )}

          {strategySource === "builder" && builderSpec ? (
            <div className="rounded-lg border border-violet-900/40 bg-violet-950/10 px-3 py-2 text-xs text-zinc-400">
              <p className="font-medium text-violet-200/90">
                {(builderSpec.name as string | undefined) || builderLabel || "Estratégia builder"}
              </p>
              <p className="mt-1 text-zinc-500">
                {Array.isArray(builderSpec.indicators) ? builderSpec.indicators.length : 0} indicadores · regras e risco são enviados como snapshot para o job.
              </p>
            </div>
          ) : null}

          {strategySource === "builder" && driftKeyRows.length > 0 ? (
            <div className="rounded-lg border border-amber-900/35 bg-amber-950/10 p-4">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 rounded border-zinc-600"
                  checked={paramDriftEnabled}
                  onChange={(e) => setParamDriftEnabled(e.target.checked)}
                  disabled={status === "running"}
                />
                <div>
                <div className="inline-flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-amber-200/90">
                    Stress de parâmetros (robustez / overfit)
                  </span>
                  <FieldInfo title="Para cada campo com % maior que zero, o motor expande a grelha para valores ~mínimo, base e máximo em torno do valor da estratégia, para stress de robustez." />
                </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                    Por campo com % maior que zero, o motor usa os valores ~mínimo, base e máximo (±percentagem sobre o
                    valor da estratégia). Indicadores usam chaves{" "}
                    <code className="rounded bg-zinc-950 px-1 text-zinc-600">ind/&lt;id&gt;/tupla.aninhada</code>.
                  </p>
                </div>
              </label>
              {paramDriftEnabled ? (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[720px] border-collapse text-left text-[11px] text-zinc-400">
                    <thead>
                      <tr className="border-b border-zinc-700 text-zinc-500">
                        <th className="py-1.5 pr-2">Parâmetro</th>
                        <th className="py-1.5 pr-2">Base</th>
                        <th className="py-1.5 pr-2">±%</th>
                        <th className="py-1.5 pr-2">Min–max</th>
                        <th className="py-1.5 pr-2">Vals</th>
                        <th className="py-1.5">Atalhos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {driftKeyRows.map((row) => {
                        const pct = paramDriftPct[row.key] ?? 0;
                        const pv = driftTripletPreview(row.base, pct, row.kind);
                        return (
                          <tr key={row.key} className="border-b border-zinc-800/80">
                            <td className="py-1.5 pr-2 text-zinc-300">{row.label}</td>
                            <td className="py-1.5 pr-2 tabular-nums">{row.base}</td>
                            <td className="py-1.5 pr-2">
                              <input
                                type="number"
                                min={0}
                                max={90}
                                step={1}
                                className="w-16 rounded border border-zinc-700/80 bg-zinc-950 px-1 py-0.5 text-zinc-200"
                                value={pct || ""}
                                placeholder="0"
                                onChange={(e) => {
                                  const v = Math.min(90, Math.max(0, Number(e.target.value) || 0));
                                  setParamDriftPct((prev) => ({ ...prev, [row.key]: v }));
                                }}
                                disabled={status === "running"}
                              />
                            </td>
                            <td className="py-1.5 pr-2 tabular-nums text-zinc-500">
                              {pct > 0 ? `${pv.min} … ${pv.max}` : "—"}
                            </td>
                            <td className="py-1.5 pr-2 text-zinc-500">{pct > 0 ? pv.triple.join(" · ") : "—"}</td>
                            <td className="py-1.5">
                              <div className="flex flex-wrap gap-1">
                                {[1, 5, 10].map((s) => (
                                  <button
                                    key={s}
                                    type="button"
                                    className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700"
                                    disabled={status === "running"}
                                    onClick={() =>
                                      setParamDriftPct((prev) => ({ ...prev, [row.key]: s }))
                                    }
                                  >
                                    {s}%
                                  </button>
                                ))}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <span className="inline-flex flex-wrap items-center gap-1.5 text-xs font-medium text-zinc-500">
              Timeframes (vários)
              <FieldInfo title="Cada timeframe marcado corre uma vez por par seleccionado; multiplica o tempo total do job." />
            </span>
            <div className="flex flex-wrap gap-2 rounded-lg border border-zinc-700/80 bg-zinc-950/60 px-2 py-2">
              {TIMEFRAME_OPTIONS.map((tf) => (
                <label
                  key={tf}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-800/90 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-900/80"
                >
                  <input
                    type="checkbox"
                    className="rounded border-zinc-600"
                    checked={selectedTimeframes.has(tf)}
                    onChange={() => toggleTimeframe(tf)}
                    disabled={status === "running"}
                  />
                  {tf}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-zinc-600">
              Seleccionados:{" "}
              <span className="text-zinc-400">{resolvedTimeframes.join(", ")}</span> — o job corre cada TF por
              símbolo (mais lento).
            </p>
          </div>

          <label className="flex flex-col gap-1.5">
            <LabelWithInfo info="Janela de histórico pedida à QuestDB (últimos N dias ou máximo disponível); limita quantas velas entram no backtest.">
              <span className="text-xs font-medium text-zinc-500">Período (limite de velas na QuestDB)</span>
            </LabelWithInfo>
            <select
              className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
              value={rangePreset}
              onChange={(e) => setRangePreset(e.target.value as BacktestRangePreset)}
              disabled={status === "running"}
            >
              {RANGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <LabelWithInfo info="Capital inicial único por simulação (vectorbt init_cash ou equivalente no builder).">
                <span className="text-xs font-medium text-zinc-500">Capital inicial</span>
              </LabelWithInfo>
              <input
                type="number"
                min={100}
                step={100}
                className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                value={initialCash}
                onChange={(e) => setInitialCash(Number(e.target.value) || 0)}
                disabled={status === "running"}
              />
            </label>
            {tab === "single" ? (
              <label className="flex flex-col gap-1.5">
                <LabelWithInfo info="No modo estratégia: número de combinações de thresholds testadas em paralelo sobre os mesmos indicadores por defeito.">
                  <span className="text-xs font-medium text-zinc-500">Número de testes (thresholds)</span>
                </LabelWithInfo>
                <input
                  type="number"
                  min={1}
                  max={5000}
                  className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                  value={numTests}
                  onChange={(e) => setNumTests(Math.min(5000, Math.max(1, Number(e.target.value) || 1)))}
                  disabled={status === "running"}
                />
              </label>
            ) : (
              <label className="flex flex-col gap-1.5">
                <LabelWithInfo info="No modo optimização: quantos pontos da grelha de parâmetros amostrar (LHS ou aleatório), sem explorar todas as combinações possíveis.">
                  <span className="text-xs font-medium text-zinc-500">Max tries (grelha optimização)</span>
                </LabelWithInfo>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                  value={maxTries}
                  onChange={(e) => setMaxTries(Math.min(10000, Math.max(1, Number(e.target.value) || 1)))}
                  disabled={status === "running"}
                />
              </label>
            )}
          </div>

          {uiMode === "advanced" ? (
          <details className="group rounded-lg border border-zinc-800/90 bg-zinc-950/40 open:border-emerald-900/20">
            <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-zinc-400 [&::-webkit-details-marker]:hidden">
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span className="text-zinc-300 group-open:text-emerald-200/90">Custos & execução (aproximação)</span>
                <FieldInfo title="Modelo global: fee por fill sobre o notional; slippage e meio-spread pessimistas vs close. No vectorbt, slip+half viram uma única fração slippage; campos ficam separados na UI para auditoria." />
              </span>
              <span className="mt-1 block text-[11px] font-normal text-zinc-600 sm:mt-0 sm:inline sm:ml-2">
                Taxa por fill · slippage · meio-spread (no vectorbt, slip + half → parâmetro slippage)
              </span>
            </summary>
            <div className="space-y-4 border-t border-zinc-800/80 px-4 pb-4 pt-3">
              <p
                className="text-[11px] leading-relaxed text-zinc-600"
                title="Smoke: com fee ou slip/spread > 0, o mesmo cenário deve tender a retorno menor ou igual ao baseline com tudo a zero (builder e vectorbt)."
              >
                Modelo global por job: sem tiers maker/taker nem funding. Long compra mais caro e vende mais barato vs close;
                short espelha. Valores entre 0 e 2% (igual ao backend). Verifica smoke passando o rato sobre este texto.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={status === "running"}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-900 disabled:opacity-40"
                  onClick={() => {
                    setExecFeePctPerFill(0);
                    setExecSlippagePct(0);
                    setExecHalfSpreadPct(0);
                  }}
                >
                  Baseline (0 / 0 / 0)
                  <FieldInfo title="Remove custos e slippage para comparar com corridas sem exec realista." />
                </button>
                <button
                  type="button"
                  disabled={status === "running"}
                  className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-900 disabled:opacity-40"
                  onClick={() => {
                    setExecFeePctPerFill(0.05);
                    setExecSlippagePct(0.02);
                    setExecHalfSpreadPct(0.01);
                  }}
                  title="Valores ilustrativos editáveis — não são quotes de mercado."
                >
                  Sugestão perp (0.05% fee · 0.02% slip · 0.01% half-spread)
                </button>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <label className="flex flex-col gap-1.5">
                  <LabelWithInfo info="Taxa percentual cobrada sobre o valor absoluto da perna em cada fill (abrir, fechar ou inverter). Modelo único, sem maker/taker.">
                    <span className="text-xs font-medium text-zinc-500">
                      Fee % por fill (notional da perna)
                    </span>
                  </LabelWithInfo>
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.005}
                    className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                    value={execFeePctPerFill}
                    onChange={(e) =>
                      setExecFeePctPerFill(clampExecPctPct(Number.parseFloat(e.target.value) || 0))
                    }
                    disabled={status === "running"}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <LabelWithInfo info="Componente adversa extra por lado vs o close de referência em cada entrada ou saída.">
                    <span className="text-xs font-medium text-zinc-500">Slippage % (por lado)</span>
                  </LabelWithInfo>
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.005}
                    className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                    value={execSlippagePct}
                    onChange={(e) =>
                      setExecSlippagePct(clampExecPctPct(Number.parseFloat(e.target.value) || 0))
                    }
                    disabled={status === "running"}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <LabelWithInfo info="Proxy de meio-spread como % do preço (bid/ask vs mid). Somado ao slippage para preço executável; no motor vectorbt funde-se no parâmetro slippage.">
                    <span className="text-xs font-medium text-zinc-500">Meio-spread %</span>
                  </LabelWithInfo>
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.005}
                    className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                    value={execHalfSpreadPct}
                    onChange={(e) =>
                      setExecHalfSpreadPct(clampExecPctPct(Number.parseFloat(e.target.value) || 0))
                    }
                    disabled={status === "running"}
                  />
                </label>
              </div>
            </div>
          </details>
          ) : null}

          {tab === "optimize" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <LabelWithInfo info="Quantas soluções distintas manter por par depois de deduplicar por fingerprint de parâmetros e ordenar pelo critério melhor escolhido.">
                  <span className="text-xs font-medium text-zinc-500">Top-K por par (ranking)</span>
                </LabelWithInfo>
                <input
                  type="number"
                  min={1}
                  max={20}
                  className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                  value={optimizeTopK}
                  onChange={(e) =>
                    setOptimizeTopK(Math.min(20, Math.max(1, Number(e.target.value) || 1)))
                  }
                  disabled={status === "running"}
                />
              </label>
              {uiMode === "advanced" ? (
              <>
              <label className="flex flex-col gap-1.5">
                <LabelWithInfo info="LHS (Latin Hypercube) cobre melhor o espaço de parâmetros com poucas amostras; aleatório é uniforme mas menos estruturado.">
                  <span className="text-xs font-medium text-zinc-500">Amostragem da grelha</span>
                </LabelWithInfo>
                <select
                  className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                  value={gridSample}
                  onChange={(e) => setGridSample(e.target.value as "lhs" | "random")}
                  disabled={status === "running"}
                >
                  <option value="lhs">LHS (cobertura)</option>
                  <option value="random">Aleatório</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 sm:col-span-2">
                <LabelWithInfo info="Seed do gerador pseudo-aleatório da grelha de optimização. Vazio = seed nova por job (menos reprodutível entre pedidos); preenche para repetir a mesma amostragem.">
                  <span className="text-xs font-medium text-zinc-500">
                    Seed (vazio = aleatório por job; preencher para reproduzir a mesma grelha)
                  </span>
                </LabelWithInfo>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Ex.: 42"
                  className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                  value={optimizeSeed}
                  onChange={(e) => setOptimizeSeed(e.target.value.replace(/[^\d-]/g, ""))}
                  disabled={status === "running"}
                />
              </label>
              </>
              ) : null}
            </div>
          ) : null}

          {uiMode === "advanced" ? (
          <>
          <label className="flex flex-col gap-1.5">
            <LabelWithInfo info="Percentagem final da série reservada para testar os melhores parâmetros fora da amostra de optimização (OOS). Zero desliga holdout.">
              <span className="text-xs font-medium text-zinc-500">
                Holdout OOS (% final da série, 0 = desligado; máx. 40%)
              </span>
            </LabelWithInfo>
            <input
              type="number"
              min={0}
              max={40}
              step={1}
              className="max-w-xs rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
              value={holdoutPct}
              onChange={(e) => setHoldoutPct(Math.min(40, Math.max(0, Number(e.target.value) || 0)))}
              disabled={status === "running"}
            />
          </label>

          <div className="rounded-lg border border-zinc-800/90 bg-zinc-950/40 p-4">
            <h3 className="inline-flex flex-wrap items-center gap-1.5 text-xs font-medium text-zinc-400">
              Validação avançada
              <FieldInfo title="Frameworks combináveis no mesmo job (por timeframe × símbolo). Standard é o núcleo de backtest; walk-forward corta no tempo; Monte Carlo faz bootstrap dos retornos." />
            </h3>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
              Frameworks combináveis — podes activar Walk-forward e Monte Carlo no mesmo job (por timeframe × símbolo).
              Standard refere-se ao núcleo de backtest com a grelha / holdout acima.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(
                [
                  ["standard", "Standard"],
                  ["walk_forward", "Walk-forward"],
                  ["monte_carlo", "Monte Carlo"],
                ] as const
              ).map(([id, lab]) => (
                <label
                  key={id}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-800/90 px-2 py-1.5 text-[11px] text-zinc-400 hover:bg-zinc-900/70"
                >
                  <input
                    type="checkbox"
                    className="rounded border-zinc-600"
                    checked={validationFrameworks.has(id)}
                    onChange={() => toggleValidationFw(id as BacktestValidationFramework)}
                    disabled={status === "running"}
                  />
                  <span className="flex-1">{lab}</span>
                  <FieldInfo
                    title={
                      id === "standard"
                        ? "Backtest principal na série com a grelha e holdout definidos acima; sem cortes walk-forward nem bootstrap MC extra."
                        : id === "walk_forward"
                          ? "Divide o in-sample em slices contíguos e calcula métricas por fold com os parâmetros do melhor rank (#1)."
                          : "Reamostragem bootstrap dos retornos por trade para estimar dispersão dos outcomes (runs configuráveis)."
                    }
                  />
                </label>
              ))}
            </div>
            {validationFrameworks.has("walk_forward") ? (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <LabelWithInfo info="Quantidade de segmentos temporais contíguos em que a série in-sample é cortada para walk-forward.">
                    <span className="text-[11px] font-medium text-zinc-500">Nº splits</span>
                  </LabelWithInfo>
                  <input
                    type="number"
                    min={2}
                    max={24}
                    className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200"
                    value={wfNSplits}
                    onChange={(e) =>
                      setWfNSplits(Math.min(24, Math.max(2, Number(e.target.value) || 2)))
                    }
                    disabled={status === "running"}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <LabelWithInfo info="Comprimento mínimo de cada slice em barras para aceitar um fold (evita segmentos curtos demais).">
                    <span className="text-[11px] font-medium text-zinc-500">Mín. barras por slice</span>
                  </LabelWithInfo>
                  <input
                    type="number"
                    min={30}
                    max={50000}
                    className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200"
                    value={wfMinSegBars}
                    onChange={(e) =>
                      setWfMinSegBars(Math.min(50000, Math.max(30, Number(e.target.value) || 30)))
                    }
                    disabled={status === "running"}
                  />
                </label>
              </div>
            ) : null}
            {validationFrameworks.has("monte_carlo") ? (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <LabelWithInfo info="Número de caminhos bootstrap Monte Carlo por símbolo/timeframe (mais runs = mais CPU).">
                    <span className="text-[11px] font-medium text-zinc-500">MC runs</span>
                  </LabelWithInfo>
                  <input
                    type="number"
                    min={50}
                    max={10000}
                    className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200"
                    value={mcRuns}
                    onChange={(e) =>
                      setMcRuns(Math.min(10000, Math.max(50, Number(e.target.value) || 50)))
                    }
                    disabled={status === "running"}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <LabelWithInfo info="Seed opcional do bootstrap MC para repetir exactamente a mesma sequência de amostragens entre corridas.">
                    <span className="text-[11px] font-medium text-zinc-500">MC seed (opcional)</span>
                  </LabelWithInfo>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="vazio = aleatório"
                    className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200"
                    value={mcSeed}
                    onChange={(e) => setMcSeed(e.target.value.replace(/[^\d-]/g, ""))}
                    disabled={status === "running"}
                  />
                </label>
              </div>
            ) : null}
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                className="mt-0.5 rounded border-zinc-600"
                checked={includeUiCharts}
                onChange={(e) => setIncludeUiCharts(e.target.checked)}
                disabled={status === "running"}
              />
              <span className="inline-flex flex-1 flex-wrap items-center gap-1.5">
                Incluir dados para gráficos multi-teste (curvas equity por trial no backend — mais lento e maior
                payload).
                <FieldInfo title="Quando activo, o backend calcula e devolve dados de equity/overlays por trial para os gráficos da página; aumenta tempo de job e tamanho da resposta JSON." />
              </span>
            </label>
          </div>

          </>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <LabelWithInfo info="Métrica usada para ordenar candidatos (thresholds ou pontos da grelha): por exemplo retorno %, Sharpe ou profit factor.">
                <span className="text-xs font-medium text-zinc-500">Critério “melhor” por par</span>
              </LabelWithInfo>
              <select
                className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                value={bestBy}
                onChange={(e) => setBestBy(e.target.value)}
                disabled={status === "running"}
              >
                {BEST_BY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <LabelWithInfo info="Combinações com menos trades que este valor são descartadas pelo motor vectorbt como inválidas (MIN_TRADES).">
                <span className="text-xs font-medium text-zinc-500">Mín. trades (filtro vectorbt)</span>
              </LabelWithInfo>
              <input
                type="number"
                min={1}
                max={5000}
                className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                value={minTrades}
                onChange={(e) => setMinTrades(Math.min(5000, Math.max(1, Number(e.target.value) || 1)))}
                disabled={status === "running"}
              />
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex flex-wrap items-center gap-1.5 text-xs font-medium text-zinc-500">
                Pares ({selectedIds.size} seleccionados)
                <FieldInfo title="Cada combinação par × timeframe marcado corre um job no backend; marca os mercados que queres incluir na corrida." />
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAllFiltered}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-emerald-400/90 hover:bg-emerald-950/35"
                  disabled={status === "running" || filteredSymbols.length === 0}
                >
                  Filtrados
                  <FieldInfo title="Selecciona todos os pares que aparecem na lista depois do filtro de texto (não altera o texto do filtro)." />
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800/80"
                  disabled={status === "running" || selectedIds.size === 0}
                >
                  Limpar
                  <FieldInfo title="Remove todas as marcações de pares." />
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                Filtrar lista de pares
                <FieldInfo title="Filtra localmente pelo código do mercado (substring); só afecta a lista visual até iniciares o job." />
              </span>
              <input
                type="search"
                placeholder="Filtrar por código…"
                className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
                value={symbolFilter}
                onChange={(e) => setSymbolFilter(e.target.value)}
                disabled={status === "running"}
              />
            </div>
            <div className="max-h-52 overflow-y-auto rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-2">
              {filteredSymbols.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-zinc-600">Sem pares.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                  {filteredSymbols.map((s) => (
                    <li key={s.symbol_id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-800/40">
                        <input
                          type="checkbox"
                          className="rounded border-zinc-600"
                          checked={selectedIds.has(s.symbol_id)}
                          onChange={() => toggleSymbol(s.symbol_id)}
                          disabled={status === "running"}
                        />
                        <span className="text-sm text-zinc-300">{s.code}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800/80 pt-4">
            <button
              type="button"
              onClick={onStart}
              disabled={!canStart}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Start
              <FieldInfo title="Envia o pedido ao backend, cria um job em background e faz polling até estado concluído ou erro; podes navegar noutras páginas." />
            </button>
            {status === "running" ? (
              <button
                type="button"
                onClick={cancelBacktest}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800/60"
              >
                Cancelar job
                <FieldInfo title="Pedido ao servidor para cancelar o job actual e limpar o estado local do painel." />
              </button>
            ) : null}
            {(status === "completed" || status === "error") && (
              <button
                type="button"
                onClick={dismissCompleted}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800/60"
              >
                Limpar estado
                <FieldInfo title="Repor o painel para idle e apagar o último resultado guardado em sessão (sessionStorage)." />
              </button>
            )}
            <span className="ml-auto inline-flex items-center gap-1">
              <Link
                href="/chart"
                className="text-sm text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
              >
                Ir para o chart
              </Link>
              <FieldInfo title="Abre o chart ao vivo para editar estratégias ou consultar mercados (não inicia backtest por si só)." />
            </span>
          </div>
        </section>

        {(status === "running" || status === "completed" || status === "error") && (
          <section className="rounded-xl border border-zinc-800/90 bg-zinc-900/20 p-4 sm:p-5">
            <h2 className="mb-3 text-sm font-medium text-zinc-300">Estado</h2>
            <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className={
                  "h-full rounded-full transition-[width] duration-200 " +
                  (status === "error" ? "bg-red-500/80" : "bg-emerald-500/90")
                }
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-xs text-zinc-500">
              {progress}% — {phase}
              {run ? ` · ${run.symbol_ids.length} par(es)` : ""}
            </p>
            {status === "error" && error ? (
              <p className="mt-2 text-sm text-red-400/90">{error}</p>
            ) : null}
          </section>
        )}

        {status === "completed" && resultRows.length > 0 ? (
          <section className="rounded-xl border border-zinc-800/90 bg-zinc-900/20 p-4 sm:p-5">
            <h2 className="mb-3 text-sm font-medium text-zinc-300">Resultados por par</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1180px] border-collapse text-left text-xs text-zinc-300">
                <thead>
                  <tr className="border-b border-zinc-700 text-zinc-500">
                    <th className="py-2 pr-3">Par</th>
                    <th className="py-2 pr-2">TF</th>
                    <th className="py-2 pr-2">#</th>
                    <th className="py-2 pr-3">Ret % (in)</th>
                    <th className="py-2 pr-3">OOS %</th>
                    <th className="py-2 pr-3">WR</th>
                    <th className="py-2 pr-3">Trades</th>
                    <th className="py-2 pr-3">n vál.</th>
                    <th className="py-2 pr-3">DD %</th>
                    <th className="py-2 pr-3">Sharpe</th>
                    <th className="py-2 pr-3">PF</th>
                    <th className="py-2 pr-2 align-bottom whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        Copiar
                        <FieldInfo title="Aplica e grava os parâmetros optimizados nesta estratégia (PostgreSQL ou armazenamento local do chart). O próximo «Correr» aqui e o chart ao recarregar usam os valores novos." />
                      </span>
                    </th>
                    <th className="py-2 pr-2 align-bottom">
                      <span className="inline-flex items-center gap-1">
                        Melhores params
                        <FieldInfo title="Snapshot efectivo da estratégia desta linha (risco, zonas e todos os números dos indicadores). «Melhores» na grelha sem stress só variam SL/TP/zonas — indicadores mostram valores da spec aplicados ao trial." />
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {resultRows.map((row, i) => {
                    const rowBusyKey = `${row.symbol ?? ""}|${row.timeframe ?? ""}|${String(row.optimize_rank ?? i)}`;
                    return (
                    <tr
                      key={`${row.symbol ?? "x"}-${row.timeframe ?? ""}-${row.optimize_rank ?? 0}-${i}`}
                      className="border-b border-zinc-800/80"
                    >
                      <td className="py-2 pr-3 font-medium text-zinc-200">{row.symbol ?? "—"}</td>
                      <td className="py-2 pr-2 font-mono text-[11px] text-zinc-500">{row.timeframe ?? "—"}</td>
                      <td className="py-2 pr-2 tabular-nums text-zinc-500">
                        {row.optimize_rank ?? "—"}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{row.return_pct ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums text-zinc-400">
                        {row.oos_return_pct != null ? row.oos_return_pct : "—"}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{row.win_rate ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">{row.trades ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums text-zinc-500">{row.n_valid ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">{row.max_dd ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">{row.sharpe ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">{row.profit_fct ?? "—"}</td>
                      <td className="py-2 pr-2 align-top">
                        {(() => {
                          const flat = pickRowOptimizedParams(row);
                          const canApply =
                            strategySource === "builder" &&
                            builderSpec !== null &&
                            builderStrategyId !== "" &&
                            flat !== null;
                          const busyHere = copyParamsBusyKey === rowBusyKey;
                          return (
                            <div className="flex flex-col gap-1">
                              <button
                              type="button"
                              disabled={!canApply || copyParamsBusyKey !== null}
                              title={
                                strategySource !== "builder"
                                  ? "Selecciona uma estratégia Builder para aplicar estes parâmetros ao formulário."
                                  : !builderSpec
                                    ? "Carrega primeiro uma estratégia builder."
                                    : !builderStrategyId
                                      ? "Escolhe uma estratégia na lista."
                                      : !flat
                                        ? "Esta linha não tem parâmetros optimizados (resolved_params / best_params)."
                                        : "Gravar estes valores na estratégia (servidor ou local do chart) e usar no próximo backtest."
                              }
                              className={
                                "rounded border px-2 py-1 text-[11px] font-medium transition-colors " +
                                (canApply && copyParamsBusyKey === null
                                  ? "border-emerald-700/60 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/35"
                                  : "cursor-not-allowed border-zinc-800 bg-zinc-950/40 text-zinc-600")
                              }
                              onClick={() => {
                                void (async () => {
                                  if (!builderSpec || !flat || !builderStrategyId) return;
                                  setParamsApplyError(null);
                                  const merged = applyOptimizedParamsToBuilderSpec(builderSpec, flat);
                                  const parsed = parseChartBuilderSpec(merged);
                                  if (!parsed.ok) {
                                    setParamsApplyFeedback(null);
                                    setParamsApplyError(parsed.errors.join("; "));
                                    return;
                                  }
                                  setCopyParamsBusyKey(rowBusyKey);
                                  try {
                                    const putRes = await apiFetch(
                                      `/api/chart/builder-strategies/${encodeURIComponent(builderStrategyId)}`,
                                      {
                                        method: "PUT",
                                        headers: { "content-type": "application/json" },
                                        body: JSON.stringify({ spec: parsed.spec }),
                                      },
                                    );
                                    const bodyUnknown = (await putRes.json()) as {
                                      spec?: Record<string, unknown>;
                                      error?: string;
                                      detail?: unknown;
                                    };
                                    const detailStr =
                                      typeof bodyUnknown.detail === "string"
                                        ? bodyUnknown.detail
                                        : Array.isArray(bodyUnknown.detail)
                                          ? bodyUnknown.detail
                                              .map((d: { msg?: string }) =>
                                                typeof d?.msg === "string" ? d.msg : "",
                                              )
                                              .filter(Boolean)
                                              .join("; ")
                                          : "";
                                    const errMsg =
                                      (typeof bodyUnknown.error === "string" ? bodyUnknown.error : "") ||
                                      detailStr ||
                                      putRes.statusText;
                                    if (!putRes.ok) {
                                      const pgDown =
                                        putRes.status === 503 ||
                                        /PostgreSQL não configurado|postgres/i.test(errMsg);
                                      if (pgDown) {
                                        upsertLocalBuilderStrategy(builderStrategyId, parsed.spec);
                                        setBuilderSpec(parsed.spec as unknown as Record<string, unknown>);
                                        notifyChartBuilderStrategySynced(builderStrategyId, flat);
                                        setParamsApplyFeedback(
                                          `Parâmetros da linha #${row.optimize_rank ?? i + 1} (${row.symbol ?? "?"} · ${row.timeframe ?? "?"}) gravados localmente. Abre o chart (ou foca o separador): os períodos na «Definições» devem alinhar com o optimizado.`,
                                        );
                                        return;
                                      }
                                      throw new Error(errMsg || `HTTP ${putRes.status}`);
                                    }
                                    const serverSpec = bodyUnknown.spec ?? (parsed.spec as unknown as Record<string, unknown>);
                                    setBuilderSpec(serverSpec);
                                    notifyChartBuilderStrategySynced(builderStrategyId, flat);
                                    setParamsApplyFeedback(
                                      `Parâmetros da linha #${row.optimize_rank ?? i + 1} (${row.symbol ?? "?"} · ${row.timeframe ?? "?"}) gravados na estratégia. No chart: «Definições» actualiza ao focar a janela ou recarregar; overrides locais dos indicadores optimizados foram limpos.`,
                                    );
                                  } catch (e) {
                                    setParamsApplyFeedback(null);
                                    setParamsApplyError(e instanceof Error ? e.message : String(e));
                                  } finally {
                                    setCopyParamsBusyKey(null);
                                  }
                                })();
                              }}
                            >
                              {busyHere ? "…" : "Copiar"}
                            </button>
                              {strategySource === "vbt" && flat && vbtStrategyId ? (
                                <button
                                  type="button"
                                  className="rounded border border-sky-700/55 bg-sky-950/35 px-2 py-1 text-[11px] font-medium text-sky-200 transition-colors hover:bg-sky-900/40"
                                  title="Guarda estes parâmetros optimizados para o POST /simulate-bars no Chart (motor vectorbt). Recarrega ou abre o Chart com a mesma estratégia seleccionada."
                                  onClick={() => {
                                    storeOptimizedVbtParamsForChart(vbtStrategyId, flat as Record<string, unknown>);
                                    setParamsApplyError(null);
                                    setParamsApplyFeedback(
                                      `Parâmetros guardados para simulação vectorbt no Chart (${row.symbol ?? "?"} · ${row.timeframe ?? "?"}). Abre ou recarrega o Chart com motor «vectorbt».`,
                                    );
                                  }}
                                >
                                  → Chart (VBT)
                                </button>
                              ) : null}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="py-2 pr-2 align-top text-[11px] text-zinc-400">
                        <BestParamsCell resolved={row.resolved_params} gridSubset={row.best_params} />
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {paramsApplyFeedback ? (
              <p className="mt-2 text-xs text-emerald-400/90">{paramsApplyFeedback}</p>
            ) : null}
            {paramsApplyError ? (
              <p className="mt-2 text-xs text-red-400/90">{paramsApplyError}</p>
            ) : null}
            <p className="mt-3 text-[11px] text-zinc-600">
              “in” = in-sample (treino); OOS = mesmos parâmetros na cauda reservada. «Copiar» grava na estratégia e notifica o chart: lista actualizada e removidos ajustes locais de período/TA-Lib nos indicadores tocados (para «Definições» reflectir o spec). Por linha: coluna «Melhores params» (expandir «Ver»); no JSON do job usa-se{" "}
              <code className="text-zinc-500">resolved_params</code> (builder, snapshot completo) e{" "}
              <code className="text-zinc-500">best_params</code> (só chaves da grelha).
            </p>
          </section>
        ) : null}

        {status === "completed" && (walkForward?.length ?? 0) > 0 ? (
          <section className="rounded-xl border border-zinc-800/90 bg-zinc-900/20 p-4 sm:p-5">
            <h2 className="mb-3 text-sm font-medium text-zinc-300">Walk-forward</h2>
            <p className="mb-3 text-[11px] text-zinc-500">
              Métricas por slice temporal com os mesmos parâmetros do melhor rank (#1) por símbolo (política MVP:
              slices contíguos).
            </p>
            <div className="flex flex-col gap-4">
              {(walkForward ?? []).map((wf, wi) => (
                <div key={wi} className="rounded-lg border border-zinc-800/80 bg-zinc-950/40 p-3">
                  <p className="text-xs font-medium text-zinc-200">
                    {String(wf.symbol ?? wf.symbol_id ?? "—")}
                    {wf.timeframe != null && wf.timeframe !== "" ? (
                      <span className="ml-2 font-mono text-[11px] text-zinc-500">{String(wf.timeframe)}</span>
                    ) : null}
                  </p>
                  {wf.error ? (
                    <p className="mt-1 text-xs text-amber-300/90">{String(wf.error)}</p>
                  ) : null}
                  {wf.summary && typeof wf.summary === "object" ? (
                    <p className="mt-2 text-[11px] text-zinc-500">
                      folds:{" "}
                      {String((wf.summary as { n_folds?: unknown }).n_folds ?? "—")} · média ret %:{" "}
                      {String((wf.summary as { return_pct_mean?: unknown }).return_pct_mean ?? "—")}
                    </p>
                  ) : null}
                  {Array.isArray(wf.folds) && wf.folds.length > 0 ? (
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[520px] border-collapse text-left text-[11px] text-zinc-400">
                        <thead>
                          <tr className="border-b border-zinc-700 text-zinc-500">
                            <th className="py-1 pr-2">#</th>
                            <th className="py-1 pr-2">Barras</th>
                            <th className="py-1 pr-2">Ret %</th>
                            <th className="py-1 pr-2">Trades</th>
                            <th className="py-1 pr-2">PF</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(wf.folds as Record<string, unknown>[]).map((f, fi) => (
                            <tr key={fi} className="border-b border-zinc-800/80">
                              <td className="py-1 pr-2">{String(f.fold ?? fi)}</td>
                              <td className="py-1 pr-2 tabular-nums">
                                {String(f.bar_from ?? "")}–{String(f.bar_to ?? "")}
                              </td>
                              <td className="py-1 pr-2 tabular-nums">{String(f.return_pct ?? "—")}</td>
                              <td className="py-1 pr-2 tabular-nums">{String(f.trades ?? "—")}</td>
                              <td className="py-1 pr-2 tabular-nums">{String(f.profit_fct ?? "—")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {status === "completed" && (monteCarlo?.length ?? 0) > 0 ? (
          <section className="rounded-xl border border-zinc-800/90 bg-zinc-900/20 p-4 sm:p-5">
            <h2 className="mb-3 text-sm font-medium text-zinc-300">Monte Carlo (bootstrap)</h2>
            <p className="mb-3 text-[11px] text-zinc-500">
              Distribuição de retorno final após recompor equity com retornos por trade amostrados com reposição
              (fallback: passos da equity). Referência = melhor rank (#1) por símbolo.
            </p>
            <div className="flex flex-col gap-3">
              {(monteCarlo ?? []).map((mc, mi) => (
                <div key={mi} className="rounded-lg border border-zinc-800/80 bg-zinc-950/40 p-3 text-[11px] text-zinc-400">
                  <p className="text-xs font-medium text-zinc-200">
                    {String(mc.symbol ?? mc.symbol_id ?? "—")}
                    {mc.timeframe != null && mc.timeframe !== "" ? (
                      <span className="ml-2 font-mono text-[11px] text-zinc-500">{String(mc.timeframe)}</span>
                    ) : null}
                  </p>
                  {mc.error ? (
                    <p className="mt-1 text-xs text-amber-300/90">{String(mc.error)}</p>
                  ) : (
                    <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                      <li>runs: {String(mc.n_runs ?? "—")}</li>
                      <li>amostras retorno: {String(mc.n_source_returns ?? "—")}</li>
                      <li>fonte: {String(mc.source ?? "—")}</li>
                      <li>média ret %: {String(mc.return_pct_mean ?? "—")}</li>
                      <li>p5 / p50 / p95 %: {String(mc.return_pct_p5 ?? "—")} /{" "}
                        {String(mc.return_pct_p50 ?? "—")} / {String(mc.return_pct_p95 ?? "—")}</li>
                      <li>σ ret %: {String(mc.return_pct_std ?? "—")}</li>
                      <li>DD médio %: {String(mc.max_dd_pct_mean ?? "—")}</li>
                      {mc.note ? <li className="sm:col-span-2 text-zinc-500">nota: {String(mc.note)}</li> : null}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {status === "completed" ? <BacktestMultiTrialCharts batches={trialBatches} /> : null}

        {status === "completed" && resultRows.length === 0 ? (
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-400">
            <p className="font-medium text-zinc-300">Job concluído sem linhas na tabela</p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">{zeroResultsExplanation(jobDiagnostics)}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
