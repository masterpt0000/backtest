export type BacktestRangePreset = "7d" | "30d" | "90d" | "1y" | "max";

export type BacktestMode = "single" | "optimize";
export type BacktestStrategySource = "vbt" | "builder";
export type BacktestValidationFramework = "standard" | "walk_forward" | "monte_carlo";

/** Payload enviado ao POST /api/backtest/jobs (snake_case no JSON). */
export type BacktestRunPayload = {
  mode: BacktestMode;
  strategy_source?: BacktestStrategySource;
  vbt_strategy: string;
  builder_strategy_id?: string;
  builder_spec?: Record<string, unknown>;
  /** Só para mostrar na barra de progresso. */
  vbt_label?: string;
  symbol_ids: number[];
  symbol_labels: Record<string, string>;
  /** Primeiro timeframe (compat legado); preferir também ``timeframes``. */
  timeframe: string;
  /** Lista de timeframes corridos no mesmo job (mesmo período / símbolos). */
  timeframes?: string[];
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
  /** Curvas Plotly / equity por trial — mais lento no backend (default recomendado: false). */
  include_ui_charts?: boolean;
  validation_framework?: BacktestValidationFramework;
  validation_frameworks?: BacktestValidationFramework[];
  wf_n_splits?: number;
  wf_min_segment_bars?: number;
  mc_runs?: number;
  mc_seed?: number;
  /** Builder: stress de parâmetros ±pct% (min/base/max na grelha). */
  param_drift_enabled?: boolean;
  param_drift_pct_by_key?: Record<string, number>;
  /** % do notional por fill (abrir/fechar/reduzir); modelo simplificado sem maker/taker. */
  exec_fee_pct_per_fill?: number;
  /** % adversa extra por lado vs close de referência (somada ao half-spread). */
  exec_slippage_pct?: number;
  /** Meio-spread como % do preço (proxy bid/ask); vectorbt usa slippage efectiva = slip + half. */
  exec_half_spread_pct?: number;
};

export type BacktestJobStatus = "idle" | "running" | "completed" | "error";

/** Um teste (threshold / combinação) com curva de equity para visualização multi-linha. */
export type BacktestTrialCurve = {
  trial_index: number;
  return_pct?: number;
  win_rate?: number;
  trades?: number;
  max_dd?: number;
  sharpe?: number;
  profit_fct?: number;
  expectancy?: number;
  best_params?: Record<string, unknown>;
  /** Builder: snapshot completo (risco + zonas + ind/…) após aplicar best_params à spec. */
  resolved_params?: Record<string, unknown>;
  equity: { t: number; v: number }[];
};

/** Trials agrupados por par (símbolo) e timeframe (opcional). */
export type BacktestTrialBatch = {
  symbol_id: number;
  symbol: string;
  timeframe?: string;
  trials: BacktestTrialCurve[];
};

export type BacktestJobState = {
  status: BacktestJobStatus;
  progress: number;
  phase: string;
  run: BacktestRunPayload | null;
  error: string | null;
  finishedAt: number | null;
  /** Resultados do FastAPI quando status === completed */
  results: unknown[] | null;
  /** Curvas por teste (uma linha por trial nos gráficos de equity / métricas). */
  trialBatches: BacktestTrialBatch[] | null;
  /** Por símbolo: folds walk-forward + summary (backend). */
  walkForward: Record<string, unknown>[] | null;
  /** Por símbolo: distribuição Monte Carlo bootstrap (backend). */
  monteCarlo: Record<string, unknown>[] | null;
  /** Contagens agregadas do job (ex.: skips QuestDB vs trials abaixo de min_trades). */
  jobDiagnostics: Record<string, unknown> | null;
};

export function formatBacktestTimeframeLabel(
  run: Pick<BacktestRunPayload, "timeframe" | "timeframes">,
): string {
  if (run.timeframes && run.timeframes.length > 0) return run.timeframes.join(", ");
  return run.timeframe;
}
