/**
 * Motor genérico para especificações do construtor (chart): condições bar-a-bar + TP/SL % fixos.
 * Execução intrabar: SL antes de TP na mesma vela; preços de saída nos níveis TP/SL.
 * Ordem na vela: (1) SL/TP, (2) sinais de saída por regra, (3) entradas / reversões.
 */
import type { ChartIndicatorDef } from "@/components/OhlcvChart";
import type {
  BuilderCondition,
  BuilderLogicExpr,
  BuilderOperand,
  BuilderEntryRule,
  BuilderRules,
  ChartBuilderSpecV1,
} from "@/lib/chartBuilderSpec";
import { logicExprContainsEntrySnap } from "@/lib/chartBuilderSpec";
import { parseBuilderIfLine } from "@/lib/builderIfParser";
import type {
  BacktestChartLayer,
  BacktestTradeRow,
  StrategyBarShading,
} from "@/lib/backtestChartLayer";
import type { OhlcBarLike } from "@/lib/indicatorsFromBars";
import type { IndicatorSeriesBundle as SeriesBundle } from "@/lib/chartTaBundles";
import { emptyQuadSignals, runQuadSignalSimulation } from "@/lib/liveStrategy/chartSimBarByBar";
import { splitBuilderDeltaRef } from "@/lib/builderDeltaRef";
import {
  effectiveDeltaLookbackBars,
  effectiveDeltaNormalizeByPrice,
  INDICATOR_DELTA_DISPLAY_SCALE,
} from "@/lib/indicatorDeltaTransform";

/** Limite de marcadores no gráfico; acima disto descarta-se o mais antigo (mantém os recentes à direita). */
const MAX_MARKERS = 800;
const MAX_TRADE_LOG = 500;
const COLOR_CLOSE = "#f59e0b";
const COLOR_ENTRY_LONG = "#4ade80";
const COLOR_ENTRY_SHORT = "#f87171";

type Pos =
  | "flat"
  | { k: "L"; n: number; e: number; entryT: number; best: number }
  | { k: "S"; n: number; e: number; entryT: number; best: number };

function snapKeyForEntrySnap(op: Extract<BuilderOperand, { type: "entry_snap" }>): string {
  return op.bollingerBand ? `${op.ref}|${op.bollingerBand}` : op.ref;
}

function entrySnapOperandAsIndicator(
  op: Extract<BuilderOperand, { type: "entry_snap" }>,
): BuilderOperand & { type: "indicator" } {
  return {
    type: "indicator",
    ref: op.ref,
    ...(op.bollingerBand ? { bollingerBand: op.bollingerBand } : {}),
  };
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

function uniqEntrySnapOperands(
  ops: Extract<BuilderOperand, { type: "entry_snap" }>[],
): Extract<BuilderOperand, { type: "entry_snap" }>[] {
  const seen = new Set<string>();
  const out: Extract<BuilderOperand, { type: "entry_snap" }>[] = [];
  for (const op of ops) {
    const k = snapKeyForEntrySnap(op);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(op);
  }
  return out;
}

function captureEntrySnapAtBar(
  snaps: Extract<BuilderOperand, { type: "entry_snap" }>[],
  bar: number,
  bundles: Map<string, SeriesBundle>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const es of snaps) {
    const v = getOperandValueAt(entrySnapOperandAsIndicator(es), bar, bundles);
    if (v !== undefined) m.set(snapKeyForEntrySnap(es), v);
  }
  return m;
}

function walkOperandRefs(op: BuilderOperand, visit: (op: Extract<BuilderOperand, { type: "indicator" }>) => void): void {
  if (op.type === "indicator") visit(op);
  else if (op.type === "entry_snap") visit(entrySnapOperandAsIndicator(op));
  else if (op.type === "adjusted") walkOperandRefs(op.inner, visit);
}

function getOperandValueAt(
  op: BuilderOperand,
  i: number,
  bundles: Map<string, SeriesBundle>,
  snap?: Map<string, number> | undefined,
): number | undefined {
  if (op.type === "constant") return op.value;
  if (op.type === "adjusted") {
    const inner = getOperandValueAt(op.inner, i, bundles, snap);
    if (inner === undefined) return undefined;
    return inner + op.add;
  }
  if (op.type === "entry_snap") {
    if (snap == null) return undefined;
    const v = snap.get(snapKeyForEntrySnap(op));
    return v !== undefined && Number.isFinite(v) ? v : undefined;
  }
  const shift = op.type === "indicator" ? (op.shift ?? 0) : 0;
  const idx = i - shift;
  if (idx < 0) return undefined;
  const b = bundles.get(op.ref);
  if (!b) return undefined;
  const source = shift > 0 && b.shifted?.[shift] ? b.shifted[shift] : b;
  const sourceIdx = shift > 0 && b.shifted?.[shift] ? i : idx;
  if (op.type === "indicator" && op.bollingerBand) {
    const arr =
      op.bollingerBand === "upper"
        ? source.upper
        : op.bollingerBand === "lower"
          ? source.lower
          : source.mid ?? source.scalar;
    if (!arr) return undefined;
    const v = arr[sourceIdx]!;
    return Number.isFinite(v) ? v : undefined;
  }
  const v = source.scalar[sourceIdx]!;
  return Number.isFinite(v) ? v : undefined;
}

