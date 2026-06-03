import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { indicatorRegistry } from "lightweight-charts-indicators";
import type { AreaData, HistogramData, LineData, UTCTimestamp, WhitespaceData } from "lightweight-charts";
import { LineStyle } from "lightweight-charts";
import type { IndicatorResult, LineStyle as OakPlotLineStyle, TimeValue } from "oakscriptjs";

import type { CandleApiBar } from "@/components/OhlcvChart";
import { candleApiBarsToOakBars } from "@/lib/candleToOakBars";

export function findLciRegistryEntry(registryId: string): IndicatorRegistryEntry | undefined {
  return indicatorRegistry.find((e) => e.id === registryId);
}

/** Mescla ``defaultInputs`` do registry com overrides da UI (valores ``undefined`` ignorados). */
export function mergeLciEffectiveInputs(
  entry: IndicatorRegistryEntry,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  const base = { ...(entry.defaultInputs as Record<string, unknown>) };
  if (!overrides) return base;
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base;
}

export function runLciIndicatorWithInputs(
  entry: IndicatorRegistryEntry,
  bars: CandleApiBar[],
  inputs: Record<string, unknown>,
): IndicatorResult | null {
  try {
    const oak = candleApiBarsToOakBars(bars);
    const raw = entry.calculate(oak, inputs);
    return raw as IndicatorResult;
  } catch {
    return null;
  }
}

export function runLciIndicator(
  entry: IndicatorRegistryEntry,
  bars: CandleApiBar[],
  inputOverrides?: Record<string, unknown>,
): IndicatorResult | null {
  const inputs = mergeLciEffectiveInputs(entry, inputOverrides);
  return runLciIndicatorWithInputs(entry, bars, inputs);
}

function toUtcTime(p: TimeValue): UTCTimestamp | null {
  const tn = Number(p.time);
  if (!Number.isFinite(tn)) return null;
  return Math.trunc(tn) as UTCTimestamp;
}

/**
 * Linhas contínuas (comportamento antigo): ignora pontos inválidos — segmentos ligados.
 */
export function timeValuesToLineData(pts: TimeValue[]): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  for (const p of pts) {
    if (p == null) continue;
    const v = p.value;
    if (v == null || typeof v !== "number" || !Number.isFinite(v)) continue;
    const t = Number(p.time);
    if (!Number.isFinite(t)) continue;
    out.push({ time: t, value: v });
  }
  return out;
}

/**
 * Linha com quebras (Pine ``linebr`` / ``areabr``): ``NaN`` / ausente → whitespace no gráfico.
 */
export function timeValuesToLineWhitespaceData(
  pts: TimeValue[],
  breakOnInvalid: boolean,
): (LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] {
  const out: (LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] = [];
  for (const p of pts) {
    if (p == null) continue;
    const time = toUtcTime(p);
    if (time == null) continue;
    const v = p.value;
    const ok = v != null && typeof v === "number" && Number.isFinite(v);
    if (!ok) {
      if (breakOnInvalid) out.push({ time });
      continue;
    }
    const row: LineData<UTCTimestamp> = { time, value: v };
    if (p.color) row.color = String(p.color);
    out.push(row);
  }
  return out;
}

export function timeValuesToAreaWhitespaceData(
  pts: TimeValue[],
  breakOnInvalid: boolean,
): (AreaData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] {
  const out: (AreaData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] = [];
  for (const p of pts) {
    if (p == null) continue;
    const time = toUtcTime(p);
    if (time == null) continue;
    const v = p.value;
    const ok = v != null && typeof v === "number" && Number.isFinite(v);
    if (!ok) {
      if (breakOnInvalid) out.push({ time });
      continue;
    }
    const row: AreaData<UTCTimestamp> = { time, value: v };
    if (p.color) row.lineColor = String(p.color);
    out.push(row);
  }
  return out;
}

export function timeValuesToHistogramData(pts: TimeValue[]): { time: number; value: number; color?: string }[] {
  const out: { time: number; value: number; color?: string }[] = [];
  for (const p of pts) {
    if (p == null) continue;
    const v = p.value;
    if (v == null || typeof v !== "number" || !Number.isFinite(v)) continue;
    const t = Number(p.time);
    if (!Number.isFinite(t)) continue;
    out.push({
      time: t,
      value: v,
      ...(p.color ? { color: String(p.color) } : {}),
    });
  }
  return out;
}

export function timeValuesToHistogramWhitespaceData(
  pts: TimeValue[],
  breakOnInvalid: boolean,
): (HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] {
  const out: (HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] = [];
  for (const p of pts) {
    if (p == null) continue;
    const time = toUtcTime(p);
    if (time == null) continue;
    const v = p.value;
    const ok = v != null && typeof v === "number" && Number.isFinite(v);
    if (!ok) {
      if (breakOnInvalid) out.push({ time });
      continue;
    }
    const row: HistogramData<UTCTimestamp> = { time, value: v };
    if (p.color) row.color = String(p.color);
    out.push(row);
  }
  return out;
}

export function lciHlineToChartLineStyle(ls: OakPlotLineStyle | undefined): LineStyle {
  if (ls === "dashed") return LineStyle.Dashed;
  if (ls === "dotted") return LineStyle.Dotted;
  return LineStyle.Solid;
}
