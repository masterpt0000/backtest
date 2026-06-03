/**
 * Replica na simulação do Chart os últimos valores da página Backtests (custos, mín. trades, capital).
 * Grava-se em ``sessionStorage`` quando o utilizador abre Backtests ou altera os campos.
 */

export type ChartSimParityPayload = {
  exec_fee_pct_per_fill: number;
  exec_slippage_pct: number;
  exec_half_spread_pct: number;
  min_trades: number;
  initial_cash: number;
};

export const CHART_SIM_PARITY_UPDATED_EVENT = "chartSimParityUpdated";

const STORAGE_KEY = "chart:simParityWithBacktests";

export function clampExecPctForChartSim(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(2, Math.max(0, n));
}

export function persistChartSimParityFromBacktests(p: ChartSimParityPayload): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    window.dispatchEvent(new CustomEvent(CHART_SIM_PARITY_UPDATED_EVENT));
  } catch {
    /* quota */
  }
}

export function readChartSimParityForChart(): ChartSimParityPayload | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const fee = clampExecPctForChartSim(Number(o.exec_fee_pct_per_fill));
    const slip = clampExecPctForChartSim(Number(o.exec_slippage_pct));
    const half = clampExecPctForChartSim(Number(o.exec_half_spread_pct));
    let mt = Math.floor(Number(o.min_trades));
    if (!Number.isFinite(mt)) mt = 50;
    mt = Math.min(5000, Math.max(1, mt));
    let cash = Number(o.initial_cash);
    if (!Number.isFinite(cash) || cash <= 0) cash = 10_000;
    return {
      exec_fee_pct_per_fill: fee,
      exec_slippage_pct: slip,
      exec_half_spread_pct: half,
      min_trades: mt,
      initial_cash: cash,
    };
  } catch {
    return null;
  }
}
