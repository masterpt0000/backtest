"use client";

import { useBacktestJob } from "@/components/BacktestJobProvider";
import { apiFetch } from "@/lib/apiFetch";
import type { BacktestPresetParamsV1, StrategyPresetRow } from "@/lib/backtestPresetTypes";
import { isPresetParamsV1 } from "@/lib/backtestPresetTypes";
import type { BacktestRangePreset, BacktestRunPayload } from "@/lib/backtestTypes";
import { TIMEFRAME_OPTIONS } from "@/lib/timeframes";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type SymbolRow = { symbol_id: number; code: string };

type VbtStrategyRow = { id: string; module: string; label: string };

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

type ResultRow = {
  symbol?: string;
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
  oos_return_pct?: number | null;
  oos_trades?: number | null;
  oos_sharpe?: number | null;
  oos_max_dd?: number | null;
};

export default function BacktestsPage() {
  const {
    status,
    progress,
    phase,
    run,
    error,
    results,
    startBacktest,
    cancelBacktest,
    dismissCompleted,
  } = useBacktestJob();

  const [tab, setTab] = useState<"single" | "optimize">("single");

  const [vbtStrategies, setVbtStrategies] = useState<VbtStrategyRow[]>([]);
  const [symbols, setSymbols] = useState<SymbolRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [vbtStrategyId, setVbtStrategyId] = useState("");
  const [timeframe, setTimeframe] = useState("5m");
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rv, sy] = await Promise.all([
          apiFetch("/api/backtest/vbt-strategies", { cache: "no-store" }),
          apiFetch("/api/symbols", { cache: "no-store" }),
        ]);
        const jv = await rv.json();
        const jy = await sy.json();
        if (!rv.ok) throw new Error(jv.error ?? rv.statusText);
        if (!sy.ok) throw new Error(jy.error ?? sy.statusText);
        if (cancelled) return;
        setVbtStrategies((jv.strategies ?? []) as VbtStrategyRow[]);
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
    if (!vbtStrategyId) {
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
  }, [vbtStrategyId, selectedIds]);

  useEffect(() => {
    if (!presetApplyId) return;
    const id = Number(presetApplyId);
    if (!presets.some((p) => p.id === id)) setPresetApplyId("");
  }, [presets, presetApplyId]);

  const buildCurrentParamsV1 = useCallback((): BacktestPresetParamsV1 => {
    return {
      version: 1,
      tab,
      timeframe,
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
    };
  }, [
    tab,
    timeframe,
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
    setTimeframe(p.timeframe);
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
  }, [presetApplyId, presets, symbols, vbtStrategyId]);

  const savePreset = useCallback(async () => {
    setPresetActionErr(null);
    if (!vbtStrategyId) {
      setPresetActionErr("Escolhe uma estratégia.");
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

  const onStart = useCallback(() => {
    if (!vbtStrategyId || selectedIds.size === 0) return;
    const labels: Record<string, string> = {};
    for (const id of selectedIds) {
      const row = symbols.find((s) => s.symbol_id === id);
      labels[String(id)] = row?.code ?? String(id);
    }
    const seedTrim = optimizeSeed.trim();
    const parsedSeed = seedTrim === "" ? undefined : Number.parseInt(seedTrim, 10);
    const payload: BacktestRunPayload = {
      mode: tab === "optimize" ? "optimize" : "single",
      vbt_strategy: vbtStrategyId,
      vbt_label: vbtLabel,
      symbol_ids: Array.from(selectedIds),
      symbol_labels: labels,
      timeframe,
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
    };
    startBacktest(payload);
  }, [
    vbtStrategyId,
    selectedIds,
    symbols,
    vbtLabel,
    tab,
    timeframe,
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
    startBacktest,
  ]);

  const canStart = vbtStrategyId !== "" && selectedIds.size > 0 && status !== "running";

  const resultRows = (results ?? []) as ResultRow[];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-auto px-3 py-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
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
              "flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors " +
              (tab === "single"
                ? "bg-emerald-600/25 text-emerald-200"
                : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200")
            }
          >
            Backtest (estratégia)
          </button>
          <button
            type="button"
            onClick={() => setTab("optimize")}
            disabled={status === "running"}
            className={
              "flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors " +
              (tab === "optimize"
                ? "bg-emerald-600/25 text-emerald-200"
                : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200")
            }
          >
            Optimizar parâmetros
          </button>
        </div>

        <p className="text-xs text-zinc-600">
          {tab === "single"
            ? "Indicadores nos valores por defeito da estratégia; só se testam combinações de thresholds (até ao número de testes que indicares), em paralelo no vectorbt."
            : "Optimização: amostragem LHS/random na grelha (sem estourar RAM), top-K soluções por par, opcional validação OOS na cauda da série."}
        </p>

        <section className="flex flex-col gap-4 rounded-xl border border-zinc-800/90 bg-zinc-900/20 p-4 sm:p-5">
          <h2 className="text-sm font-medium text-zinc-300">Presets (PostgreSQL)</h2>
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
              <span className="text-xs font-medium text-zinc-500">Carregar preset</span>
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
              className="rounded-lg border border-zinc-600 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800/60 disabled:opacity-40"
            >
              Aplicar
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 border-t border-zinc-800/80 pt-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-zinc-500">Nome (novo preset)</span>
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
              <span className="text-xs font-medium text-zinc-500">Notas (opcional)</span>
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
            Ligar este preset ao par seleccionado (só com exactamente 1 par marcado)
          </label>
          <button
            type="button"
            onClick={() => void savePreset()}
            disabled={status === "running" || !vbtStrategyId}
            className="w-fit rounded-lg bg-zinc-700 px-3 py-2 text-sm text-zinc-100 hover:bg-zinc-600 disabled:opacity-40"
          >
            Guardar preset
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
                    className="text-red-400/90 hover:underline disabled:opacity-40"
                  >
                    Apagar
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="flex flex-col gap-4 rounded-xl border border-zinc-800/90 bg-zinc-900/20 p-4 sm:p-5">
          <h2 className="text-sm font-medium text-zinc-300">Configuração</h2>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-500">Estratégia vectorbt (*_vbt.py)</span>
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

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-500">Timeframe</span>
            <select
              className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              disabled={status === "running"}
            >
              {TIMEFRAME_OPTIONS.map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-500">Período (limite de velas na QuestDB)</span>
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
              <span className="text-xs font-medium text-zinc-500">Capital inicial</span>
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
                <span className="text-xs font-medium text-zinc-500">Número de testes (thresholds)</span>
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
                <span className="text-xs font-medium text-zinc-500">Max tries (grelha optimização)</span>
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

          {tab === "optimize" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-500">Top-K por par (ranking)</span>
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
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-500">Amostragem da grelha</span>
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
                <span className="text-xs font-medium text-zinc-500">
                  Seed (vazio = aleatório por job; preencher para reproduzir a mesma grelha)
                </span>
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
            </div>
          ) : null}

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-500">
              Holdout OOS (% final da série, 0 = desligado; máx. 40%)
            </span>
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-500">Critério “melhor” por par</span>
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
              <span className="text-xs font-medium text-zinc-500">Mín. trades (filtro vectorbt)</span>
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
              <span className="text-xs font-medium text-zinc-500">
                Pares ({selectedIds.size} seleccionados)
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={selectAllFiltered}
                  className="rounded-md px-2 py-1 text-xs text-emerald-400/90 hover:bg-emerald-950/35"
                  disabled={status === "running" || filteredSymbols.length === 0}
                >
                  Filtrados
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800/80"
                  disabled={status === "running" || selectedIds.size === 0}
                >
                  Limpar
                </button>
              </div>
            </div>
            <input
              type="search"
              placeholder="Filtrar por código…"
              className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
              value={symbolFilter}
              onChange={(e) => setSymbolFilter(e.target.value)}
              disabled={status === "running"}
            />
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
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Start
            </button>
            {status === "running" ? (
              <button
                type="button"
                onClick={cancelBacktest}
                className="rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800/60"
              >
                Cancelar job
              </button>
            ) : null}
            {(status === "completed" || status === "error") && (
              <button
                type="button"
                onClick={dismissCompleted}
                className="rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800/60"
              >
                Limpar estado
              </button>
            )}
            <Link
              href="/chart"
              className="ml-auto text-sm text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
            >
              Ir para o chart
            </Link>
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
              <table className="w-full min-w-[880px] border-collapse text-left text-xs text-zinc-300">
                <thead>
                  <tr className="border-b border-zinc-700 text-zinc-500">
                    <th className="py-2 pr-3">Par</th>
                    <th className="py-2 pr-2">#</th>
                    <th className="py-2 pr-3">Ret % (in)</th>
                    <th className="py-2 pr-3">OOS %</th>
                    <th className="py-2 pr-3">WR</th>
                    <th className="py-2 pr-3">Trades</th>
                    <th className="py-2 pr-3">n vál.</th>
                    <th className="py-2 pr-3">DD %</th>
                    <th className="py-2 pr-3">Sharpe</th>
                    <th className="py-2 pr-3">PF</th>
                  </tr>
                </thead>
                <tbody>
                  {resultRows.map((r, i) => (
                    <tr
                      key={`${r.symbol ?? "x"}-${r.optimize_rank ?? 0}-${i}`}
                      className="border-b border-zinc-800/80"
                    >
                      <td className="py-2 pr-3 font-medium text-zinc-200">{r.symbol ?? "—"}</td>
                      <td className="py-2 pr-2 tabular-nums text-zinc-500">
                        {r.optimize_rank ?? "—"}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{r.return_pct ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums text-zinc-400">
                        {r.oos_return_pct != null ? r.oos_return_pct : "—"}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{r.win_rate ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">{r.trades ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums text-zinc-500">{r.n_valid ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">{r.max_dd ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">{r.sharpe ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">{r.profit_fct ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-zinc-600">
              “in” = in-sample (treino); OOS = mesmos parâmetros na cauda reservada. Parâmetros:{" "}
              <code className="text-zinc-500">best_params</code> na resposta JSON.
            </p>
          </section>
        ) : null}

        {status === "completed" && resultRows.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Job concluído sem resultados (dados insuficientes na QuestDB ou nenhum par passou o mínimo de
            trades).
          </p>
        ) : null}
      </div>
    </div>
  );
}
