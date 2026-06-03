/**
 * Primitives alinhados com a demo oficial:
 * https://github.com/deepentropy/lightweight-charts-indicators/blob/main/example/src/chart.ts
 * Licença MIT (repositório lightweight-charts-indicators).
 */
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import { LineStyle, MismatchDirection } from "lightweight-charts";
import type { MarkerData } from "lightweight-charts-indicators";

export function lciDemoGetBarWidth(
  timeScale: ReturnType<IChartApi["timeScale"]>,
  mediaWidth: number,
): number {
  const visibleRange = timeScale.getVisibleLogicalRange();
  if (!visibleRange) return 8;
  const barsCount = visibleRange.to - visibleRange.from;
  if (barsCount <= 0) return 8;
  return Math.max(1, mediaWidth / barsCount);
}

class BasePrimitive implements ISeriesPrimitive {
  protected _chart: IChartApi | null = null;
  /** Série âncora (linha ou velas); genérico evita instanciar 5 type params do ISeriesApi. */
  protected _series: ISeriesApi<"Line" | "Candlestick", Time> | null = null;
  protected _requestUpdate: (() => void) | null = null;

  attached(param: SeriesAttachedParameter): void {
    this._chart = param.chart as IChartApi;
    this._series = param.series as ISeriesApi<"Line" | "Candlestick", Time>;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }
}

/** linebr / steplinebr — segmentos quebrados em NaN (igual à demo). */
export class LineBrPrimitive extends BasePrimitive {
  private _data: Array<{ time: number; value: number }> = [];
  private _color = "#2962FF";
  private _lineWidth = 2;
  private _lineStyle = LineStyle.Solid;
  private _withSteps = false;
  private _views: IPrimitivePaneView[] = [new LineBrPaneView(this)];

  setData(
    data: Array<{ time: number; value: number }>,
    color: string,
    lineWidth = 2,
    lineStyle: LineStyle = LineStyle.Solid,
    withSteps = false,
  ): void {
    this._data = data;
    this._color = color;
    this._lineWidth = lineWidth;
    this._lineStyle = lineStyle;
    this._withSteps = withSteps;
    this._requestUpdate?.();
  }

  getData() {
    return this._data;
  }
  getColor() {
    return this._color;
  }
  getLineWidth() {
    return this._lineWidth;
  }
  getLineStyle() {
    return this._lineStyle;
  }
  getWithSteps() {
    return this._withSteps;
  }
  getChart() {
    return this._chart;
  }
  getSeries() {
    return this._series;
  }

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }
}

class LineBrPaneView implements IPrimitivePaneView {
  constructor(private _source: LineBrPrimitive) {}

  zOrder(): "normal" {
    return "normal";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new LineBrRenderer(this._source);
  }
}

class LineBrRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: LineBrPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    const series = this._source.getSeries();
    if (!chart || !series) return;

    const data = this._source.getData();
    const color = this._source.getColor();
    const lineWidth = this._source.getLineWidth();
    const lineStyle = this._source.getLineStyle();
    const withSteps = this._source.getWithSteps();
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      if (lineStyle === LineStyle.Dashed) {
        ctx.setLineDash([4, 4]);
      } else if (lineStyle === LineStyle.Dotted) {
        ctx.setLineDash([2, 2]);
      } else {
        ctx.setLineDash([]);
      }

      let drawing = false;
      let prevY = 0;

      for (const point of data) {
        const isNaN = point.value == null || Number.isNaN(point.value);

        if (isNaN) {
          if (drawing) {
            ctx.stroke();
            drawing = false;
          }
          continue;
        }

        const x = timeScale.timeToCoordinate(point.time as unknown as Time);
        const y = series.priceToCoordinate(point.value);
        if (x == null || y == null) {
          if (drawing) {
            ctx.stroke();
            drawing = false;
          }
          continue;
        }

        if (!drawing) {
          ctx.beginPath();
          ctx.moveTo(x as number, y as number);
          drawing = true;
        } else {
          if (withSteps) {
            ctx.lineTo(x as number, prevY);
          }
          ctx.lineTo(x as number, y as number);
        }
        prevY = y as number;
      }

      if (drawing) {
        ctx.stroke();
      }

      ctx.setLineDash([]);
    });
  }
}

