import type { IndicatorSource, IndicatorTimeframe, StrategyIndicator } from "@/lib/strategies";
import { INDICATOR_SOURCES, INDICATOR_TIMEFRAMES, migrateLegacyIndicatorToTalib, normalizeTrendCompositeParams } from "@/lib/strategies";
import { parseBuilderIfLine } from "@/lib/builderIfParser";
import { splitBuilderDeltaRef } from "@/lib/builderDeltaRef";

export const BUILDER_OPS = ["cross_up", "cross_down", "gt", "lt", "ge", "le", "eq"] as const;
export type BuilderOp = (typeof BUILDER_OPS)[number];

/** @deprecated Cadeia linear; migrada para {@link BuilderLogicExpr}. */
export const BUILDER_LOGIC_OPS = ["and", "or"] as const;
export type BuilderLogicOp = (typeof BUILDER_LOGIC_OPS)[number];

export const BOLLINGER_BANDS = ["upper", "mid", "lower"] as const;
export type BollingerBand = (typeof BOLLINGER_BANDS)[number];

export type BuilderOperand =
  | { type: "indicator"; ref: string; bollingerBand?: BollingerBand; shift?: number }
  | { type: "constant"; value: number }
  /** Valor do indicador na vela de entrada da posição actual (saídas com fluxo stateful). */
  | { type: "entry_snap"; ref: string; bollingerBand?: BollingerBand }
  /** ``valor(inner) + add`` (ex.: ``entry(rsi,-60)``). */
  | { type: "adjusted"; inner: BuilderOperand; add: number };

export type BuilderCondition = {
  left: BuilderOperand;
  right: BuilderOperand;
  op: BuilderOp;
};

/**
 * Lógica com parêntesis: ``atom`` = uma comparação; ``all`` = E entre filhos; ``any`` = OU entre filhos.
 */
export type BuilderLogicExpr =
  | { kind: "atom"; condition: BuilderCondition }
  | { kind: "all"; children: BuilderLogicExpr[] }
  | { kind: "any"; children: BuilderLogicExpr[] };

/** Formato antigo (linear); convertido com {@link chainToExpr}. */
export type BuilderConditionChain = {
  parts: BuilderCondition[];
  between: BuilderLogicOp[];
};

export type BuilderEntryRule = {
  applyFilter: boolean;
  /** Se ``false``, o motor ignora esta entrada (rascunho preservado na UI). Omisso = activo. */
  enabled?: boolean;
  /** Texto editável no builder (uma linha); tem precedência sobre ``expr`` ao compilar. */
  ifLine: string | null;
  expr: BuilderLogicExpr | null;
};

export type BuilderRules = {
  /** Uma linha; se preenchida, compila para ``filter``. */
  filterIf: string | null;
  filter: BuilderLogicExpr | null;
  /**
   * Zona long: define contexto direccional. Entrada long só é permitida nas velas em que
   * ainda estamos dentro da janela (inclui a vela em que a zona foi true e as ``zoneLongWaitCandles`` seguintes).
   */
  zoneLongIf: string | null;
  zoneLong: BuilderLogicExpr | null;
  zoneLongApplyFilter: boolean;
  zoneLongWaitCandles: number;
  zoneShortIf: string | null;
  zoneShort: BuilderLogicExpr | null;
  zoneShortApplyFilter: boolean;
  zoneShortWaitCandles: number;
  long: BuilderEntryRule | null;
  short: BuilderEntryRule | null;
  exitLongIf: string | null;
  exitShortIf: string | null;
  exitLong: BuilderLogicExpr | null;
  exitShort: BuilderLogicExpr | null;
  /**
   * Obrigatório quando usas ``entry(...)`` nas saídas: memoriza indicadores na entrada
   * e avalia saídas contra esses valores (e não só contra o valor actual da vela).
   */
  entrySnapEnabled?: boolean;
};

export type BuilderRisk = {
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
};

