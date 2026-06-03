import {
  migrateLegacyIndicatorToTalib,
  INDICATOR_SOURCES,
  type IndicatorSource,
  type StrategyIndicator,
} from "@/lib/strategies";

export const STANDALONE_INDICATORS_STORAGE_KEY = "backtest-chart-standalone-indicators-v1";

export const USER_INDICATORS_STORAGE_KEY = "backtest-chart-user-indicators-v1";

/** Presets de biblioteca (convertidos para TA-Lib através de ``migrateLegacyIndicatorToTalib``). */
export type StandaloneKind = "ema" | "rsi" | "bollinger";

function newStandaloneId(): string {
  return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createStandaloneIndicator(kind: StandaloneKind): StrategyIndicator {
  const id = newStandaloneId();
  const mapped = migrateLegacyIndicatorToTalib(
    kind === "ema"
      ? {
          id,
          label: "EMA 21",
          group: "overlays",
          kind: "ema",
          params: { period: 21 },
        }
      : kind === "rsi"
        ? {
            id,
            label: "RSI 14",
            group: "studies",
            kind: "rsi",
            params: { period: 14 },
          }
        : {
            id,
            label: "Bollinger 20",
            group: "overlays",
            kind: "bollinger",
            params: { period: 20, mult: 2 },
          },
  );
  if (!mapped) {
    throw new Error("createStandaloneIndicator: migração falhou");
  }
  return mapped;
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
    const kindStr = typeof o.kind === "string" ? o.kind : "";
    if (!id || !label || !group || !kindStr) continue;
    const pr = o.params;
    let params: StrategyIndicator["params"];
    if (pr && typeof pr === "object") {
      const p = pr as Record<string, unknown>;
      params = {};
      if (typeof p.period === "number" && Number.isFinite(p.period)) params.period = p.period;
      if (typeof p.mult === "number" && Number.isFinite(p.mult)) params.mult = p.mult;
      if (typeof p.fast === "number" && Number.isFinite(p.fast)) params.fast = p.fast;
      if (typeof p.slow === "number" && Number.isFinite(p.slow)) params.slow = p.slow;
      if (typeof p.signal === "number" && Number.isFinite(p.signal)) params.signal = p.signal;
      if (typeof p.talibFunction === "string" && p.talibFunction.trim()) {
        params.talibFunction = p.talibFunction.trim();
      }
      const tp = p.talibParams;
      if (tp && typeof tp === "object" && !Array.isArray(tp)) {
        const numMap: Record<string, number> = {};
        for (const [k, v] of Object.entries(tp as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v)) numMap[k] = v;
        }
        if (Object.keys(numMap).length) params.talibParams = numMap;
      }
      if (
        typeof p.source === "string" &&
        (INDICATOR_SOURCES as readonly string[]).includes(p.source)
      ) {
        params.source = p.source as IndicatorSource;
      }
      if (Object.keys(params).length === 0) params = undefined;
    } else {
      params = undefined;
    }

    const migrated = migrateLegacyIndicatorToTalib({
      id,
      label,
      group,
      kind: kindStr,
      params,
    });
    if (!migrated) continue;
    out.push(migrated);
  }
  return out;
}
