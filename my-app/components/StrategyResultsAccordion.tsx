"use client";

import type { ReactNode } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  strategyLabel: string | null;
  children: ReactNode;
};

/** Barra no fundo da coluna do gráfico; conteúdo em fluxo normal — o scroll fica no contentor pai (página). */
export function StrategyResultsAccordion({ open, onOpenChange, strategyLabel, children }: Props) {
  const name = strategyLabel?.trim() || "Estratégia";
  return (
    <div className="shrink-0 border-t border-zinc-800/90 bg-zinc-950/98 shadow-[0_-6px_28px_rgba(0,0,0,0.45)]">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-zinc-900/55 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-600/35"
      >
        <div className="min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-400/95">
            {name}
          </span>
          <span className="text-[11px] text-zinc-500"> — </span>
          <span className="text-[11px] font-medium text-zinc-400">
            {open ? "Ocultar métricas e equity" : "Mostrar resultados da simulação"}
          </span>
        </div>
        <span
          className={"shrink-0 text-zinc-500 transition-transform duration-200 " + (open ? "rotate-180" : "")}
          aria-hidden
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="border-t border-zinc-800/80 bg-[#060608]">
          {children}
        </div>
      ) : null}
    </div>
  );
}