export type ChartBuilderSpecV1 = {
  version: 1;
  name: string;
  indicators: StrategyIndicator[];
  rules: BuilderRules;
  risk: BuilderRisk;
};

export type ChartBuilderParseResult =
  | { ok: true; spec: ChartBuilderSpecV1 }
  | { ok: false; errors: string[] };

export function operandContainsEntrySnap(op: BuilderOperand): boolean {
  if (op.type === "entry_snap") return true;
  if (op.type === "adjusted") return operandContainsEntrySnap(op.inner);
  return false;
}

export function walkOperandsInLogicExpr(
  expr: BuilderLogicExpr | null,
  fn: (op: BuilderOperand) => void,
): void {
  if (!expr) return;
  if (expr.kind === "atom") {
    fn(expr.condition.left);
    fn(expr.condition.right);
    return;
  }
  for (const ch of expr.children) walkOperandsInLogicExpr(ch, fn);
}

export function logicExprContainsEntrySnap(expr: BuilderLogicExpr | null): boolean {
  let hit = false;
  walkOperandsInLogicExpr(expr, (op) => {
    if (operandContainsEntrySnap(op)) hit = true;
  });
  return hit;
}

/** Converte cadeia linear (assoc. à esquerda) na árvore equivalente. */
export function chainToExpr(chain: BuilderConditionChain): BuilderLogicExpr {
  if (chain.parts.length === 0) {
    throw new Error("chain vazia");
  }
  if (chain.parts.length === 1) {
    return { kind: "atom", condition: chain.parts[0]! };
  }
  let acc: BuilderLogicExpr = { kind: "atom", condition: chain.parts[0]! };
  for (let j = 0; j < chain.between.length; j++) {
    const right: BuilderLogicExpr = { kind: "atom", condition: chain.parts[j + 1]! };
    if (chain.between[j] === "and") {
      acc = { kind: "all", children: [acc, right] };
    } else {
      acc = { kind: "any", children: [acc, right] };
    }
  }
  return acc;
}

export function defaultLogicExprFromSpec(spec: Pick<ChartBuilderSpecV1, "indicators">): BuilderLogicExpr {
  return {
    kind: "atom",
    condition: {
      left: { type: "indicator", ref: spec.indicators[0]?.id ?? "" },
      right: { type: "constant", value: 0 },
      op: "gt",
    },
  };
}

