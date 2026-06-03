/**
 * Séries facetas alinhadas às barras (liquidations/OI…) via FastAPI `/api/chart/bar-features`.
 */
export type BarFeaturesApiResponse = {
  compute_ms: number;
  features: Record<string, number[]>;
  errors?: string[];
  partial?: boolean;
};

export function parseBarFeaturesResponse(raw: unknown): BarFeaturesApiResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const cms = o.compute_ms;
  const fe = o.features;
  if (typeof cms !== "number" || !Number.isFinite(cms) || !fe || typeof fe !== "object") return null;
  const features: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(fe as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    const nums = v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    if (nums.length !== v.length || nums.length === 0) continue;
    features[k] = nums;
  }
  return { compute_ms: cms, features, ...(Array.isArray(o.errors) ? { errors: o.errors as string[] } : {}) };
}
