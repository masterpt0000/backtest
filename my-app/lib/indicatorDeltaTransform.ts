import type { UTCTimestamp } from "lightweight-charts";

/** Mínimo necessário para Δ e normalização pelo fecho */
export type DeltaBarLike = { t: number; c: number };

export type IndicatorDeltaParams = {
  deltaLookbackBars?: number;
  deltaNormalizeByPrice?: boolean;
};

export const DELTA_LOOKBACK_MAX = 500;

/** Factor applied to Δ (N barras e ÷fecho) só na apresentação — evita decimais ínfimos. */
export const INDICATOR_DELTA_DISPLAY_SCALE = 1000;

export function effectiveDeltaLookbackBars(def: IndicatorDeltaParams): number {
  const raw = def.deltaLookbackBars;
  if (raw == null || !Number.isFinite(raw)) return 0;
  const n = Math.round(Number(raw));
  if (n < 1) return 0;
  return Math.min(DELTA_LOOKBACK_MAX, n);
}

export function effectiveDeltaNormalizeByPrice(def: IndicatorDeltaParams): boolean {
  return def.deltaNormalizeByPrice !== false;
}

/** Alinha pontos `{time,value}` aos índices de ``bars`` (tempos Unix em ``t``). */
export function denseValuesByBarIndex(
  bars: DeltaBarLike[],
  lineData: { time: UTCTimestamp; value: number }[],
): (number | null)[] {
  const n = bars.length;
  const dense: (number | null)[] = new Array(n).fill(null);
  const timeToIx = new Map<number, number>();
  for (let i = 0; i < n; i++) timeToIx.set(Math.trunc(bars[i]!.t), i);
  for (const p of lineData) {
    const ti = Math.trunc(Number(p.time));
    const ix = timeToIx.get(ti);
    if (ix !== undefined && Number.isFinite(p.value)) dense[ix] = p.value;
  }
  return dense;
}

export function forwardFillSparseLineToBars(
  bars: DeltaBarLike[],
  lineData: { time: UTCTimestamp; value: number }[],
): { time: UTCTimestamp; value: number }[] {
  if (bars.length === 0 || lineData.length === 0) return [];
  const sorted = [...lineData].sort((a, b) => Number(a.time) - Number(b.time));
  let j = 0;
  let lastV: number | null = null;
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (const b of bars) {
    const bt = Number(b.t);
    while (j < sorted.length && Number(sorted[j]!.time) <= bt) {
      lastV = sorted[j]!.value;
      j++;
    }
    if (lastV != null && Number.isFinite(lastV)) {
      out.push({ time: b.t as UTCTimestamp, value: lastV });
    }
  }
  return out;
}

/**
 * Variação do indicador nas últimas ``lookback`` barras.
 * Se ``normalizeByPrice``: (v − v₋ₙ) / fecho na vela actual.
 */
export function applyIndicatorDeltaToLineData(
  bars: DeltaBarLike[],
  lineData: { time: UTCTimestamp; value: number }[],
  lookback: number,
  normalizeByPrice: boolean,
): { time: UTCTimestamp; value: number }[] {
  if (bars.length === 0 || lookback < 1) return [];
  const dense = denseValuesByBarIndex(bars, lineData);
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < lookback) continue;
    const v = dense[i];
    const v0 = dense[i - lookback];
    if (v == null || v0 == null || !Number.isFinite(v) || !Number.isFinite(v0)) continue;
    let d = v - v0;
    const c = bars[i]!.c;
    if (normalizeByPrice) {
      if (!Number.isFinite(c) || c === 0) continue;
      d /= c;
    }
    d *= INDICATOR_DELTA_DISPLAY_SCALE;
    out.push({ time: bars[i]!.t as UTCTimestamp, value: d });
  }
  return out;
}

export function maybeApplyIndicatorDeltaSeries(
  def: IndicatorDeltaParams,
  bars: DeltaBarLike[],
  lineData: { time: UTCTimestamp; value: number }[],
): { time: UTCTimestamp; value: number }[] {
  const lb = effectiveDeltaLookbackBars(def);
  if (lb < 1) return lineData;
  const filled = forwardFillSparseLineToBars(bars, lineData);
  return applyIndicatorDeltaToLineData(
    bars,
    filled,
    lb,
    effectiveDeltaNormalizeByPrice(def),
  );
}

export function deltaHistogramColor(v: number): string {
  return v >= 0 ? "rgba(74, 222, 128, 0.85)" : "rgba(248, 113, 113, 0.85)";
}

export function fmtIndicatorDeltaHud(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1) return x.toFixed(4);
  if (a >= 1e-4) return x.toFixed(6);
  return x.toExponential(3);
}

/** Sufixo curto quando a série está em modo Δ (HUD). */
export function indicatorDeltaHudSuffix(def: IndicatorDeltaParams): string {
  const lb = effectiveDeltaLookbackBars(def);
  if (lb < 1) return "";
  const n = effectiveDeltaNormalizeByPrice(def);
  return n ? ` Δ${lb}÷fecho` : ` Δ${lb}`;
}

/**
 * Valor Δ no índice ``idx`` (HUD), coerente com {@link applyIndicatorDeltaToLineData}.
 */
export function indicatorDeltaValueAtBarIndex(
  bars: DeltaBarLike[],
  dense: (number | null)[],
  idx: number,
  lookback: number,
  normalizeByPrice: boolean,
): number | undefined {
  if (
    lookback < 1 ||
    idx < lookback ||
    idx < 0 ||
    idx >= bars.length ||
    idx >= dense.length
  ) {
    return undefined;
  }
  const v = dense[idx];
  const v0 = dense[idx - lookback];
  if (v == null || v0 == null || !Number.isFinite(v) || !Number.isFinite(v0)) return undefined;
  let d = v - v0;
  const c = bars[idx]!.c;
  if (normalizeByPrice) {
    if (!Number.isFinite(c) || c === 0) return undefined;
    d /= c;
  }
  return d * INDICATOR_DELTA_DISPLAY_SCALE;
}
