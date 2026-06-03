import type { StrategyIndicator } from "@/lib/strategies";
import { apiFetch } from "@/lib/apiFetch";

export const BUILDER_BLOCK_KINDS = [
  "filter",
  "zone_long",
  "zone_short",
  "entry_long",
  "entry_short",
  "exit_long",
  "exit_short",
  "group",
] as const;

export type BuilderBlockKind = (typeof BUILDER_BLOCK_KINDS)[number];

export type BuilderBlockSpec = {
  ifLine: string;
  expr?: unknown;
  waitCandles?: number | null;
  requiredIndicators?: StrategyIndicator[];
  requiredRefs?: string[];
  requiredFacts?: string[];
};

export type BuilderBlock = {
  id: string;
  name: string;
  kind: BuilderBlockKind;
  description: string;
  spec: BuilderBlockSpec;
  created_at?: string | null;
  updated_at?: string | null;
};

export const BUILDER_BLOCK_KIND_LABEL: Record<BuilderBlockKind, string> = {
  filter: "Filtro",
  zone_long: "Zona long",
  zone_short: "Zona short",
  entry_long: "Entrada long",
  entry_short: "Entrada short",
  exit_long: "Saída long",
  exit_short: "Saída short",
  group: "Grupo",
};

const RESERVED_REFS = new Set([
  "and",
  "or",
  "not",
  "true",
  "false",
  "ema",
  "sma",
  "rsi",
  "delta",
  "roc",
  "abs",
  "min",
  "max",
  "normalise",
  "normalize",
]);

export function refsFromBuilderLine(line: string): string[] {
  const noCalls = line.replace(/\b(?:ema|sma|rsi|delta|roc|abs|min|max|normalise|normalize)\s*\(/gi, "(");
  const refs = new Set<string>();
  for (const m of noCalls.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\[(?:\d+)\])?(?:\.(?:upper|mid|lower))?/g)) {
    const token = m[0];
    const base = token.split("[", 1)[0]!.split(".", 1)[0]!;
    if (RESERVED_REFS.has(base.toLowerCase())) continue;
    refs.add(token);
  }
  return [...refs].sort();
}

export function factsFromBuilderRefs(refs: readonly string[]): string[] {
  return [
    ...new Set(
      refs
        .map((r) => r.split("[", 1)[0]!.split(".", 1)[0]!.toLowerCase())
        .filter((r) => r.startsWith("feat_")),
    ),
  ].sort();
}

function parseBlock(raw: unknown): BuilderBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const name = typeof o.name === "string" ? o.name : "";
  const kind = typeof o.kind === "string" && (BUILDER_BLOCK_KINDS as readonly string[]).includes(o.kind)
    ? (o.kind as BuilderBlockKind)
    : null;
  const specRaw = o.spec;
  if (!id || !name || !kind || !specRaw || typeof specRaw !== "object") return null;
  const s = specRaw as Record<string, unknown>;
  const ifLine = typeof s.ifLine === "string" ? s.ifLine : "";
  if (!ifLine.trim()) return null;
  const requiredRefs = Array.isArray(s.requiredRefs)
    ? s.requiredRefs.filter((x): x is string => typeof x === "string")
    : refsFromBuilderLine(ifLine);
  const requiredFacts = Array.isArray(s.requiredFacts)
    ? s.requiredFacts.filter((x): x is string => typeof x === "string")
    : factsFromBuilderRefs(requiredRefs);
  const requiredIndicators = Array.isArray(s.requiredIndicators)
    ? (s.requiredIndicators.filter((x) => x && typeof x === "object") as StrategyIndicator[])
    : [];
  return {
    id,
    name,
    kind,
    description: typeof o.description === "string" ? o.description : "",
    spec: {
      ifLine,
      expr: s.expr,
      waitCandles: typeof s.waitCandles === "number" && Number.isFinite(s.waitCandles) ? s.waitCandles : null,
      requiredRefs,
      requiredFacts,
      requiredIndicators,
    },
    created_at: typeof o.created_at === "string" ? o.created_at : null,
    updated_at: typeof o.updated_at === "string" ? o.updated_at : null,
  };
}

export async function fetchBuilderBlocks(): Promise<BuilderBlock[]> {
  const r = await apiFetch("/api/chart/builder-blocks", { cache: "no-store" }, 20_000);
  const j = (await r.json()) as unknown;
  if (!r.ok) throw new Error(j && typeof j === "object" && "error" in j ? String((j as { error?: unknown }).error) : r.statusText);
  const list = j && typeof j === "object" ? (j as { blocks?: unknown }).blocks : undefined;
  if (!Array.isArray(list)) return [];
  return list.map(parseBlock).filter((x): x is BuilderBlock => x != null);
}

export async function createBuilderBlock(
  block: Omit<BuilderBlock, "id" | "created_at" | "updated_at">,
): Promise<BuilderBlock> {
  const r = await apiFetch(
    "/api/chart/builder-blocks",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(block) },
    25_000,
  );
  const j = (await r.json()) as unknown;
  if (!r.ok) throw new Error(j && typeof j === "object" && "error" in j ? String((j as { error?: unknown }).error) : r.statusText);
  const parsed = parseBlock(j);
  if (!parsed) throw new Error("Resposta inválida ao guardar bloco.");
  return parsed;
}