function evalConditionAt(
  cond: BuilderCondition | null,
  i: number,
  bundles: Map<string, SeriesBundle>,
  snap?: Map<string, number> | undefined,
): boolean {
  if (cond == null) return false;
  const lv = getOperandValueAt(cond.left, i, bundles, snap);
  const rv = getOperandValueAt(cond.right, i, bundles, snap);
  if (lv === undefined || rv === undefined) return false;

  switch (cond.op) {
    case "gt":
      return lv > rv;
    case "lt":
      return lv < rv;
    case "ge":
      return lv >= rv;
    case "le":
      return lv <= rv;
    case "eq":
      return Math.abs(lv - rv) <= 1e-9 * Math.max(1, Math.abs(lv), Math.abs(rv));
    case "cross_up": {
      if (i === 0) return false;
      const lp = getOperandValueAt(cond.left, i - 1, bundles, snap);
      const rp = getOperandValueAt(cond.right, i - 1, bundles, snap);
      if (lp === undefined || rp === undefined) return false;
      return lp <= rp && lv > rv;
    }
    case "cross_down": {
      if (i === 0) return false;
      const lp = getOperandValueAt(cond.left, i - 1, bundles, snap);
      const rp = getOperandValueAt(cond.right, i - 1, bundles, snap);
      if (lp === undefined || rp === undefined) return false;
      return lp >= rp && lv < rv;
    }
    default:
      return false;
  }
}

function evalLogicExpr(
  expr: BuilderLogicExpr,
  i: number,
  bundles: Map<string, SeriesBundle>,
  snap?: Map<string, number> | undefined,
): boolean {
  if (expr.kind === "atom") {
    return evalConditionAt(expr.condition, i, bundles, snap);
  }
  if (expr.kind === "all") {
    return expr.children.every((c) => evalLogicExpr(c, i, bundles, snap));
  }
  return expr.children.some((c) => evalLogicExpr(c, i, bundles, snap));
}

function logicExprFromIfLine(
  line: string | null | undefined,
  fallback: BuilderLogicExpr | null,
  indicators: ChartBuilderSpecV1["indicators"],
): BuilderLogicExpr | null {
  const t = line?.trim();
  if (!t) return fallback;
  const r = parseBuilderIfLine(t, indicators);
  return r.ok ? r.expr : fallback;
}

function effectiveFilterExpr(rules: BuilderRules, indicators: ChartBuilderSpecV1["indicators"]) {
  return logicExprFromIfLine(rules.filterIf, rules.filter, indicators);
}

function effectiveZoneLongExpr(rules: BuilderRules, indicators: ChartBuilderSpecV1["indicators"]) {
  return logicExprFromIfLine(rules.zoneLongIf, rules.zoneLong, indicators);
}

function effectiveZoneShortExpr(rules: BuilderRules, indicators: ChartBuilderSpecV1["indicators"]) {
  return logicExprFromIfLine(rules.zoneShortIf, rules.zoneShort, indicators);
}

function effectiveEntryExpr(rule: BuilderEntryRule | null, indicators: ChartBuilderSpecV1["indicators"]) {
  if (!rule || rule.enabled === false) return null;
  return logicExprFromIfLine(rule.ifLine, rule.expr, indicators);
}

function effectiveExitExpr(
  ifLine: string | null,
  fallback: BuilderLogicExpr | null,
  indicators: ChartBuilderSpecV1["indicators"],
) {
  return logicExprFromIfLine(ifLine, fallback, indicators);
}

/** Filtro de mercado: ausente → não bloqueia. */
function evalFilterAt(
  spec: ChartBuilderSpecV1,
  i: number,
  bundles: Map<string, SeriesBundle>,
): boolean {
  const f = effectiveFilterExpr(spec.rules, spec.indicators);
  if (!f) return true;
  return evalLogicExpr(f, i, bundles);
}

function evalEntryAt(
  rule: BuilderEntryRule | null,
  marketOk: boolean,
  i: number,
  bundles: Map<string, SeriesBundle>,
  indicators: ChartBuilderSpecV1["indicators"],
): boolean {
  const ex = effectiveEntryExpr(rule, indicators);
  if (!ex) return false;
  const entryOk = evalLogicExpr(ex, i, bundles);
  if (rule?.applyFilter && !marketOk) return false;
  return entryOk;
}