/** Estilo Pine ``plot.style_cross`` — X no ponto (demo). */
export class CrossPlotPrimitive extends BasePrimitive {
  private _data: Array<{ time: number; value: number }> = [];
  private _color = "#2962FF";
  private _size = 6;
  private _views: IPrimitivePaneView[] = [new CrossPlotPaneView(this)];

  setData(data: Array<{ time: number; value: number }>, color: string, size = 6): void {
    this._data = data;
    this._color = color;
    this._size = size;
    this._requestUpdate?.();
  }

  getData() {
    return this._data;
  }
  getColor() {
    return this._color;
  }
  getSize() {
    return this._size;
  }
  getChart() {
    return this._chart;
  }
  getSeries() {
    return this._series;
  }

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }
}

class CrossPlotPaneView implements IPrimitivePaneView {
  constructor(private _source: CrossPlotPrimitive) {}

  zOrder(): "normal" {
    return "normal";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new CrossPlotRenderer(this._source);
  }
}

class CrossPlotRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: CrossPlotPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    const series = this._source.getSeries();
    if (!chart || !series) return;

    const data = this._source.getData();
    const color = this._source.getColor();
    const halfSize = this._source.getSize();
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      for (const point of data) {
        if (point.value == null || Number.isNaN(point.value)) continue;
        const x = timeScale.timeToCoordinate(point.time as unknown as Time);
        const y = series.priceToCoordinate(point.value);
        if (x == null || y == null) continue;

        ctx.beginPath();
        ctx.moveTo(x - halfSize, y - halfSize);
        ctx.lineTo(x + halfSize, y + halfSize);
        ctx.moveTo(x + halfSize, y - halfSize);
        ctx.lineTo(x - halfSize, y + halfSize);
        ctx.stroke();
      }
    });
  }
}

interface PlotFillBar {
  time: number;
  upper: number;
  lower: number;
}

/** Preenchimento entre duas séries (``result.fills``), como na demo. */
export class PlotFillPrimitive extends BasePrimitive {
  private _data: PlotFillBar[] = [];
  private _color = "#2962FF40";
  private _views: IPrimitivePaneView[] = [new PlotFillPaneView(this)];

  setData(data: PlotFillBar[], color: string): void {
    this._data = data;
    this._color = color;
    this._requestUpdate?.();
  }

  getData() {
    return this._data;
  }
  getColor() {
    return this._color;
  }
  getChart() {
    return this._chart;
  }
  getSeries() {
    return this._series;
  }

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }
}

class PlotFillPaneView implements IPrimitivePaneView {
  constructor(private _source: PlotFillPrimitive) {}

  zOrder(): "bottom" {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new PlotFillRenderer(this._source);
  }
}

class PlotFillRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: PlotFillPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    const series = this._source.getSeries();
    if (!chart || !series) return;

    const data = this._source.getData();
    const color = this._source.getColor();
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.fillStyle = color;
      const barWidth = lciDemoGetBarWidth(timeScale, mediaSize.width);

      for (const bar of data) {
        const x = timeScale.timeToCoordinate(bar.time as unknown as Time);
        if (x == null) continue;
        const yUpper = series.priceToCoordinate(bar.upper);
        const yLower = series.priceToCoordinate(bar.lower);
        if (yUpper == null || yLower == null) continue;

        const top = Math.min(yUpper as number, yLower as number);
        const bottom = Math.max(yUpper as number, yLower as number);
        ctx.fillRect((x as number) - barWidth / 2, top, barWidth, bottom - top);
      }
    });
  }
}