function parseIndicator(raw: unknown, errs: string[]): StrategyIndicator | null {
  if (!raw || typeof raw !== "object") {
    errs.push("indicador inválido");
    return null;
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const label = typeof o.label === "string" ? o.label : id;
  const legacyKind = typeof o.kind === "string" ? o.kind.trim() : "";
  const group = o.group as StrategyIndicator["group"];
  if (group !== "overlays" && group !== "studies") {
    errs.push(`group inválido: ${String(o.group)}`);
    return null;
  }
  if (!id) {
    errs.push("indicador sem id");
    return null;
  }
  const pr = o.params;
  let params: StrategyIndicator["params"] | undefined;
  if (pr && typeof pr === "object") {
    const p = pr as Record<string, unknown>;
    params = {};
    if (typeof p.period === "number" && Number.isFinite(p.period)) params.period = p.period;
    if (typeof p.mult === "number" && Number.isFinite(p.mult)) params.mult = p.mult;
    if (typeof p.fast === "number" && Number.isFinite(p.fast)) params.fast = p.fast;
    if (typeof p.slow === "number" && Number.isFinite(p.slow)) params.slow = p.slow;
    if (typeof p.signal === "number" && Number.isFinite(p.signal)) params.signal = p.signal;
    if (typeof p.deltaLookbackBars === "number" && Number.isFinite(p.deltaLookbackBars)) {
      params.deltaLookbackBars = p.deltaLookbackBars;
    }
    if (typeof p.deltaNormalizeByPrice === "boolean") params.deltaNormalizeByPrice = p.deltaNormalizeByPrice;
    if (typeof p.source === "string" && (INDICATOR_SOURCES as readonly string[]).includes(p.source)) {
      params.source = p.source as IndicatorSource;
    }
    if (typeof p.timeframe === "string" && (INDICATOR_TIMEFRAMES as readonly string[]).includes(p.timeframe)) {
      params.timeframe = p.timeframe as IndicatorTimeframe;
    }
    if (typeof p.talibFunction === "string" && p.talibFunction.trim()) {
      params.talibFunction = p.talibFunction.trim();
    }
    if (legacyKind === "trend_composite") {
      params.trendComposite = normalizeTrendCompositeParams(p.trendComposite ?? p);
    }
    const derived = p.derived;
    if (derived && typeof derived === "object" && !Array.isArray(derived)) {
      const d = derived as Record<string, unknown>;
      const mode = d.mode === "formula" ? "formula" : d.mode === "chain" ? "chain" : null;
      if (mode) {
        const out: NonNullable<NonNullable<StrategyIndicator["params"]>["derived"]> = { mode };
        if (typeof d.inputRef === "string" && d.inputRef.trim()) out.inputRef = d.inputRef.trim();
        if (typeof d.transform === "string" && d.transform.trim()) {
          const tr = d.transform.trim().toLowerCase();
          if (["ema", "sma", "rsi", "delta", "roc", "abs", "normalize"].includes(tr)) {
            out.transform = tr as NonNullable<typeof out.transform>;
          }
        }
        if (typeof d.formula === "string" && d.formula.trim()) out.formula = d.formula.trim();
        const dp = d.params;
        if (dp && typeof dp === "object" && !Array.isArray(dp)) {
          const numMap: Record<string, number> = {};
          for (const [k, v] of Object.entries(dp as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v)) numMap[k] = v;
          }
          if (Object.keys(numMap).length) out.params = numMap;
        }
        params.derived = out;
      }
    }
    const tp = p.talibParams;
    if (tp && typeof tp === "object" && !Array.isArray(tp)) {
      const numMap: Record<string, number> = {};
      for (const [k, v] of Object.entries(tp as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) numMap[k] = v;
      }
      if (Object.keys(numMap).length) params.talibParams = numMap;
    }
    if (Object.keys(params).length === 0) params = undefined;
  } else {
    params = undefined;
  }
  const migrated = migrateLegacyIndicatorToTalib({
    id,
    label,
    group,
    kind: legacyKind,
    params,
  });
  if (!migrated) {
    errs.push(`kind inválido ou não suportado: ${String(o.kind)}`);
    return null;
  }
  if (migrated.kind === "talib" && (!migrated.params?.talibFunction?.trim())) {
    errs.push("indicador talib exige params.talibFunction");
    return null;
  }
  return migrated;
}

function isFeatOperandRef(ref: string): boolean {
  return /^feat_[a-z][a-z0-9_]*$/i.test(ref.trim());
}