function collectRefOperands(spec: ChartBuilderSpecV1): BuilderOperand[] {
  const out: BuilderOperand[] = [];
  const ind = spec.indicators;
  const walkCond = (c: BuilderCondition | null) => {
    if (!c) return;
    walkOperandRefs(c.left, (op) => out.push(op));
    walkOperandRefs(c.right, (op) => out.push(op));
  };
  const walkExpr = (ex: BuilderLogicExpr | null) => {
    if (!ex) return;
    if (ex.kind === "atom") {
      walkCond(ex.condition);
      return;
    }
    for (const ch of ex.children) walkExpr(ch);
  };
  const fromLine = (line: string | null | undefined) => {
    const t = line?.trim();
    if (!t) return;
    const r = parseBuilderIfLine(t, ind);
    if (r.ok) walkExpr(r.expr);
  };
  fromLine(spec.rules.filterIf);
  walkExpr(spec.rules.filter);
  fromLine(spec.rules.zoneLongIf);
  walkExpr(spec.rules.zoneLong);
  fromLine(spec.rules.zoneShortIf);
  walkExpr(spec.rules.zoneShort);
  fromLine(spec.rules.long?.ifLine);
  walkExpr(spec.rules.long?.expr ?? null);
  fromLine(spec.rules.short?.ifLine);
  walkExpr(spec.rules.short?.expr ?? null);
  fromLine(spec.rules.exitLongIf);
  walkExpr(spec.rules.exitLong);
  fromLine(spec.rules.exitShortIf);
  walkExpr(spec.rules.exitShort);
  return out;
}

function previousDistinctValues(series: number[], shift: number): number[] {
  const out = new Array<number>(series.length).fill(NaN);
  if (shift < 1) return out;
  const distinctValues: number[] = [];
  let lastDistinct = NaN;
  for (let i = 0; i < series.length; i++) {
    const cur = series[i]!;
    if (!Number.isFinite(cur)) {
      out[i] = NaN;
      continue;
    }
    if (!Number.isFinite(lastDistinct) || Math.abs(cur - lastDistinct) > 1e-12) {
      distinctValues.push(cur);
      lastDistinct = cur;
    }
    const currentIx = distinctValues.length - 1;
    const prevIx = currentIx - shift;
    out[i] = prevIx >= 0 ? distinctValues[prevIx]! : NaN;
  }
  return out;
}

function withMtfShiftedBundle(
  bundle: SeriesBundle,
  shifts: Set<number> | undefined,
): SeriesBundle {
  if (!shifts?.size) return bundle;
  const shifted: NonNullable<SeriesBundle["shifted"]> = {};
  for (const shift of shifts) {
    if (shift < 1) continue;
    shifted[shift] = {
      scalar: previousDistinctValues(bundle.scalar, shift),
      ...(bundle.upper ? { upper: previousDistinctValues(bundle.upper, shift) } : {}),
      ...(bundle.mid ? { mid: previousDistinctValues(bundle.mid, shift) } : {}),
      ...(bundle.lower ? { lower: previousDistinctValues(bundle.lower, shift) } : {}),
    };
  }
  return Object.keys(shifted).length ? { ...bundle, shifted } : bundle;
}

function buildStrategyHighlightRows(
  bars: OhlcBarLike[],
  bundles: Map<string, SeriesBundle>,
  spec: ChartBuilderSpecV1,
): StrategyBarShading[] | null {
  const ind = spec.indicators;
  const fExpr = effectiveFilterExpr(spec.rules, ind);
  const zLongEx = effectiveZoneLongExpr(spec.rules, ind);
  const zShortEx = effectiveZoneShortExpr(spec.rules, ind);
  if (!fExpr && !zLongEx && !zShortEx) return null;
  const n = bars.length;
  const out = new Array<StrategyBarShading>(n);
  for (let i = 0; i < n; i++) {
    const filterPass = !!(fExpr && evalLogicExpr(fExpr, i, bundles));
    /** Quando activo na zona, o filtro faz parte da própria zona, igual à simulação. */
    const longZoneAllowed = !spec.rules.zoneLongApplyFilter || !fExpr || filterPass;
    const shortZoneAllowed = !spec.rules.zoneShortApplyFilter || !fExpr || filterPass;
    const longOn = !!(zLongEx && evalLogicExpr(zLongEx, i, bundles));
    const shortOn = !!(zShortEx && evalLogicExpr(zShortEx, i, bundles));
    out[i] = {
      t: bars[i]!.t,
      filter: filterPass,
      zoneLong: longZoneAllowed && longOn,
      zoneShort: shortZoneAllowed && shortOn,
    };
  }
  return out;
}

