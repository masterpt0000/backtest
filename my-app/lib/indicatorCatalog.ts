import type { StrategyIndicator } from "@/lib/strategies";

export type CatalogKind = StrategyIndicator["kind"];

export type IndicatorCatalogEntry = {
  /** Identificador estável do modelo (não é o id da instância no gráfico). */
  templateId: string;
  label: string;
  description: string;
  /** Palavras para a pesquisa (minúsculas). */
  searchText: string;
  kind: CatalogKind;
  group: StrategyIndicator["group"];
  chartLabel: string;
  params?: StrategyIndicator["params"];
};

function newInstanceId(templateId: string): string {
  return `u_${templateId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Catálogo fixo — um modelo por tipo; o período ajusta-se nas definições do indicador no gráfico. */
export const INDICATOR_CATALOG: IndicatorCatalogEntry[] = [
  {
    templateId: "ema",
    label: "EMA",
    description: "Média móvel exponencial (período configurável nas definições).",
    searchText: "ema média exponencial moving average",
    kind: "ema",
    group: "overlays",
    chartLabel: "EMA",
    params: { period: 21 },
  },
  {
    templateId: "rsi",
    label: "RSI",
    description: "Índice de força relativa (período configurável nas definições).",
    searchText: "rsi relative strength",
    kind: "rsi",
    group: "studies",
    chartLabel: "RSI",
    params: { period: 14 },
  },
  {
    templateId: "bollinger",
    label: "Bollinger",
    description: "Bandas de Bollinger — período e multiplicador nas definições.",
    searchText: "bollinger bandas volatilidade",
    kind: "bollinger",
    group: "overlays",
    chartLabel: "BB",
    params: { period: 20, mult: 2 },
  },
];

export function getCatalogEntry(templateId: string): IndicatorCatalogEntry | undefined {
  return INDICATOR_CATALOG.find((e) => e.templateId === templateId);
}

export function createUserIndicatorFromTemplate(templateId: string): StrategyIndicator | null {
  const e = getCatalogEntry(templateId);
  if (!e) return null;
  return {
    id: newInstanceId(e.templateId),
    label: e.chartLabel,
    group: e.group,
    kind: e.kind,
    params: e.params ? { ...e.params } : undefined,
  };
}

export function filterCatalog(query: string): IndicatorCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return INDICATOR_CATALOG;
  return INDICATOR_CATALOG.filter(
    (e) =>
      e.label.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.searchText.includes(q) ||
      e.templateId.includes(q),
  );
}

export const CUSTOM_INDICATOR_DRAFT_STORAGE_KEY = "backtest-chart-custom-indicator-draft-v1";
