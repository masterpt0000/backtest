"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

export type ChartMenuOption = { value: string; label: string };

type Props = {
  id: string;
  /** Texto acessível (ex.: Par, Timeframe). */
  ariaLabel: string;
  /** Rótulo curto opcional visível à esquerda do valor (ex.: PAR, TF). */
  badge?: string;
  options: ChartMenuOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Classes no wrapper externo (largura, etc.). */
  className?: string;
  /** Largura mínima do painel em relação ao gatilho. */
  menuMinWidth?: "trigger" | "wide";
};

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={
        "h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-200 " +
        (open ? "rotate-180 text-emerald-500/90" : "")
      }
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden
    >
      <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function ChartMenuDropdown({
  id,
  ariaLabel,
  badge,
  options,
  value,
  onChange,
  disabled = false,
  className = "",
  menuMinWidth = "trigger",
}: Props) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const selected = options.find((o) => o.value === value);
  const displayLabel =
    options.length === 0 ? "A carregar…" : (selected?.label ?? (value ? value : "—"));

  const close = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const i = options.findIndex((o) => o.value === value);
    setHighlight(i >= 0 ? i : 0);
  }, [open, options, value]);

  const onKeyMenu = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[highlight];
      if (o) {
        onChange(o.value);
        close();
      }
    }
  };

  return (
    <div
      ref={rootRef}
      className={`relative ${open ? "z-[100]" : "z-0"} ${className}`}
    >
      <label htmlFor={id} className="sr-only">
        {ariaLabel}
      </label>
      <button
        ref={btnRef}
        id={id}
        type="button"
        disabled={disabled || options.length === 0}
        title={displayLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        className={
          "flex h-9 w-full min-w-0 items-center gap-2 rounded-xl border border-zinc-600/55 bg-gradient-to-b from-zinc-800/45 to-zinc-950/95 px-2.5 py-0 text-left shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07),0_2px_8px_rgba(0,0,0,0.35)] transition-all duration-150 " +
          "hover:border-zinc-500/70 hover:from-zinc-800/60 hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.09)] " +
          "focus:border-emerald-600/55 focus:outline-none focus:ring-2 focus:ring-emerald-600/25 " +
          "disabled:pointer-events-none disabled:opacity-45 " +
          (open ? "border-emerald-600/50 ring-2 ring-emerald-600/20" : "")
        }
        onClick={() => !disabled && options.length > 0 && setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) setOpen(true);
            else onKeyMenu(e);
          }
        }}
      >
        {badge ? (
          <span className="shrink-0 rounded-md bg-zinc-900/90 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-500/95 ring-1 ring-emerald-800/40">
            {badge}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-tight text-zinc-100">
          {displayLabel}
        </span>
        <Chevron open={open} />
      </button>

      {open && options.length > 0 ? (
        <div
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          className={
            "absolute left-0 top-[calc(100%+6px)] z-[110] max-h-[min(16rem,50vh)] overflow-y-auto overflow-x-hidden overscroll-contain rounded-xl border border-zinc-600/50 bg-zinc-950/98 py-1 shadow-[0_12px_40px_rgba(0,0,0,0.55)] ring-1 ring-black/50 backdrop-blur-md " +
            "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar]:bg-transparent " +
            (menuMinWidth === "wide" ? "min-w-[12rem] sm:min-w-[14rem]" : "min-w-full")
          }
          onKeyDown={onKeyMenu}
        >
          {options.map((o, i) => {
            const isSel = o.value === value;
            const isHi = i === highlight;
            return (
              <button
                key={o.value || `opt-${i}`}
                type="button"
                role="option"
                aria-selected={isSel}
                className={
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium transition-colors " +
                  (isHi ? "bg-zinc-800/90" : "bg-transparent") +
                  " " +
                  (isSel
                    ? "text-emerald-300"
                    : "text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100")
                }
                onMouseEnter={() => setHighlight(i)}
                onClick={() => {
                  onChange(o.value);
                  close();
                }}
              >
                <span
                  className={
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] " +
                    (isSel
                      ? "border-emerald-600/70 bg-emerald-950/50 text-emerald-400"
                      : "border-zinc-600/50 bg-zinc-900/50 text-transparent")
                  }
                  aria-hidden
                >
                  ✓
                </span>
                <span className="min-w-0 flex-1 truncate tracking-tight">{o.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
