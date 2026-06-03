/**
 * Lógica espelhada da demo ``example/src/indicator-ui.ts`` (routing de plots e fills).
 */
import type { FillConfig, FillData, HLineConfig, PlotConfig, TimeValue } from "oakscriptjs";
import type { Time, UTCTimestamp } from "lightweight-charts";
import type { SeriesMarker } from "lightweight-charts";
import type { MarkerData } from "lightweight-charts-indicators";
import type { IChartApi, ISeriesApi, ISeriesPrimitive, LineData } from "lightweight-charts";
import { BaselineSeries, LineSeries, LineStyle } from "lightweight-charts";
import type { BaselineData } from "lightweight-charts";

import { PlotFillPrimitive } from "@/lib/lciDemoPrimitives";

const BUILTIN_MARKER_SHAPES = new Set(["arrowUp", "arrowDown", "circle", "square"]);

export type ExtendedLciResult = {
  plots: Record<string, TimeValue[]>;
  hlines?: { value: number; options?: { color?: string; linestyle?: string; linewidth?: number; title?: string } }[];
  fills?: FillData[];
  markers?: MarkerData[];
  visibility?: Record<string, boolean>;
};

export function evaluateLciPlotVisible(
  plotDef: PlotConfig,
  result: ExtendedLciResult,
  inputs: Record<string, unknown>,
): boolean {
  if (plotDef.display === "none") return false;
  if (plotDef.visible === undefined) return true;
  if (typeof plotDef.visible === "boolean") return plotDef.visible;
  if (typeof plotDef.visible === "string") {
    const visibleVar = plotDef.visible;
    if (inputs[visibleVar] !== undefined) return Boolean(inputs[visibleVar]);
    if (result.visibility && result.visibility[visibleVar] !== undefined) {
      return Boolean(result.visibility[visibleVar]);
    }
    const plotData = result.plots[plotDef.id];
    if (plotData && Array.isArray(plotData)) {
      return plotData.some(
        (p: TimeValue) =>
          p?.value !== undefined && p?.value !== null && !Number.isNaN(Number(p.value)),
      );
    }
  }
  return true;
}

export function timeValuesToLineBrRaw(pts: TimeValue[]): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  for (const p of pts) {
    if (p == null) continue;
    const t = Number(p.time);
    if (!Number.isFinite(t)) continue;
    const v = p.value;
    if (v == null || typeof v !== "number" || !Number.isFinite(v)) {
      out.push({ time: t, value: NaN });
    } else {
      out.push({ time: t, value: v });
    }
  }
  return out;
}

export function splitLciMarkers(markers: MarkerData[]): {
  builtin: SeriesMarker<Time>[];
  extended: MarkerData[];
} {
  const builtin: SeriesMarker<Time>[] = [];
  const extended: MarkerData[] = [];
  for (const m of markers) {
    if (BUILTIN_MARKER_SHAPES.has(m.shape)) {
      builtin.push({
        time: m.time as unknown as Time,
        position: m.position,
        shape: m.shape as "arrowUp" | "arrowDown" | "circle" | "square",
        color: m.color,
        text: m.text ?? "",
        size: m.size,
      });
    } else {
      extended.push(m);
    }
  }
  return { builtin, extended };
}

export function resolvePlotFillRgba(fill: FillData): string {
  const o = fill.options;
  if (!o?.color) return "#2962FF40";
  if (o.transp != null) {
    const alpha = Math.round((1 - o.transp / 100) * 255);
    return o.color + alpha.toString(16).padStart(2, "0");
  }
  return o.color.length === 7 ? o.color + "40" : o.color;
}