function parseOperand(raw: unknown, indicatorIds: Set<string>, errs: string[]): BuilderOperand | null {
  if (!raw || typeof raw !== "object") {
    errs.push("operando inválido");
    return null;
  }
  const o = raw as Record<string, unknown>;
  const t = o.type;
  if (t === "constant") {
    const v = o.value;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errs.push("constante inválida");
      return null;
    }
    return { type: "constant", value: v };
  }
  if (t === "indicator") {
    let ref = typeof o.ref === "string" ? o.ref.trim() : "";
    if (!ref) {
      errs.push("ref de indicador desconhecida: (vazio)");
      return null;
    }
    const deltaBaseRef = splitBuilderDeltaRef(ref);
    if (isFeatOperandRef(ref)) ref = ref.toLowerCase();
    else if (deltaBaseRef && indicatorIds.has(deltaBaseRef)) {
      ref = ref.trim();
    } else if (!indicatorIds.has(ref)) {
      errs.push(`ref de indicador desconhecida: ${ref}`);
      return null;
    }
    const band = o.bollingerBand;
    if (band != null) {
      if (!BOLLINGER_BANDS.includes(band as BollingerBand)) {
        errs.push(`bollingerBand inválido: ${String(band)}`);
        return null;
      }
      return { type: "indicator", ref, bollingerBand: band as BollingerBand, ...parseShift(o, errs) };
    }
    return { type: "indicator", ref, ...parseShift(o, errs) };
  }
  if (t === "entry_snap") {
    let ref = typeof o.ref === "string" ? o.ref.trim() : "";
    if (!ref) {
      errs.push("entry_snap: ref vazia");
      return null;
    }
    const deltaBaseRef = splitBuilderDeltaRef(ref);
    if (isFeatOperandRef(ref)) ref = ref.toLowerCase();
    else if (deltaBaseRef && indicatorIds.has(deltaBaseRef)) {
      ref = ref.trim();
    } else if (!indicatorIds.has(ref) && ref !== "close") {
      errs.push(`entry_snap: ref desconhecida: ${ref}`);
      return null;
    }
    const band = o.bollingerBand;
    if (band != null) {
      if (!BOLLINGER_BANDS.includes(band as BollingerBand)) {
        errs.push(`entry_snap: bollingerBand inválido: ${String(band)}`);
        return null;
      }
      return { type: "entry_snap", ref, bollingerBand: band as BollingerBand };
    }
    return { type: "entry_snap", ref };
  }
  if (t === "adjusted") {
    const inner = parseOperand(o.inner, indicatorIds, errs);
    const add = o.add;
    if (!inner || typeof add !== "number" || !Number.isFinite(add)) {
      errs.push("adjusted: inner e add inválidos");
      return null;
    }
    if (inner.type !== "entry_snap") {
      errs.push("adjusted só pode envolver entry_snap");
      return null;
    }
    return { type: "adjusted", inner, add };
  }
  errs.push(`tipo de operando inválido: ${String(t)}`);
  return null;
}

function parseShift(o: Record<string, unknown>, errs: string[]): { shift?: number } {
  const sh = o.shift;
  if (sh == null) return {};
  if (typeof sh !== "number" || !Number.isInteger(sh) || sh < 0 || sh > 500) {
    errs.push("shift inválido (inteiro 0…500)");
    return {};
  }
  return sh > 0 ? { shift: sh } : {};
}

function parseCondition(
  raw: unknown,
  indicatorIds: Set<string>,
  errs: string[],
): BuilderCondition | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    errs.push("condição inválida");
    return null;
  }
  const o = raw as Record<string, unknown>;
  const op = o.op;
  if (!BUILDER_OPS.includes(op as BuilderOp)) {
    errs.push(`op inválido: ${String(op)}`);
    return null;
  }
  const left = parseOperand(o.left, indicatorIds, errs);
  const right = parseOperand(o.right, indicatorIds, errs);
  if (!left || !right) return null;
  return { left, right, op: op as BuilderOp };
}

function parseConditionChain(
  raw: unknown,
  indicatorIds: Set<string>,
  errs: string[],
): BuilderConditionChain | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    errs.push("cadeia de condições inválida");
    return null;
  }
  const o = raw as Record<string, unknown>;
  const partsRaw = o.parts;
  if (!Array.isArray(partsRaw) || partsRaw.length === 0) return null;
  const parts: BuilderCondition[] = [];
  for (const p of partsRaw) {
    const c = parseCondition(p, indicatorIds, errs);
    if (!c) return null;
    parts.push(c);
  }
  let between: BuilderLogicOp[] = [];
  const betweenRaw = o.between;
  if (Array.isArray(betweenRaw)) {
    for (let i = 0; i < parts.length - 1; i++) {
      const b = betweenRaw[i];
      if (b !== "and" && b !== "or") {
        errs.push(`operador lógico inválido: ${String(b)}`);
        return null;
      }
      between.push(b);
    }
  }
  if (parts.length === 1) {
    if (between.length > 0) {
      errs.push("cadeia: sem operadores entre condições quando há só uma parte");
      return null;
    }
  } else if (between.length !== parts.length - 1) {
    if (between.length === 0) {
      between = Array.from({ length: parts.length - 1 }, () => "and" as const);
    } else {
      errs.push("cadeia: número de AND/OR não coincide com as condições");
      return null;
    }
  }
  return { parts, between };
}

