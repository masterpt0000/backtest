/**
 * Sincronização quando a estratégia builder é gravada fora do chart (ex.: botão «Copiar» nos backtests).
 * O painel «Definições» usa overrides locais que sobrepõem o spec — é preciso limpá-los e refetch da lista.
 */

import { extractIndicatorIdsFromFlatParams } from "@/lib/applyOptimizedParamsToBuilderSpec";

export const BUILDER_STRATEGY_SYNC_STORAGE_KEY = "backtest:chartBuilderStrategySync:v1";

export const CHART_BUILDER_STRATEGY_SYNC_EVENT = "chart-builder-strategy-sync";

export type ChartBuilderStrategySyncDetail = {
  uuid: string;
  at: number;
  indicatorIds: string[];
};

/** Chamado pela página de backtests após PUT/localStorage da estratégia com params optimizados. */
export function notifyChartBuilderStrategySynced(uuid: string, flatParams: Record<string, unknown>): void {
  const indicatorIds = extractIndicatorIdsFromFlatParams(flatParams);
  const payload: ChartBuilderStrategySyncDetail = {
    uuid,
    at: Date.now(),
    indicatorIds,
  };
  try {
    localStorage.setItem(BUILDER_STRATEGY_SYNC_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHART_BUILDER_STRATEGY_SYNC_EVENT, { detail: payload }));
  }
}
