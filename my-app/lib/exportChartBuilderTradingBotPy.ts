/**
 * Exporta estratégias do Chart Builder para `.py` no formato TradingBot
 * (imports configs/, `indicators(df)`, `strategy(self, df)`, `run(bot)`).
 *
 * Gera cálculo de indicadores (talib + derivados + Δ) e expressões IF compiladas
 * a partir do mesmo AST que o motor `builderEngine.ts`, sem JSON embutido.
 */

import type {
  BuilderCondition,
  BuilderLogicExpr,
  BuilderOperand,
  BuilderOp,
  BuilderRules,
  ChartBuilderSpecV1,
} from "@/lib/chartBuilderSpec";
import { logicExprContainsEntrySnap } from "@/lib/chartBuilderSpec";
import { parseBuilderIfLine } from "@/lib/builderIfParser";
import { splitBuilderDeltaRef } from "@/lib/builderDeltaRef";
import {
  effectiveDeltaLookbackBars,
  effectiveDeltaNormalizeByPrice,
  INDICATOR_DELTA_DISPLAY_SCALE,
} from "@/lib/indicatorDeltaTransform";
import type { StrategyIndicator } from "@/lib/strategies";

const OHLC_REFS = new Set(["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"]);

function escapePyStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function slugFromName(name: string): string {
  const base = (name ?? "").trim() || "chart_strategy";
  return (
    base
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "chart_strategy"
  );
}

function effectiveExpr(
  ifStr: string | null | undefined,
  fb: BuilderLogicExpr | null,
  indicators: StrategyIndicator[],
): BuilderLogicExpr | null {
  const t = ifStr?.trim();
  if (!t) return fb;
  const r = parseBuilderIfLine(t, indicators);
  return r.ok ? r.expr : fb;
}

function effectiveFilterExpr(rules: BuilderRules, indicators: StrategyIndicator[]) {
  return effectiveExpr(rules.filterIf, rules.filter, indicators);
}

function effectiveZoneLongExpr(rules: BuilderRules, indicators: StrategyIndicator[]) {
  return effectiveExpr(rules.zoneLongIf, rules.zoneLong, indicators);
}

function effectiveZoneShortExpr(rules: BuilderRules, indicators: StrategyIndicator[]) {
  return effectiveExpr(rules.zoneShortIf, rules.zoneShort, indicators);
}

function effectiveExitExpr(
  ifStr: string | null | undefined,
  fb: BuilderLogicExpr | null,
  indicators: StrategyIndicator[],
) {
  return effectiveExpr(ifStr, fb, indicators);
}

function effectiveEntryExpr(
  rule: ChartBuilderSpecV1["rules"]["long"],
  indicators: StrategyIndicator[],
): BuilderLogicExpr | null {
  if (!rule || rule.enabled === false) return null;
  return effectiveExpr(rule.ifLine, rule.expr, indicators);
}

function walkOperandRefs(op: BuilderOperand, visit: (op: Extract<BuilderOperand, { type: "indicator" }>) => void): void {
  if (op.type === "indicator") visit(op);
  else if (op.type === "entry_snap") {
    visit({
      type: "indicator",
      ref: op.ref,
      ...(op.bollingerBand ? { bollingerBand: op.bollingerBand } : {}),
    });
  } else if (op.type === "adjusted") walkOperandRefs(op.inner, visit);
}

function walkConditionRefs(c: BuilderCondition, visit: (op: Extract<BuilderOperand, { type: "indicator" }>) => void): void {
  walkOperandRefs(c.left, visit);
  walkOperandRefs(c.right, visit);
}

function walkLogicRefs(expr: BuilderLogicExpr | null, visit: (op: Extract<BuilderOperand, { type: "indicator" }>) => void): void {
  if (!expr) return;
  if (expr.kind === "atom") {
    walkConditionRefs(expr.condition, visit);
    return;
  }
  for (const ch of expr.children) walkLogicRefs(ch, visit);
}

