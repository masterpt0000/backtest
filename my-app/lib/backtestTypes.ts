export type BacktestRangePreset = "7d" | "30d" | "90d" | "1y" | "max";

export type BacktestMode = "single" | "optimize";

/** Payload enviado ao POST /api/backtest/jobs (snake_case no JSON). */
export type BacktestRunPayload = {
  mode: BacktestMode;
  vbt_strategy: string;
  /** Só para mostrar na barra de progresso. */
  vbt_label?: string;
  symbol_ids: number[];
  symbol_labels: Record<string, string>;
  timeframe: string;
  range_preset: BacktestRangePreset;
  initial_cash: number;
  num_tests: number;
  max_tries: number;
  best_by: string;
  min_trades: number;
  /** Omitir para seed pseudo-aleatória por job (reprodutível se definido). */
  optimize_seed?: number;
  optimize_grid_sample?: "lhs" | "random";
  /** Só modo optimize: quantas soluções guardar por par (dedupe + ranking). */
  optimize_top_k?: number;
  /** Fração 0–0.5: última parte da série para validação OOS dos top resultados. */
  optimize_holdout_ratio?: number;
};

export type BacktestJobStatus = "idle" | "running" | "completed" | "error";

export type BacktestJobState = {
  status: BacktestJobStatus;
  progress: number;
  phase: string;
  run: BacktestRunPayload | null;
  error: string | null;
  finishedAt: number | null;
  /** Resultados do FastAPI quando status === completed */
  results: unknown[] | null;
};