function parseLogicExpr(
  raw: unknown,
  indicatorIds: Set<string>,
  errs: string[],
): BuilderLogicExpr | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    errs.push("expressão lógica inválida");
    return null;
  }
  const o = raw as Record<string, unknown>;
  if ("parts" in o && Array.isArray(o.parts)) {
    const ch = parseConditionChain(raw, indicatorIds, errs);
    if (!ch) return null;
    try {
      return chainToExpr(ch);
    } catch {
      errs.push("cadeia inválida");
      return null;
    }
  }
  if ("left" in o && "op" in o && !("kind" in o)) {
    const c = parseCondition(raw, indicatorIds, errs);
    if (!c) return null;
    return { kind: "atom", condition: c };
  }
  const kind = o.kind;
  if (kind === "atom") {
    const c = parseCondition(o.condition, indicatorIds, errs);
    if (!c) return null;
    return { kind: "atom", condition: c };
  }
  if (kind === "all" || kind === "any") {
    const chRaw = o.children;
    if (!Array.isArray(chRaw) || chRaw.length === 0) {
      errs.push(`${kind}: children obrigatório (mín. 1)`);
      return null;
    }
    const children: BuilderLogicExpr[] = [];
    for (const item of chRaw) {
      const ex = parseLogicExpr(item, indicatorIds, errs);
      if (!ex) return null;
      children.push(ex);
    }
    return kind === "all" ? { kind: "all", children } : { kind: "any", children };
  }
  errs.push(`kind de expressão desconhecido: ${String(kind)}`);
  return null;
}

function parseEntryRule(
  raw: unknown,
  indicators: StrategyIndicator[],
  indicatorIds: Set<string>,
  errs: string[],
  label: "entrada long" | "entrada short",
): BuilderEntryRule | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    errs.push("regra de entrada inválida");
    return null;
  }
  const o = raw as Record<string, unknown>;
  const applyFilter = o.applyFilter === true;
  const disabledUi = o.enabled === false;
  const ifLineRaw = typeof o.ifLine === "string" ? o.ifLine : null;
  let expr: BuilderLogicExpr | null = null;

  if (disabledUi) {
    const trimmed = ifLineRaw?.trim() ?? "";
    if (trimmed) {
      const r = parseBuilderIfLine(trimmed, indicators);
      if (r.ok) expr = r.expr;
    } else if ("expr" in o && o.expr != null) {
      expr = parseLogicExpr(o.expr, indicatorIds, errs);
    } else if ("chain" in o && o.chain != null) {
      const chain = parseConditionChain(o.chain, indicatorIds, errs);
      if (chain) {
        try {
          expr = chainToExpr(chain);
        } catch {
          errs.push(`${label}: chain inválida`);
        }
      }
    } else if ("left" in o) {
      const c = parseCondition(raw, indicatorIds, errs);
      if (c) expr = { kind: "atom", condition: c };
    }
    return {
      applyFilter,
      enabled: false,
      ifLine: trimmed || null,
      expr,
    };
  }

  if (ifLineRaw !== null && !ifLineRaw.trim() && !("expr" in o && o.expr != null)) {
    errs.push(`${label}: linha de condição vazia (preenche ou desactiva a entrada)`);
    return null;
  }

  if (ifLineRaw?.trim()) {
    const r = parseBuilderIfLine(ifLineRaw.trim(), indicators);
    if (r.ok) expr = r.expr;
    else for (const e of r.errors) errs.push(`${label}: ${e}`);
  } else if ("expr" in o && o.expr != null) {
    expr = parseLogicExpr(o.expr, indicatorIds, errs);
  } else if ("chain" in o && o.chain != null) {
    const chain = parseConditionChain(o.chain, indicatorIds, errs);
    if (chain) {
      try {
        expr = chainToExpr(chain);
      } catch {
        errs.push(`${label}: chain inválida`);
      }
    }
  } else if ("left" in o) {
    const c = parseCondition(raw, indicatorIds, errs);
    if (c) expr = { kind: "atom", condition: c };
  }
  if (!expr) return null;
  return {
    applyFilter,
    ifLine: ifLineRaw?.trim() ? ifLineRaw.trim() : null,
    expr,
  };
}

