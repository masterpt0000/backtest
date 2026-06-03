import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  ISeriesPrimitive,
  IChartApiBase,
  ITimeScaleApi,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { StrategyBarShading } from "@/lib/backtestChartLayer";

/** Filtro · fundo azul translúcido (alpha mais baixo para não tapear grelha/velas). */
const COLOR_FILTER = "rgba(37,99,235,0.05)";
/** Zona long. */
const COLOR_ZONE_LONG = "rgba(34,197,94,0.05)";
/** Zona short. */
const COLOR_ZONE_SHORT = "rgba(220,38,38,0.05)";

/**
 * Faixas verticais a toda a altura do painel de preço (atrás das velas), por vela.
 */
export class StrategyShadingBandsPrimitive implements ISeriesPrimitive {
  private _chart: IChartApiBase<Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _unsubs: Array<() => void> = [];

  private _barTimes: readonly number[] = [];
  private _rows: readonly StrategyBarShading[] = [];

  private readonly _paneView = {
    zOrder: () => "bottom" as const,
    renderer: () => ({
      draw: () => {},
      drawBackground: (target: CanvasRenderingTarget2D) => {
        this._draw(target);
      },
    }),
  };

  attached(param: SeriesAttachedParameter<Time, "Candlestick">): void {
    this._chart = param.chart;
    this._requestUpdate = param.requestUpdate;
    const ts = param.chart.timeScale();
    const r = () => param.requestUpdate();
    ts.subscribeVisibleLogicalRangeChange(r);
    ts.subscribeVisibleTimeRangeChange(r);
    this._unsubs.push(() => ts.unsubscribeVisibleLogicalRangeChange(r));
    this._unsubs.push(() => ts.unsubscribeVisibleTimeRangeChange(r));
  }

  detached(): void {
    for (const u of this._unsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this._unsubs = [];
    this._chart = null;
    this._requestUpdate = null;
  }

  paneViews() {
    return [this._paneView];
  }

  setData(barTimesSorted: readonly number[], rows: readonly StrategyBarShading[]): void {
    this._barTimes = barTimesSorted;
    this._rows = rows;
    this._requestUpdate?.();
  }

  clear(): void {
    this._barTimes = [];
    this._rows = [];
    this._requestUpdate?.();
  }

  private _barWidthPx(
    ts: ITimeScaleApi<Time>,
    bars: readonly number[],
    idx: number,
    barT: number,
  ): { x0: number; w: number } {
    const x0 = ts.timeToCoordinate(barT as UTCTimestamp);
    if (x0 === null) return { x0: 0, w: 0 };
    const nextT = bars[idx + 1];
    let x1: number | null =
      nextT !== undefined ? ts.timeToCoordinate(nextT as UTCTimestamp) : null;
    if (x1 === null) {
      const prevT = bars[idx - 1];
      const delta =
        prevT !== undefined
          ? barT - prevT
          : nextT !== undefined
            ? nextT - barT
            : 60;
      x1 = ts.timeToCoordinate((barT + Math.max(1, delta)) as UTCTimestamp);
    }
    const w = Math.max(2, Math.abs((x1 ?? x0 + 8) - x0));
    return { x0, w };
  }

  private _draw(target: CanvasRenderingTarget2D): void {
    const chart = this._chart;
    if (!chart || !this._rows.length || !this._barTimes.length) return;

    let ts: ITimeScaleApi<Time>;
    try {
      ts = chart.timeScale();
    } catch {
      return;
    }

    const bars = this._barTimes;
    const rows = this._rows;
    const n = Math.min(bars.length, rows.length);
    if (n === 0) return;

    const logical = ts.getVisibleLogicalRange();
    if (!logical) return;
    const i0 = Math.max(0, Math.floor(logical.from));
    const i1 = Math.min(n - 1, Math.ceil(logical.to));

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const H = mediaSize.height;
      const paint = (color: string, pick: (r: StrategyBarShading) => boolean) => {
        for (let i = i0; i <= i1; i++) {
          const row = rows[i];
          if (!row || !pick(row)) continue;
          const barT = bars[i]!;
          const { x0, w } = this._barWidthPx(ts, bars, i, barT);
          if (w <= 0) continue;
          ctx.fillStyle = color;
          ctx.fillRect(x0, 0, w, H);
        }
      };

      paint(COLOR_FILTER, (r) => r.filter);
      paint(COLOR_ZONE_LONG, (r) => r.zoneLong);
      paint(COLOR_ZONE_SHORT, (r) => r.zoneShort);
    });
  }
}
