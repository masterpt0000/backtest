import { normalizeVbtStem } from "@/lib/liveStrategy/chartSimIndicatorParams";

export const CHART_VBT_FLAT_PARAMS_EVENT = "chartVbtFlatParamsUpdated";

const STORAGE_PREFIX = "chartVbtFlatParams:";

/** Guarda o mapa plano ``best_params`` / ``resolved_params`` para o próximo POST ``simulate-bars``. */
export function storeOptimizedVbtParamsForChart(
  vbtStrategyStem: string,
  flat: Record<string, unknown>,
): void {
  try {
    const stem = normalizeVbtStem(vbtStrategyStem);
    const normalized: Record<string, number> = {};
    for (const [k, v] of Object.entries(flat)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) normalized[k] = n;
    }
    sessionStorage.setItem(STORAGE_PREFIX + stem, JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent(CHART_VBT_FLAT_PARAMS_EVENT, { detail: { stem } }));
  } catch {
    /* quota / modo privado */
  }
}

/** Sobrepõe os valores vindos dos sliders do chart pelos guardados na página Backtests. */
export function mergeChartPayloadWithStoredVbtParams(
  vbtStrategyStem: string,
  payloadFromDefs: Record<string, number>,
): Record<string, number> {
  try {
    const stem = normalizeVbtStem(vbtStrategyStem);
    const raw = sessionStorage.getItem(STORAGE_PREFIX + stem);
    if (!raw) return payloadFromDefs;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const stored: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) stored[k] = n;
    }
    return { ...payloadFromDefs, ...stored };
  } catch {
    return payloadFromDefs;
  }
}
