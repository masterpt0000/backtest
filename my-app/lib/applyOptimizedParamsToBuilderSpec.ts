/**
 * Aplica um mapa plano de parâmetros optimizados (``resolved_params`` / ``best_params``)
 * ao snapshot JSON da estratégia builder — mesma semântica que ``merge_builder_best_params_into_spec`` no Python.
 */

const RISK_KEYS = new Set(["takeProfitPct", "stopLossPct", "trailingStopPct"]);
const ZONE_KEYS = new Set(["zoneLongWaitCandles", "zoneShortWaitCandles"]);

export function parseBuilderIndOverrideKey(key: string): { indId: string; pathParts: string[] } | null {
  if (!key.startsWith("ind/")) return null;
  const rest = key.slice(4);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const indId = rest.slice(0, slash);
  const path = rest.slice(slash + 1).trim();
  if (!path) return null;
  return { indId, pathParts: path.split(".") };
}

function ensureRecord(x: unknown): Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? { ...(x as object) } : {};
}

function setNestedParams(root: Record<string, unknown>, pathParts: string[], val: unknown): void {
  let cur = root;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const seg = pathParts[i]!;
    const raw = cur[seg];
    const next =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : {};
    cur[seg] = next;
    cur = next;
  }
  cur[pathParts[pathParts.length - 1]!] = val;
}

/** Mantém ``period`` e ``talibParams.timeperiod`` alinhados quando ambos existem. */
function mirrorPeriodTalib(params: Record<string, unknown>, pathParts: string[], val: unknown): void {
  if (pathParts.length === 1 && pathParts[0] === "period") {
    const tp = params.talibParams;
    if (typeof tp === "object" && tp !== null && !Array.isArray(tp)) {
      (tp as Record<string, unknown>).timeperiod = val;
    }
  } else if (pathParts.length === 2 && pathParts[0] === "talibParams" && pathParts[1] === "timeperiod") {
    if ("period" in params) params.period = val;
  }
}

export function applyOptimizedParamsToBuilderSpec(
  spec: Record<string, unknown>,
  flatParams: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(spec) as Record<string, unknown>;
  const risk = ensureRecord(next.risk);
  const rules = ensureRecord(next.rules);
  next.risk = risk;
  next.rules = rules;

  const indicatorsRaw = next.indicators;
  if (!Array.isArray(indicatorsRaw)) return next;

  for (const [rawK, val] of Object.entries(flatParams)) {
    const k = String(rawK);
    if (RISK_KEYS.has(k)) {
      risk[k] = val;
      continue;
    }
    if (ZONE_KEYS.has(k)) {
      rules[k] = val;
      continue;
    }
    const parsed = parseBuilderIndOverrideKey(k);
    if (!parsed) continue;

    const idx = indicatorsRaw.findIndex((row) => {
      if (typeof row !== "object" || row === null) return false;
      return String((row as Record<string, unknown>).id) === parsed.indId;
    });
    if (idx < 0) continue;

    const ind = ensureRecord(indicatorsRaw[idx]) as Record<string, unknown>;
    indicatorsRaw[idx] = ind;
    const params = ensureRecord(ind.params);
    ind.params = params;

    setNestedParams(params, parsed.pathParts, val);
    mirrorPeriodTalib(params, parsed.pathParts, val);
  }

  return next;
}

/** Ids de indicadores referenciados por chaves ``ind/<id>/…`` no mapa plano (optimização / drift). */
export function extractIndicatorIdsFromFlatParams(flatParams: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const k of Object.keys(flatParams)) {
    const p = parseBuilderIndOverrideKey(k);
    if (p) ids.add(p.indId);
  }
  return [...ids];
}

export function pickRowOptimizedParams(row: {
  resolved_params?: Record<string, unknown>;
  best_params?: Record<string, unknown>;
}): Record<string, unknown> | null {
  const rp = row.resolved_params;
  if (rp && typeof rp === "object" && Object.keys(rp).length > 0) return rp;
  const bp = row.best_params;
  if (bp && typeof bp === "object" && Object.keys(bp).length > 0) return bp;
  return null;
}
