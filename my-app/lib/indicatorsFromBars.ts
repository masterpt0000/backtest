import type { UTCTimestamp } from "lightweight-charts";

import type { IndicatorSource } from "@/lib/strategies";

export type OhlcBarLike = { t: number; o: number; h: number; l: number; c: number };

export type BarClose = { t: number; c: number };

export function valueAtSource(bar: OhlcBarLike, source: IndicatorSource): number {
  switch (source) {
    case "open":
      return bar.o;
    case "high":
      return bar.h;
    case "low":
      return bar.l;
    case "close":
      return bar.c;
    case "hl2":
      return (bar.h + bar.l) / 2;
    case "hlc3":
      return (bar.h + bar.l + bar.c) / 3;
    case "ohlc4":
      return (bar.o + bar.h + bar.l + bar.c) / 4;
    default:
      return bar.c;
  }
}

/** Converte velas numa série `{ time, value }` interna (campo `c` = fonte escolhida). */
export function barsAsSourceSeries(bars: OhlcBarLike[], source: IndicatorSource): BarClose[] {
  return bars.map((b) => ({ t: b.t, c: valueAtSource(b, source) }));
}

export type LinePoint = { time: UTCTimestamp; value: number };

function toTime(t: number): UTCTimestamp {
  return t as UTCTimestamp;
}

/** EMA com seed no primeiro close (adequado para séries longas). */
export function emaSeries(bars: BarClose[], period: number): LinePoint[] {
  if (bars.length === 0) return [];
  const k = 2 / (period + 1);
  const out: LinePoint[] = [];
  let e = bars[0].c;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].c;
    e = i === 0 ? c : c * k + e * (1 - k);
    out.push({ time: toTime(bars[i].t), value: e });
  }
  return out;
}

function smaAt(closes: number[], i: number, period: number): number {
  let s = 0;
  for (let j = 0; j < period; j++) s += closes[i - j];
  return s / period;
}

function stdevAt(closes: number[], i: number, period: number, mean: number): number {
  let s = 0;
  for (let j = 0; j < period; j++) {
    const d = closes[i - j] - mean;
    s += d * d;
  }
  return Math.sqrt(s / period);
}

export function bollingerSeries(
  bars: BarClose[],
  period: number,
  mult: number,
): { upper: LinePoint[]; mid: LinePoint[]; lower: LinePoint[] } {
  const upper: LinePoint[] = [];
  const mid: LinePoint[] = [];
  const lower: LinePoint[] = [];
  if (bars.length < period) {
    return { upper, mid, lower };
  }
  const closes = bars.map((b) => b.c);
  for (let i = period - 1; i < bars.length; i++) {
    const m = smaAt(closes, i, period);
    const sd = stdevAt(closes, i, period, m);
    const t = toTime(bars[i].t);
    mid.push({ time: t, value: m });
    upper.push({ time: t, value: m + mult * sd });
    lower.push({ time: t, value: m - mult * sd });
  }
  return { upper, mid, lower };
}

/** RSI tipo Wilder (14 por defeito nos params da estratégia). */
export function rsiSeries(bars: BarClose[], period: number): LinePoint[] {
  const out: LinePoint[] = [];
  if (bars.length < period + 1) return out;

  const closes = bars.map((b) => b.c);
  const rsiVals: (number | undefined)[] = new Array(bars.length);

  let avgG = 0;
  let avgL = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) avgG += ch;
    else avgL -= ch;
  }
  avgG /= period;
  avgL /= period;

  const rs0 = avgL === 0 ? 100 : avgG / avgL;
  rsiVals[period] = 100 - 100 / (1 + rs0);

  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    const rs = avgL === 0 ? 100 : avgG / avgL;
    rsiVals[i] = 100 - 100 / (1 + rs);
  }

  for (let i = period; i < bars.length; i++) {
    const v = rsiVals[i];
    if (v !== undefined) out.push({ time: toTime(bars[i].t), value: v });
  }
  return out;
}
