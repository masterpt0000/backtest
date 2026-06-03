"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { apiFetch } from "@/lib/apiFetch";
import type {
  BacktestJobState,
  BacktestJobStatus,
  BacktestRunPayload,
  BacktestTrialBatch,
  BacktestValidationFramework,
} from "@/lib/backtestTypes";

type BacktestJobContextValue = BacktestJobState & {
  startBacktest: (payload: BacktestRunPayload) => void;
  cancelBacktest: () => void;
  dismissCompleted: () => void;
};

const BacktestJobContext = createContext<BacktestJobContextValue | null>(null);

const POLL_MS = 600;

/** Último backtest concluído: sobrevive a refresh da página (sessionStorage, ~5MB). */
const BACKTEST_SESSION_KEY = "backtest:lastCompleted";

function readStoredBacktest():
  | {
      status: "completed";
      results: unknown[];
      trialBatches: BacktestTrialBatch[] | null;
      walkForward: Record<string, unknown>[] | null;
      monteCarlo: Record<string, unknown>[] | null;
      jobDiagnostics: Record<string, unknown> | null;
      run: BacktestRunPayload;
      finishedAt: number;
    }
  | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(BACKTEST_SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as {
      results?: unknown;
      trial_batches?: unknown;
      walk_forward?: unknown;
      monte_carlo?: unknown;
      diagnostics?: unknown;
      run?: BacktestRunPayload;
      status?: string;
      finishedAt?: number;
    };
    if (o?.status !== "completed" || !Array.isArray(o.results) || !o.run) return null;
    const tb = Array.isArray(o.trial_batches) ? (o.trial_batches as BacktestTrialBatch[]) : null;
    const wf = Array.isArray(o.walk_forward) ? (o.walk_forward as Record<string, unknown>[]) : null;
    const mc = Array.isArray(o.monte_carlo) ? (o.monte_carlo as Record<string, unknown>[]) : null;
    const jd =
      o.diagnostics != null && typeof o.diagnostics === "object" && !Array.isArray(o.diagnostics)
        ? (o.diagnostics as Record<string, unknown>)
        : null;
    return {
      status: "completed",
      results: o.results,
      trialBatches: tb,
      walkForward: wf,
      monteCarlo: mc,
      jobDiagnostics: jd,
      run: o.run,
      finishedAt: typeof o.finishedAt === "number" ? o.finishedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function writeStoredBacktest(payload: {
  results: unknown[];
  trialBatches: BacktestTrialBatch[] | null;
  walkForward: Record<string, unknown>[] | null;
  monteCarlo: Record<string, unknown>[] | null;
  jobDiagnostics: Record<string, unknown> | null;
  run: BacktestRunPayload;
  finishedAt: number;
}): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      BACKTEST_SESSION_KEY,
      JSON.stringify({
        status: "completed" as const,
        results: payload.results,
        trial_batches: payload.trialBatches,
        walk_forward: payload.walkForward,
        monte_carlo: payload.monteCarlo,
        diagnostics: payload.jobDiagnostics,
        run: payload.run,
        finishedAt: payload.finishedAt,
      }),
    );
  } catch {
    /* quota ou private mode */
  }
}

