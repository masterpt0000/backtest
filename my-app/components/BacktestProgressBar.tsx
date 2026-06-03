"use client";

import Link from "next/link";

import { useBacktestJob } from "@/components/BacktestJobProvider";
import { formatBacktestTimeframeLabel } from "@/lib/backtestTypes";

export function BacktestProgressBar() {
  const { status, progress, phase, run, error, cancelBacktest, dismissCompleted } =
    useBacktestJob();

  if (status === "idle") return null;

  const label =
    status === "running"
      ? `Backtest ${progress}%`
      : status === "completed"
        ? "Backtest concluído"
        : "Backtest falhou";

  return (
    <div
      className="relative z-[55] flex shrink-0 flex-col border-t border-zinc-800/90 bg-zinc-950/95 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="flex min-h-10 items-center gap-3 px-3 py-1.5 sm:px-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-xs font-medium text-zinc-300">{label}</span>
            {run ? (
              <span className="truncate text-[11px] text-zinc-500">
                {run.vbt_label ?? run.vbt_strategy} · {formatBacktestTimeframeLabel(run)} ·{" "}
                {run.mode === "optimize" ? "optimização" : `${run.num_tests} testes`} · {run.symbol_ids.length}{" "}
                par(es)
              </span>
            ) : null}
          </div>
          {phase ? <p className="truncate text-[11px] text-zinc-500">{phase}</p> : null}
          {status === "error" && error ? (
            <p className="truncate text-[11px] text-red-400/90">{error}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/backtests"
            className="rounded-md px-2 py-1 text-xs font-medium text-emerald-400/90 hover:bg-emerald-950/40 hover:text-emerald-300"
          >
            Abrir
          </Link>
          {status === "running" ? (
            <button
              type="button"
              onClick={cancelBacktest}
              className="rounded-md px-2 py-1 text-xs font-medium text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200"
            >
              Cancelar
            </button>
          ) : (
            <button
              type="button"
              onClick={dismissCompleted}
              className="rounded-md px-2 py-1 text-xs font-medium text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200"
            >
              Fechar
            </button>
          )}
        </div>
      </div>
      <div className="h-1 w-full bg-zinc-900">
        <div
          className={
            "h-full transition-[width] duration-200 ease-out " +
            (status === "error" ? "bg-red-500/80" : "bg-emerald-500/90")
          }
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
    </div>
  );
}