export function buildPlotFillBars(
  fill: FillData,
  plotData: Record<string, TimeValue[]>,
): Array<{ time: number; upper: number; lower: number }> {
  const p1Data = plotData[fill.plot1];
  const p2Data = plotData[fill.plot2];
  if (!p1Data?.length || !p2Data?.length) return [];
  const p2Map = new Map(p2Data.map((d) => [d.time, d.value]));
  const fillBars: Array<{ time: number; upper: number; lower: number }> = [];
  for (const d1 of p1Data) {
    const v1 = d1.value;
    const v2 = p2Map.get(d1.time);
    if (
      v1 == null ||
      v2 == null ||
      typeof v1 !== "number" ||
      typeof v2 !== "number" ||
      Number.isNaN(v1) ||
      Number.isNaN(v2)
    ) {
      continue;
    }
    fillBars.push({
      time: Number(d1.time),
      upper: Math.max(v1, v2),
      lower: Math.min(v1, v2),
    });
  }
  return fillBars;
}

export function attachPlotFillPrimitive(
  chart: IChartApi,
  paneIndex: number,
  fillBars: Array<{ time: number; upper: number; lower: number }>,
  fillColor: string,
): () => void {
  const anchor = chart.addSeries(LineSeries, {
    color: "transparent",
    lineVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  });
  anchor.moveToPane(paneIndex);
  anchor.setData(
    fillBars.map((b) => ({
      time: b.time as UTCTimestamp,
      value: b.upper,
    })) as LineData<UTCTimestamp>[],
  );
  const primitive = new PlotFillPrimitive();
  primitive.setData(fillBars, fillColor);
  anchor.attachPrimitive(primitive as ISeriesPrimitive);
  return () => {
    try {
      anchor.detachPrimitive(primitive as ISeriesPrimitive);
    } catch {
      /* ignore */
    }
    try {
      chart.removeSeries(anchor);
    } catch {
      /* ignore */
    }
  };
}

/** Hlines estáticos do registry + bandas entre preços (Baseline), como ``setHLines`` / ``setFills`` da demo. */
export function attachRegistryHlinesAndFills(
  chart: IChartApi,
  paneIndex: number,
  hlines: HLineConfig[],
  fills: FillConfig[] | undefined,
  firstTime: Time,
  lastTime: Time,
): () => void {
  const seriesToRemove: ISeriesApi<"Line" | "Baseline", Time>[] = [];
  const lineStyleMap: Record<string, LineStyle> = {
    solid: LineStyle.Solid,
    dashed: LineStyle.Dashed,
    dotted: LineStyle.Dotted,
  };

  const hlineMap = new Map(hlines.map((h) => [h.id, h.price]));

  for (const hline of hlines) {
    const ser = chart.addSeries(LineSeries, {
      color: hline.color ?? "#787B86",
      lineWidth: (hline.linewidth ?? 1) as 1 | 2 | 3 | 4,
      lineStyle: lineStyleMap[hline.linestyle ?? "solid"] ?? LineStyle.Solid,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    ser.moveToPane(paneIndex);
    ser.setData([
      { time: firstTime, value: hline.price },
      { time: lastTime, value: hline.price },
    ] as LineData<Time>[]);
    seriesToRemove.push(ser);
  }

  for (const fill of fills ?? []) {
    const price1 = hlineMap.get(fill.plot1);
    const price2 = hlineMap.get(fill.plot2);
    if (price1 == null || price2 == null) continue;

    const upperPrice = Math.max(price1, price2);
    const lowerPrice = Math.min(price1, price2);
    const color = fill.color ?? "rgba(41,98,255,0.1)";

    const ser = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: lowerPrice },
      topFillColor1: color,
      topFillColor2: color,
      bottomFillColor1: "transparent",
      bottomFillColor2: "transparent",
      topLineColor: "transparent",
      bottomLineColor: "transparent",
      lineVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    ser.moveToPane(paneIndex);
    ser.setData([
      { time: firstTime, value: upperPrice },
      { time: lastTime, value: upperPrice },
    ] as BaselineData<Time>[]);
    seriesToRemove.push(ser);
  }

  return () => {
    for (const s of seriesToRemove) {
      try {
        chart.removeSeries(s);
      } catch {
        /* ignore */
      }
    }
  };
}
