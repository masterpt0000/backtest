/**
 * Cache em memória de facetas QuestDB (`feat_*`) por grelha **1× minuto**, com agregação
 * cliente para barras de timeframe superior — evita novo round-trip quando mudas só o TF
 * desde que o alcance temporal coberto pelos mesmos minutos já tenha sido carregado.
 */
import type { CandleApiBar } from "@/components/OhlcvChart";

/** Alinhado ao teto Python `ratio_cap`. */
const RATIO_CAP = 1_000_000;

const IDS_SUM = [
  "feat_liq_long",
  "feat_liq_short",
  "feat_tick_buy_vol",
  "feat_tick_sell_vol",
] as const;

/** Alinhado ao default backend ``CHART_TA_1M_BAR_LIMIT`` / carga de feat em 1m. */
const MAX_1M_BARS_API = 50_000;
const LRU_1M = 24;
const LRU_EXACT = 32;

/** Evita repetir tipo em stub de minuto vs import circular — mesmo shape que ChartPage usa. */
type Bar = CandleApiBar;

export function medianBarSpacingSec(bars: Bar[]): number {
  if (bars.length < 2) return 300;
  const d: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    d.push(bars[i]!.t - bars[i - 1]!.t);
  }
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)] ?? 300;
}

function barsTimeFingerprint(symbolId: number, bars: Bar[]): string {
  if (bars.length === 0) return `${symbolId}:0`;
  let h = 2166136261;
  const step = Math.max(1, Math.floor(bars.length / 48));
  for (let i = 0; i < bars.length; i += step) {
    const t = Math.trunc(Number(bars[i]!.t)) | 0;
    h ^= t;
    h = Math.imul(h, 16777619);
  }
  const first = bars[0]!.t;
  const last = bars[bars.length - 1]!.t;
  return `${symbolId}:${bars.length}:${first}:${last}:${h >>> 0}`;
}

type Entry1m = {
  minuteOpenTimes: readonly number[];
  features: Record<string, number[]>;
};

const cache1m = new Map<string, Entry1m>();
const cacheExact = new Map<string, Record<string, number[]>>();

function lruTrim<K, V>(m: Map<K, V>, max: number) {
  while (m.size > max) {
    const k = m.keys().next().value as K | undefined;
    if (k === undefined) break;
    m.delete(k);
  }
}

function lruTouch<K, V>(m: Map<K, V>, k: K, v: V) {
  m.delete(k);
  m.set(k, v);
}

export function feat1mCacheKey(symbolId: number, minuteOpens: readonly number[]): string | null {
  if (minuteOpens.length === 0) return null;
  return `${symbolId}:${minuteOpens[0]}:${minuteOpens.length}:${minuteOpens[minuteOpens.length - 1]}`;
}

export function getCachedFeat1m(key: string): Entry1m | undefined {
  const v = cache1m.get(key);
  if (v === undefined) return undefined;
  lruTouch(cache1m, key, v);
  return v;
}

export function setCachedFeat1m(key: string, entry: Entry1m): void {
  cache1m.delete(key);
  cache1m.set(key, entry);
  lruTrim(cache1m, LRU_1M);
}

export function getCachedFeatExact(
  symbolId: number,
  bars: Bar[],
): Record<string, number[]> | undefined {
  const fk = barsTimeFingerprint(symbolId, bars);
  const v = cacheExact.get(fk);
  if (v === undefined || !featBundlesMatchBarsLength(bars.length, v)) return undefined;
  lruTouch(cacheExact, fk, v);
  return v;
}

export function setCachedFeatExact(symbolId: number, bars: Bar[], features: Record<string, number[]>): void {
  const fk = barsTimeFingerprint(symbolId, bars);
  cacheExact.delete(fk);
  cacheExact.set(fk, features);
  lruTrim(cacheExact, LRU_EXACT);
}

/** Resolve se um payload de facetas já está alinhado ao número de velas pedido. */
export function featBundlesMatchBarsLength(
  barsLength: number,
  features: Record<string, number[]> | undefined,
): boolean {
  if (!features || barsLength === 0) return false;
  const cand =
    features.feat_tick_buy_vol ?? features.feat_liq_long ?? Object.values(features).find(Array.isArray);
  return Array.isArray(cand) && cand.length === barsLength;
}

/**
 * Opens de vela por minuto (alinhamento 60 s) até cobrir `[t primeiro, último + spacing)`, com teto.
 */