function buildSeriesBundles(
  bars: OhlcBarLike[],
  defs: ChartIndicatorDef[],
  spec: ChartBuilderSpecV1,
  taBundles: Map<string, SeriesBundle> | null | undefined,
): Map<string, SeriesBundle> {
  const bundles = new Map<string, SeriesBundle>();
  const refs = new Set<string>();
  const deltaRefs = new Set<string>();
  const mtfShifts = new Map<string, Set<number>>();
  for (const ind of spec.indicators) refs.add(ind.id);
  for (const op of collectRefOperands(spec)) {
    if (op.type === "indicator") {
      refs.add(op.ref);
      if ((op.shift ?? 0) > 0) {
        const set = mtfShifts.get(op.ref) ?? new Set<number>();
        set.add(op.shift ?? 0);
        mtfShifts.set(op.ref, set);
      }
    }
  }

  const n = bars.length;
  const nan = () => new Array<number>(n).fill(NaN);
  const closeBundle = (): SeriesBundle => ({
    scalar: bars.map((b) => b.c),
  });
  for (const ref of refs) {
    if (ref === "close") {
      bundles.set(ref, closeBundle());
      continue;
    }
    const deltaBaseRef = splitBuilderDeltaRef(ref);
    if (deltaBaseRef) {
      deltaRefs.add(ref);
      if (!refs.has(deltaBaseRef)) {
        bundles.set(deltaBaseRef, taBundles?.get(deltaBaseRef) ?? { scalar: nan() });
      }
      continue;
    }
    const base = taBundles?.get(ref) ?? { scalar: nan() };
    const def = defs.find((d) => d.id === ref);
    const isMtf = !!def?.timeframe && def.timeframe !== "chart";
    bundles.set(ref, isMtf ? withMtfShiftedBundle(base, mtfShifts.get(ref)) : base);
  }
  const defById = new Map(defs.map((d) => [d.id, d]));
  for (const deltaRef of deltaRefs) {
    const baseRef = splitBuilderDeltaRef(deltaRef);
    const baseBundle = baseRef ? (bundles.get(baseRef) ?? taBundles?.get(baseRef)) : undefined;
    const def = baseRef ? defById.get(baseRef) : undefined;
    const lookback = def ? effectiveDeltaLookbackBars(def) : 0;
    if (!baseRef || !baseBundle || !def || lookback < 1) {
      bundles.set(deltaRef, { scalar: nan() });
      continue;
    }
    const normalizeByPrice = effectiveDeltaNormalizeByPrice(def);
    const scalar = new Array<number>(n).fill(NaN);
    for (let i = lookback; i < n; i++) {
      const cur = baseBundle.scalar[i];
      const prev = baseBundle.scalar[i - lookback];
      if (typeof cur !== "number" || typeof prev !== "number" || !Number.isFinite(cur) || !Number.isFinite(prev)) {
        continue;
      }
      let v = cur - prev;
      if (normalizeByPrice) {
        const close = bars[i]!.c;
        if (!Number.isFinite(close) || close === 0) continue;
        v /= close;
      }
      scalar[i] = v * INDICATOR_DELTA_DISPLAY_SCALE;
    }
    bundles.set(deltaRef, { scalar });
  }
  return bundles;
}

/**
 * Janela após última vela em que ``zoneExpr`` foi true: permite entrada mesmo que a zona já não seja true,
 * até ``waitCandles`` velas depois dessa última (inclusive a vela da zona: índice 0 na janela).
 */
function buildZoneEntryWindow(
  n: number,
  zoneExpr: BuilderLogicExpr | null,
  filterExpr: BuilderLogicExpr | null,
  applyFilter: boolean,
  waitCandles: number,
  bundles: Map<string, SeriesBundle>,
): boolean[] {
  const out = new Array<boolean>(n).fill(true);
  if (!zoneExpr) return out;
  const w = Math.max(0, Math.min(500, Math.round(waitCandles)));
  let lastTrue = -1;
  for (let i = 0; i < n; i++) {
    const filterOk = !applyFilter || !filterExpr || evalLogicExpr(filterExpr, i, bundles);
    if (filterOk && evalLogicExpr(zoneExpr, i, bundles)) lastTrue = i;
    out[i] = lastTrue >= 0 && i - lastTrue <= w;
  }
  return out;
}