function collectRefOperands(spec: ChartBuilderSpecV1): Extract<BuilderOperand, { type: "indicator" }>[] {
  const ind = spec.indicators;
  const out: Extract<BuilderOperand, { type: "indicator" }>[] = [];
  const push = (op: Extract<BuilderOperand, { type: "indicator" }>) => out.push(op);

  const fromLine = (line: string | null | undefined) => {
    const t = line?.trim();
    if (!t) return;
    const r = parseBuilderIfLine(t, ind);
    if (r.ok) walkLogicRefs(r.expr, push);
  };

  fromLine(spec.rules.filterIf);
  walkLogicRefs(spec.rules.filter, push);
  fromLine(spec.rules.zoneLongIf);
  walkLogicRefs(spec.rules.zoneLong, push);
  fromLine(spec.rules.zoneShortIf);
  walkLogicRefs(spec.rules.zoneShort, push);
  fromLine(spec.rules.long?.ifLine);
  walkLogicRefs(spec.rules.long?.expr ?? null, push);
  fromLine(spec.rules.short?.ifLine);
  walkLogicRefs(spec.rules.short?.expr ?? null, push);
  fromLine(spec.rules.exitLongIf);
  walkLogicRefs(spec.rules.exitLong, push);
  fromLine(spec.rules.exitShortIf);
  walkLogicRefs(spec.rules.exitShort, push);
  return out;
}

function bbCol(ref: string, band: "upper" | "mid" | "lower"): string {
  return `${ref}_${band}`;
}

function priceSeriesPy(ind: StrategyIndicator): string {
  const src = ind.params?.source ?? "close";
  return `df["${src}"].astype(float)`;
}

function topoSortIndicators(items: StrategyIndicator[]): StrategyIndicator[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const deps = new Map<string, Set<string>>();
  for (const ind of items) {
    const d = new Set<string>();
    if (ind.kind === "derived" && ind.params?.derived?.mode === "chain") {
      const ir = ind.params.derived.inputRef?.trim() ?? "";
      if (ir && !OHLC_REFS.has(ir) && byId.has(ir)) d.add(ir);
    }
    deps.set(ind.id, d);
  }
  const out: StrategyIndicator[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    for (const p of deps.get(id) ?? []) visit(p);
    visiting.delete(id);
    visited.add(id);
    const ind = byId.get(id);
    if (ind) out.push(ind);
  }
  for (const ind of items) visit(ind.id);
  return out;
}