function clearStoredBacktest(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(BACKTEST_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function BacktestJobProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BacktestJobStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("");
  const [run, setRun] = useState<BacktestRunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [results, setResults] = useState<unknown[] | null>(null);
  const [trialBatches, setTrialBatches] = useState<BacktestTrialBatch[] | null>(null);
  const [walkForward, setWalkForward] = useState<Record<string, unknown>[] | null>(null);
  const [monteCarlo, setMonteCarlo] = useState<Record<string, unknown>[] | null>(null);
  const [jobDiagnostics, setJobDiagnostics] = useState<Record<string, unknown> | null>(null);

  const runGenRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const serverJobIdRef = useRef<string | null>(null);
  const restoredRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const s = readStoredBacktest();
    if (!s) return;
    setStatus("completed");
    setResults(s.results);
    setTrialBatches(s.trialBatches);
    setWalkForward(s.walkForward);
    setMonteCarlo(s.monteCarlo);
    setJobDiagnostics(s.jobDiagnostics);
    setRun(s.run);
    setFinishedAt(s.finishedAt);
    setProgress(100);
    setPhase("Concluído (sessão)");
  }, []);

  const stopPoll = useCallback(() => {
    if (pollTimerRef.current != null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    serverJobIdRef.current = null;
  }, []);

  const cancelBacktest = useCallback(() => {
    const jid = serverJobIdRef.current;
    runGenRef.current += 1;
    if (jid) {
      void apiFetch(`/api/backtest/jobs/${encodeURIComponent(jid)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {
        /* ignore */
      });
    }
    stopPoll();
    clearStoredBacktest();
    setStatus("idle");
    setProgress(0);
    setPhase("");
    setRun(null);
    setError(null);
    setFinishedAt(null);
    setResults(null);
    setTrialBatches(null);
    setWalkForward(null);
    setMonteCarlo(null);
    setJobDiagnostics(null);
  }, [stopPoll]);

  const dismissCompleted = useCallback(() => {
    if (status === "completed" || status === "error") {
      stopPoll();
      clearStoredBacktest();
      setStatus("idle");
      setProgress(0);
      setPhase("");
      setRun(null);
      setError(null);
      setFinishedAt(null);
      setResults(null);
      setTrialBatches(null);
      setWalkForward(null);
      setMonteCarlo(null);
      setJobDiagnostics(null);
    }
  }, [status, stopPoll]);

  const startBacktest = useCallback(
    (payload: BacktestRunPayload) => {
      runGenRef.current += 1;
      const gen = runGenRef.current;
      stopPoll();
      clearStoredBacktest();

      setRun(payload);
      setError(null);
      setFinishedAt(null);
      setResults(null);
      setTrialBatches(null);
      setWalkForward(null);
      setMonteCarlo(null);
      setJobDiagnostics(null);
      setStatus("running");
      setProgress(0);
      setPhase("A enviar pedido…");

          void (async () => {
            try {
              const vfs: BacktestValidationFramework[] =
                payload.validation_frameworks && payload.validation_frameworks.length > 0
                  ? [...payload.validation_frameworks]
                  : payload.validation_framework
                    ? [payload.validation_framework]
                    : ["standard"];
              const tfPayload =
                payload.timeframes && payload.timeframes.length > 0
                  ? payload.timeframes
                  : [payload.timeframe];

              const r = await apiFetch(
                "/api/backtest/jobs",
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  cache: "no-store",
                  body: JSON.stringify({
                    mode: payload.mode,
                    strategy_source: payload.strategy_source ?? "vbt",
                    vbt_strategy: payload.vbt_strategy,
                    ...(payload.builder_strategy_id ? { builder_strategy_id: payload.builder_strategy_id } : {}),
                    ...(payload.builder_spec ? { builder_spec: payload.builder_spec } : {}),
                    symbol_ids: payload.symbol_ids,
                    symbol_labels: payload.symbol_labels,
                    timeframe: payload.timeframe,
                    timeframes: tfPayload,
                    range_preset: payload.range_preset,
                    initial_cash: payload.initial_cash,
                    num_tests: payload.num_tests,
                    max_tries: payload.max_tries,
                    best_by: payload.best_by,
                    min_trades: payload.min_trades,
                    ...(typeof payload.optimize_seed === "number" &&
                    !Number.isNaN(payload.optimize_seed)
                      ? { optimize_seed: payload.optimize_seed }
                      : {}),
                    ...(payload.optimize_grid_sample
                      ? { optimize_grid_sample: payload.optimize_grid_sample }
                      : {}),
                    ...(payload.optimize_top_k != null ? { optimize_top_k: payload.optimize_top_k } : {}),
                    ...(payload.optimize_holdout_ratio != null &&
                    payload.optimize_holdout_ratio > 0
                      ? { optimize_holdout_ratio: payload.optimize_holdout_ratio }
                      : {}),
                    include_ui_charts: payload.include_ui_charts === true,
                    validation_framework: vfs[0] ?? "standard",
                    validation_frameworks: vfs,
                    ...(vfs.includes("walk_forward")
                      ? {
                          wf_n_splits: payload.wf_n_splits ?? 5,
                          wf_min_segment_bars: payload.wf_min_segment_bars ?? 80,
                        }
                      : {}),
                    ...(vfs.includes("monte_carlo")
                      ? {
                          mc_runs: payload.mc_runs ?? 800,
                          ...(typeof payload.mc_seed === "number" && !Number.isNaN(payload.mc_seed)
                            ? { mc_seed: payload.mc_seed }
                            : {}),
                        }
                      : {}),
                    ...(payload.strategy_source === "builder"
                      ? {
                          param_drift_enabled: payload.param_drift_enabled === true,
                          ...(payload.param_drift_enabled &&
                          payload.param_drift_pct_by_key &&
                          Object.keys(payload.param_drift_pct_by_key).length > 0
                            ? { param_drift_pct_by_key: payload.param_drift_pct_by_key }
                            : {}),
                        }
                      : {}),
                    exec_fee_pct_per_fill:
                      typeof payload.exec_fee_pct_per_fill === "number" &&
                      Number.isFinite(payload.exec_fee_pct_per_fill)
                        ? payload.exec_fee_pct_per_fill
                        : 0,
                    exec_slippage_pct:
                      typeof payload.exec_slippage_pct === "number" &&
                      Number.isFinite(payload.exec_slippage_pct)
                        ? payload.exec_slippage_pct
                        : 0,
                    exec_half_spread_pct:
                      typeof payload.exec_half_spread_pct === "number" &&
                      Number.isFinite(payload.exec_half_spread_pct)
                        ? payload.exec_half_spread_pct
                        : 0,
                  }),
                },
                30_000,
              );
          const j = (await r.json()) as { job_id?: string; error?: string };
          if (!r.ok) {
            throw new Error(j.error ?? r.statusText);
          }
          if (runGenRef.current !== gen) return;
          const jobId = j.job_id;
          if (!jobId) throw new Error("Resposta sem job_id");
          serverJobIdRef.current = jobId;
          setPhase("Job iniciado…");

          const pollOnce = async () => {
            if (runGenRef.current !== gen) return;
            try {
              const pr = await apiFetch(`/api/backtest/jobs/${encodeURIComponent(jobId)}`, {
                cache: "no-store",
              });
              const st = (await pr.json()) as {
                status?: string;
                progress?: number;
                phase?: string;
                error?: string;
                results?: unknown[];
                trial_batches?: unknown;
                walk_forward?: unknown;
                monte_carlo?: unknown;
                diagnostics?: unknown;
              };
              if (!pr.ok) {
                throw new Error((st as { error?: string }).error ?? pr.statusText);
              }
              if (runGenRef.current !== gen) return;
              setProgress(typeof st.progress === "number" ? st.progress : 0);
              setPhase(typeof st.phase === "string" ? st.phase : "");

              if (st.status === "completed") {
                stopPoll();
                const list = Array.isArray(st.results) ? st.results : [];
                const batches = Array.isArray(st.trial_batches)
                  ? (st.trial_batches as BacktestTrialBatch[])
                  : null;
                const wf = Array.isArray(st.walk_forward)
                  ? (st.walk_forward as Record<string, unknown>[])
                  : null;
                const mc = Array.isArray(st.monte_carlo)
                  ? (st.monte_carlo as Record<string, unknown>[])
                  : null;
                const jd =
                  st.diagnostics != null &&
                  typeof st.diagnostics === "object" &&
                  !Array.isArray(st.diagnostics)
                    ? (st.diagnostics as Record<string, unknown>)
                    : null;
                setResults(list);
                setTrialBatches(batches);
                setWalkForward(wf);
                setMonteCarlo(mc);
                setJobDiagnostics(jd);
                setProgress(100);
                setPhase("Concluído");
                setStatus("completed");
                const doneAt = Date.now();
                setFinishedAt(doneAt);
                writeStoredBacktest({
                  results: list,
                  trialBatches: batches,
                  walkForward: wf,
                  monteCarlo: mc,
                  jobDiagnostics: jd,
                  run: payload,
                  finishedAt: doneAt,
                });
              } else if (st.status === "error") {
                stopPoll();
                setError(st.error ?? "Erro no backtest");
                setStatus("error");
                setFinishedAt(Date.now());
              }
            } catch (e) {
              if (runGenRef.current !== gen) return;
              stopPoll();
              setError(e instanceof Error ? e.message : String(e));
              setStatus("error");
              setFinishedAt(Date.now());
            }
          };

          await pollOnce();
          pollTimerRef.current = setInterval(pollOnce, POLL_MS);
        } catch (e) {
          if (runGenRef.current !== gen) return;
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
          setFinishedAt(Date.now());
          setPhase("");
        }
      })();
    },
    [stopPoll],
  );

  const value = useMemo<BacktestJobContextValue>(
    () => ({
      status,
      progress,
      phase,
      run,
      error,
      finishedAt,
      results,
      trialBatches,
      walkForward,
      monteCarlo,
      jobDiagnostics,
      startBacktest,
      cancelBacktest,
      dismissCompleted,
    }),
    [
      status,
      progress,
      phase,
      run,
      error,
      finishedAt,
      results,
      trialBatches,
      walkForward,
      monteCarlo,
      jobDiagnostics,
      startBacktest,
      cancelBacktest,
      dismissCompleted,
    ],
  );

  return <BacktestJobContext.Provider value={value}>{children}</BacktestJobContext.Provider>;
}

export function useBacktestJob(): BacktestJobContextValue {
  const ctx = useContext(BacktestJobContext);
  if (!ctx) {
    throw new Error("useBacktestJob must be used within BacktestJobProvider");
  }
  return ctx;
}