export function buildMinuteOpensForFeatBase(
  bars: Bar[],
  spacingSec: number,
): { opens: number[]; stubBars: Bar[] } {
  if (bars.length === 0) return { opens: [], stubBars: [] };
  const start = Math.floor(bars[0]!.t / 60) * 60;
  const endExclusive = bars[bars.length - 1]!.t + Math.max(spacingSec, 60);
  const opens: number[] = [];
  for (let t = start; t < endExclusive && opens.length < MAX_1M_BARS_API; t += 60) {
    opens.push(t);
  }
  /** Se o intervalo for gigante (meses em 5m já truncado antes), ficamos com os últimos N minutos. */
  let slice = opens;
  if (opens.length >= MAX_1M_BARS_API) {
    slice = opens.slice(-MAX_1M_BARS_API);
  }
  const stubBars = slice.map((t): Bar => ({ t, o: 0, h: 0, l: 0, c: 0, v: 0 }));
  return { opens: slice, stubBars };
}

/** Usar base 1m + agregação em vez de POST directo só para TF estritamente > 1m. */
export function shouldUseOneMinuteFeatBase(timeframeLabel: string, barsLength: number): boolean {
  if (timeframeLabel === "1m" || barsLength < 2) return false;
  return true;
}

function tickDerived(b: number, s: number): { ratio: number; imb: number } {
  let ratio = 0;
  let imb = 0;
  if (s <= 1e-14) {
    ratio = b > 1e-14 ? RATIO_CAP : 0;
  } else {
    ratio = Math.min(b / s, RATIO_CAP);
  }
  const tot = b + s;
  if (tot > 1e-14) imb = (b - s) / tot;
  return { ratio, imb };
}

/** Agrega arrays 1× minuto para o comprimento e janelas de `bars`. */
export function aggregateFeat1mFeaturesToBars(
  featuresByKey: Record<string, number[]>,
  minuteOpens: readonly number[],
  bars: Bar[],
  spacingFallback: number,
): Record<string, number[]> {
  const nM = minuteOpens.length;
  const nB = bars.length;
  if (nM === 0 || nB === 0) return {};

  const get = (id: string, j: number) => {
    const a = featuresByKey[id];
    if (!Array.isArray(a) || j < 0 || j >= a.length) return 0;
    const x = Number(a[j]);
    return Number.isFinite(x) ? x : 0;
  };

  const SNAP_LAST_IDS = [
    "feat_oi_snap",
    "feat_mark_px",
    "feat_index_px",
    "feat_funding_rate",
    "feat_ob_imb_snap",
  ] as const;

  const spacing = spacingFallback > 0 ? spacingFallback : 60;
  const out: Record<string, number[]> = {};

  IDS_SUM.forEach((id) => {
    out[id] = new Array<number>(nB).fill(0);
  });

  const spreadNumer = new Array<number>(nB).fill(0);
  const spreadDen = new Array<number>(nB).fill(0);

  SNAP_LAST_IDS.forEach((id) => {
    out[id] = new Array<number>(nB).fill(0);
  });
  out["feat_ob_spread_avg"] = new Array<number>(nB).fill(0);

  for (let bi = 0; bi < nB; bi++) {
    const tLo = bars[bi]!.t;
    const tHi =
      bi + 1 < nB ? bars[bi + 1]!.t : bars[bi]!.t + spacing;

    /** Último minuto que cai em [tLo,tHi) sobrescreve snaps (lista por tempo ascendente). */
    for (let mj = 0; mj < nM; mj++) {
      const mt = minuteOpens[mj]!;
      if (mt < tLo || mt >= tHi) continue;

      for (const sid of IDS_SUM) {
        out[sid]![bi] += get(sid, mj);
      }
      spreadNumer[bi] += get("feat_ob_spread_avg", mj);
      spreadDen[bi]++;
      for (const skid of SNAP_LAST_IDS) {
        out[skid]![bi] = get(skid, mj);
      }
    }

    out["feat_ob_spread_avg"]![bi] =
      spreadDen[bi]! > 0 ? spreadNumer[bi]! / spreadDen[bi]! : 0;
  }

  out["feat_tick_buy_sell_ratio"] = new Array<number>(nB);
  out["feat_tick_imbalance"] = new Array<number>(nB);
  for (let bi = 0; bi < nB; bi++) {
    const der = tickDerived(out["feat_tick_buy_vol"]![bi]!, out["feat_tick_sell_vol"]![bi]!);
    out["feat_tick_buy_sell_ratio"][bi] = der.ratio;
    out["feat_tick_imbalance"][bi] = der.imb;
  }

  return out;
}
