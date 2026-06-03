import type { CandleApiBar } from "@/components/OhlcvChart";

export type FootprintLevel = {
  price: number;
  buy: number;
  sell: number;
  delta: number;
  total: number;
};

export type FootprintBar = {
  t: number;
  levels: FootprintLevel[];
};

export type FootprintResponse = {
  compute_ms: number;
  price_step: number;
  bars: FootprintBar[];
  ticks_used?: number;
  truncated?: boolean;
};

function isFootprintLevel(x: unknown): x is FootprintLevel {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.price === "number" &&
    typeof o.buy === "number" &&
    typeof o.sell === "number" &&
    typeof o.delta === "number" &&
    typeof o.total === "number"
  );
}

export function parseFootprintResponse(raw: unknown): FootprintResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.compute_ms !== "number" || typeof o.price_step !== "number") return null;
  if (!Array.isArray(o.bars)) return null;
  const bars: FootprintBar[] = [];
  for (const b of o.bars) {
    if (!b || typeof b !== "object") continue;
    const bo = b as Record<string, unknown>;
    if (typeof bo.t !== "number" || !Array.isArray(bo.levels)) continue;
    const levels = bo.levels.filter(isFootprintLevel);
    if (levels.length) bars.push({ t: bo.t, levels });
  }
  return {
    compute_ms: o.compute_ms,
    price_step: o.price_step,
    bars,
    ...(typeof o.ticks_used === "number" ? { ticks_used: o.ticks_used } : {}),
    ...(typeof o.truncated === "boolean" ? { truncated: o.truncated } : {}),
  };
}

export function footprintRequestBars(bars: CandleApiBar[], maxBars = 5_000): CandleApiBar[] {
  return bars.slice(-maxBars);
}
