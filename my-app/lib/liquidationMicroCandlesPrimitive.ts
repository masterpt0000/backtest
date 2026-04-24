import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  ISeriesPrimitive,
  ISeriesApi,
  IChartApiBase,
  ITimeScaleApi,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

/** Cores alinhadas com as velas principais (OhlcvChart). */
const LIQ_UP = "#26a69a";
const LIQ_DOWN = "#ef5350";
const LIQ_WICK_UP = "#378658";
const LIQ_WICK_DOWN = "#c62828";

export type LiquidationMicroCandle = {
  barT: number;
  price: number;
  contracts: number;
  /** Long liquidado → corpo tipo vela “baixa” (vermelho). */
  longLiq: boolean;
};

const MAX_ITEMS = 320;

/**
 * Liquidações como micro-velas no preço (corpo + pavio), por baixo das velas reais.
 */
export class LiquidationMicroCandlesPrimitive implements ISeriesPrimitive {
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<"Candlestick", Time> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _unsubs: Array<() => void> = [];

  private _barTimes: readonly number[] = [];
  private _items: readonly LiquidationMicroCandle[] = [];

  private readonly _paneView = {
    zOrder: () => "bottom" as const,
    renderer: () => ({
      draw: () => {
        /* tudo em drawBackground — atrás das velas */
      },
      drawBackground: (target: CanvasRenderingTarget2D) => {
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

  setItems(barTimesSorted: readonly number[], items: readonly LiquidationMicroCandle[]): void {
    this._barTimes = barTimesSorted;
    const cap = items.length > MAX_ITEMS ? items.slice(-MAX_ITEMS) : items;
    this._items = cap;
    this._requestUpdate?.();
  }

  clear(): void {
    this._items = [];
    this._barTimes = [];
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
    const w = Math.max(4, Math.abs((x1 ?? x0 + 8) - x0));
    return { x0, w };
  }

  private _draw(target: CanvasRenderingTarget2D): void {
    const chart = this._chart;
    const series = this._series;
    if (!chart || !series || this._items.length === 0 || this._barTimes.length === 0) {
      return;
    }

    const ts = chart.timeScale();
    const bars = this._barTimes;
    const tToIdx = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) {
      tToIdx.set(bars[i], i);
    }

    const byBar = new Map<number, LiquidationMicroCandle[]>();
    for (const it of this._items) {
      const arr = byBar.get(it.barT);
      if (arr) arr.push(it);
      else byBar.set(it.barT, [it]);
    }

    let maxC = 0;
    for (const it of this._items) {
      const c = Math.abs(it.contracts) || 0;
      if (c > maxC) maxC = c;
    }
    if (maxC <= 0) maxC = 1;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.globalAlpha = 0.88;

      for (const [barT, group] of byBar) {
        const idx = tToIdx.get(barT);
        if (idx === undefined) continue;

        const { x0, w } = this._barWidthPx(ts, bars, idx, barT);
        if (w <= 0) continue;

        const n = group.length;
        const maxPerBar = 10;
        const slice = n > maxPerBar ? group.slice(-maxPerBar) : group;

        slice.forEach((it, j) => {
          const px = slice.length <= 1 ? x0 + w * 0.5 : x0 + ((j + 1) / (slice.length + 1)) * w;

          const rel = Math.sqrt((Math.abs(it.contracts) || 0) / maxC);
          const bodyW = Math.max(1.5, Math.min(6.5, w * 0.2 + rel * 2.5));

          const tick = Math.max(it.price * 1.2e-4, it.price * 1e-6, 0.01);
          let oP: number;
          let cP: number;
          let hiP: number;
          let loP: number;
          if (it.longLiq) {
            oP = it.price + tick;
            cP = it.price - tick * 0.65;
            hiP = it.price + tick * 2.5;
            loP = it.price - tick * 2.5;
          } else {
            oP = it.price - tick;
            cP = it.price + tick * 0.65;
            hiP = it.price + tick * 2.5;
            loP = it.price - tick * 2.5;
          }

          const yHi = series.priceToCoordinate(hiP);
          const yLo = series.priceToCoordinate(loP);
          const yO = series.priceToCoordinate(oP);
          const yC = series.priceToCoordinate(cP);
          if (yHi === null || yLo === null || yO === null || yC === null) return;

          const wickTop = Math.min(yHi, yLo);
          const wickBot = Math.max(yHi, yLo);
          const midX = px;

          ctx.strokeStyle = it.longLiq ? LIQ_WICK_DOWN : LIQ_WICK_UP;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(midX, wickTop);
          ctx.lineTo(midX, wickBot);
          ctx.stroke();

          const bodyTop = Math.min(yO, yC);
          const bodyBot = Math.max(yO, yC);
          const bh = Math.max(2, bodyBot - bodyTop);

          ctx.fillStyle = it.longLiq ? LIQ_DOWN : LIQ_UP;
          ctx.fillRect(midX - bodyW * 0.5, bodyTop, bodyW, bh);
        });
      }

      ctx.globalAlpha = 1;
    });
  }
}
