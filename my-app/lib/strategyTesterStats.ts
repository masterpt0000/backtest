/**
 * Agrega métricas p/ tabelas e gráficos do Strategy Tester a partir de
 * ``tradeLog`` + curva de equity.
 */
import type { BacktestStatsStrip, BacktestTradeRow } from "@/lib/backtestChartLayer";

export type ColumnKey = "all" | "long" | "short";

export type ColMetrics = {
  trades: number;
  openTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRatePct: number;
  netPnlUsd: number;
  netPnlPct: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number;
  commissionUsd: number;
  expectedPayoffUsd: number;
  avgPnlPct: number;
  avgWinPct: number;
  avgLossPct: number;
  ratioWinLoss: number;
  largestWinPct: number;
  largestLossPct: number;
  largestWinUsd: number;
  largestLossUsd: number;
  avgBarsInTrade: number;
  avgBarsWin: number;
  avgBarsLoss: number;
  sharpe: number;
  sortino: number;
};

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function sortedIndex(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo;
}

export function equityValueAt(
  eq: Array<{ t: number; v: number }>,
  t: number,
  fallback: number,
): number {
  if (eq.length === 0) return fallback;
  const a = eq[0]!;
  const b = eq[eq.length - 1]!;
  if (t <= a.t) return a.v;
  if (t >= b.t) return b.v;
  const i = sortedIndex(
    eq.map((p) => p.t),
    t,
  );
  if (i <= 0) return a.v;
  if (i >= eq.length) return b.v;
  const p0 = eq[i - 1]!;
  const p1 = eq[i]!;
  if (p1.t === p0.t) return p1.v;
  const w = (t - p0.t) / (p1.t - p0.t);
  return p0.v + w * (p1.v - p0.v);
}

function barsBetween(
  entryT: number,
  exitT: number,
  eq: Array<{ t: number; v: number }>,
): number {
  if (eq.length < 2) return 1;
  const dts: number[] = [];
  for (let i = 1; i < eq.length; i++) dts.push(eq[i]!.t - eq[i - 1]!.t);
  const step = dts.length ? dts.sort((a, b) => a - b)[Math.floor(dts.length / 2)]! : 1;
  if (step <= 0) return 1;
  return Math.max(1, Math.round((exitT - entryT) / step));
}

type RowUsd = { pnl_usd: number; pnl_pct: number; bars: number };

function buildCol(
  initialCash: number,
  tradeRows: BacktestTradeRow[],
  eq: Array<{ t: number; v: number }>,
): ColMetrics {
  const rows: RowUsd[] = tradeRows.map((tr) => {
    const v0 = equityValueAt(eq, tr.entryTime, initialCash);
    const v1 = equityValueAt(eq, tr.exitTime, initialCash);
    const pnl_usd = v1 - v0;
    return {
      pnl_usd,
      pnl_pct: tr.pnl_pct,
      bars: barsBetween(tr.entryTime, tr.exitTime, eq),
    };
  });
  const n = rows.length;
  const winsR = rows.filter((r) => r.pnl_usd > 1e-9);
  const lossR = rows.filter((r) => r.pnl_usd < -1e-9);
  const beR = rows.filter((r) => Math.abs(r.pnl_usd) <= 1e-9);
  const grossP = winsR.reduce((a, b) => a + b.pnl_usd, 0);
  const grossL = -lossR.reduce((a, b) => a + b.pnl_usd, 0);
  const netUsd = rows.reduce((a, b) => a + b.pnl_usd, 0);
  const netPct = initialCash > 0 ? (netUsd / initialCash) * 100 : 0;
  const pf = grossL > 1e-9 ? grossP / grossL : grossP > 0 ? 99 : 0;
  const pcts = rows.map((r) => r.pnl_pct);
  const winPcts = winsR.map((r) => r.pnl_pct);
  const lossPcts = lossR.map((r) => r.pnl_pct);
  const rets = rows.map((r) => r.pnl_usd / (initialCash > 0 ? initialCash : 1));
  const neg = rets.filter((r) => r < 0);
  const m = mean(rets);
  const sd = stdev(rets);
  const sharpe = sd > 1e-12 && n > 1 ? m / sd : 0;
  const down = stdev(neg);
  const sortino = down > 1e-12 ? m / down : 0;
  return {
    trades: n,
    openTrades: 0,
    wins: winsR.length,
    losses: lossR.length,
    breakEven: beR.length,
    winRatePct: n > 0 ? (100 * winsR.length) / n : 0,
    netPnlUsd: netUsd,
    netPnlPct: netPct,
    grossProfitUsd: grossP,
    grossLossUsd: grossL,
    profitFactor: pf,
    commissionUsd: 0,
    expectedPayoffUsd: n > 0 ? netUsd / n : 0,
    avgPnlPct: n > 0 ? mean(pcts) : 0,
    avgWinPct: winPcts.length ? mean(winPcts) : 0,
    avgLossPct: lossPcts.length ? mean(lossPcts) : 0,
    ratioWinLoss:
      winPcts.length && lossPcts.length
        ? mean(winPcts) / (Math.abs(mean(lossPcts)) + 1e-12)
        : 0,
    largestWinPct: pcts.length ? Math.max(...pcts) : 0,
    largestLossPct: pcts.length ? Math.min(...pcts) : 0,
    largestWinUsd: rows.length ? Math.max(...rows.map((r) => r.pnl_usd), 0) : 0,
    largestLossUsd: rows.length ? Math.min(...rows.map((r) => r.pnl_usd), 0) : 0,
    avgBarsInTrade: n ? mean(rows.map((r) => r.bars)) : 0,
    avgBarsWin: winsR.length ? mean(winsR.map((r) => r.bars)) : 0,
    avgBarsLoss: lossR.length ? mean(lossR.map((r) => r.bars)) : 0,
    sharpe,
    sortino,
  };
}