function buildSignalArrays(
  bars: OhlcBarLike[],
  bundles: Map<string, SeriesBundle>,
  spec: ChartBuilderSpecV1,
) {
  const n = bars.length;
  const longEntry = new Array<boolean>(n).fill(false);
  const longExit = new Array<boolean>(n).fill(false);
  const shortEntry = new Array<boolean>(n).fill(false);
  const shortExit = new Array<boolean>(n).fill(false);

  const ind = spec.indicators;
  const exL = effectiveExitExpr(spec.rules.exitLongIf, spec.rules.exitLong, ind);
  const exS = effectiveExitExpr(spec.rules.exitShortIf, spec.rules.exitShort, ind);
  const fExpr = effectiveFilterExpr(spec.rules, ind);
  const zLongEx = effectiveZoneLongExpr(spec.rules, ind);
  const zShortEx = effectiveZoneShortExpr(spec.rules, ind);
  const zoneLongOk = buildZoneEntryWindow(
    n,
    zLongEx,
    fExpr,
    spec.rules.zoneLongApplyFilter !== false,
    spec.rules.zoneLongWaitCandles ?? 10,
    bundles,
  );
  const zoneShortOk = buildZoneEntryWindow(
    n,
    zShortEx,
    fExpr,
    spec.rules.zoneShortApplyFilter !== false,
    spec.rules.zoneShortWaitCandles ?? 10,
    bundles,
  );

  const snapEnabled =
    spec.rules.entrySnapEnabled === true &&
    (logicExprContainsEntrySnap(exL) || logicExprContainsEntrySnap(exS));
  const hasRisk =
    spec.risk.takeProfitPct > 0 ||
    spec.risk.stopLossPct > 0 ||
    (spec.risk.trailingStopPct ?? 0) > 0;
  const writeStatefulExitMasks = snapEnabled && !hasRisk;

  const keysL = uniqEntrySnapOperands(collectEntrySnapLeaves(exL));
  const keysS = uniqEntrySnapOperands(collectEntrySnapLeaves(exS));

  for (let i = 0; i < n; i++) {
    const marketOk = evalFilterAt(spec, i, bundles);
    if (evalEntryAt(spec.rules.long, marketOk, i, bundles, ind) && zoneLongOk[i]) longEntry[i] = true;
    if (evalEntryAt(spec.rules.short, marketOk, i, bundles, ind) && zoneShortOk[i]) shortEntry[i] = true;
    if (!writeStatefulExitMasks) {
      if (exL && evalLogicExpr(exL, i, bundles)) longExit[i] = true;
      if (exS && evalLogicExpr(exS, i, bundles)) shortExit[i] = true;
    }
  }

  if (writeStatefulExitMasks) {
    let pos: "flat" | "L" | "S" = "flat";
    let snapL = new Map<string, number>();
    let snapS = new Map<string, number>();

    for (let i = 0; i < n; i++) {
      const le = longEntry[i]!;
      const se = shortEntry[i]!;

      longExit[i] = !!(pos === "L" && exL && evalLogicExpr(exL, i, bundles, snapL));
      shortExit[i] = !!(pos === "S" && exS && evalLogicExpr(exS, i, bundles, snapS));

      if (pos === "flat") {
        if (le) {
          pos = "L";
          snapL = captureEntrySnapAtBar(keysL, i, bundles);
        } else if (se) {
          pos = "S";
          snapS = captureEntrySnapAtBar(keysS, i, bundles);
        }
      } else if (pos === "L") {
        if (longExit[i]) {
          pos = "flat";
          snapL = new Map();
        } else if (se) {
          pos = "S";
          snapL = new Map();
          snapS = captureEntrySnapAtBar(keysS, i, bundles);
        }
      } else {
        if (shortExit[i]) {
          pos = "flat";
          snapS = new Map();
        } else if (le) {
          pos = "L";
          snapS = new Map();
          snapL = captureEntrySnapAtBar(keysL, i, bundles);
        }
      }
    }
  }

  return { longEntry, longExit, shortEntry, shortExit };
}

function downsampleEquity(
  points: { t: number; v: number }[],
  maxPoints: number,
): { t: number; v: number }[] {
  if (points.length <= maxPoints) return points;
  const step = Math.max(1, Math.floor(points.length / maxPoints));
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]!);
  if (out[out.length - 1]!.t !== points[points.length - 1]!.t) {
    out.push(points[points.length - 1]!);
  }
  return out;
}

type RawMarker = {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown";
  text: string;
};

const INITIAL = 10_000;

type BuilderTpSlSnapOpts = {
  bundles: Map<string, SeriesBundle>;
  spec: ChartBuilderSpecV1;
};

