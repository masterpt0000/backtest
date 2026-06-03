import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  IChartApiBase,
  ISeriesApi,
  ISeriesPrimitive,
  ITimeScaleApi,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

import type { FootprintBar } from "@/lib/chartFootprintApi";

const BUY = "rgba(34,197,94,0.72)";
const SELL = "rgba(239,68,68,0.72)";
const DELTA_POS = "rgba(34,197,94,0.95)";
const DELTA_NEG = "rgba(248,113,113,0.95)";
const TEXT = "rgba(244,244,245,0.92)";
const MUTED = "rgba(161,161,170,0.55)";

export class VolumeFootprintPrimitive implements ISeriesPrimitive {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<"Candlestick", Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _unsubs: Array<() => void> = [];
  private _barTimes: readonly number[] = [];
  private _rows: readonly FootprintBar[] = [];

  private readonly _paneView = {
    zOrder: () => "top" as const,
    renderer: () => ({
      draw: (target: CanvasRenderingTarget2D) => {
        this._draw(target);
      },
    }),
  };

  attached(param: SeriesAttachedParameter<Time, "Candlestick">): void {
    this._chart = param.chart;
    this._series = param.series;
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
    this._series = null;
    this._requestUpdate = null;
  }

  paneViews() {
    return [this._paneView];
  }

  setData(barTimesSorted: readonly number[], rows: readonly FootprintBar[]): void {
    this._barTimes = barTimesSorted;
    this._rows = rows;
    this._requestUpdate?.();
  }

  clear(): void {
    this._barTimes = [];
    this._rows = [];
    this._requestUpdate?.();
  }

  private _barWidthPx(ts: ITimeScaleApi<Time>, bars: readonly number[], idx: number, barT: number) {
    const x0 = ts.timeToCoordinate(barT as UTCTimestamp);
    if (x0 === null) return { x0: 0, w: 0 };
    const nextT = bars[idx + 1];
    let x1 = nextT !== undefined ? ts.timeToCoordinate(nextT as UTCTimestamp) : null;
    if (x1 === null) {
      const prevT = bars[idx - 1];
      const delta = prevT !== undefined ? barT - prevT : 60;
      x1 = ts.timeToCoordinate((barT + Math.max(1, delta)) as UTCTimestamp);
    }
    return { x0, w: Math.max(2, Math.abs((x1 ?? x0 + 8) - x0)) };
  }

  private _draw(target: CanvasRenderingTarget2D): void {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series || this._rows.length === 0 || this._barTimes.length === 0) return;

    let ts: ITimeScaleApi<Time>;
    try {
      ts = chart.timeScale();
    } catch {
      return;
    }

    const byT = new Map<number, FootprintBar>();
    for (const row of this._rows) byT.set(row.t, row);
    const maxTotal = Math.max(
      1,
      ...this._rows.flatMap((r) => r.levels.map((l) => Math.max(0, l.total))),
    );
    const maxDelta = Math.max(
      1,
      ...this._rows.flatMap((r) => r.levels.map((l) => Math.abs(l.delta))),
    );

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.save();
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      ctx.textBaseline = "middle";

      for (let i = 0; i < this._barTimes.length; i++) {
        const barT = this._barTimes[i]!;
        const row = byT.get(barT);
        if (!row?.levels.length) continue;
        const { x0, w } = this._barWidthPx(ts, this._barTimes, i, barT);
        if (w < 18) continue;

        const left = x0 + Math.max(1, w * 0.08);
        const cellW = Math.max(4, (w * 0.84) / 2);
        const mid = left + cellW;
        const showText = w >= 54;

        for (const lvl of row.levels) {
          const y = series.priceToCoordinate(lvl.price);
          if (y === null) continue;
          const yNext = series.priceToCoordinate(lvl.price + Math.max(lvl.price * 1e-7, 1e-9));
          const h = Math.max(3, Math.min(16, Math.abs((yNext ?? y - 8) - y) * 4));
          const top = y - h * 0.5;
          const buyRel = Math.sqrt(Math.max(0, lvl.buy) / maxTotal);
          const sellRel = Math.sqrt(Math.max(0, lvl.sell) / maxTotal);

          ctx.fillStyle = SELL;
          ctx.fillRect(mid - cellW * sellRel, top, cellW * sellRel, h);
          ctx.fillStyle = BUY;
          ctx.fillRect(mid, top, cellW * buyRel, h);

          const deltaRel = Math.min(1, Math.abs(lvl.delta) / maxDelta);
          ctx.fillStyle = lvl.delta >= 0 ? DELTA_POS : DELTA_NEG;
          ctx.fillRect(mid - 1, top, 2, h);
          ctx.globalAlpha = 0.25 + deltaRel * 0.5;
          ctx.fillRect(left, top, cellW * 2, h);
          ctx.globalAlpha = 1;

          if (showText && h >= 7) {
            ctx.fillStyle = TEXT;
            ctx.textAlign = "right";
            ctx.fillText(Math.round(lvl.sell).toString(), mid - 3, y);
            ctx.textAlign = "left";
            ctx.fillText(Math.round(lvl.buy).toString(), mid + 3, y);
          }
        }

        if (w >= 42) {
          const delta = row.levels.reduce((acc, l) => acc + l.delta, 0);
          const y0 = series.priceToCoordinate(row.levels[row.levels.length - 1]!.price);
          if (y0 !== null) {
            ctx.fillStyle = delta >= 0 ? DELTA_POS : DELTA_NEG;
            ctx.textAlign = "center";
            ctx.fillText(`Δ ${Math.round(delta)}`, x0 + w * 0.5, y0 + 12);
          }
        }
      }

      ctx.strokeStyle = MUTED;
      ctx.restore();
    });
  }
}