function collectDeltaTargets(spec: ChartBuilderSpecV1): { base: string; col: string; lb: number; norm: boolean }[] {
  const refs = new Set<string>();
  for (const op of collectRefOperands(spec)) {
    const b = splitBuilderDeltaRef(op.ref);
    if (b) refs.add(b);
  }
  const out: { base: string; col: string; lb: number; norm: boolean }[] = [];
  const seen = new Set<string>();
  for (const base of refs) {
    const ind = spec.indicators.find((x) => x.id === base);
    const lb = ind ? effectiveDeltaLookbackBars(ind.params ?? {}) : 0;
    const norm = ind ? effectiveDeltaNormalizeByPrice(ind.params ?? {}) : true;
    const col = `${base}_delta`;
    const key = `${base}|${lb}|${norm ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ base, col, lb, norm });
  }
  return out;
}

function entrySnapKey(op: Extract<BuilderOperand, { type: "entry_snap" }>): string {
  return op.bollingerBand ? `${op.ref}|${op.bollingerBand}` : op.ref;
}

function collectEntrySnapLeaves(expr: BuilderLogicExpr | null): Extract<BuilderOperand, { type: "entry_snap" }>[] {
  const acc: Extract<BuilderOperand, { type: "entry_snap" }>[] = [];
  const walkOp = (op: BuilderOperand) => {
    if (op.type === "entry_snap") acc.push(op);
    else if (op.type === "adjusted") walkOp(op.inner);
  };
  const walk = (ex: BuilderLogicExpr | null) => {
    if (!ex) return;
    if (ex.kind === "atom") {
      walkOp(ex.condition.left);
      walkOp(ex.condition.right);
      return;
    }
    for (const ch of ex.children) walk(ch);
  };
  walk(expr);
  return acc;
}

function uniqEntrySnapOperands(ops: Extract<BuilderOperand, { type: "entry_snap" }>[]): Extract<
  BuilderOperand,
  { type: "entry_snap" }
>[] {
  const seen = new Set<string>();
  const out: Extract<BuilderOperand, { type: "entry_snap" }>[] = [];
  for (const op of ops) {
    const k = entrySnapKey(op);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(op);
  }
  return out;
}

function emitTalibIndicator(ind: StrategyIndicator, warnings: string[]): string[] {
  const fn = (ind.params?.talibFunction ?? "").trim().toUpperCase();
  const tp = ind.params?.talibParams ?? {};
  const lines: string[] = [];
  const src = priceSeriesPy(ind);
  const id = ind.id;

  if (fn === "RSI") {
    const n = Math.round(Number(tp.timeperiod ?? ind.params?.period ?? 14));
    lines.push(`_${id}_rsi = talib.RSI(${src}.values, timeperiod=${n})`);
    lines.push(`df["${id}"] = pd.Series(_${id}_rsi, index=df.index).astype(float)`);
    return lines;
  }
  if (fn === "EMA") {
    const n = Math.round(Number(tp.timeperiod ?? ind.params?.period ?? 20));
    lines.push(`_${id}_ema = talib.EMA(${src}.values, timeperiod=${n})`);
    lines.push(`df["${id}"] = pd.Series(_${id}_ema, index=df.index).astype(float)`);
    return lines;
  }
  if (fn === "SMA") {
    const n = Math.round(Number(tp.timeperiod ?? ind.params?.period ?? 20));
    lines.push(`_${id}_sma = talib.SMA(${src}.values, timeperiod=${n})`);
    lines.push(`df["${id}"] = pd.Series(_${id}_sma, index=df.index).astype(float)`);
    return lines;
  }
  if (fn === "BBANDS") {
    const n = Math.round(Number(tp.timeperiod ?? ind.params?.period ?? 20));
    const nu = Number(tp.nbdevup ?? 2);
    const nd = Number(tp.nbdevdn ?? 2);
    const mat = Math.round(Number(tp.matype ?? 0));
    lines.push(
      `_${id}_u, _${id}_m, _${id}_l = talib.BBANDS(${src}.values, timeperiod=${n}, nbdevup=${nu}, nbdevdn=${nd}, matype=${mat})`,
    );
    lines.push(`df["${bbCol(id, "upper")}"] = pd.Series(_${id}_u, index=df.index).astype(float)`);
    lines.push(`df["${bbCol(id, "mid")}"] = pd.Series(_${id}_m, index=df.index).astype(float)`);
    lines.push(`df["${bbCol(id, "lower")}"] = pd.Series(_${id}_l, index=df.index).astype(float)`);
    lines.push(`df["${id}"] = df["${bbCol(id, "mid")}"]`);
    return lines;
  }
  if (fn === "MACD") {
    const fp = Math.round(Number(tp.fastperiod ?? 12));
    const sp = Math.round(Number(tp.slowperiod ?? 26));
    const sig = Math.round(Number(tp.signalperiod ?? 9));
    lines.push(
      `_${id}_macd, _${id}_signal, _${id}_hist = talib.MACD(${src}.values, fastperiod=${fp}, slowperiod=${sp}, signalperiod=${sig})`,
    );
    lines.push(`df["${id}"] = pd.Series(_${id}_macd, index=df.index).astype(float)`);
    lines.push(`df["${id}_signal"] = pd.Series(_${id}_signal, index=df.index).astype(float)`);
    lines.push(`df["${id}_hist"] = pd.Series(_${id}_hist, index=df.index).astype(float)`);
    return lines;
  }

  warnings.push(`Indicador TA-Lib «${fn}» (${id}): geração automática incompleta — completa manualmente com talib.${fn}.`);
  lines.push(`# TODO: talib.${fn} para id="${id}" — params=${JSON.stringify(tp)}`);
  lines.push(`df["${id}"] = np.nan`);
  return lines;
}

function derivedInputSeriesPy(ref: string): string {
  if (OHLC_REFS.has(ref)) {
    if (ref === "hl2") return `(df["high"] + df["low"]) / 2.0`;
    if (ref === "hlc3") return `(df["high"] + df["low"] + df["close"]) / 3.0`;
    if (ref === "ohlc4") return `(df["open"] + df["high"] + df["low"] + df["close"]) / 4.0`;
    return `df["${ref}"].astype(float)`;
  }
  return `df["${ref}"].astype(float)`;
}

function emitDerivedChain(ind: StrategyIndicator, warnings: string[]): string[] {
  const d = ind.params?.derived;
  const id = ind.id;
  if (!d || d.mode !== "chain") return [`df["${id}"] = np.nan`];
  const tr = (d.transform ?? "ema").toLowerCase();
  const p = d.params ?? {};
  const period = Math.round(Number(p.period ?? p.timeperiod ?? p.length ?? 14));
  const lookback = Math.round(Number(p.lookback ?? p.bars ?? p.period ?? 1));
  const srcPy = derivedInputSeriesPy((d.inputRef ?? "close").trim());

  const lines: string[] = [];
  lines.push(`_${id}_x = ${srcPy}`);

  if (tr === "ema") {
    const n = Math.max(1, Math.min(1000, period || 14));
    lines.push(`df["${id}"] = _${id}_x.ewm(span=${n}, adjust=False).mean()`);
    return lines;
  }
  if (tr === "sma") {
    const n = Math.max(1, Math.min(1000, period || 14));
    lines.push(`df["${id}"] = _${id}_x.rolling(window=${n}, min_periods=${n}).mean()`);
    return lines;
  }
  if (tr === "rsi") {
    const n = Math.max(2, Math.min(1000, period || 14));
    lines.push(`df["${id}"] = pd.Series(talib.RSI(_${id}_x.values, timeperiod=${n}), index=df.index).astype(float)`);
    return lines;
  }
  if (tr === "delta") {
    const lb = Math.max(1, Math.min(5000, lookback || 1));
    lines.push(`df["${id}"] = _${id}_x - _${id}_x.shift(${lb})`);
    return lines;
  }
  if (tr === "roc") {
    const lb = Math.max(1, Math.min(5000, lookback || 1));
    lines.push(`df["${id}"] = (_${id}_x - _${id}_x.shift(${lb})) / _${id}_x.shift(${lb}).replace(0.0, np.nan)`);
    return lines;
  }
  if (tr === "abs") {
    lines.push(`df["${id}"] = np.abs(_${id}_x)`);
    return lines;
  }
  if (tr === "normalize" || tr === "normalise") {
    const n = Math.max(2, Math.min(1000, period || 14));
    lines.push(`_${id}_m = _${id}_x.rolling(window=${n}, min_periods=${n}).mean()`);
    lines.push(`_${id}_s = _${id}_x.rolling(window=${n}, min_periods=${n}).std(ddof=0).replace(0.0, np.nan)`);
    lines.push(`df["${id}"] = (_${id}_x - _${id}_m) / _${id}_s`);
    return lines;
  }

  warnings.push(`Derivado ${id}: transformação «${tr}» não suportada na exportação.`);
  lines.push(`df["${id}"] = np.nan`);
  return lines;
}

function emitIndicatorsSection(spec: ChartBuilderSpecV1, warnings: string[]): string {
  const ordered = topoSortIndicators(spec.indicators);
  const lines: string[] = [];

  lines.push(`    # --- OHLCV esperado: open, high, low, close, volume ---`);

  for (const ind of ordered) {
    lines.push(`    # ${ind.id}: ${ind.kind} · ${ind.label}`);
    if (ind.kind === "talib") {
      lines.push(...emitTalibIndicator(ind, warnings).map((x) => `    ${x}`));
      continue;
    }
    if (ind.kind === "derived") {
      const d = ind.params?.derived;
      if (d?.mode === "formula") {
        warnings.push(`Indicador ${ind.id}: modo fórmula («${d.formula ?? ""}») — implementa manualmente.`);
        lines.push(`    df["${ind.id}"] = np.nan  # TODO formula: ${(d.formula ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
        continue;
      }
      lines.push(...emitDerivedChain(ind, warnings).map((x) => `    ${x}`));
      continue;
    }
    warnings.push(`Kind «${ind.kind}» (${ind.id}) não migrado — usa só talib/derived no builder.`);
    lines.push(`    df["${ind.id}"] = np.nan`);
  }

  const deltas = collectDeltaTargets(spec);
  for (const { base, col, lb, norm } of deltas) {
    if (lb < 1) {
      warnings.push(`Δ ${base}: lookback inválido — coluna ${col} ficou NaN.`);
      lines.push(`    df["${col}"] = np.nan`);
      continue;
    }
    const scale = INDICATOR_DELTA_DISPLAY_SCALE;
    if (norm) {
      lines.push(`    _d_raw = df["${base}"] - df["${base}"].shift(${lb})`);
      lines.push(`    df["${col}"] = (_d_raw / df["close"].replace(0.0, np.nan)) * ${scale}`);
    } else {
      lines.push(`    df["${col}"] = (df["${base}"] - df["${base}"].shift(${lb})) * ${scale}`);
    }
  }

  const ops = collectRefOperands(spec);
  for (const op of ops) {
    if (op.shift && op.shift > 0) {
      warnings.push(
        `Deslocamento [${op.shift}] em «${op.ref}»: em timeframe superior o builder alinha por tempo; aqui usa-se índice simples j−${op.shift}.`,
      );
    }
    if (op.ref.startsWith("feat_")) {
      lines.push(`    if "${op.ref}" not in df.columns:`);
      lines.push(`        df["${op.ref}"] = np.nan  # série QuestDB / facetas — preencher na ingestão`);
    }
  }

  return lines.join("\n");
}

/** Série pandas sem .shift — o deslocamento MTF/[n] aplica-se só no índice da barra (como no builderEngine). */
function operandSeriesAccessorPlain(op: Extract<BuilderOperand, { type: "indicator" }>): string {
  if (op.ref === "close") return `df["close"]`;
  if (op.bollingerBand) return `df["${bbCol(op.ref, op.bollingerBand)}"]`;
  return `df["${op.ref}"]`;
}

function operandValuePyFixed(op: BuilderOperand, jExpr: string): string {
  if (op.type === "constant") return String(op.value);
  if (op.type === "adjusted") {
    const inner = op.inner;
    if (inner.type !== "entry_snap") return "np.nan";
    const base = `_entry_snap_get(self, "${escapePyStr(entrySnapKey(inner))}")`;
    const add = op.add;
    return `((${base}) + ${add}) if pd.notna(${base}) else np.nan`;
  }
  if (op.type === "entry_snap") {
    return `_entry_snap_get(self, "${escapePyStr(entrySnapKey(op))}")`;
  }
  const indOp = op as Extract<BuilderOperand, { type: "indicator" }>;
  const ser = operandSeriesAccessorPlain(indOp);
  const sh = indOp.shift ?? 0;
  const ji = sh > 0 ? `(${jExpr} - ${sh})` : jExpr;
  return `_fv(${ser}, ${ji})`;
}

function comparisonToPyFixed(cond: BuilderCondition, jExpr: string): string {
  const Lc = operandValuePyFixed(cond.left, jExpr);
  const Rc = operandValuePyFixed(cond.right, jExpr);
  const Lp = operandValuePyFixed(cond.left, `(${jExpr} - 1)`);
  const Rp = operandValuePyFixed(cond.right, `(${jExpr} - 1)`);
  switch (cond.op as BuilderOp) {
    case "gt":
      return `((${Lc}) > (${Rc}))`;
    case "lt":
      return `((${Lc}) < (${Rc}))`;
    case "ge":
      return `((${Lc}) >= (${Rc}))`;
    case "le":
      return `((${Lc}) <= (${Rc}))`;
    case "eq":
      return `(abs((${Lc}) - (${Rc})) <= 1e-9 * max(1.0, abs(${Lc}), abs(${Rc})))`;
    case "cross_up":
      return `((${jExpr} > 0) and (${Lp}) <= (${Rp}) and (${Lc}) > (${Rc}))`;
    case "cross_down":
      return `((${jExpr} > 0) and (${Lp}) >= (${Rp}) and (${Lc}) < (${Rc}))`;
    default:
      return "False";
  }
}

function logicExprToPyFixed(expr: BuilderLogicExpr | null, jExpr: string): string {
  if (!expr) return "False";
  if (expr.kind === "atom") return comparisonToPyFixed(expr.condition, jExpr);
  if (expr.kind === "all") {
    if (!expr.children.length) return "True";
    return "(" + expr.children.map((c) => logicExprToPyFixed(c, jExpr)).join(" and ") + ")";
  }
  if (!expr.children.length) return "False";
  return "(" + expr.children.map((c) => logicExprToPyFixed(c, jExpr)).join(" or ") + ")";
}

export function generateTradingBotPyFromChartSpec(spec: ChartBuilderSpecV1): string {
  const name = (spec.name ?? "").trim() || "chart_strategy";
  const slug = slugFromName(name);
  const warnings: string[] = [];

  const tp = Number(spec.risk.takeProfitPct);
  const sl = Number(spec.risk.stopLossPct);
  const tr = Number(spec.risk.trailingStopPct ?? 0);
  const tpPct = Number.isFinite(tp) ? tp : 0;
  const slPct = Number.isFinite(sl) ? sl : 0;
  const trPct = Number.isFinite(tr) ? tr : 0;

  const ind = spec.indicators;

  const fExpr = effectiveFilterExpr(spec.rules, ind);
  const zLongEx = effectiveZoneLongExpr(spec.rules, ind);
  const zShortEx = effectiveZoneShortExpr(spec.rules, ind);
  const exL = effectiveExitExpr(spec.rules.exitLongIf, spec.rules.exitLong, ind);
  const exS = effectiveExitExpr(spec.rules.exitShortIf, spec.rules.exitShort, ind);
  const longEx = effectiveEntryExpr(spec.rules.long, ind);
  const shortEx = effectiveEntryExpr(spec.rules.short, ind);

  const zoneLongWait = Math.max(0, Math.min(500, Math.round(Number(spec.rules.zoneLongWaitCandles ?? 10))));
  const zoneShortWait = Math.max(0, Math.min(500, Math.round(Number(spec.rules.zoneShortWaitCandles ?? 10))));
  const zoneLongApplyFilter = spec.rules.zoneLongApplyFilter !== false;
  const zoneShortApplyFilter = spec.rules.zoneShortApplyFilter !== false;

  const longApplyFilter = spec.rules.long?.applyFilter === true;
  const shortApplyFilter = spec.rules.short?.applyFilter === true;

  const filterPy = logicExprToPyFixed(fExpr, "j");
  const zoneLongPy = logicExprToPyFixed(zLongEx, "j");
  const zoneShortPy = logicExprToPyFixed(zShortEx, "j");
  const exitLongPy = logicExprToPyFixed(exL, "cur_i");
  const exitShortPy = logicExprToPyFixed(exS, "cur_i");
  const longEntryPy = logicExprToPyFixed(longEx, "cur_i");
  const shortEntryPy = logicExprToPyFixed(shortEx, "cur_i");

  const exitUsesSnap =
    spec.rules.entrySnapEnabled === true &&
    ((exL && logicExprContainsEntrySnap(exL)) || (exS && logicExprContainsEntrySnap(exS)));

  const snapOpsExit = uniqEntrySnapOperands([
    ...collectEntrySnapLeaves(exL),
    ...collectEntrySnapLeaves(exS),
  ]);

  const indicatorsBody = emitIndicatorsSection(spec, warnings);

  const hasFilter = fExpr != null;
  const hasZoneLong = zLongEx != null;
  const hasZoneShort = zShortEx != null;

  const warnHeader =
    warnings.length || exitUsesSnap
      ? "\n# AVISOS EXPORTAÇÃO:\n" +
        warnings.map((w) => `# - ${w.replace(/\s+/g, " ")}`).join("\n") +
        (exitUsesSnap
          ? "\n# - Saídas usam entry(...): self.entry_snap é preenchido em cada entrada (ver _capture_entry_snap)."
          : "") +
        "\n"
      : "";

  const snapCaptureFn =
    snapOpsExit.length && exitUsesSnap
      ? `
def _capture_entry_snap(df, cur_i):
    return {
${snapOpsExit
  .map((op) => {
    const k = escapePyStr(entrySnapKey(op));
    const indOp: Extract<BuilderOperand, { type: "indicator" }> = {
      type: "indicator",
      ref: op.ref,
      ...(op.bollingerBand ? { bollingerBand: op.bollingerBand } : {}),
    };
    return `        "${k}": ${operandValuePyFixed(indOp, "cur_i")},`;
  })
  .join("\n")}
    }
`
      : "";

  const filterDef = hasFilter
    ? `    def _filter_ok_at(j):
        return (${filterPy})
`
    : `    def _filter_ok_at(j):
        return True
`;

  const marketOkLine = hasFilter ? `    market_ok = _filter_ok_at(cur_i)` : `    market_ok = True`;

  const zoneLongSection = hasZoneLong
    ? `
    def _zone_long_ok():
        wait = ${zoneLongWait}
        apply_zf = ${zoneLongApplyFilter ? "True" : "False"}
        last_true = -1
        for j in range(0, cur_i + 1):
            filter_ok_j = (not apply_zf) or _filter_ok_at(j)
            zone_raw_j = (${zoneLongPy})
            if filter_ok_j and zone_raw_j:
                last_true = j
        return last_true >= 0 and (cur_i - last_true) <= wait

    zone_long_ok = _zone_long_ok()
`
    : `    zone_long_ok = True
`;

  const zoneShortSection = hasZoneShort
    ? `
    def _zone_short_ok():
        wait = ${zoneShortWait}
        apply_zf = ${zoneShortApplyFilter ? "True" : "False"}
        last_true = -1
        for j in range(0, cur_i + 1):
            filter_ok_j = (not apply_zf) or _filter_ok_at(j)
            zone_raw_j = (${zoneShortPy})
            if filter_ok_j and zone_raw_j:
                last_true = j
        return last_true >= 0 and (cur_i - last_true) <= wait

    zone_short_ok = _zone_short_ok()
`
    : `    zone_short_ok = True
`;

  const snapLongLine =
    snapOpsExit.length && exitUsesSnap ? `        self.entry_snap = _capture_entry_snap(df, cur_i)` : "";
  const snapShortLine =
    snapOpsExit.length && exitUsesSnap ? `        self.entry_snap = _capture_entry_snap(df, cur_i)` : "";

  const strategySectionFixed =
    `
def strategy(self, df):
    get_current_position(self)
    print(f"POSITION: {self.position}")
    last_idx = -1
    df = indicators(df)

    n = len(df)
    cur_i = n + last_idx

${filterDef}
${marketOkLine}
${zoneLongSection}${zoneShortSection}
    long_signal = bool(${longEntryPy})${longApplyFilter ? " and market_ok" : ""}
    short_signal = bool(${shortEntryPy})${shortApplyFilter ? " and market_ok" : ""}

    exit_long = bool(${exL ? exitLongPy : "False"})
    exit_short = bool(${exS ? exitShortPy : "False"})

    signal_result = None

    # Saídas por regra, depois entradas (motor Chart Builder; sem TP/SL intrabar aqui).

    if self.position == "long" and exit_long:
        signal_result = "sell"
        return signal_result

    if self.position == "short" and exit_short:
        signal_result = "sell"
        return signal_result

    if long_signal and zone_long_ok and (self.position in (None, "short")):
        signal_result = "long"
${snapLongLine ? `${snapLongLine}\n` : ""}        return signal_result

    if short_signal and zone_short_ok and (self.position in (None, "long")):
        signal_result = "short"
${snapShortLine ? `${snapShortLine}\n` : ""}        return signal_result

    return signal_result
`;

  const headerWarnings = warnHeader ? `${warnHeader}\n` : "";

  return `${headerWarnings}import os
import pandas as pd
import numpy as np
import talib
from configs.get_info_account import *
from configs.get_candles import *
from configs.Actions_trading import *
from configs.Sync_time import *
from configs.loop import *
from configs.Custom_indicators import *
from configs.bot_main import TradingBot

# ── Chart Builder → bot Python (nome: "${escapePyStr(name)}")
# Requer: pip install TA-Lib (wrapper C talib).
# Séries feat_* ficam NaN até ligares dados QuestDB no teu pipeline.

TAKE_PROFIT_PCT = ${tpPct}
STOP_LOSS_PCT = ${slPct}
TRAILING_STOP_PCT = ${trPct}

ZONE_LONG_WAIT_CANDLES = ${zoneLongWait}
ZONE_SHORT_WAIT_CANDLES = ${zoneShortWait}


def _fv(ser, ji):
    n = len(ser)
    if ji < 0 or ji >= n:
        return float("nan")
    v = ser.iloc[int(ji)]
    return float(v) if pd.notna(v) else float("nan")


def _entry_snap_get(self, key):
    snap = getattr(self, "entry_snap", None)
    if not isinstance(snap, dict) or key not in snap:
        return float("nan")
    v = snap[key]
    return float(v) if pd.notna(v) else float("nan")

${snapCaptureFn}

def indicators(df):
    df = df.copy()
${indicatorsBody}
    return df

${strategySectionFixed}


if __name__ == "__main__":
    bot = TradingBot(
        api_key=os.environ.get("EXCHANGE_API_KEY", ""),
        api_secret=os.environ.get("EXCHANGE_API_SECRET", ""),
        symbol="WLD/USDC:USDC",
        timeframe="3m",
        leverage=10,
        sl_percent=STOP_LOSS_PCT / 100.0,
        tp_percent=TAKE_PROFIT_PCT / 100.0,
        # trailing_percent=TRAILING_STOP_PCT / 100.0,
        buyed=False,
        strategy_name="${slug}",
        type_strategy="trend",
        one_trade_per_account=False,
    )
    if not hasattr(bot, "entry_snap"):
        bot.entry_snap = {}
    run(bot)
`;
}

export function chartStrategyPyDownloadBasename(spec: ChartBuilderSpecV1): string {
  return `${slugFromName(spec.name ?? "")}.py`;
}
