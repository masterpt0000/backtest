/**
 * Simulação bar-a-bar com a mesma contabilidade de equity que ``minimalRsiStairs``
 * (long/short reversível, preço de execução = fecho).
 */
import type { OhlcBarLike } from "@/lib/indicatorsFromBars";
import type {
  BacktestChartLayer,
  BacktestTradeRow,
  StrategyBarShading,
} from "@/lib/backtestChartLayer";

export const CHART_SIM_INITIAL_CASH = 10_000;
/** Limite de marcadores no gráfico; acima disto descarta-se o mais antigo (mantém os recentes à direita). */
const MAX_MARKERS = 800;
const MAX_TRADE_LOG = 500;
const COLOR_CLOSE = "#f59e0b";
const COLOR_ENTRY_LONG = "#4ade80";
const COLOR_ENTRY_SHORT = "#f87171";

type Pos =
  | "flat"
  | { k: "L"; n: number; e: number; entryT: number }
  | { k: "S"; n: number; e: number; entryT: number };

export type QuadBarSignals = {
  longEntry: boolean[];
  longExit: boolean[];
  shortEntry: boolean[];
  shortExit: boolean[];
};

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

/**
 * @param skipBar — se true, não avalia sinais nessa barra (mantém posição e equity).
 */
function shadingHasPaint(row: StrategyBarShading): boolean {
  return row.filter || row.zoneLong || row.zoneShort;
}

export function runQuadSignalSimulation(
  bars: OhlcBarLike[],
  sig: QuadBarSignals,
  skipBar?: boolean[],
  strategyShading?: StrategyBarShading[] | null,
): BacktestChartLayer | null {
  const n = bars.length;
  if (
    n === 0 ||
    sig.longEntry.length !== n ||
    sig.longExit.length !== n ||
    sig.shortEntry.length !== n ||
    sig.shortExit.length !== n
  ) {
    return null;
  }

  const rawMarkers: RawMarker[] = [];
  const equity: { t: number; v: number }[] = [];
  const pushM = (time: number, o: Omit<RawMarker, "time">) => {
    if (rawMarkers.length >= MAX_MARKERS) rawMarkers.shift();
    rawMarkers.push({ ...o, time });
  };

  let pos: Pos = "flat";
  let v = CHART_SIM_INITIAL_CASH;
  const roundTradeReturns: number[] = [];
  const tradeLog: BacktestTradeRow[] = [];
  const pushTrade = (row: BacktestTradeRow) => {
    if (tradeLog.length < MAX_TRADE_LOG) tradeLog.push(row);
  };

  for (let i = 0; i < n; i++) {
    const c = bars[i]!.c;
    const t = bars[i]!.t;
    if (skipBar?.[i]) {
      equity.push({ t, v });
      continue;
    }

    const le = sig.longEntry[i]!;
    const lx = sig.longExit[i]!;
    const se = sig.shortEntry[i]!;
    const sx = sig.shortExit[i]!;

    if (pos === "flat") {
      if (le) {
        pos = { k: "L", n: v, e: c, entryT: t };
        v = (pos.n * c) / pos.e;
        pushM(t, { position: "belowBar", color: COLOR_ENTRY_LONG, shape: "arrowUp", text: "B" });
      } else if (se) {
        pos = { k: "S", n: v, e: c, entryT: t };
        v = pos.n * (2 - c / pos.e);
        pushM(t, { position: "aboveBar", color: COLOR_ENTRY_SHORT, shape: "arrowDown", text: "S" });
      }
    } else if (pos.k === "L") {
      v = (pos.n * c) / pos.e;
      if (lx) {
        const cash = (pos.n * c) / pos.e;
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
        pushM(t, { position: "aboveBar", color: COLOR_CLOSE, shape: "arrowDown", text: "C" });
      } else if (se) {
        const cash0: number = (pos.n * c) / pos.e;
        const pnlR = cash0 / pos.n - 1;
        roundTradeReturns.push(pnlR);
        pushTrade({
          entryTime: pos.entryT,
          exitTime: t,
          side: "long",
          pnl_pct: pnlR * 100,
        });
        pos = { k: "S", n: cash0, e: c, entryT: t };
        v = pos.n * (2 - c / pos.e);
        pushM(t, { position: "aboveBar", color: COLOR_CLOSE, shape: "arrowDown", text: "C" });
        pushM(t, { position: "aboveBar", color: COLOR_ENTRY_SHORT, shape: "arrowDown", text: "S" });
      }
    } else {
      v = pos.n * (2 - c / pos.e);
      if (sx) {
        const cash = v;
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
        pushM(t, { position: "belowBar", color: COLOR_CLOSE, shape: "arrowUp", text: "C" });
      } else if (le) {
        const cash0: number = v;
        const pnlR = cash0 / pos.n - 1;
        roundTradeReturns.push(pnlR);
        pushTrade({
          entryTime: pos.entryT,
          exitTime: t,
          side: "short",
          pnl_pct: pnlR * 100,
        });
        pos = { k: "L", n: cash0, e: c, entryT: t };
        v = (pos.n * c) / pos.e;
        pushM(t, { position: "belowBar", color: COLOR_CLOSE, shape: "arrowUp", text: "C" });
        pushM(t, { position: "belowBar", color: COLOR_ENTRY_LONG, shape: "arrowUp", text: "B" });
      }
    }
    equity.push({ t, v });
  }

  const last = equity[equity.length - 1]?.v ?? CHART_SIM_INITIAL_CASH;
  const returnPct = ((last - CHART_SIM_INITIAL_CASH) / CHART_SIM_INITIAL_CASH) * 100;
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

  const shade =
    strategyShading &&
    strategyShading.length === bars.length &&
    strategyShading.some(shadingHasPaint)
      ? strategyShading
      : undefined;

  return {
    overlay: {
      markers: rawMarkers,
      equity: downsampleEquity(equity, 2500),
      initial_cash: CHART_SIM_INITIAL_CASH,
      ...(shade ? { strategyShading: shade } : {}),
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

export function emptyQuadSignals(n: number): QuadBarSignals {
  const f = () => new Array<boolean>(n).fill(false);
  return { longEntry: f(), longExit: f(), shortEntry: f(), shortExit: f() };
}