function parseExitExpr(
  raw: unknown,
  indicatorIds: Set<string>,
  errs: string[],
): BuilderLogicExpr | null {
  if (raw === null || raw === undefined) return null;
  return parseLogicExpr(raw, indicatorIds, errs);
}

/** ``rules.*If: ""`` vindo da BD / JSON → ``null`` para não falhar parse (desligado vs legado ``expr``). */
function normalizeBlankOptionalRuleStrings(rules: Record<string, unknown>): Record<string, unknown> {
  const out = { ...rules };
  if (typeof out.filterIf === "string" && !(out.filterIf as string).trim() && out.filter == null) {
    out.filterIf = null;
  }
  if (typeof out.zoneLongIf === "string" && !(out.zoneLongIf as string).trim() && out.zoneLong == null) {
    out.zoneLongIf = null;
  }
  if (typeof out.zoneShortIf === "string" && !(out.zoneShortIf as string).trim() && out.zoneShort == null) {
    out.zoneShortIf = null;
  }
  if (typeof out.exitLongIf === "string" && !(out.exitLongIf as string).trim() && out.exitLong == null) {
    out.exitLongIf = null;
  }
  if (typeof out.exitShortIf === "string" && !(out.exitShortIf as string).trim() && out.exitShort == null) {
    out.exitShortIf = null;
  }
  return out;
}

