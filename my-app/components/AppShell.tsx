"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { BacktestProgressBar } from "@/components/BacktestProgressBar";
import { SetChartHeaderSlotContext } from "@/components/ChartHeaderSlotContext";

function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="4" y="18" width="4" height="10" rx="1" className="fill-emerald-500/90" />
      <rect x="11" y="12" width="4" height="16" rx="1" className="fill-emerald-400/90" />
      <rect x="18" y="8" width="4" height="20" rx="1" className="fill-zinc-500" />
      <rect x="25" y="14" width="4" height="14" rx="1" className="fill-emerald-600/90" />
    </svg>
  );
}

function IconMenu({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path
        strokeWidth="2"
        strokeLinecap="round"
        d="M5 7h14M5 12h14M5 17h14"
      />
    </svg>
  );
}

function IconClose({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path strokeWidth="2" strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [chartHeaderSlot, setChartHeaderSlot] = useState<ReactNode>(null);
  const pathname = usePathname();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (pathname !== "/chart") setChartHeaderSlot(null);
  }, [pathname]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(false));
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <SetChartHeaderSlotContext.Provider value={setChartHeaderSlot}>
      <div className="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
        <header className="sticky top-0 z-[60] flex h-14 shrink-0 items-center border-b border-zinc-800/80 bg-zinc-950/90 px-2 backdrop-blur-md supports-[backdrop-filter]:bg-zinc-950/75 sm:px-3">
          <div className="flex shrink-0 items-center gap-0.5">
            <Link
              href="/"
              className="relative z-30 flex shrink-0 items-center rounded-lg p-1.5 transition-colors hover:bg-zinc-800/50"
              aria-label="Início"
            >
              <LogoMark className="h-8 w-8" />
            </Link>

            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="relative z-20 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-zinc-300 transition-colors hover:bg-zinc-800/80 hover:text-white"
              aria-expanded={open}
              aria-controls="app-header-menu"
              aria-label={open ? "Fechar menu" : "Abrir menu"}
            >
              {open ? <IconClose className="h-5 w-5" /> : <IconMenu className="h-5 w-5" />}
            </button>
          </div>

          {/* Sem overflow-hidden aqui: senão os dropdowns do gráfico (absolute) ficam cortados por baixo do main. */}
          <div className="relative z-[1] flex min-h-14 min-w-0 flex-1 items-center gap-2 pl-2 pr-1 sm:pr-2">
            {pathname === "/chart" && chartHeaderSlot ? (
              <div className="relative z-[2] ml-auto flex min-h-14 min-w-0 max-w-[min(100%,calc(100vw-9rem))] shrink-0 items-center justify-end gap-2 sm:gap-3">
                {chartHeaderSlot}
              </div>
            ) : null}

            <div
              id="app-header-menu"
              className={
                "absolute inset-y-0 left-0 right-0 flex items-center bg-zinc-950/95 px-2 backdrop-blur-sm transition-[opacity,visibility] duration-200 supports-[backdrop-filter]:bg-zinc-950/90 " +
                (open
                  ? "visible z-10 opacity-100"
                  : "invisible z-0 pointer-events-none opacity-0")
              }
              role="navigation"
              aria-label="Navegação principal"
            >
              <nav className="flex min-w-0 flex-wrap items-center gap-1">
                <Link
                  href="/chart"
                  onClick={close}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-emerald-950/50 hover:text-emerald-300"
                >
                  Chart
                </Link>
                <Link
                  href="/backtests"
                  onClick={close}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-emerald-950/50 hover:text-emerald-300"
                >
                  Backtests
                </Link>
              </nav>
            </div>
          </div>
        </header>

        <main className="relative z-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
        <BacktestProgressBar />
      </div>
    </SetChartHeaderSlotContext.Provider>
  );
}
