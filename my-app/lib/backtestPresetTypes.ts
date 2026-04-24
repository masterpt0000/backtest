import type { BacktestRangePreset } from "@/lib/backtestTypes";

/** Conteúdo JSON em ``strategy_symbol_configs.params`` (versão 1). */
export type BacktestPresetParamsV1 = {
  version: 1;
  tab: "single" | "optimize";
  timeframe: string;
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
