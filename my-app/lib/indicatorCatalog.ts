import { apiFetch } from "@/lib/apiFetch";
import {
  DEFAULT_TREND_COMPOSITE,
  normalizeTrendCompositeParams,
  type StrategyIndicator,
} from "@/lib/strategies";

export type CatalogKind = StrategyIndicator["kind"];

export type IndicatorCategory = "trend" | "momentum" | "volatility" | "volume";

export type IndicatorCatalogEntry = {
  templateId: string;
  label: string;
  description: string;
  searchText: string;
  kind: CatalogKind;
  group: StrategyIndicator["group"];
  chartLabel: string;
  params?: StrategyIndicator["params"];
  category: IndicatorCategory;
  /** Entradas TA-Lib da API são sempre implementadas se o servidor expuser o catálogo. */
  implemented: boolean;
};

export const INDICATOR_CATEGORY_ORDER: IndicatorCategory[] = [
  "trend",
  "momentum",
  "volatility",
  "volume",
];

export const INDICATOR_CATEGORY_LABEL: Record<IndicatorCategory, string> = {
  trend: "Trend",
  momentum: "Momentum",
  volatility: "Volatility",
  volume: "Volume",
};

/** Resposta de ``GET /api/chart/talib-catalog``. */
export type TalibCatalogApiResponse = {
  available?: boolean;
  functions?: { name: string; group: string }[];
  groups?: Record<string, string[]>;
};

function talibGroupToCategory(group: string): IndicatorCategory {
  const g = group.toLowerCase();
  if (g.includes("overlap") || g.includes("price transform")) return "trend";
  if (g.includes("volatility")) return "volatility";
  if (g.includes("volume")) return "volume";
  if (
    g.includes("momentum") ||
    g.includes("cycle") ||
    g.includes("pattern") ||
    g.includes("candlestick")
  ) {
    return "momentum";
  }
  if (g.includes("math")) return "momentum";
  return "momentum";
}

function talibGroupToChartGroup(group: string): StrategyIndicator["group"] {
  const g = group.toLowerCase();
  if (g.includes("overlap") || g.includes("price transform")) return "overlays";
  return "studies";
}

export function buildTalibCatalogEntries(
  flat: { name: string; group: string }[],
): IndicatorCatalogEntry[] {
  return flat.map(({ name, group }) => {
    const cat = talibGroupToCategory(group);
    const chartGroup = talibGroupToChartGroup(group);
    const desc = `${group} (TA-Lib)`;
    return {
      templateId: name.toUpperCase(),
      label: name,
      description: desc,
      searchText: `${name} ${group} talib ${INDICATOR_CATEGORY_LABEL[cat]}`.toLowerCase(),
      kind: "talib",
      group: chartGroup,
      chartLabel: name,
      category: cat,
      implemented: true,
      params: { talibFunction: name },
    };
  });
}

export const BUILTIN_CHART_INDICATOR_ENTRIES: IndicatorCatalogEntry[] = [
  {
    templateId: "__TREND_COMPOSITE_V1__",
    label: "Trend composite",
    description: "Score ponderado por vários blocos (normalização rolling + tanh), escala típica −100…+100.",
    searchText: "trend composite score tendência regime ensemble",
    kind: "trend_composite",
    group: "studies",
    chartLabel: "Trend composite",
    category: "trend",
    implemented: true,
    params: { trendComposite: DEFAULT_TREND_COMPOSITE },
  },
];

export async function fetchTalibIndicatorCatalog(): Promise<IndicatorCatalogEntry[]> {
  try {
    const r = await apiFetch("/api/chart/talib-catalog", {}, 20_000);
    const j = (await r.json()) as TalibCatalogApiResponse;
    if (!r.ok || !j.available || !Array.isArray(j.functions) || j.functions.length === 0) {
      return [];
    }
    return buildTalibCatalogEntries(j.functions);
  } catch {
    return [];
  }
}

export function getCatalogEntry(
  templateId: string,
  catalog: readonly IndicatorCatalogEntry[],
): IndicatorCatalogEntry | undefined {
  const u = templateId.toUpperCase();
  return catalog.find((e) => e.templateId === u || e.templateId === templateId);
}

function nextSequentialIndicatorId(kind: CatalogKind, used: ReadonlySet<string>): string {
  const prefix =
    kind === "macd"
      ? "macd"
      : kind === "sma"
        ? "sma"
        : kind === "atr"
          ? "atr"
          : kind === "trend_composite"
            ? "tc"
            : kind === "talib"
              ? "t"
              : kind;
  let n = 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function createUserIndicatorFromTemplate(
  templateId: string,
  existing: readonly { id: string }[] = [],
  catalog: readonly IndicatorCatalogEntry[],
): StrategyIndicator | null {
  const e = getCatalogEntry(templateId, catalog);
  if (!e || !e.implemented) return null;
  const used = new Set(existing.map((x) => x.id));
  const id = nextSequentialIndicatorId(e.kind, used);
  if (e.kind === "talib") {
    const fn = e.params?.talibFunction ?? e.templateId;
    return {
      id,
      label: e.chartLabel,
      group: e.group,
      kind: "talib",
      params: {
        talibFunction: fn,
        ...(e.params?.talibParams ? { talibParams: e.params.talibParams } : {}),
      },
    };
  }
  if (e.kind === "trend_composite") {
    const tc = e.params?.trendComposite
      ? normalizeTrendCompositeParams(e.params.trendComposite)
      : normalizeTrendCompositeParams(undefined);
    return {
      id,
      label: e.chartLabel,
      group: e.group,
      kind: "trend_composite",
      params: { trendComposite: tc },
    };
  }
  return null;
}

export function filterCatalog(
  query: string,
  catalog: readonly IndicatorCatalogEntry[],
): IndicatorCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...catalog];
  return catalog.filter(
    (e) =>
      e.label.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.searchText.includes(q) ||
      e.templateId.toLowerCase().includes(q) ||
      INDICATOR_CATEGORY_LABEL[e.category].toLowerCase().includes(q),
  );
}

export function filterCatalogGrouped(
  query: string,
  catalog: readonly IndicatorCatalogEntry[],
): Record<IndicatorCategory, IndicatorCatalogEntry[]> {
  const flat = filterCatalog(query, catalog);
  const inFilter = new Set(flat.map((e) => e.templateId));
  const out: Record<IndicatorCategory, IndicatorCatalogEntry[]> = {
    trend: [],
    momentum: [],
    volatility: [],
    volume: [],
  };
  for (const e of catalog) {
    if (!inFilter.has(e.templateId)) continue;
    out[e.category].push(e);
  }
  return out;
}

export const CUSTOM_INDICATOR_DRAFT_STORAGE_KEY = "backtest-chart-custom-indicator-draft-v1";
