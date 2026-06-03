import type { Bar } from "oakscriptjs";

import type { CandleApiBar } from "@/components/OhlcvChart";

/** Velas únicas por tempo, ordenadas — formato esperado pelos indicadores OakScript / LCI. */
export function candleApiBarsToOakBars(bars: CandleApiBar[]): Bar[] {
  const m = new Map<number, CandleApiBar>();
  for (const b of bars) {
    const t = Math.trunc(Number(b.t));
    if (!Number.isFinite(t)) continue;
    m.set(t, { ...b, t });
  }
  return [...m.keys()]
    .sort((a, b) => a - b)
    .map((k) => {
      const b = m.get(k)!;
      return {
        time: b.t,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v ?? 0,
      };
    });
}
