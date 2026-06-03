import type { ChartBuilderSpecV1 } from "@/lib/chartBuilderSpec";

export type BuilderDriftKeyRow = {
  /** Chave enviada ao backend (`takeProfitPct`, `ind/<id>/<path>`). */
  key: string;
  label: string;
  base: number;
  kind: "int" | "float";
};

export function driftTripletPreview(
  base: number,
  pct: number,
  kind: "int" | "float",
): { min: number; max: number; triple: number[] } {
  if (!Number.isFinite(base) || !Number.isFinite(pct) || pct <= 0) {
    const b = kind === "int" ? Math.round(base) : base;
    return { min: b, max: b, triple: [b] };
  }
  const lo = base * (1 - pct / 100);
  const hi = base * (1 + pct / 100);
  if (kind === "int") {
    const bi = Math.round(base);
    const lo_i = Math.max(1, Math.floor(lo + 1e-9));
    const hi_i = Math.max(1, Math.ceil(hi - 1e-9));
    const triple = [...new Set([lo_i, bi, hi_i])].sort((a, b) => a - b);
    return { min: lo_i, max: hi_i, triple };
  }
  const lo_f = Math.round(lo * 1e6) / 1e6;
  const mid_f = Math.round(base * 1e6) / 1e6;
  const hi_f = Math.round(hi * 1e6) / 1e6;
  const triple = [...new Set([lo_f, mid_f, hi_f])].sort((a, b) => a - b);
  return { min: lo_f, max: hi_f, triple };
}

function guessKind(lastSeg: string, v: number): "int" | "float" {
  if (Number.isInteger(v)) return "int";
  if (/period|bars|signal|fast|slow|length|lookback|timeperiod/i.test(lastSeg)) return "int";
  return "float";
}

function walkNumeric(
  obj: Record<string, unknown>,
  pathPrefix: string,
  labelPrefix: string,
  indId: string,
  rows: BuilderDriftKeyRow[],
  opts?: { omitTalibTimeperiodDup?: boolean },
): void {
  const omitTp = opts?.omitTalibTimeperiodDup === true;
  for (const [k, v] of Object.entries(obj)) {
    const path = pathPrefix ? `${pathPrefix}.${k}` : k;
    const lab = labelPrefix ? `${labelPrefix} · ${k}` : k;
    if (typeof v === "number" && Number.isFinite(v)) {
      if (omitTp && path === "talibParams.timeperiod") continue;
      rows.push({
        key: `ind/${indId}/${path}`,
        label: `${labelPrefix}: ${path}`,
        base: v,
        kind: guessKind(k, v),
      });
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      walkNumeric(v as Record<string, unknown>, path, lab, indId, rows, opts);
    }
  }
}

export function collectBuilderDriftKeys(spec: ChartBuilderSpecV1): BuilderDriftKeyRow[] {
  const rows: BuilderDriftKeyRow[] = [];
  const risk = spec.risk;
  rows.push({
    key: "takeProfitPct",
    label: "Take profit %",
    base: Number(risk.takeProfitPct) || 0,
    kind: "float",
  });
  rows.push({
    key: "stopLossPct",
    label: "Stop loss %",
    base: Number(risk.stopLossPct) || 0,
    kind: "float",
  });
  rows.push({
    key: "trailingStopPct",
    label: "Trailing stop %",
    base: Number(risk.trailingStopPct) || 0,
    kind: "float",
  });
  const rules = spec.rules;
  rows.push({
    key: "zoneLongWaitCandles",
    label: "Zona long · velas de espera",
    base: Number(rules.zoneLongWaitCandles ?? 10) || 10,
    kind: "int",
  });
  rows.push({
    key: "zoneShortWaitCandles",
    label: "Zona short · velas de espera",
    base: Number(rules.zoneShortWaitCandles ?? 10) || 10,
    kind: "int",
  });

  for (const ind of spec.indicators ?? []) {
    const params = ind.params;
    if (!params || typeof params !== "object") continue;
    const title = ind.label?.trim() || ind.id;
    const p = params as Record<string, unknown>;
    const hasRootPeriod = typeof p.period === "number" && Number.isFinite(p.period);
    walkNumeric(p, "", title, ind.id, rows, {
      omitTalibTimeperiodDup: hasRootPeriod,
    });
  }
  return rows;
}
