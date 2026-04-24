"use client";

import {
  effectiveLineWidth,
  effectiveMult,
  effectivePeriod,
  effectiveSource,
  type ChartIndicatorOverride,
  type ChartLineWidth,
} from "@/lib/chartIndicatorSettings";
import { defaultRsiLineColor } from "@/lib/indicatorLineColors";
import {
  INDICATOR_SOURCES,
  type IndicatorSource,
  type Strategy,
  type StrategyIndicator,
} from "@/lib/strategies";
import { useEffect, useState } from "react";

function IconGear({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 15a3 3 0 100-6 3 3 0 000 6z"
      />
      <path
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"
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

type GearProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
};

export function ChartSettingsGearButton({ open, onOpenChange, disabled }: GearProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-expanded={open}
      aria-controls="chart-settings-sidebar"
      className={
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-900/90 text-zinc-400 shadow-inner shadow-black/20 transition-colors hover:border-zinc-600 hover:text-zinc-100 focus:border-emerald-600/70 focus:outline-none focus:ring-2 focus:ring-emerald-600/25 disabled:pointer-events-none disabled:opacity-40 " +
        (open ? "border-emerald-700/50 text-emerald-300/90" : "")
      }
      title={disabled ? "Sem indicadores" : "Definições do gráfico"}
      onClick={() => !disabled && onOpenChange(!open)}
    >
      <IconGear className="h-4 w-4" />
    </button>
  );
}

function IconMinus({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path strokeWidth="2.5" strokeLinecap="round" d="M6 12h12" />
    </svg>
  );
}

function IconPlus({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path strokeWidth="2.5" strokeLinecap="round" d="M12 6v12M6 12h12" />
    </svg>
  );
}

