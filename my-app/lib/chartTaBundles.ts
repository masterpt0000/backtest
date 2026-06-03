/**
 * Junta dados do endpoint `/api/chart/ta-series` ao formato usado pela simulação do builder
 * e pelos motores JS de paridade nas velas.
 */
import type { UTCTimestamp } from "lightweight-charts";

import type { CandleApiBar, ChartIndicatorDef } from "@/components/OhlcvChart";

export type IndicatorSeriesBundle = {
  scalar: number[];
  upper?: number[];
  mid?: number[];
  lower?: number[];
  shifted?: Record<number, Omit<IndicatorSeriesBundle, "shifted">>;
};

function nanArr(n: number): number[] {
  return new Array<number>(n).fill(NaN);
}

/** Último valor da série TA com tempo ≤ tempo da barra (igual ao HUD do gráfico). */
export function alignTaPointsBackward(
  bars: CandleApiBar[],
  pts: { time: UTCTimestamp; value: number }[],
): number[] {
  const n = bars.length;
  const out = nanArr(n);
  if (!pts.length) return out;
  const sorted = [...pts].sort((a, b) => Number(a.time) - Number(b.time));
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = bars[i]!.t;
    while (j < sorted.length && Number(sorted[j]!.time) <= t) {
      j++;
    }
    if (j > 0) out[i] = sorted[j - 1]!.value;
  }
  return out;
}

function bbTripleKeys(
  keys: string[],
): { upper: string; mid: string; lower: string } | null {
  const upper = keys.find((k) => /^upper/i.test(k));
  const mid = keys.find((k) => /(middle|mid)/i.test(k));
  const lower = keys.find((k) => /^lower/i.test(k));
  return upper && mid && lower ? { upper, mid, lower } : null;
}

export type ChartTaHudState = {
  lines: Record<string, { time: UTCTimestamp; value: number }[]>;
  macd: Record<
    string,
    {
      macd: { time: UTCTimestamp; value: number }[];
      signal: { time: UTCTimestamp; value: number }[];
      histogram: { time: UTCTimestamp; value: number }[];
    }
  >;
  talibMulti: Record<string, Record<string, { time: UTCTimestamp; value: number }[]>>;
};

/**
 * Séries escalonadas pelo comprimento das velas: uma entrada por ``def.id`` quando há dados TA.
 */
export function composeIndicatorBundlesFromTaState(
  bars: CandleApiBar[],
  defs: ChartIndicatorDef[],
  ta: ChartTaHudState | null | undefined,
): Map<string, IndicatorSeriesBundle> {
  const bundles = new Map<string, IndicatorSeriesBundle>();
  if (!bars.length || !ta) return bundles;

  for (const d of defs) {
    const id = d.id;

    if (d.kind === "sma") {
      const pts = ta.lines[id];
      if (pts?.length) bundles.set(id, { scalar: alignTaPointsBackward(bars, pts) });
      continue;
    }
    if (d.kind === "atr") {
      const pts = ta.lines[id];
      if (pts?.length) bundles.set(id, { scalar: alignTaPointsBackward(bars, pts) });
      continue;
    }
    if (d.kind === "macd") {
      const m = ta.macd[id];
      if (!m?.macd?.length) continue;
      bundles.set(id, {
        scalar: alignTaPointsBackward(bars, m.macd),
      });
      continue;
    }

    if (d.kind === "derived") {
      const pts = ta.lines[id];
      if (pts?.length) bundles.set(id, { scalar: alignTaPointsBackward(bars, pts) });
      continue;
    }

    if (d.kind === "trend_composite") {
      const pts = ta.lines[id];
      if (pts?.length) bundles.set(id, { scalar: alignTaPointsBackward(bars, pts) });
      continue;
    }

    if (d.kind !== "talib") continue;

    const fn = d.talibFunction?.trim().toUpperCase() ?? "";
    const tm = ta.macd[id];
    if ((fn === "MACD" || fn === "") && tm?.macd?.length) {
      bundles.set(id, {
        scalar: alignTaPointsBackward(bars, tm.macd),
      });
      continue;
    }

    const multi = ta.talibMulti[id];
    if (multi && Object.keys(multi).length > 0) {
      if (fn === "BBANDS") {
        const kk = bbTripleKeys(Object.keys(multi));
        if (kk) {
          const u = multi[kk.upper];
          const m = multi[kk.mid];
          const l = multi[kk.lower];
          if (u?.length && m?.length && l?.length) {
            bundles.set(id, {
              scalar: alignTaPointsBackward(bars, m),
              upper: alignTaPointsBackward(bars, u),
              mid: alignTaPointsBackward(bars, m),
              lower: alignTaPointsBackward(bars, l),
            });
            continue;
          }
        }
      }
      const fk = Object.keys(multi).sort()[0];
      const first = fk ? multi[fk] : undefined;
      if (first?.length) bundles.set(id, { scalar: alignTaPointsBackward(bars, first) });
      continue;
    }

    const pts = ta.lines[id];
    if (pts?.length) {
      bundles.set(id, { scalar: alignTaPointsBackward(bars, pts) });
    }
  }

  return bundles;
}

/** Para o painel de paridade (séries do gráfico TA vs VBT). */
export function flattenedParityArraysFromBundles(
  bars: CandleApiBar[],
  defs: ChartIndicatorDef[],
  ta: ChartTaHudState | null | undefined,
): Record<string, (number | null)[]> | null {
  const bmap = composeIndicatorBundlesFromTaState(bars, defs, ta ?? null);
  const n = bars.length;
  if (!n) return null;

  const out: Record<string, (number | null)[]> = {};
  out.close = bars.map((x) => x.c);
  const nullish = (v: number) => (!Number.isFinite(v) ? null : v);

  const rsiDef = defs.find(
    (d) => d.kind === "talib" && (d.talibFunction ?? "").trim().toUpperCase() === "RSI",
  );
  const rs = rsiDef?.id ? bmap.get(rsiDef.id)?.scalar : undefined;
  if (rs?.length === n) out.rsi = rs.map(nullish);

  const emas = defs
    .filter(
      (d) => d.kind === "talib" && (d.talibFunction ?? "").trim().toUpperCase() === "EMA",
    )
    .sort(
      (a, b) =>
        (a.talibParams?.timeperiod ?? a.period ?? 0) -
        (b.talibParams?.timeperiod ?? b.period ?? 0),
    );

  let ef = bmap.get("ema_fast")?.scalar;
  if (!ef?.length && emas[0]?.id) ef = bmap.get(emas[0]!.id)?.scalar;
  let es = bmap.get("ema_slow")?.scalar;
  if (!es?.length && emas.length >= 2 && emas[1]?.id) es = bmap.get(emas[1]!.id)?.scalar;

  if (ef?.length === n) out.ema_fast = ef.map(nullish);
  if (es?.length === n) out.ema_slow = es.map(nullish);

  const bb = defs.find(
    (d) => d.kind === "talib" && (d.talibFunction ?? "").trim().toUpperCase() === "BBANDS",
  );
  const bbB = bb?.id ? bmap.get(bb.id) : undefined;
  if (bbB?.mid?.length === n && bbB.upper?.length === n && bbB.lower?.length === n) {
    out.basis = bbB.mid.map(nullish);
    out.upper = bbB.upper.map(nullish);
    out.lower = bbB.lower.map(nullish);
  }

  return Object.keys(out).length > 1 ? out : null;
}
