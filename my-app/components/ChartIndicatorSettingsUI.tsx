"use client";

import {
  effectiveLineWidth,
  effectiveMacdFast,
  effectiveMacdSignal,
  effectiveMacdSlow,
  effectiveMult,
  effectivePeriod,
  effectiveIndicatorTimeframe,
  effectiveSource,
  type ChartIndicatorOverride,
  type ChartLineWidth,
} from "@/lib/chartIndicatorSettings";
import { defaultRsiLineColor } from "@/lib/indicatorLineColors";
import {
  INDICATOR_SOURCES,
  INDICATOR_TIMEFRAMES,
  normalizeTrendCompositeParams,
  type IndicatorSource,
  type IndicatorTimeframe,
  type Strategy,
  type StrategyIndicator,
  type TrendCompositeParams,
  type TrendCompositePreset,
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

const TIMEFRAME_LABELS: Record<IndicatorTimeframe, string> = {
  chart: "Timeframe do gráfico",
  "1m": "1 minuto",
  "3m": "3 minutos",
  "5m": "5 minutos",
  "15m": "15 minutos",
  "30m": "30 minutos",
  "1h": "1 hora",
  "4h": "4 horas",
  "1d": "1 dia",
};

function defaultEmaRsiColor(ind: StrategyIndicator): string {
  if (ind.kind === "sma") return "#c4b5fd";
  if (ind.kind === "atr") return "#fb923c";
  if (ind.kind === "macd") return "#22d3ee";
  if (ind.kind === "trend_composite") return "#10b981";
  if (ind.kind === "talib") {
    const fn = (ind.params?.talibFunction ?? "").trim().toUpperCase();
    if (fn === "RSI") return defaultRsiLineColor(ind.id);
    if (fn === "EMA") {
      if (ind.id === "ema8") return "#f59e0b";
      if (ind.id === "ema21") return "#38bdf8";
      return "#94a3b8";
    }
  }
  return "#a78bfa";
}

function isTalibFunction(ind: StrategyIndicator, name: string): boolean {
  return (
    ind.kind === "talib" &&
    (ind.params?.talibFunction ?? "").trim().toUpperCase() === name.toUpperCase()
  );
}

const TREND_PRESET_OPTIONS: { value: TrendCompositePreset; label: string }[] = [
  { value: "price_vs_sma_atr", label: "Preço vs SMA / ATR" },
  { value: "macd_hist_zscore", label: "MACD histograma" },
  { value: "rsi_zscore", label: "RSI" },
  { value: "plus_di_minus_di", label: "+DI − −DI" },
];

function trendWeightSum(components: { weight: number }[]): number {
  return components.reduce((a, c) => a + (Number.isFinite(c.weight) ? c.weight : 0), 0);
}

function TrendCompositeParamsEditor({
  ind,
  effectiveTc,
  onCommit,
}: {
  ind: StrategyIndicator;
  /** Valor mostrado: fundido com overrides quando o indicador vem da estratégia. */
  effectiveTc: TrendCompositeParams;
  onCommit: (tc: TrendCompositeParams) => void;
}) {
  if (ind.kind !== "trend_composite") return null;
  const tc = normalizeTrendCompositeParams(effectiveTc);
  const sumW = trendWeightSum(tc.components);

  const pushTc = (next: TrendCompositeParams) => {
    onCommit(normalizeTrendCompositeParams(next));
  };

  return (
    <div className="space-y-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-2 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Score composto</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1" htmlFor={`tc-nw-${ind.id}`}>
          <span className="text-[10px] text-zinc-500">Janela z-score</span>
          <NumericStepper
            id={`tc-nw-${ind.id}`}
            rootClassName="min-w-0"
            value={tc.normWindow}
            min={5}
            max={500}
            step={1}
            decimals={0}
            decrementLabel="Menos barras na normalização"
            incrementLabel="Mais barras na normalização"
            onCommit={(n) => pushTc({ ...tc, normWindow: n })}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1" htmlFor={`tc-clip-${ind.id}`}>
          <span className="text-[10px] text-zinc-500">Clip tanh</span>
          <NumericStepper
            id={`tc-clip-${ind.id}`}
            rootClassName="min-w-0"
            value={tc.clip}
            min={0.25}
            max={12}
            step={0.25}
            decimals={2}
            decrementLabel="Menos clip"
            incrementLabel="Mais clip"
            onCommit={(n) => pushTc({ ...tc, clip: n })}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 col-span-2" htmlFor={`tc-scale-${ind.id}`}>
          <span className="text-[10px] text-zinc-500">Escala saída (±)</span>
          <NumericStepper
            id={`tc-scale-${ind.id}`}
            rootClassName="min-w-0"
            value={tc.outputScale}
            min={1}
            max={500}
            step={1}
            decimals={0}
            decrementLabel="Menor escala"
            incrementLabel="Maior escala"
            onCommit={(n) => pushTc({ ...tc, outputScale: n })}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] tabular-nums text-zinc-400">Soma pesos: {sumW.toFixed(1)}%</span>
        <button
          type="button"
          className="rounded-md border border-zinc-600/80 bg-zinc-800/80 px-2 py-1 text-[10px] font-medium text-zinc-200 hover:border-emerald-600/50 hover:text-emerald-200"
          onClick={() => {
            if (sumW <= 0) return;
            pushTc({
              ...tc,
              components: tc.components.map((c) => ({
                ...c,
                weight: (100 * c.weight) / sumW,
              })),
            });
          }}
        >
          Normalizar para 100%
        </button>
      </div>
      <ul className="max-h-48 space-y-2 overflow-y-auto pr-0.5">
        {tc.components.map((c, idx) => (
          <li key={`${ind.id}-${c.cid}-${idx}`} className="rounded border border-zinc-800/60 bg-zinc-950/40 p-2">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-10 shrink-0 text-[10px] font-medium text-zinc-500">{c.cid}</span>
                <select
                  className="h-8 min-w-0 flex-1 cursor-pointer rounded-lg border border-zinc-700/85 bg-zinc-900/90 px-2 text-[11px] text-zinc-100"
                  value={c.preset}
                  aria-label={`Preset ${c.cid}`}
                  onChange={(e) => {
                    const next = [...tc.components];
                    next[idx] = { ...c, preset: e.target.value as TrendCompositePreset };
                    pushTc({ ...tc, components: next });
                  }}
                >
                  {TREND_PRESET_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <span className="text-[10px] text-zinc-500">Peso %</span>
                <div className="min-w-[5.5rem] flex-1">
                  <NumericStepper
                    rootClassName="w-full"
                    value={c.weight}
                    min={0}
                    max={100}
                    step={1}
                    decimals={0}
                    decrementLabel="Menos peso"
                    incrementLabel="Mais peso"
                    onCommit={(n) => {
                      const next = [...tc.components];
                      next[idx] = { ...c, weight: n };
                      pushTc({ ...tc, components: next });
                    }}
                  />
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IndicatorsSection({
  strategy,
  overrides,
  onPatch,
  onResetParams,
  onTrendCompositeChange,
}: {
  strategy: Strategy;
  overrides: Record<string, ChartIndicatorOverride | undefined>;
  onPatch: (indicatorId: string, patch: Partial<ChartIndicatorOverride> | null) => void;
  onResetParams: (indicatorId: string) => void;
  onTrendCompositeChange: (indicatorId: string, tc: TrendCompositeParams) => void;
}) {
  return (
    <div className="space-y-1 px-3 pb-4 pt-2">
      <p className="mb-3 text-[11px] leading-snug text-zinc-500">
        Período, fonte OHLC e parâmetros TA-Lib quando o indicador o suporta. Indicadores vêm sempre do servidor
        (pandas / TA-Lib).
      </p>
      {strategy.indicators.map((ind) => {
        const o = overrides[ind.id];
        const period = effectivePeriod(ind, o);
        const mult = effectiveMult(ind, o);
        const source = effectiveSource(ind, o);
        const timeframe = effectiveIndicatorTimeframe(ind, o);
        const macdFast = effectiveMacdFast(ind, o);
        const macdSlow = effectiveMacdSlow(ind, o);
        const macdSig = effectiveMacdSignal(ind, o);
        const deltaLookbackBars = o?.deltaLookbackBars ?? ind.params?.deltaLookbackBars ?? 0;
        const deltaNormalizeByPrice =
          o?.deltaNormalizeByPrice ?? ind.params?.deltaNormalizeByPrice ?? true;
        return (
          <div
            key={ind.id}
            className="space-y-2 border-b border-zinc-800/80 py-3 last:border-b-0 last:pb-0 first:pt-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium text-zinc-200">{ind.label}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">{ind.kind}</span>
            </div>
            {ind.kind !== "trend_composite" ? (
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
            ) : null}
            <label className="flex items-center gap-2" htmlFor={`chart-set-${ind.id}-timeframe`}>
              <span className="w-20 shrink-0 text-[11px] text-zinc-400">Timeframe</span>
              <select
                id={`chart-set-${ind.id}-timeframe`}
                className="h-8 min-w-0 flex-1 cursor-pointer rounded-lg border border-zinc-700/85 bg-zinc-900/90 px-2 text-xs font-medium text-zinc-100 shadow-inner shadow-black/20 transition-colors hover:border-zinc-600 focus:border-emerald-600/55 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
                value={timeframe}
                onChange={(e) =>
                  onPatch(ind.id, { ...o, timeframe: e.target.value as IndicatorTimeframe })
                }
              >
                {INDICATOR_TIMEFRAMES.map((tf) => (
                  <option key={tf} value={tf}>
                    {TIMEFRAME_LABELS[tf]}
                  </option>
                ))}
              </select>
            </label>
            {ind.kind === "trend_composite" ? (
              <TrendCompositeParamsEditor
                ind={ind}
                effectiveTc={normalizeTrendCompositeParams(
                  o?.trendComposite !== undefined ? o.trendComposite : ind.params?.trendComposite,
                )}
                onCommit={(tc) => onTrendCompositeChange(ind.id, tc)}
              />
            ) : ind.kind === "macd" ? (
              <>
                <label className="flex items-center gap-2" htmlFor={`chart-set-${ind.id}-fast`}>
                  <span className="w-20 shrink-0 text-[11px] text-zinc-400">Fast</span>
                  <NumericStepper
                    id={`chart-set-${ind.id}-fast`}
                    rootClassName="flex-1"
                    value={macdFast}
                    min={1}
                    max={200}
                    step={1}
                    decimals={0}
                    decrementLabel="Diminuir fast"
                    incrementLabel="Aumentar fast"
                    onCommit={(n) => onPatch(ind.id, { ...o, fast: n })}
                  />
                </label>
                <label className="flex items-center gap-2" htmlFor={`chart-set-${ind.id}-slow`}>
                  <span className="w-20 shrink-0 text-[11px] text-zinc-400">Slow</span>
                  <NumericStepper
                    id={`chart-set-${ind.id}-slow`}
                    rootClassName="flex-1"
                    value={macdSlow}
                    min={1}
                    max={500}
                    step={1}
                    decimals={0}
                    decrementLabel="Diminuir slow"
                    incrementLabel="Aumentar slow"
                    onCommit={(n) => onPatch(ind.id, { ...o, slow: n })}
                  />
                </label>
                <label className="flex items-center gap-2" htmlFor={`chart-set-${ind.id}-sig`}>
                  <span className="w-20 shrink-0 text-[11px] text-zinc-400">Signal</span>
                  <NumericStepper
                    id={`chart-set-${ind.id}-sig`}
                    rootClassName="flex-1"
                    value={macdSig}
                    min={1}
                    max={200}
                    step={1}
                    decimals={0}
                    decrementLabel="Diminuir signal"
                    incrementLabel="Aumentar signal"
                    onCommit={(n) => onPatch(ind.id, { ...o, signal: n })}
                  />
                </label>
              </>
            ) : (
              <label className="flex items-center gap-2" htmlFor={`chart-set-${ind.id}-period`}>
                <span className="w-20 shrink-0 text-[11px] text-zinc-400">Período</span>
                <NumericStepper
                  id={`chart-set-${ind.id}-period`}
                  rootClassName="flex-1"
                  value={period}
                  min={isTalibFunction(ind, "RSI") ? 2 : 1}
                  max={500}
                  step={1}
                  decimals={0}
                  decrementLabel="Diminuir período"
                  incrementLabel="Aumentar período"
                  onCommit={(n) =>
                    ind.kind === "talib"
                      ? onPatch(ind.id, {
                          ...o,
                          period: n,
                          talibParams: {
                            ...(ind.params?.talibParams ?? {}),
                            ...(o?.talibParams ?? {}),
                            timeperiod: n,
                          },
                        })
                      : onPatch(ind.id, { ...o, period: n })
                  }
                />
              </label>
            )}
            {isTalibFunction(ind, "BBANDS") ? (
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
                  onCommit={(n) =>
                    onPatch(ind.id, {
                      ...o,
                      mult: n,
                      talibParams: {
                        ...(ind.params?.talibParams ?? {}),
                        ...(o?.talibParams ?? {}),
                        nbdevup: n,
                        nbdevdn: n,
                      },
                    })
                  }
                />
              </label>
            ) : null}
            <div className="space-y-2 border-t border-zinc-800/65 pt-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-600">
                Variação (Δ versus N barras)
              </p>
              <label className="flex items-center gap-2" htmlFor={`chart-set-${ind.id}-delta`}>
                <span className="w-20 shrink-0 text-[11px] text-zinc-400">Δ barras</span>
                <NumericStepper
                  id={`chart-set-${ind.id}-delta`}
                  rootClassName="flex-1"
                  value={deltaLookbackBars}
                  min={0}
                  max={120}
                  step={1}
                  decimals={0}
                  decrementLabel="Menos barras no Δ"
                  incrementLabel="Mais barras no Δ"
                  onCommit={(n) => onPatch(ind.id, { ...o, deltaLookbackBars: Math.max(0, n) })}
                />
              </label>
              <label className="flex cursor-pointer flex-wrap items-center gap-2" htmlFor={`chart-set-${ind.id}-delta-norm`}>
                <span className="w-20 shrink-0 text-[11px] text-zinc-400">÷ fecho</span>
                <input
                  id={`chart-set-${ind.id}-delta-norm`}
                  type="checkbox"
                  disabled={deltaLookbackBars < 1}
                  className="h-4 w-4 shrink-0 cursor-pointer rounded border-zinc-600 bg-zinc-900 accent-emerald-600 disabled:pointer-events-none disabled:opacity-40"
                  checked={deltaNormalizeByPrice !== false}
                  onChange={(e) =>
                    onPatch(ind.id, { ...o, deltaNormalizeByPrice: e.target.checked })
                  }
                />
                <span
                  className={
                    "text-[11px] text-zinc-500 " +
                    (deltaLookbackBars < 1 ? "opacity-50" : "")
                  }
                >
                  Dividir Δ pelo fecho na vela (escala compatível entre activos)
                </span>
              </label>
            </div>
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

            {isTalibFunction(ind, "BBANDS") ? (
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
  onTrendCompositeChange: (indicatorId: string, tc: TrendCompositeParams) => void;
  onClose: () => void;
};

export function ChartIndicatorSettingsSidebar({
  strategy,
  overrides,
  onPatch,
  onResetParams,
  onResetStyle,
  onTrendCompositeChange,
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
            onTrendCompositeChange={onTrendCompositeChange}
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
