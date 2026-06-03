/**
 * Fallback quando ``DATABASE_URL`` não está definido: estratégias builder só neste browser.
 */
import {
  parseChartBuilderSpec,
  toBuilderStrategyRowId,
  type ChartBuilderSpecV1,
} from "@/lib/chartBuilderSpec";
import type { Strategy } from "@/lib/strategies";

export const CHART_BUILDER_LOCAL_STORAGE_KEY = "backtest-chart-builder-strategies-v1";

type StoredRow = {
  id: string;
  updatedAt: number;
  spec: unknown;
};

function readRowsRaw(): StoredRow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CHART_BUILDER_LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: StoredRow[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id.trim() : "";
      const updatedAt = typeof o.updatedAt === "number" ? o.updatedAt : 0;
      if (!id) continue;
      out.push({ id, updatedAt, spec: o.spec });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function writeRowsRaw(rows: StoredRow[]): void {
  try {
    localStorage.setItem(CHART_BUILDER_LOCAL_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    /* quota / private mode */
  }
}

function newLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Converte linhas guardadas em estratégias para fundir na lista do chart. */
export function localBuilderRowsToStrategies(): Strategy[] {
  const rows = readRowsRaw();
  const built: Strategy[] = [];
  for (const row of rows) {
    const parsed = parseChartBuilderSpec(row.spec);
    if (!parsed.ok) continue;
    built.push({
      id: toBuilderStrategyRowId(row.id),
      label: parsed.spec.name,
      indicators: parsed.spec.indicators,
      isBuilderStrategy: true,
      builderSpec: parsed.spec,
    });
  }
  return built;
}

/** Cria ou actualiza uma estratégia local; devolve o UUID usado. */
export function upsertLocalBuilderStrategy(
  id: string | null,
  spec: ChartBuilderSpecV1,
): string {
  const rows = readRowsRaw();
  const uuid = id?.trim() || newLocalId();
  const now = Date.now();
  const nextSpec = { ...spec, name: spec.name.trim() || "Sem nome" };
  const idx = rows.findIndex((r) => r.id === uuid);
  const row: StoredRow = { id: uuid, updatedAt: now, spec: nextSpec };
  if (idx >= 0) rows[idx] = row;
  else rows.push(row);
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  writeRowsRaw(rows);
  return uuid;
}

/** Remove uma estratégia builder guardada neste browser (UUID da linha, sem prefixo ``builder_``). */
export function deleteLocalBuilderStrategy(id: string): void {
  const uuid = id.trim();
  if (!uuid) return;
  const rows = readRowsRaw().filter((r) => r.id !== uuid);
  writeRowsRaw(rows);
}