function clampNum(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function roundToDecimals(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function formatStepperText(v: number, decimals: number): string {
  if (decimals > 0) return String(v);
  return String(Math.round(v));
}

/**
 * Campo numérico com − / + (substitui as setas nativas do input number).
 */
function NumericStepper({
  value,
  onCommit,
  min,
  max,
  step,
  decimals,
  decrementLabel,
  incrementLabel,
  id,
  rootClassName = "",
}: {
  value: number;
  onCommit: (n: number) => void;
  min: number;
  max: number;
  step: number;
  decimals: number;
  decrementLabel: string;
  incrementLabel: string;
  id?: string;
  rootClassName?: string;
}) {
  const [text, setText] = useState(() => formatStepperText(value, decimals));

  useEffect(() => {
    setText(formatStepperText(value, decimals));
  }, [value, decimals]);

  const commitText = (raw: string) => {
    const n = Number(raw.replace(",", ".").trim());
    if (!Number.isFinite(n)) {
      setText(formatStepperText(value, decimals));
      return;
    }
    const rounded = roundToDecimals(n, decimals);
    const next = clampNum(rounded, min, max);
    onCommit(next);
    setText(formatStepperText(next, decimals));
  };

  const applyDelta = (delta: number) => {
    const raw = value + delta;
    const rounded = roundToDecimals(raw, decimals);
    const next = clampNum(rounded, min, max);
    onCommit(next);
    setText(formatStepperText(next, decimals));
  };

  const atMin = value <= min + 1e-9;
  const atMax = value >= max - 1e-9;

  return (
    <div
      className={
        "flex h-8 min-w-0 overflow-hidden rounded-lg border border-zinc-700/85 bg-gradient-to-b from-zinc-800/50 to-zinc-900/90 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition-shadow focus-within:border-emerald-600/55 focus-within:ring-2 focus-within:ring-emerald-600/20 " +
        rootClassName
      }
    >
      <button
        type="button"
        aria-label={decrementLabel}
        disabled={atMin}
        className="flex h-full w-8 shrink-0 items-center justify-center border-r border-zinc-700/60 bg-zinc-900/40 text-zinc-500 transition-colors hover:bg-zinc-800/90 hover:text-zinc-100 active:bg-zinc-800 disabled:pointer-events-none disabled:opacity-35"
        onClick={() => applyDelta(-step)}
      >
        <IconMinus className="h-3.5 w-3.5" />
      </button>
      <input
        id={id}
        type="text"
        inputMode={decimals > 0 ? "decimal" : "numeric"}
        autoComplete="off"
        className="min-w-0 flex-1 border-0 bg-transparent px-1 text-center text-xs font-semibold tabular-nums text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-0"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commitText(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitText((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            applyDelta(step);
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            applyDelta(-step);
          }
        }}
      />
      <button
        type="button"
        aria-label={incrementLabel}
        disabled={atMax}
        className="flex h-full w-8 shrink-0 items-center justify-center border-l border-zinc-700/60 bg-zinc-900/40 text-zinc-500 transition-colors hover:bg-zinc-800/90 hover:text-zinc-100 active:bg-zinc-800 disabled:pointer-events-none disabled:opacity-35"
        onClick={() => applyDelta(step)}
      >
        <IconPlus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const SOURCE_LABELS: Record<IndicatorSource, string> = {
  open: "Abertura",
  high: "Máxima",
  low: "Mínima",
  close: "Fecho",
  hl2: "(Máx + Mín) / 2",
  hlc3: "(Máx + Mín + Fecho) / 3",
  ohlc4: "(Abr + Máx + Mín + Fecho) / 4",
};

function defaultEmaRsiColor(ind: StrategyIndicator): string {
  if (ind.kind === "ema") {
    if (ind.id === "ema8") return "#f59e0b";
    if (ind.id === "ema21") return "#38bdf8";
    return "#94a3b8";
  }
  if (ind.kind === "rsi") return defaultRsiLineColor(ind.id);
  return "#a78bfa";
}

function IndicatorsSection({
  strategy,
  overrides,
  onPatch,
  onResetParams,
}: {
  strategy: Strategy;
  overrides: Record<string, ChartIndicatorOverride | undefined>;
  onPatch: (indicatorId: string, patch: Partial<ChartIndicatorOverride> | null) => void;
  onResetParams: (indicatorId: string) => void;
}) {
  return (
    <div className="space-y-1 px-3 pb-4 pt-2">
      <p className="mb-3 text-[11px] leading-snug text-zinc-500">
        Período, fonte de preço (OHLC) e multiplicador (Bollinger). Só neste browser.
      </p>
      {strategy.indicators.map((ind) => {
        const o = overrides[ind.id];
        const period = effectivePeriod(ind, o);
        const mult = effectiveMult(ind, o);
        const source = effectiveSource(ind, o);
        return (
          <div
            key={ind.id}
            className="space-y-2 border-b border-zinc-800/80 py-3 last:border-b-0 last:pb-0 first:pt-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium text-zinc-200">{ind.label}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">{ind.kind}</span>
            </div>
            <label className="flex items-center gap-2" htmlFor={`chart-set-${ind.id}-source`}>
              <span className="w-20 shrink-0 text-[11px] text-zinc-400">Fonte</span>
              <select
                id={`chart-set-${ind.id}-source`}
                className="h-8 min-w-0 flex-1 cursor-pointer rounded-lg border border-zinc-700/85 bg-zinc-900/90 px-2 text-xs font-medium text-zinc-100 shadow-inner shadow-black/20 transition-colors hover:border-zinc-600 focus:border-emerald-600/55 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
                value={source}
                onChange={(e) =>
                  onPatch(ind.id, { ...o, source: e.target.value as IndicatorSource })
                }
              >
                {INDICATOR_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2" htmlFor={`chart-set-${ind.id}-period`}>
              <span className="w-20 shrink-0 text-[11px] text-zinc-400">Período</span>
              <NumericStepper
                id={`chart-set-${ind.id}-period`}
                rootClassName="flex-1"
                value={period}
                min={2}
                max={500}
                step={1}
                decimals={0}
                decrementLabel="Diminuir período"
                incrementLabel="Aumentar período"
                onCommit={(n) => onPatch(ind.id, { ...o, period: n })}
              />
            </label>
            {ind.kind === "bollinger" ? (
              <label className="flex items-center gap-2" htmlFor={`chart-set-${ind.id}-mult`}>
                <span className="w-20 shrink-0 text-[11px] text-zinc-400">Mult.</span>
                <NumericStepper
                  id={`chart-set-${ind.id}-mult`}
                  rootClassName="flex-1"
                  value={mult}
                  min={0.5}
                  max={10}
                  step={0.1}
                  decimals={1}
                  decrementLabel="Diminuir multiplicador"
                  incrementLabel="Aumentar multiplicador"
                  onCommit={(n) => onPatch(ind.id, { ...o, mult: n })}
                />
              </label>
            ) : null}
            <button
              type="button"
              className="text-[11px] font-medium text-emerald-500/90 hover:text-emerald-400"
              onClick={() => onResetParams(ind.id)}
            >
              Restaurar parâmetros
            </button>
          </div>
        );
      })}
    </div>
  );
}

function StyleSection({
  strategy,
  overrides,
  onPatch,
  onResetStyle,
}: {
  strategy: Strategy;
  overrides: Record<string, ChartIndicatorOverride | undefined>;
  onPatch: (indicatorId: string, patch: Partial<ChartIndicatorOverride> | null) => void;
  onResetStyle: (indicatorId: string) => void;
}) {
  return (
    <div className="space-y-1 px-3 pb-4 pt-2">
      <p className="mb-3 text-[11px] leading-snug text-zinc-500">
        Cores e espessura das linhas.
      </p>
      {strategy.indicators.map((ind) => {
        const o = overrides[ind.id];
        const lw = effectiveLineWidth(ind, o);
        return (
          <div
            key={ind.id}
            className="space-y-2 border-b border-zinc-800/80 py-3 last:border-b-0 last:pb-0 first:pt-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium text-zinc-200">{ind.label}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">{ind.kind}</span>
            </div>

            <label className="flex items-center gap-2" htmlFor={`chart-set-${ind.id}-lw`}>
              <span className="w-20 shrink-0 text-[11px] text-zinc-400">Espessura</span>
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <NumericStepper
                  id={`chart-set-${ind.id}-lw`}
                  rootClassName="flex-1"
                  value={lw}
                  min={1}
                  max={4}
                  step={1}
                  decimals={0}
                  decrementLabel="Diminuir espessura"
                  incrementLabel="Aumentar espessura"
                  onCommit={(n) =>
                    onPatch(ind.id, { ...o, lineWidth: clampNum(n, 1, 4) as ChartLineWidth })
                  }
                />
                <span className="shrink-0 text-[10px] font-medium text-zinc-500">px</span>
              </div>
            </label>

            {ind.kind === "bollinger" ? (
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["Superior", "colorUpper", "#71717a"],
                    ["Média", "colorMid", "#a1a1aa"],
                    ["Inferior", "colorLower", "#71717a"],
                  ] as const
                ).map(([label, field, fallback]) => (
                  <label key={field} className="flex flex-col gap-1">
                    <span className="text-[10px] text-zinc-500">{label}</span>
                    <input
                      type="color"
                      className="h-8 w-full cursor-pointer rounded border border-zinc-700/80 bg-zinc-900 p-0.5"
                      value={o?.[field] ?? fallback}
                      onChange={(e) => onPatch(ind.id, { ...o, [field]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <label className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-[11px] text-zinc-400">Cor</span>
                <input
                  type="color"
                  className="h-8 w-24 cursor-pointer rounded border border-zinc-700/80 bg-zinc-900 p-0.5"
                  value={o?.color ?? defaultEmaRsiColor(ind)}
                  onChange={(e) => onPatch(ind.id, { ...o, color: e.target.value })}
                />
              </label>
            )}

            <button
              type="button"
              className="text-[11px] font-medium text-emerald-500/90 hover:text-emerald-400"
              onClick={() => onResetStyle(ind.id)}
            >
              Restaurar estilo
            </button>
          </div>
        );
      })}
    </div>
  );
}

type SidebarProps = {
  strategy: Strategy;
  /** Chave = id do indicador no gráfico. */
  overrides: Record<string, ChartIndicatorOverride | undefined>;
  onPatch: (indicatorId: string, patch: Partial<ChartIndicatorOverride> | null) => void;
  onResetParams: (indicatorId: string) => void;
  onResetStyle: (indicatorId: string) => void;
  onClose: () => void;
};

export function ChartIndicatorSettingsSidebar({
  strategy,
  overrides,
  onPatch,
  onResetParams,
  onResetStyle,
  onClose,
}: SidebarProps) {
  const [section, setSection] = useState<"indicators" | "style">("indicators");

  return (
    <aside
      id="chart-settings-sidebar"
      role="complementary"
      aria-label="Definições do gráfico"
      className="flex h-full min-h-0 w-full min-w-0 flex-col border-l border-zinc-800/90 bg-zinc-950/98 shadow-[inset_1px_0_0_rgba(255,255,255,0.03)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800/90 px-3 py-2.5">
        <h2 className="text-sm font-semibold text-zinc-200">Definições</h2>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800/80 hover:text-zinc-200"
          aria-label="Fechar definições"
          onClick={onClose}
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Secções"
        className="flex shrink-0 gap-1 border-b border-zinc-800/90 px-2 py-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={section === "indicators"}
          className={
            "min-w-0 flex-1 rounded-lg px-2 py-2 text-center text-xs font-medium transition-colors " +
            (section === "indicators"
              ? "bg-zinc-800/90 text-zinc-100"
              : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300")
          }
          onClick={() => setSection("indicators")}
        >
          Indicadores
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "style"}
          className={
            "min-w-0 flex-1 rounded-lg px-2 py-2 text-center text-xs font-medium transition-colors " +
            (section === "style"
              ? "bg-zinc-800/90 text-zinc-100"
              : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300")
          }
          onClick={() => setSection("style")}
        >
          Estilo
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="tabpanel">
        {section === "indicators" ? (
          <IndicatorsSection
            strategy={strategy}
            overrides={overrides}
            onPatch={onPatch}
            onResetParams={onResetParams}
          />
        ) : (
          <StyleSection
            strategy={strategy}
            overrides={overrides}
            onPatch={onPatch}
            onResetStyle={onResetStyle}
          />
        )}
      </div>
    </aside>
  );
}
