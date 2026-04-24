import {
  INDICATOR_SOURCES,
  type IndicatorSource,
  type StrategyIndicator,
} from "@/lib/strategies";

export const STANDALONE_INDICATORS_STORAGE_KEY = "backtest-chart-standalone-indicators-v1";

/** Chave atual para indicadores adicionados pelo utilizador (biblioteca). */
export const USER_INDICATORS_STORAGE_KEY = "backtest-chart-user-indicators-v1";

export type StandaloneKind = "ema" | "rsi" | "bollinger";

function newStandaloneId(): string {
  return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Cria um indicador com id único (vários EMAs, etc.). */
export function createStandaloneIndicator(kind: StandaloneKind): StrategyIndicator {
  const id = newStandaloneId();
  if (kind === "ema") {
    return { id, label: "EMA 21", group: "overlays", kind: "ema", params: { period: 21 } };
  }
  if (kind === "rsi") {
    return { id, label: "RSI 14", group: "studies", kind: "rsi", params: { period: 14 } };
  }
  return {
    id,
    label: "Bollinger 20",
    group: "overlays",
    kind: "bollinger",
    params: { period: 20, mult: 2 },
  };
}

export function parseStandaloneIndicatorsFromStorage(data: unknown): StrategyIndicator[] {
  if (!Array.isArray(data)) return [];
  const out: StrategyIndicator[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    const label = typeof o.label === "string" ? o.label : "";
    const group = o.group === "overlays" || o.group === "studies" ? o.group : null;
    const kind = o.kind === "ema" || o.kind === "bollinger" || o.kind === "rsi" ? o.kind : null;
    if (!id || !label || !group || !kind) continue;
    const pr = o.params;
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
    out.push({ id, label, group, kind, params });
  }
  return out;
}
