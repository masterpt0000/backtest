export type IndicatorKind = "ema" | "bollinger" | "rsi";

/** Campo de preço usado no cálculo (TradingView-style). */
export const INDICATOR_SOURCES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"] as const;
export type IndicatorSource = (typeof INDICATOR_SOURCES)[number];

export type StrategyIndicator = {
  id: string;
  label: string;
  group: "overlays" | "studies";
  kind: IndicatorKind;
  params?: { period?: number; mult?: number; source?: IndicatorSource };
};

export type Strategy = {
  id: string;
  label: string;
  indicators: StrategyIndicator[];
};

/** Opção “sem estratégia” (sempre primeiro no select). */
export const NONE_STRATEGY: Strategy = { id: "", label: "Nenhuma", indicators: [] };

export function getStrategyById(strategies: Strategy[], id: string): Strategy {
  return strategies.find((s) => s.id === id) ?? NONE_STRATEGY;
}

/** Normaliza resposta da API (params opcionais). */
export function parseStrategiesPayload(raw: unknown): Strategy[] {
  if (!raw || typeof raw !== "object") return [NONE_STRATEGY];
  const list = (raw as { strategies?: unknown }).strategies;
  if (!Array.isArray(list)) return [NONE_STRATEGY];
  const out: Strategy[] = [NONE_STRATEGY];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id) continue;
    const label = typeof o.label === "string" ? o.label : id;
    const indicatorsRaw = o.indicators;
    const indicators: StrategyIndicator[] = [];
    if (Array.isArray(indicatorsRaw)) {
      for (const ir of indicatorsRaw) {
        if (!ir || typeof ir !== "object") continue;
        const ind = ir as Record<string, unknown>;
        const kind = ind.kind as StrategyIndicator["kind"];
        if (kind !== "ema" && kind !== "bollinger" && kind !== "rsi") continue;
        const group = ind.group as StrategyIndicator["group"];
        if (group !== "overlays" && group !== "studies") continue;
        const iid = typeof ind.id === "string" ? ind.id : "";
        const ilabel = typeof ind.label === "string" ? ind.label : iid;
        if (!iid) continue;
        const pr = ind.params;
        let params: StrategyIndicator["params"];
        if (pr && typeof pr === "object") {
          const p = pr as Record<string, unknown>;
          params = {};
          if (typeof p.period === "number" && Number.isFinite(p.period)) params.period = p.period;
          if (typeof p.mult === "number" && Number.isFinite(p.mult)) params.mult = p.mult;
          if (
            typeof p.source === "string" &&
            (INDICATOR_SOURCES as readonly string[]).includes(p.source)
          ) {
            params.source = p.source as IndicatorSource;
          }
          if (Object.keys(params).length === 0) params = undefined;
        }
        indicators.push({ id: iid, label: ilabel, group, kind, params });
      }
    }
    out.push({ id, label, indicators });
  }
  return out;
}
