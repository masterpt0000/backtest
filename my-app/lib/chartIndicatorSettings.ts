import {
  INDICATOR_SOURCES,
  INDICATOR_TIMEFRAMES,
  normalizeTrendCompositeParams,
  type IndicatorSource,
  type IndicatorTimeframe,
  type StrategyIndicator,
  type TrendCompositeParams,
} from "@/lib/strategies";

/** Espessura de linha (lightweight-charts). */
export type ChartLineWidth = 1 | 2 | 3 | 4;

/** Sobreposições de estilo/parâmetros por estratégia e indicador (`strategyId::indicatorId`). */
export type ChartIndicatorOverride = {
  period?: number;
  mult?: number;
  source?: IndicatorSource;
  timeframe?: IndicatorTimeframe;
  fast?: number;
  slow?: number;
  signal?: number;
  color?: string;
  colorUpper?: string;
  colorMid?: string;
  colorLower?: string;
  lineWidth?: ChartLineWidth;
  /** Parâmetros do indicador LCI (lightweight-charts-indicators), por id de input do registry. */
  lciInputs?: Record<string, unknown>;
  /** Parâmetros numéricos TA-Lib (`timeperiod`, etc.) quando ``kind === "talib"``. */
  talibParams?: Record<string, number>;
  /**
   * Variação Δ em N barras relativamente ao valor gravado (mesma série no gráfico).
   * 0 ou omisso = série original.
   */
  deltaLookbackBars?: number;
  /** Se não for ``false``, Δ é dividido pelo fecho na vela actual (escala sem unidade do preço). */
  deltaNormalizeByPrice?: boolean;
  /** Sobreposição de pesos/presets do Trend composite quando o indicador vem da estratégia. */
  trendComposite?: TrendCompositeParams;
};

/** Scope quando não há estratégia (indicadores adicionados manualmente). */
export const CHART_NONE_SCOPE = "__none__";

/** Indicadores acrescentados pelo utilizador (biblioteca) — estáveis ao mudar de estratégia. */
export const USER_INDICATOR_SCOPE = "__user__";

export function chartOverrideScopeId(strategyId: string): string {
  const s = strategyId.trim();
  return s ? s : CHART_NONE_SCOPE;
}

export function chartOverrideKey(strategyId: string, indicatorId: string): string {
  return `${chartOverrideScopeId(strategyId)}::${indicatorId}`;
}

export function resolveIndicatorOverrideKey(
  strategyId: string,
  indicatorId: string,
  isUserOwnedIndicator: boolean,
): string {
  if (isUserOwnedIndicator) {
    return chartOverrideKey(USER_INDICATOR_SCOPE, indicatorId);
  }
  return chartOverrideKey(strategyId, indicatorId);
}

