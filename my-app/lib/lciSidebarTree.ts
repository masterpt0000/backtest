import type { IndicatorCategory, IndicatorRegistryEntry } from "lightweight-charts-indicators";

export type LciGrouped = {
  standard: Map<IndicatorCategory, IndicatorRegistryEntry[]>;
  community: Map<IndicatorCategory, IndicatorRegistryEntry[]>;
  candlestick: IndicatorRegistryEntry[];
};

/** Ordem das subsecções (igual à library / demo TradingView-style). */
export const LCI_CATEGORY_ORDER: IndicatorCategory[] = [
  "Moving Averages",
  "Momentum",
  "Oscillators",
  "Trend",
  "Volatility",
  "Volume",
  "Channels & Bands",
  "Candlestick Patterns",
];

export function formatLciCategoryTitle(cat: IndicatorCategory): string {
  return cat.toUpperCase();
}

export function groupLciRegistry(registry: IndicatorRegistryEntry[]): LciGrouped {
  const standard = new Map<IndicatorCategory, IndicatorRegistryEntry[]>();
  const community = new Map<IndicatorCategory, IndicatorRegistryEntry[]>();
  const candlestick: IndicatorRegistryEntry[] = [];

  for (const e of registry) {
    if (e.group === "candlestick") {
      candlestick.push(e);
      continue;
    }
    const map = e.group === "standard" ? standard : community;
    const list = map.get(e.category) ?? [];
    list.push(e);
    map.set(e.category, list);
  }

  const sortArr = (a: IndicatorRegistryEntry, b: IndicatorRegistryEntry) =>
    a.name.localeCompare(b.name, "pt", { sensitivity: "base" });

  for (const m of [standard, community]) {
    for (const [k, arr] of m) {
      m.set(k, [...arr].sort(sortArr));
    }
  }
  candlestick.sort(sortArr);

  return { standard, community, candlestick };
}

export function countMapEntries(m: Map<IndicatorCategory, IndicatorRegistryEntry[]>): number {
  let n = 0;
  for (const arr of m.values()) n += arr.length;
  return n;
}

export function filterLciRegistry(
  registry: IndicatorRegistryEntry[],
  query: string,
): IndicatorRegistryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return registry;
  return registry.filter((e) => {
    const blob = `${e.id} ${e.name} ${e.shortName} ${e.description ?? ""} ${e.category}`.toLowerCase();
    return blob.includes(q);
  });
}

export function filterGrouped(grouped: LciGrouped, query: string): LciGrouped {
  const q = query.trim();
  if (!q) return grouped;
  const f = (arr: IndicatorRegistryEntry[]) => filterLciRegistry(arr, q);
  const standard = new Map<IndicatorCategory, IndicatorRegistryEntry[]>();
  const community = new Map<IndicatorCategory, IndicatorRegistryEntry[]>();
  for (const [k, arr] of grouped.standard) {
    const next = f(arr);
    if (next.length) standard.set(k, next);
  }
  for (const [k, arr] of grouped.community) {
    const next = f(arr);
    if (next.length) community.set(k, next);
  }
  return {
    standard,
    community,
    candlestick: f(grouped.candlestick),
  };
}
