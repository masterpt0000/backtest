/**
 * Simula ``minimal_rsi_stairs_vbt`` nas velas visíveis do gráfico.
 * A série RSI deve vir do ``/api/chart/ta-series`` (TA-Lib), alinhada às velas.
 */
import type { OhlcBarLike } from "@/lib/indicatorsFromBars";

import type { BacktestChartLayer } from "@/lib/backtestChartLayer";

import type { IndicatorSource } from "@/lib/strategies";

import { emptyQuadSignals, runQuadSignalSimulation } from "@/lib/liveStrategy/chartSimBarByBar";

export type MinimalRsiStairsSimParams = {
  rsiPeriod: number;
  source: IndicatorSource;
  longCross: number;
  shortCross: number;
  exitMid: number;
};

function resolvedParams(p?: Partial<MinimalRsiStairsSimParams>): MinimalRsiStairsSimParams {
  return {
    rsiPeriod: Math.max(2, Math.min(200, Math.round(p?.rsiPeriod ?? 14))),
    source: p?.source ?? "close",
    longCross: p?.longCross ?? 40,
    shortCross: p?.shortCross ?? 60,
    exitMid: p?.exitMid ?? 50,
  };
}

/** ``rsiAligned`` = um valor por barra (mesmo ``n`` que ``bars``). */
export function buildMinimalRsiStairsFromBars(
  bars: OhlcBarLike[],
  params?: Partial<MinimalRsiStairsSimParams>,
  rsiAligned?: number[] | null,
): BacktestChartLayer | null {
  const { longCross: LONG_CROSS, shortCross: SHORT_CROSS, exitMid: EXIT_MID } =
    resolvedParams(params);
  const n = bars.length;
  if (!n) return null;

  if (!rsiAligned || rsiAligned.length !== n) return null;

  const rsi = rsiAligned.map((v) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined,
  );

  const sig = emptyQuadSignals(n);
  const skipBar = new Array<boolean>(n).fill(false);

  for (let i = 0; i < n; i++) {
    const r = rsi[i];
    const rp = i > 0 ? rsi[i - 1] : undefined;
    if (r === undefined || rp === undefined) {
      skipBar[i] = true;
      continue;
    }
    sig.longEntry[i] = r <= LONG_CROSS && rp > LONG_CROSS;
    sig.shortEntry[i] = r >= SHORT_CROSS && rp < SHORT_CROSS;
    sig.longExit[i] = r >= EXIT_MID && rp < EXIT_MID;
    sig.shortExit[i] = r <= EXIT_MID && rp > EXIT_MID;
  }

  return runQuadSignalSimulation(bars, sig, skipBar);
}

export const MINIMAL_RSI_STAIRS_VBT_ID = "minimal_rsi_stairs" as const;
