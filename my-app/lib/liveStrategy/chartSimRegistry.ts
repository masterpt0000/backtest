/**
 * Modo de simulação por cima das velas: motor local na chart (usa ``/api/chart/ta-series``),
 * apenas VBT no servidor ou ambos em paralelo.
 */
import type { CandleApiBar, ChartIndicatorDef } from "@/components/OhlcvChart";
import type { ChartBuilderSpecV1 } from "@/lib/chartBuilderSpec";
import type { BacktestChartLayer } from "@/lib/backtestChartLayer";
import type { IndicatorSeriesBundle } from "@/lib/chartTaBundles";
import { mergeFeatureScalarsIntoBundles } from "@/lib/chartFeatMerge";
import { runBuilderStrategyFromSpec } from "@/lib/liveStrategy/builderEngine";
import { normalizeVbtStem } from "@/lib/liveStrategy/chartSimIndicatorParams";
import { runJsStrategyByStem } from "@/lib/liveStrategy/chartSimStrategies";
import type { Strategy } from "@/lib/strategies";

export type SimEngineMode = "js" | "vbt" | "both";

export const SIM_ENGINE_STORAGE_KEY = "chart_sim_engine";

/** Stems ``vbt_strategy`` com motor local em ``chartSimStrategies.ts``. */
const LOCAL_TRADE_ENGINE_STEMS = new Set([
  "minimal_rsi_stairs",
  "ema_cross_long_only",
  "rsi_level_flip",
  "bollinger_mean_revert",
  "lateral_market_rsi",
  "trend_composite_gate",
]);

export function parseSimEngineMode(raw: string | null): SimEngineMode {
  if (raw === "vbt" || raw === "both" || raw === "js") return raw;
  return "vbt";
}

export function strategyHasJsTradeEngine(vbtStrategy: string | undefined): boolean {
  if (!vbtStrategy?.trim()) return false;
  return LOCAL_TRADE_ENGINE_STEMS.has(normalizeVbtStem(vbtStrategy));
}

/** Inclui estratégias do construtor com spec carregada (simulação local). */
export function chartStrategyHasJsSimulation(strategy: Strategy): boolean {
  if (strategy.isBuilderStrategy && strategy.builderSpec) return true;
  return strategyHasJsTradeEngine(strategy.vbt_strategy);
}

export function runJsChartSimulation(
  vbtStrategy: string | undefined,
  bars: CandleApiBar[],
  defs: ChartIndicatorDef[],
  builderSpec?: ChartBuilderSpecV1 | null,
  taBundles?: Map<string, IndicatorSeriesBundle> | null,
  featureScalars?: Record<string, number[]> | null,
): BacktestChartLayer | null {
  if (!bars.length) return null;
  const bundles = mergeFeatureScalarsIntoBundles(taBundles, bars.length, featureScalars ?? undefined);
  if (builderSpec) return runBuilderStrategyFromSpec(bars, defs, builderSpec, bundles);
  if (!vbtStrategy?.trim()) return null;
  return runJsStrategyByStem(normalizeVbtStem(vbtStrategy), bars, defs, bundles);
}