function emptyCol(initialCash: number, summary: BacktestStatsStrip): ColMetrics {
  return {
    trades: 0,
    openTrades: 0,
    wins: 0,
    losses: 0,
    breakEven: 0,
    winRatePct: 0,
    netPnlUsd: 0,
    netPnlPct: summary.return_pct,
    grossProfitUsd: 0,
    grossLossUsd: 0,
    profitFactor: 0,
    commissionUsd: 0,
    expectedPayoffUsd: 0,
    avgPnlPct: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    ratioWinLoss: 0,
    largestWinPct: 0,
    largestLossPct: 0,
    largestWinUsd: 0,
    largestLossUsd: 0,
    avgBarsInTrade: 0,
    avgBarsWin: 0,
    avgBarsLoss: 0,
    sharpe: summary.sharpe,
    sortino: 0,
  };
}

export type HistogramBin = { label: string; value: number; isProfit: boolean; center: number };
export type RunupDrawdown = {
  maxRunupPct: number;
  maxDrawdownPct: number;
  maxRunupUsd: number;
  maxDrawdownUsd: number;
  avgRunupPct: number;
  avgDrawdownPct: number;
  avgRunupDurationBars: number;
  avgDrawdownDurationBars: number;
};

function analyzeEquityForRunupDd(
  initialCash: number,
  eq: Array<{ t: number; v: number }>,
): RunupDrawdown {
  if (eq.length < 1) {
    return {
      maxRunupPct: 0,
      maxDrawdownPct: 0,
      maxRunupUsd: 0,
      maxDrawdownUsd: 0,
      avgRunupPct: 0,
      avgDrawdownPct: 0,
      avgRunupDurationBars: 0,
      avgDrawdownDurationBars: 0,
    };
  }
  /* Peak-trailing max drawdown (off peak equity). */
  let peakV = Math.max(initialCash, eq[0]!.v);
  let troughV = Math.min(initialCash, eq[0]!.v);
  let maxDdPct = 0;
  let maxRuPct = 0;
  let maxDdUsd = 0;
  let maxRuUsd = 0;
  for (const p of eq) {
    const v = p.v;
    peakV = Math.max(peakV, v);
    troughV = Math.min(troughV, v);
    if (peakV > 1e-9) {
      const ddp = ((v - peakV) / peakV) * 100;
      if (ddp < maxDdPct) maxDdPct = ddp;
      const ddu = v - peakV;
      if (ddu < maxDdUsd) maxDdUsd = ddu;
    }
  }
  troughV = Math.min(initialCash, eq[0]!.v);
  for (const p of eq) {
    const v = p.v;
    troughV = Math.min(troughV, v);
    if (troughV > 1e-9) {
      const rup = ((v - troughV) / troughV) * 100;
      if (rup > maxRuPct) maxRuPct = rup;
      const ruu = v - troughV;
      if (ruu > maxRuUsd) maxRuUsd = ruu;
    }
  }
  return {
    maxRunupPct: maxRuPct,
    maxDrawdownPct: maxDdPct,
    maxRunupUsd: maxRuUsd,
    maxDrawdownUsd: maxDdUsd,
    avgRunupPct: 0,
    avgDrawdownPct: 0,
    avgRunupDurationBars: 0,
    avgDrawdownDurationBars: 0,
  };
}