/** Merge shallow (__none → __user__ → estratégia) só com valores definidos. */
function mergeOverrides(
  ...parts: (ChartIndicatorOverride | undefined)[]
): ChartIndicatorOverride | undefined {
  const out: ChartIndicatorOverride = {};
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    for (const [vk, vv] of Object.entries(p as Record<string, unknown>)) {
      if (vv !== undefined) (out as Record<string, unknown>)[vk] = vv;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Lê override (__none__, __user__, ``strategyId::id`` migrados pela ordem de precedência adequada). */
export function readIndicatorOverride(
  overrides: Record<string, ChartIndicatorOverride>,
  strategyId: string,
  indicatorId: string,
  isUserOwnedIndicator: boolean,
): ChartIndicatorOverride | undefined {
  if (isUserOwnedIndicator) {
    return mergeOverrides(
      overrides[chartOverrideKey(CHART_NONE_SCOPE, indicatorId)],
      overrides[chartOverrideKey(USER_INDICATOR_SCOPE, indicatorId)],
    );
  }
  return mergeOverrides(
    overrides[chartOverrideKey(CHART_NONE_SCOPE, indicatorId)],
    overrides[chartOverrideKey(USER_INDICATOR_SCOPE, indicatorId)],
    overrides[chartOverrideKey(strategyId, indicatorId)],
  );
}

export function defaultIndicatorPeriod(kind: StrategyIndicator["kind"]): number {
  if (kind === "sma") return 20;
  if (kind === "atr") return 14;
  return 14;
}

export function defaultBollingerMult(): number {
  return 2;
}

export const DEFAULT_INDICATOR_SOURCE: IndicatorSource = "close";
export const DEFAULT_INDICATOR_TIMEFRAME: IndicatorTimeframe = "chart";

export function effectiveSource(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): IndicatorSource {
  const s = o?.source ?? ind.params?.source;
  if (s && (INDICATOR_SOURCES as readonly string[]).includes(s)) return s;
  return DEFAULT_INDICATOR_SOURCE;
}

export function effectiveIndicatorTimeframe(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): IndicatorTimeframe {
  const tf = o?.timeframe ?? ind.params?.timeframe;
  if (tf && (INDICATOR_TIMEFRAMES as readonly string[]).includes(tf)) return tf;
  return DEFAULT_INDICATOR_TIMEFRAME;
}

export function effectivePeriod(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): number {
  const talibTpRaw =
    ind.kind === "talib" && ind.params?.talibParams?.timeperiod != null
      ? Number(ind.params.talibParams.timeperiod)
      : undefined;
  const raw =
    o?.period ??
    ind.params?.period ??
    (talibTpRaw != null && Number.isFinite(talibTpRaw) ? talibTpRaw : undefined) ??
    defaultIndicatorPeriod(ind.kind);
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return defaultIndicatorPeriod(ind.kind);
  const isRsiTalib =
    ind.kind === "talib" &&
    (ind.params?.talibFunction ?? "").trim().toUpperCase() === "RSI";
  const lo = isRsiTalib ? 2 : 1;
  return Math.max(lo, Math.min(500, Math.round(n)));
}

/**
 * Parâmetros TA-Lib enviados ao gráfico/API: funde ``params`` da estratégia, overrides e garante
 * ``timeperiod`` alinhado com o controlo «Período» quando a função não é multi-período (ex. MACD).
 */
export function effectiveTalibParamsForChart(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): Record<string, number> | undefined {
  if (ind.kind !== "talib" || !ind.params?.talibFunction?.trim()) return undefined;
  const base: Record<string, number> = {
    ...(ind.params.talibParams ?? {}),
    ...(o?.talibParams ?? {}),
  };
  const fn = ind.params.talibFunction.trim().toUpperCase();
  const ep = effectivePeriod(ind, o);
  const multiPeriodFamily =
    fn.startsWith("MACD") ||
    fn.startsWith("APO") ||
    fn.startsWith("PPO") ||
    fn.startsWith("MAMA") ||
    /** STOCHRSI usa ``timeperiod`` (período RSI) + fastk/fastd — não agrupar com STOCH clássico. */
    (fn.startsWith("STOCH") && fn !== "STOCHRSI");
  if (multiPeriodFamily) {
    return Object.keys(base).length ? base : undefined;
  }
  if (fn === "BBANDS") {
    const m = effectiveMult(ind, o);
    return { ...base, timeperiod: ep, nbdevup: m, nbdevdn: m };
  }
  return { ...base, timeperiod: ep };
}

export function effectiveMult(ind: StrategyIndicator, o: ChartIndicatorOverride | undefined): number {
  const raw = o?.mult ?? ind.params?.mult ?? defaultBollingerMult();
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return defaultBollingerMult();
  return Math.max(0.5, Math.min(10, Math.round(n * 10) / 10));
}

export function defaultLineWidth(ind: StrategyIndicator): ChartLineWidth {
  if (ind.kind === "talib" && (ind.params?.talibFunction ?? "").trim().toUpperCase() === "BBANDS")
    return 1;
  return 2;
}

export function effectiveMacdFast(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): number {
  const v = o?.fast ?? ind.params?.fast ?? 12;
  return Math.max(1, Math.min(200, Math.round(Number(v))));
}

export function effectiveMacdSlow(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): number {
  const v = o?.slow ?? ind.params?.slow ?? 26;
  return Math.max(1, Math.min(500, Math.round(Number(v))));
}

export function effectiveMacdSignal(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): number {
  const v = o?.signal ?? ind.params?.signal ?? 9;
  return Math.max(1, Math.min(200, Math.round(Number(v))));
}

/** Parâmetros Trend composite: override substitui o bloco em ``params.trendComposite`` da estratégia. */
export function effectiveTrendCompositeParams(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): TrendCompositeParams | undefined {
  if (ind.kind !== "trend_composite") return undefined;
  const raw =
    o?.trendComposite !== undefined ? o.trendComposite : ind.params?.trendComposite;
  return normalizeTrendCompositeParams(raw);
}

export function effectiveLineWidth(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): ChartLineWidth {
  const w = o?.lineWidth;
  if (w === 1 || w === 2 || w === 3 || w === 4) return w;
  return defaultLineWidth(ind);
}