function parseRules(
  raw: unknown,
  indicators: StrategyIndicator[],
  errs: string[],
): BuilderRules | null {
  if (!raw || typeof raw !== "object") {
    errs.push("rules inválidas");
    return null;
  }
  const o = normalizeBlankOptionalRuleStrings(raw as Record<string, unknown>);
  const ids = new Set(indicators.map((x) => x.id));

  const filterIfStr = typeof o.filterIf === "string" ? o.filterIf : null;
  const filterIf = filterIfStr?.trim() ? filterIfStr.trim() : null;

  let filter: BuilderLogicExpr | null = null;
  if (filterIf) {
    const r = parseBuilderIfLine(filterIf, indicators);
    if (r.ok) filter = r.expr;
    else for (const e of r.errors) errs.push(`filtro: ${e}`);
  } else if (o.filter != null) {
    filter = parseLogicExpr(o.filter, ids, errs);
  }

  const zoneLongIfStr = typeof o.zoneLongIf === "string" ? o.zoneLongIf : null;
  const zoneLongIf = zoneLongIfStr?.trim() ? zoneLongIfStr.trim() : null;
  let zoneLong: BuilderLogicExpr | null = null;
  if (zoneLongIf) {
    const r = parseBuilderIfLine(zoneLongIf, indicators);
    if (r.ok) zoneLong = r.expr;
    else for (const e of r.errors) errs.push(`zona long: ${e}`);
  } else if (o.zoneLong != null) {
    zoneLong = parseLogicExpr(o.zoneLong, ids, errs);
  }

  const zoneShortIfStr = typeof o.zoneShortIf === "string" ? o.zoneShortIf : null;
  const zoneShortIf = zoneShortIfStr?.trim() ? zoneShortIfStr.trim() : null;
  let zoneShort: BuilderLogicExpr | null = null;
  if (zoneShortIf) {
    const r = parseBuilderIfLine(zoneShortIf, indicators);
    if (r.ok) zoneShort = r.expr;
    else for (const e of r.errors) errs.push(`zona short: ${e}`);
  } else if (o.zoneShort != null) {
    zoneShort = parseLogicExpr(o.zoneShort, ids, errs);
  }

  const zlw = o.zoneLongWaitCandles;
  const zoneLongApplyFilter = o.zoneLongApplyFilter !== false;
  let zoneLongWaitCandles = 10;
  if (typeof zlw === "number" && Number.isFinite(zlw)) {
    zoneLongWaitCandles = Math.max(0, Math.min(500, Math.round(zlw)));
  } else if (zlw != null) errs.push("zoneLongWaitCandles inválido");

  const zsw = o.zoneShortWaitCandles;
  const zoneShortApplyFilter = o.zoneShortApplyFilter !== false;
  let zoneShortWaitCandles = 10;
  if (typeof zsw === "number" && Number.isFinite(zsw)) {
    zoneShortWaitCandles = Math.max(0, Math.min(500, Math.round(zsw)));
  } else if (zsw != null) errs.push("zoneShortWaitCandles inválido");

  const long = parseEntryRule(o.long, indicators, ids, errs, "entrada long");
  const short = parseEntryRule(o.short, indicators, ids, errs, "entrada short");

  const exitLongIfStr = typeof o.exitLongIf === "string" ? o.exitLongIf : null;
  const exitLongIf = exitLongIfStr?.trim() ? exitLongIfStr.trim() : null;
  let exitLong: BuilderLogicExpr | null = null;
  if (exitLongIf) {
    const r = parseBuilderIfLine(exitLongIf, indicators);
    if (r.ok) exitLong = r.expr;
    else for (const e of r.errors) errs.push(`saída long: ${e}`);
  } else if (o.exitLong != null) {
    exitLong = parseExitExpr(o.exitLong, ids, errs);
  }

  const exitShortIfStr = typeof o.exitShortIf === "string" ? o.exitShortIf : null;
  const exitShortIf = exitShortIfStr?.trim() ? exitShortIfStr.trim() : null;
  let exitShort: BuilderLogicExpr | null = null;
  if (exitShortIf) {
    const r = parseBuilderIfLine(exitShortIf, indicators);
    if (r.ok) exitShort = r.expr;
    else for (const e of r.errors) errs.push(`saída short: ${e}`);
  } else if (o.exitShort != null) {
    exitShort = parseExitExpr(o.exitShort, ids, errs);
  }

  const entrySnapEnabled = o.entrySnapEnabled === true;

  const forbidEntrySnapOutsideExits = (expr: BuilderLogicExpr | null, label: string) => {
    walkOperandsInLogicExpr(expr, (op) => {
      if (operandContainsEntrySnap(op)) {
        errs.push(`${label}: entry(...) só é permitido nas condições de saída long/short.`);
      }
    });
  };

  forbidEntrySnapOutsideExits(filter, "filtro");
  forbidEntrySnapOutsideExits(zoneLong, "zona long");
  forbidEntrySnapOutsideExits(zoneShort, "zona short");
  if (long?.expr) forbidEntrySnapOutsideExits(long.expr, "entrada long");
  if (short?.expr) forbidEntrySnapOutsideExits(short.expr, "entrada short");

  const exitUsesSnap =
    logicExprContainsEntrySnap(exitLong) || logicExprContainsEntrySnap(exitShort);
  if (exitUsesSnap && !entrySnapEnabled) {
    errs.push(
      'Para usar entry(...) nas saídas, activa «Memorizar valores à entrada».',
    );
  }

  if (errs.length) return null;
  return {
    filterIf,
    filter,
    zoneLongIf,
    zoneLong,
    zoneLongApplyFilter,
    zoneLongWaitCandles,
    zoneShortIf,
    zoneShort,
    zoneShortApplyFilter,
    zoneShortWaitCandles,
    long,
    short,
    exitLongIf,
    exitShortIf,
    exitLong,
    exitShort,
    ...(entrySnapEnabled ? { entrySnapEnabled: true } : {}),
  };
}