function drawExtendedShape(
  ctx: CanvasRenderingContext2D,
  shape: string,
  x: number,
  y: number,
  size: number,
): void {
  switch (shape) {
    case "triangleUp":
      ctx.beginPath();
      ctx.moveTo(x, y - size);
      ctx.lineTo(x - size, y + size);
      ctx.lineTo(x + size, y + size);
      ctx.closePath();
      ctx.fill();
      break;
    case "triangleDown":
      ctx.beginPath();
      ctx.moveTo(x, y + size);
      ctx.lineTo(x - size, y - size);
      ctx.lineTo(x + size, y - size);
      ctx.closePath();
      ctx.fill();
      break;
    case "diamond":
      ctx.beginPath();
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x, y + size);
      ctx.lineTo(x - size, y);
      ctx.closePath();
      ctx.fill();
      break;
    case "cross":
      ctx.beginPath();
      ctx.moveTo(x - size, y);
      ctx.lineTo(x + size, y);
      ctx.moveTo(x, y - size);
      ctx.lineTo(x, y + size);
      ctx.stroke();
      break;
    case "xcross":
      ctx.beginPath();
      ctx.moveTo(x - size, y - size);
      ctx.lineTo(x + size, y + size);
      ctx.moveTo(x + size, y - size);
      ctx.lineTo(x - size, y + size);
      ctx.stroke();
      break;
    case "flag":
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - size * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y - size * 2);
      ctx.lineTo(x + size * 1.5, y - size * 1.5);
      ctx.lineTo(x, y - size);
      ctx.closePath();
      ctx.fill();
      break;
    case "labelUp":
      ctx.beginPath();
      ctx.moveTo(x, y - size * 2);
      ctx.lineTo(x - size, y - size);
      ctx.lineTo(x + size, y - size);
      ctx.closePath();
      ctx.fill();
      break;
    case "labelDown":
      ctx.beginPath();
      ctx.moveTo(x, y + size * 2);
      ctx.lineTo(x - size, y + size);
      ctx.lineTo(x + size, y + size);
      ctx.closePath();
      ctx.fill();
      break;
    default:
      break;
  }
}

/** Marcadores Pine além de circle/square/arrow (labelUp, Buy, Sell, etc.). */
export class ExtendedMarkerPrimitive extends BasePrimitive {
  private _markers: MarkerData[] = [];
  private _views: IPrimitivePaneView[] = [new ExtendedMarkerPaneView(this)];

  setMarkers(markers: MarkerData[]): void {
    this._markers = markers;
    this._requestUpdate?.();
  }

  getMarkers() {
    return this._markers;
  }
  getChart() {
    return this._chart;
  }
  getSeries() {
    return this._series;
  }

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }
}

class ExtendedMarkerPaneView implements IPrimitivePaneView {
  constructor(private _source: ExtendedMarkerPrimitive) {}

  zOrder(): "normal" {
    return "normal";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new ExtendedMarkerRenderer(this._source);
  }
}

class ExtendedMarkerRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: ExtendedMarkerPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    const series = this._source.getSeries();
    if (!chart || !series) return;

    const markers = this._source.getMarkers();
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const marker of markers) {
        const x = timeScale.timeToCoordinate(marker.time as unknown as Time);
        if (x == null) continue;

        const logical = timeScale.coordinateToLogical(x as number);
        if (logical == null) continue;
        const barData = series.dataByIndex(logical, MismatchDirection.NearestLeft);
        if (!barData) continue;

        const bar = barData as {
          high?: number;
          low?: number;
          close?: number;
          value?: number;
        };
        let baseY: number | null;
        if (marker.position === "aboveBar") {
          baseY = series.priceToCoordinate(bar.high ?? bar.value ?? 0);
          if (baseY != null) baseY -= 10;
        } else if (marker.position === "belowBar") {
          baseY = series.priceToCoordinate(bar.low ?? bar.value ?? 0);
          if (baseY != null) baseY += 10;
        } else {
          baseY = series.priceToCoordinate(bar.close ?? bar.value ?? 0);
        }
        if (baseY == null) continue;

        const size = (marker.size ?? 1) * 6;
        ctx.fillStyle = marker.color;
        ctx.strokeStyle = marker.color;
        ctx.lineWidth = 2;

        drawExtendedShape(ctx, marker.shape, x, baseY, size);

        if (marker.text) {
          ctx.fillStyle = marker.color;
          ctx.font = "11px sans-serif";
          ctx.textAlign = "center";
          const textY =
            marker.position === "aboveBar" ? baseY - size - 4 : baseY + size + 12;
          ctx.fillText(marker.text, x, textY);
        }
      }
    });
  }
}
