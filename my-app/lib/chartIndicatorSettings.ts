import { INDICATOR_SOURCES, type IndicatorSource, type StrategyIndicator } from "@/lib/strategies";

/** Espessura de linha (lightweight-charts). */
export type ChartLineWidth = 1 | 2 | 3 | 4;

/** Sobreposições de estilo/parâmetros por estratégia e indicador (`strategyId::indicatorId`). */
export type ChartIndicatorOverride = {
  period?: number;
  mult?: number;
  source?: IndicatorSource;
  color?: string;
  colorUpper?: string;
  colorMid?: string;
  colorLower?: string;
  lineWidth?: ChartLineWidth;
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

/** Lê override (inclui legado __none__ para indicadores do utilizador). */
export function readIndicatorOverride(
  overrides: Record<string, ChartIndicatorOverride>,
  strategyId: string,
  indicatorId: string,
  isUserOwnedIndicator: boolean,
): ChartIndicatorOverride | undefined {
  const k = resolveIndicatorOverrideKey(strategyId, indicatorId, isUserOwnedIndicator);
  const v = overrides[k];
  if (v !== undefined) return v;
  if (isUserOwnedIndicator) {
    return overrides[chartOverrideKey(CHART_NONE_SCOPE, indicatorId)];
  }
  return undefined;
}

export function defaultIndicatorPeriod(kind: StrategyIndicator["kind"]): number {
  if (kind === "bollinger") return 20;
  return 14;
}

export function defaultBollingerMult(): number {
  return 2;
}

export const DEFAULT_INDICATOR_SOURCE: IndicatorSource = "close";

export function effectiveSource(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): IndicatorSource {
  const s = o?.source ?? ind.params?.source;
  if (s && (INDICATOR_SOURCES as readonly string[]).includes(s)) return s;
  return DEFAULT_INDICATOR_SOURCE;
}

export function effectivePeriod(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): number {
  return o?.period ?? ind.params?.period ?? defaultIndicatorPeriod(ind.kind);
}

export function effectiveMult(ind: StrategyIndicator, o: ChartIndicatorOverride | undefined): number {
  return o?.mult ?? ind.params?.mult ?? defaultBollingerMult();
}

export function defaultLineWidth(kind: StrategyIndicator["kind"]): ChartLineWidth {
  return kind === "bollinger" ? 1 : 2;
}

export function effectiveLineWidth(
  ind: StrategyIndicator,
  o: ChartIndicatorOverride | undefined,
): ChartLineWidth {
  const w = o?.lineWidth;
  if (w === 1 || w === 2 || w === 3 || w === 4) return w;
  return defaultLineWidth(ind.kind);
}
