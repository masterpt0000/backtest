import type { BacktestRangePreset } from "@/lib/backtestTypes";

/** Conteúdo JSON em ``strategy_symbol_configs.params`` (versão 1). */
export type BacktestPresetParamsV1 = {
  version: 1;
  tab: "single" | "optimize";
  timeframe: string;
  /** Preferência multi-TF (preset pode omitir → só ``timeframe``). */
  timeframes?: string[];
  range_preset: BacktestRangePreset;
  initial_cash: number;
  num_tests: number;
  max_tries: number;
  best_by: string;
  min_trades: number;
  optimize_seed: string;
  grid_sample: "lhs" | "random";
  optimize_top_k: number;
  holdout_pct: number;
  symbol_ids: number[];
  include_ui_charts?: boolean;
  validation_framework?: "standard" | "walk_forward" | "monte_carlo";
  validation_frameworks?: ("standard" | "walk_forward" | "monte_carlo")[];
  wf_n_splits?: number;
  wf_min_segment_bars?: number;
  mc_runs?: number;
  mc_seed?: string;
  param_drift_enabled?: boolean;
  param_drift_pct_by_key?: Record<string, number>;
  exec_fee_pct_per_fill?: number;
  exec_slippage_pct?: number;
  exec_half_spread_pct?: number;
};

export type StrategyPresetRow = {
  id: number;
  vbt_strategy_id: string;
  symbol_id: number | null;
  name: string;
  params: Record<string, unknown>;
  notes: string;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export function isPresetParamsV1(x: unknown): x is BacktestPresetParamsV1 {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return o.version === 1 && (o.tab === "single" || o.tab === "optimize");
}