/** Valida e normaliza spec v1 (paridade com validação mínima no FastAPI). */
export function parseChartBuilderSpec(raw: unknown): ChartBuilderParseResult {
  const errs: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["spec não é um objecto"] };
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) {
    errs.push(`version esperada 1, recebida ${String(o.version)}`);
  }
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) errs.push("name obrigatório");

  const indRaw = o.indicators;
  if (!Array.isArray(indRaw) || indRaw.length === 0) {
    errs.push("indicators: lista não vazia obrigatória");
  }
  const indicators: StrategyIndicator[] = [];
  const ids = new Set<string>();
  if (Array.isArray(indRaw)) {
    for (const ir of indRaw) {
      const ind = parseIndicator(ir, errs);
      if (!ind) continue;
      if (ids.has(ind.id)) errs.push(`id duplicado: ${ind.id}`);
      ids.add(ind.id);
      indicators.push(ind);
    }
  }

  const rules = parseRules(o.rules, indicators, errs);
  const riskRaw = o.risk;
  const risk: BuilderRisk = { takeProfitPct: 0, stopLossPct: 0, trailingStopPct: 0 };
  if (riskRaw && typeof riskRaw === "object") {
    const r = riskRaw as Record<string, unknown>;
    const tp = r.takeProfitPct;
    const sl = r.stopLossPct;
    const ts = r.trailingStopPct;
    if (typeof tp === "number" && Number.isFinite(tp) && tp >= 0 && tp <= 1000) {
      risk.takeProfitPct = tp;
    } else if (tp != null) errs.push("takeProfitPct inválido");
    if (typeof sl === "number" && Number.isFinite(sl) && sl >= 0 && sl <= 1000) {
      risk.stopLossPct = sl;
    } else if (sl != null) errs.push("stopLossPct inválido");
    if (typeof ts === "number" && Number.isFinite(ts) && ts >= 0 && ts <= 1000) {
      risk.trailingStopPct = ts;
    } else if (ts != null) errs.push("trailingStopPct inválido");
  }

  if (!rules) {
    if (!errs.includes("rules inválidas")) errs.push("rules em falta ou inválidas");
  }

  if (errs.length) return { ok: false, errors: errs };

  return {
    ok: true,
    spec: {
      version: 1,
      name,
      indicators,
      rules: rules!,
      risk,
    },
  };
}

export const BUILDER_STRATEGY_ID_PREFIX = "builder_" as const;

export function toBuilderStrategyRowId(uuid: string): string {
  return `${BUILDER_STRATEGY_ID_PREFIX}${uuid}`;
}

export function extractBuilderUuidFromStrategyId(strategyId: string): string | null {
  if (!strategyId.startsWith(BUILDER_STRATEGY_ID_PREFIX)) return null;
  const u = strategyId.slice(BUILDER_STRATEGY_ID_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(u)
    ? u
    : null;
}

export function defaultChartBuilderSpec(): ChartBuilderSpecV1 {
  return {
    version: 1,
    name: "Nova estratégia",
    indicators: [
      {
        id: "t1",
        label: "RSI",
        group: "studies",
        kind: "talib",
        params: { talibFunction: "RSI", talibParams: { timeperiod: 14 }, source: "close" },
      },
    ],
    rules: {
      filterIf: null,
      filter: null,
      zoneLongIf: null,
      zoneLong: null,
      zoneLongApplyFilter: true,
      zoneLongWaitCandles: 10,
      zoneShortIf: null,
      zoneShort: null,
      zoneShortApplyFilter: true,
      zoneShortWaitCandles: 10,
      long: null,
      short: null,
      exitLongIf: null,
      exitShortIf: null,
      exitLong: null,
      exitShort: null,
      entrySnapEnabled: false,
    },
    risk: { takeProfitPct: 2, stopLossPct: 1, trailingStopPct: 0 },
  };
}