function runWithTpSl(
  bars: OhlcBarLike[],
  sig: ReturnType<typeof buildSignalArrays>,
  tpPct: number,
  slPct: number,
  trailingStopPct: number,
  strategyShading: StrategyBarShading[] | null,
  opts?: BuilderTpSlSnapOpts,
): BacktestChartLayer | null {
  const n = bars.length;
  if (n === 0) return null;

  const rawMarkers: RawMarker[] = [];
  const equity: { t: number; v: number }[] = [];
  const pushM = (time: number, o: Omit<RawMarker, "time">) => {
    if (rawMarkers.length >= MAX_MARKERS) rawMarkers.shift();
    rawMarkers.push({ ...o, time });
  };

  let pos: Pos = "flat";
  let v = INITIAL;
  const roundTradeReturns: number[] = [];
  const tradeLog: BacktestTradeRow[] = [];
  const pushTrade = (row: BacktestTradeRow) => {
    if (tradeLog.length < MAX_TRADE_LOG) tradeLog.push(row);
  };

  const tpR = tpPct > 0 ? tpPct / 100 : 0;
  const slR = slPct > 0 ? slPct / 100 : 0;
  const trailR = trailingStopPct > 0 ? trailingStopPct / 100 : 0;

  const bundlesOpt = opts?.bundles;
  const specOpt = opts?.spec;
  const indSnap = specOpt?.indicators ?? [];
  const exLDynamic =
    specOpt && bundlesOpt
      ? effectiveExitExpr(specOpt.rules.exitLongIf, specOpt.rules.exitLong, indSnap)
      : null;
  const exSDynamic =
    specOpt && bundlesOpt
      ? effectiveExitExpr(specOpt.rules.exitShortIf, specOpt.rules.exitShort, indSnap)
      : null;
  const dynamicExit =
    !!bundlesOpt &&
    !!specOpt &&
    specOpt.rules.entrySnapEnabled === true &&
    (logicExprContainsEntrySnap(exLDynamic) || logicExprContainsEntrySnap(exSDynamic));
  const keysLDynamic = dynamicExit ? uniqEntrySnapOperands(collectEntrySnapLeaves(exLDynamic)) : [];
  const keysSDynamic = dynamicExit ? uniqEntrySnapOperands(collectEntrySnapLeaves(exSDynamic)) : [];
  let snapL = new Map<string, number>();
  let snapS = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const bar = bars[i]!;
    const { h, l, c, t } = bar;
    const le = sig.longEntry[i]!;
    const lxRaw = sig.longExit[i]!;
    const se = sig.shortEntry[i]!;
    const sxRaw = sig.shortExit[i]!;
    const lx =
      dynamicExit && bundlesOpt && pos !== "flat" && pos.k === "L" && exLDynamic
        ? evalLogicExpr(exLDynamic, i, bundlesOpt, snapL)
        : lxRaw;
    const sx =
      dynamicExit && bundlesOpt && pos !== "flat" && pos.k === "S" && exSDynamic
        ? evalLogicExpr(exSDynamic, i, bundlesOpt, snapS)
        : sxRaw;

    const closeLongAt = (exitPx: number, label: string) => {
      if (pos !== "flat" && pos.k === "L") {
        const cash = (pos.n * exitPx) / pos.e;
        const pnlR = cash / pos.n - 1;
        roundTradeReturns.push(pnlR);
        pushTrade({
          entryTime: pos.entryT,
          exitTime: t,
          side: "long",
          pnl_pct: pnlR * 100,
        });
        v = cash;
        pos = "flat";
        if (dynamicExit) snapL = new Map();
        pushM(t, { position: "aboveBar", color: COLOR_CLOSE, shape: "arrowDown", text: label });
      }
    };

    const closeShortAt = (exitPx: number, label: string) => {
      if (pos !== "flat" && pos.k === "S") {
        const cash = pos.n * (2 - exitPx / pos.e);
        const pnlR = cash / pos.n - 1;
        roundTradeReturns.push(pnlR);
        pushTrade({
          entryTime: pos.entryT,
          exitTime: t,
          side: "short",
          pnl_pct: pnlR * 100,
        });
        v = cash;
        pos = "flat";
        if (dynamicExit) snapS = new Map();
        pushM(t, { position: "belowBar", color: COLOR_CLOSE, shape: "arrowUp", text: label });
      }
    };

    if (pos === "flat") {
      if (le) {
        pos = { k: "L", n: v, e: c, entryT: t, best: c };
        if (dynamicExit && bundlesOpt) snapL = captureEntrySnapAtBar(keysLDynamic, i, bundlesOpt);
        v = (pos.n * c) / pos.e;
        pushM(t, { position: "belowBar", color: COLOR_ENTRY_LONG, shape: "arrowUp", text: "B" });
      } else if (se) {
        pos = { k: "S", n: v, e: c, entryT: t, best: c };
        if (dynamicExit && bundlesOpt) snapS = captureEntrySnapAtBar(keysSDynamic, i, bundlesOpt);
        v = pos.n * (2 - c / pos.e);
        pushM(t, { position: "aboveBar", color: COLOR_ENTRY_SHORT, shape: "arrowDown", text: "S" });
      }
    } else if (pos.k === "L") {
      v = (pos.n * c) / pos.e;
      const entry = pos.e;
      let done = false;
      if (slR > 0) {
        const slPx = entry * (1 - slR);
        if (l <= slPx) {
          closeLongAt(slPx, "SL");
          done = true;
        }
      }
      if (!done && tpR > 0) {
        const tpPx = entry * (1 + tpR);
        if (h >= tpPx) {
          closeLongAt(tpPx, "TP");
          done = true;
        }
      }
      if (!done && trailR > 0) {
        const trailPx = pos.best * (1 - trailR);
        if (l <= trailPx) {
          closeLongAt(trailPx, "TR");
          done = true;
        }
      }
      if (!done && lx) {
        closeLongAt(c, "C");
        done = true;
      }
      if (!done && se) {
        const cash0: number = (pos.n * c) / pos.e;
        const pnlR = cash0 / pos.n - 1;
        roundTradeReturns.push(pnlR);
        pushTrade({
          entryTime: pos.entryT,
          exitTime: t,
          side: "long",
          pnl_pct: pnlR * 100,
        });
        if (dynamicExit) snapL = new Map();
        pos = { k: "S", n: cash0, e: c, entryT: t, best: c };
        if (dynamicExit && bundlesOpt) snapS = captureEntrySnapAtBar(keysSDynamic, i, bundlesOpt);
        v = pos.n * (2 - c / pos.e);
        pushM(t, { position: "aboveBar", color: COLOR_CLOSE, shape: "arrowDown", text: "C" });
        pushM(t, { position: "aboveBar", color: COLOR_ENTRY_SHORT, shape: "arrowDown", text: "S" });
        done = true;
      }
      if (done && (pos as Pos) === "flat") {
        if (le) {
          pos = { k: "L", n: v, e: c, entryT: t, best: c };
          if (dynamicExit && bundlesOpt) snapL = captureEntrySnapAtBar(keysLDynamic, i, bundlesOpt);
          v = (pos.n * c) / pos.e;
          pushM(t, { position: "belowBar", color: COLOR_ENTRY_LONG, shape: "arrowUp", text: "B" });
        } else if (se) {
          pos = { k: "S", n: v, e: c, entryT: t, best: c };
          if (dynamicExit && bundlesOpt) snapS = captureEntrySnapAtBar(keysSDynamic, i, bundlesOpt);
          v = pos.n * (2 - c / pos.e);
          pushM(t, { position: "aboveBar", color: COLOR_ENTRY_SHORT, shape: "arrowDown", text: "S" });
        }
      }
      const afterLong = pos as Pos;
      if (!done && afterLong !== "flat" && afterLong.k === "L") {
        afterLong.best = Math.max(afterLong.best, h);
        pos = afterLong;
      }
    } else {
      v = pos.n * (2 - c / pos.e);
      const entry = pos.e;
      let done = false;
      if (slR > 0) {
        const slPx = entry * (1 + slR);
        if (h >= slPx) {
          closeShortAt(slPx, "SL");
          done = true;
        }
      }
      if (!done && tpR > 0) {
        const tpPx = entry * (1 - tpR);
        if (l <= tpPx) {
          closeShortAt(tpPx, "TP");
          done = true;
        }
      }
      if (!done && trailR > 0) {
        const trailPx = pos.best * (1 + trailR);
        if (h >= trailPx) {
          closeShortAt(trailPx, "TR");
          done = true;
        }
      }
      if (!done && sx) {
        closeShortAt(c, "C");
        done = true;
      }
      if (!done && le) {
        const cash0: number = v;
        const pnlR = cash0 / pos.n - 1;
        roundTradeReturns.push(pnlR);
        pushTrade({
          entryTime: pos.entryT,
          exitTime: t,
          side: "short",
          pnl_pct: pnlR * 100,
        });
        if (dynamicExit) snapS = new Map();
        pos = { k: "L", n: cash0, e: c, entryT: t, best: c };
        if (dynamicExit && bundlesOpt) snapL = captureEntrySnapAtBar(keysLDynamic, i, bundlesOpt);
        v = (pos.n * c) / pos.e;
        pushM(t, { position: "belowBar", color: COLOR_CLOSE, shape: "arrowUp", text: "C" });
        pushM(t, { position: "belowBar", color: COLOR_ENTRY_LONG, shape: "arrowUp", text: "B" });
        done = true;
      }
      if (done && (pos as Pos) === "flat") {
        if (le) {
          pos = { k: "L", n: v, e: c, entryT: t, best: c };
          if (dynamicExit && bundlesOpt) snapL = captureEntrySnapAtBar(keysLDynamic, i, bundlesOpt);
          v = (pos.n * c) / pos.e;
          pushM(t, { position: "belowBar", color: COLOR_ENTRY_LONG, shape: "arrowUp", text: "B" });
        } else if (se) {
          pos = { k: "S", n: v, e: c, entryT: t, best: c };
          if (dynamicExit && bundlesOpt) snapS = captureEntrySnapAtBar(keysSDynamic, i, bundlesOpt);
          v = pos.n * (2 - c / pos.e);
          pushM(t, { position: "aboveBar", color: COLOR_ENTRY_SHORT, shape: "arrowDown", text: "S" });
        }
      }
      const afterShort = pos as Pos;
      if (!done && afterShort !== "flat" && afterShort.k === "S") {
        afterShort.best = Math.min(afterShort.best, l);
        pos = afterShort;
      }
    }

    equity.push({ t, v });
  }

  const last = equity[equity.length - 1]?.v ?? INITIAL;
  const returnPct = ((last - INITIAL) / INITIAL) * 100;
  const wins = roundTradeReturns.filter((x) => x > 0);
  const losses = roundTradeReturns.filter((x) => x < 0);
  const winRate =
    roundTradeReturns.length > 0 ? (100 * wins.length) / roundTradeReturns.length : 0;
  const grossP = wins.reduce((a, b) => a + b, 0);
  const grossL = -losses.reduce((a, b) => a + b, 0);
  const profitFct = grossL > 1e-9 ? grossP / grossL : grossP > 0 ? 9.99 : 0;

  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equity) {
    if (p.v > peak) peak = p.v;
    const dd = peak > 0 ? ((p.v - peak) / peak) * 100 : 0;
    if (dd < maxDd) maxDd = dd;
  }

  const rets: number[] = [];
  for (let j = 1; j < equity.length; j++) {
    const a = equity[j - 1]!.v;
    const b = equity[j]!.v;
    if (a > 0) rets.push((b - a) / a);
  }
  const meanR = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const varR =
    rets.length > 1
      ? rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / (rets.length - 1)
      : 0;
  const sharpe = varR > 0 ? (meanR / Math.sqrt(varR)) * Math.sqrt(252) : 0;

  return {
    overlay: {
      markers: rawMarkers,
      equity: downsampleEquity(equity, 2500),
      initial_cash: INITIAL,
      ...(strategyShading &&
      strategyShading.length === bars.length &&
      strategyShading.some((r) => r.filter || r.zoneLong || r.zoneShort)
        ? { strategyShading }
        : {}),
    },
    stats: {
      return_pct: Math.round(returnPct * 100) / 100,
      win_rate: Math.round(winRate * 10) / 10,
      trades: roundTradeReturns.length,
      max_dd: Math.round(maxDd * 100) / 100,
      sharpe: Math.round(sharpe * 100) / 100,
      profit_fct: Math.round(profitFct * 100) / 100,
    },
    tradeLog,
  };
}