function histogramFromPnl(pnls: number[], bins = 14): HistogramBin[] {
  if (pnls.length === 0) return [];
  const lo = Math.min(...pnls);
  const hi = Math.max(...pnls);
  if (lo === hi) {
    return [{ label: lo.toFixed(2), value: pnls.length, isProfit: lo >= 0, center: lo }];
  }
  const w = (hi - lo) / bins;
  const out: { count: number; center: number; isP: boolean }[] = Array.from(
    { length: bins },
    (_, i) => ({
      count: 0,
      center: lo + (i + 0.5) * w,
      isP: lo + (i + 0.5) * w >= 0,
    }),
  );
  for (const x of pnls) {
    let i = Math.floor((x - lo) / w);
    if (i >= bins) i = bins - 1;
    if (i < 0) i = 0;
    out[i]!.count += 1;
  }
  return out.map((b, i) => ({
    label: `${(lo + i * w).toFixed(2)}‒${(lo + (i + 1) * w).toFixed(2)}%`,
    value: b.count,
    isProfit: b.isP,
    center: b.center,
  }));
}

export type StrategyTesterAnalytics = {
  all: ColMetrics;
  long: ColMetrics;
  short: ColMetrics;
  hasTradeDetail: boolean;
  histogram: HistogramBin[];
  avgWinPct: number;
  avgLossPct: number;
  runupDd: RunupDrawdown;
  pnlPcts: number[];
};

export function buildStrategyTesterAnalytics(
  initialCash: number,
  tradeLog: BacktestTradeRow[] | null | undefined,
  eq: Array<{ t: number; v: number }>,
  summary: BacktestStatsStrip,
): StrategyTesterAnalytics {
  const tl = tradeLog ?? [];
  if (tl.length === 0) {
    const c = emptyCol(initialCash, summary);
    c.netPnlPct = summary.return_pct;
    c.grossLossUsd = Math.abs((summary.max_dd / 100) * initialCash);
    c.trades = summary.trades;
    c.wins = Math.round((summary.trades * summary.win_rate) / 100);
    c.losses = Math.max(0, summary.trades - c.wins);
    c.winRatePct = summary.win_rate;
    c.profitFactor = summary.profit_fct;
    c.sharpe = summary.sharpe;
    return {
      all: c,
      long: c,
      short: c,
      hasTradeDetail: false,
      histogram: [],
      avgWinPct: 0,
      avgLossPct: 0,
      runupDd: analyzeEquityForRunupDd(initialCash, eq),
      pnlPcts: [],
    };
  }
  const longL = tl.filter((t) => t.side === "long");
  const shortL = tl.filter((t) => t.side === "short");
  const pnlPcts = tl.map((t) => t.pnl_pct);
  const wP = pnlPcts.filter((p) => p > 0);
  const lP = pnlPcts.filter((p) => p < 0);
  return {
    all: buildCol(initialCash, tl, eq),
    long: buildCol(initialCash, longL, eq),
    short: buildCol(initialCash, shortL, eq),
    hasTradeDetail: true,
    histogram: histogramFromPnl(pnlPcts),
    avgWinPct: wP.length ? mean(wP) : 0,
    avgLossPct: lP.length ? mean(lP) : 0,
    runupDd: analyzeEquityForRunupDd(initialCash, eq),
    pnlPcts,
  };
}
