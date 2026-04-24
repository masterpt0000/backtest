"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { apiFetch } from "@/lib/apiFetch";
import type { BacktestJobState, BacktestJobStatus, BacktestRunPayload } from "@/lib/backtestTypes";

type BacktestJobContextValue = BacktestJobState & {
  startBacktest: (payload: BacktestRunPayload) => void;
  cancelBacktest: () => void;
  dismissCompleted: () => void;
};

const BacktestJobContext = createContext<BacktestJobContextValue | null>(null);

const POLL_MS = 600;

export function BacktestJobProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BacktestJobStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("");
  const [run, setRun] = useState<BacktestRunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [results, setResults] = useState<unknown[] | null>(null);

  const runGenRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const serverJobIdRef = useRef<string | null>(null);

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
    setStatus("idle");
    setProgress(0);
    setPhase("");
    setRun(null);
    setError(null);
    setFinishedAt(null);
    setResults(null);
  }, [stopPoll]);

  const dismissCompleted = useCallback(() => {
    if (status === "completed" || status === "error") {
      stopPoll();
      setStatus("idle");
      setProgress(0);
      setPhase("");
      setRun(null);
      setError(null);
      setFinishedAt(null);
      setResults(null);
    }
  }, [status, stopPoll]);

  const startBacktest = useCallback(
    (payload: BacktestRunPayload) => {
      runGenRef.current += 1;
      const gen = runGenRef.current;
      stopPoll();

      setRun(payload);
      setError(null);
      setFinishedAt(null);
      setResults(null);
      setStatus("running");
      setProgress(0);
      setPhase("A enviar pedido…");

      void (async () => {
        try {
          const r = await apiFetch(
            "/api/backtest/jobs",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              cache: "no-store",
              body: JSON.stringify({
                mode: payload.mode,
                vbt_strategy: payload.vbt_strategy,
                symbol_ids: payload.symbol_ids,
                symbol_labels: payload.symbol_labels,
                timeframe: payload.timeframe,
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
                ...(payload.optimize_top_k != null
                  ? { optimize_top_k: payload.optimize_top_k }
                  : {}),
                ...(payload.optimize_holdout_ratio != null &&
                payload.optimize_holdout_ratio > 0
                  ? { optimize_holdout_ratio: payload.optimize_holdout_ratio }
                  : {}),
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
              };
              if (!pr.ok) {
                throw new Error((st as { error?: string }).error ?? pr.statusText);
              }
              if (runGenRef.current !== gen) return;
              setProgress(typeof st.progress === "number" ? st.progress : 0);
              setPhase(typeof st.phase === "string" ? st.phase : "");

              if (st.status === "completed") {
                stopPoll();
                setResults(Array.isArray(st.results) ? st.results : []);
                setProgress(100);
                setPhase("Concluído");
                setStatus("completed");
                setFinishedAt(Date.now());
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
      startBacktest,
      cancelBacktest,
      dismissCompleted,
    }),
    [status, progress, phase, run, error, finishedAt, results, startBacktest, cancelBacktest, dismissCompleted],
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
