import type { IndicatorSeriesBundle } from "@/lib/chartTaBundles";

/**
 * Junta séries facetas (`feat_*`), alinhadas por índice de vela,
 * aos bundles TA já existentes para a simulação do construtor.
 */
export function mergeFeatureScalarsIntoBundles(
  taBundles: Map<string, IndicatorSeriesBundle> | null | undefined,
  barCount: number,
  features: Record<string, number[]> | null | undefined,
): Map<string, IndicatorSeriesBundle> {
  const out = taBundles ? new Map(taBundles) : new Map<string, IndicatorSeriesBundle>();
  if (!features) return out;
  for (const [key, arr] of Object.entries(features)) {
    if (!Array.isArray(arr) || arr.length !== barCount) continue;
    const scalar = arr.map((x) =>
      typeof x === "number" && Number.isFinite(x) ? x : Number.NaN,
    );
    out.set(key, { scalar });
  }
  return out;
}