/**
 * Se TP e SL forem ambos 0, delega em ``runQuadSignalSimulation`` (só fecho).
 * Caso contrário aplica TP/SL intrabar conforme documentado no topo do ficheiro.
 */
export function runBuilderStrategyFromSpec(
  bars: OhlcBarLike[],
  defs: ChartIndicatorDef[],
  spec: ChartBuilderSpecV1,
  taBundles: Map<string, SeriesBundle> | null | undefined,
): BacktestChartLayer | null {
  if (!bars.length) return null;
  const bundles = buildSeriesBundles(bars, defs, spec, taBundles);
  const strategyShading = buildStrategyHighlightRows(bars, bundles, spec);
  const sig = buildSignalArrays(bars, bundles, spec);
  const { takeProfitPct, stopLossPct, trailingStopPct } = spec.risk;
  const indForSnap = spec.indicators;
  const exLForSnap = effectiveExitExpr(spec.rules.exitLongIf, spec.rules.exitLong, indForSnap);
  const exSForSnap = effectiveExitExpr(spec.rules.exitShortIf, spec.rules.exitShort, indForSnap);
  const tpSlSnapOpts =
    spec.rules.entrySnapEnabled === true &&
    (logicExprContainsEntrySnap(exLForSnap) || logicExprContainsEntrySnap(exSForSnap))
      ? { bundles, spec }
      : undefined;

  if (
    takeProfitPct <= 0 &&
    stopLossPct <= 0 &&
    (trailingStopPct ?? 0) <= 0 &&
    sig.longEntry.length === bars.length
  ) {
    const quad = emptyQuadSignals(bars.length);
    quad.longEntry = sig.longEntry;
    quad.longExit = sig.longExit;
    quad.shortEntry = sig.shortEntry;
    quad.shortExit = sig.shortExit;
    return runQuadSignalSimulation(bars, quad, undefined, strategyShading);
  }

  return runWithTpSl(
    bars,
    sig,
    takeProfitPct,
    stopLossPct,
    trailingStopPct ?? 0,
    strategyShading,
    tpSlSnapOpts,
  );
}
