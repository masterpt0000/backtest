"use client";

import {
  ColorType,
  createChart,
  CrosshairMode,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { BacktestChartLayer } from "@/lib/backtestChartLayer";
import { buildStrategyTesterAnalytics } from "@/lib/strategyTesterStats";
import {
  CapitalEfficiencyTableBlock,
  PnlDistributionHistogram,
  PnlWaterfallBlock,
  RunupDrawdownTableBlock,
  TradeAveragesTable,
  TradesDetailsTableBlock,
  WinLossDonutBlock,
} from "@/components/StrategyTesterPlotlyBlocks";
const CHART_BG = "#050506";
const CHART_GRID = "#1a1a1f";
const CHART_BORDER = "#25252b";

const LINKED_TIME = {
  fixRightEdge: true,
  rightOffset: 4,
} as const;

function formatBarTime(t: number): string {
  return new Date(t * 1000).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clampVisibleRange(
  tr: { from: unknown; to: unknown },
  lastBarTimeSec: number | null,
): { from: unknown; to: unknown } {
  if (lastBarTimeSec == null) return tr;
  const to = tr.to;
  if (typeof to === "number" && to > lastBarTimeSec) {
    return { ...tr, to: lastBarTimeSec };
  }
  return tr;
}

function safeCopyVisibleToTarget(
  source: IChartApi,
  target: IChartApi,
  lastBarT: number | null,
): void {
  let tr: { from?: unknown; to?: unknown } | null = null;
  try {
    tr = source.timeScale().getVisibleRange() as { from?: unknown; to?: unknown } | null;
  } catch {
    return;
  }
  if (tr == null || tr.from == null || tr.to == null) return;
  const clamped = clampVisibleRange(
    tr as { from: unknown; to: unknown },
    lastBarT,
  );
  try {
    target.timeScale().setVisibleRange(clamped as never);
  } catch {
    /* ignore */
  }
}

type TabId = "metrics" | "trades";

type Props = {
  backtest: BacktestChartLayer;
  strategyLabel?: string | null;
  overlayMode?: "live" | "questdb" | null;
  mainChart: IChartApi | null;
  lastBarTimeSec: number | null;
};

function AccRow({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-zinc-800/80">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-0 py-2.5 text-left text-[13px] font-medium text-zinc-200 hover:bg-zinc-900/40"
        aria-expanded={open}
      >
        <span>{title}</span>
        <span className="text-zinc-500" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? <div className="pb-3 pl-0 pr-1 text-[12px] leading-relaxed text-zinc-400">{children}</div> : null}
    </div>
  );
}

export function StrategyTesterPanel({
  backtest,
  strategyLabel,
  overlayMode,
  mainChart,
  lastBarTimeSec,
}: Props) {
  const [tab, setTab] = useState<TabId>("metrics");
  const containerRef = useRef<HTMLDivElement>(null);
  const eqRef = useRef<IChartApi | null>(null);
  const eqSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  /** Refs evitam callbacks de subscribe a usar um ``IChartApi`` já disposed antes do cleanup do efeito. */
  const mainChartRef = useRef<IChartApi | null>(mainChart);
  const lastBarTimeRef = useRef<number | null>(lastBarTimeSec);
  mainChartRef.current = mainChart;
  lastBarTimeRef.current = lastBarTimeSec;
  const { overlay, stats, tradeLog } = backtest;
  const initialCash = overlay.initial_cash ?? 10_000;
  const modeLabel = overlayMode === "live" ? "Simulação (velas do gráfico)" : "Backtest (QuestDB)";

  const analytics = useMemo(
    () => buildStrategyTesterAnalytics(initialCash, tradeLog, overlay.equity, stats),
    [initialCash, tradeLog, overlay.equity, stats],
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const w = Math.max(200, el.clientWidth);
    const h = 200;
    const chart = createChart(el, {
      width: w,
      height: h,
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: "#b4b4b8",
        attributionLogo: false,
      },
      grid: { vertLines: { color: CHART_GRID }, horzLines: { color: CHART_GRID } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: CHART_BORDER, ...LINKED_TIME },
      rightPriceScale: { borderColor: CHART_BORDER },
    });
    const series = chart.addSeries(LineSeries, {
      color: "#a78bfa",
      lineWidth: 2,
      lastValueVisible: true,
      priceLineVisible: false,
    });
    eqRef.current = chart;
    eqSeriesRef.current = series;
    return () => {
      eqRef.current = null;
      eqSeriesRef.current = null;
      try {
        chart.remove();
      } catch {
        /* chart already disposed */
      }
    };
  }, []);

  useEffect(() => {
    const series = eqSeriesRef.current;
    const chart = eqRef.current;
    if (!series || !chart) return;
    const pts = (overlay.equity ?? []).map((p) => ({
      time: p.t as UTCTimestamp,
      value: p.v,
    }));
    try {
      series.setData(pts);
    } catch {
      return;
    }
    const align = () => {
      try {
        const c = eqRef.current;
        const src = mainChartRef.current;
        if (src && c) {
          safeCopyVisibleToTarget(src, c, lastBarTimeRef.current);
        } else if (pts.length && c) {
          c.timeScale().fitContent();
        }
      } catch {
        /* gráfico principal ou filho disposed */
      }
    };
    queueMicrotask(align);
  }, [overlay.equity, mainChart, lastBarTimeSec]);

  useEffect(() => {
    const child = eqRef.current;
    const src = mainChartRef.current;
    if (!src || !child) return;
    const sync = () => {
      try {
        const c = eqRef.current;
        const m = mainChartRef.current;
        if (m && c) safeCopyVisibleToTarget(m, c, lastBarTimeRef.current);
      } catch {
        /* Object is disposed durante remount do OhlcvChart */
      }
    };
    try {
      child.timeScale().applyOptions({ visible: true, ...LINKED_TIME });
    } catch {
      return;
    }
    queueMicrotask(sync);
    try {
      src.timeScale().subscribeVisibleTimeRangeChange(sync);
    } catch {
      return;
    }
    return () => {
      try {
        src.timeScale().unsubscribeVisibleTimeRangeChange(sync);
      } catch {
        /* src pode já estar disposed (OhlcvChart.remove antes deste cleanup) */
      }
    };
  }, [mainChart, lastBarTimeSec]);

  useEffect(() => {
    const el = containerRef.current;
    const c = eqRef.current;
    if (!el || !c) return;
    let disposed = false;
    const ro = new ResizeObserver(() => {
      if (disposed || eqRef.current !== c) return;
      const w = Math.max(200, el.clientWidth);
      try {
        c.applyOptions({ width: w });
      } catch {
        /* chart disposed */
      }
    });
    ro.observe(el);
    const w0 = Math.max(200, el.clientWidth);
    try {
      c.applyOptions({ width: w0 });
    } catch {
      /* ignore */
    }
    return () => {
      disposed = true;
      ro.disconnect();
    };
  }, [tab]);

  const pnlClass = (x: number) => (x >= 0 ? "text-emerald-400" : "text-rose-400");

  return (
    <section
      className="shrink-0 border-t border-zinc-800/80 bg-[#08080a]"
      aria-label="Strategy tester"
    >
      <div className="border-b border-zinc-800/60 px-2 py-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-violet-400/90">
            {strategyLabel?.trim() || "Estratégia"} — {modeLabel}
          </h2>
        </div>
        <div className="flex gap-1 rounded-lg border border-zinc-800/90 bg-zinc-950/80 p-0.5">
          <button
            type="button"
            onClick={() => setTab("metrics")}
            className={
              "flex-1 rounded-md px-3 py-1.5 text-center text-[12px] font-medium " +
              (tab === "metrics" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300")
            }
          >
            Métricas
          </button>
          <button
            type="button"
            onClick={() => setTab("trades")}
            className={
              "flex-1 rounded-md px-3 py-1.5 text-center text-[12px] font-medium " +
              (tab === "trades" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300")
            }
          >
            Lista de negócios
          </button>
        </div>
      </div>

      <div className="px-2 py-2">
        <div className={tab === "trades" ? "hidden" : "block"}>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">P&amp;L total</div>
              <div
                className={`text-[14px] font-semibold tabular-nums ${
                  stats.return_pct >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {stats.return_pct >= 0 ? "+" : ""}
                {stats.return_pct.toFixed(2)}%
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Max. drawdown</div>
              <div className="text-[14px] font-semibold tabular-nums text-rose-300/90">
                {stats.max_dd.toFixed(2)}%
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Negócios</div>
              <div className="text-[14px] font-semibold tabular-nums text-zinc-200">{stats.trades}</div>
            </div>
            <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">% ganhos</div>
              <div className="text-[14px] font-semibold tabular-nums text-zinc-200">
                {stats.win_rate.toFixed(1)}%
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2 sm:col-span-2 lg:col-span-1">
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Profit factor</div>
              <div className="text-[14px] font-semibold tabular-nums text-zinc-200">
                {stats.profit_fct.toFixed(3)}
              </div>
            </div>
          </div>

          <h3 className="mb-1 text-[11px] font-semibold text-zinc-500">Equity</h3>
          <p className="mb-1 text-[10px] text-zinc-600">
            Eixo alinhado ao preço: ao mudar o zoom no gráfico principal, o equity acompanha.
          </p>
          <div
            ref={containerRef}
            className="mb-2 min-h-[200px] w-full overflow-hidden rounded-lg border border-zinc-800/80 bg-[#050506]"
            style={{ minHeight: 200 }}
          />
          <div className="text-[10px] text-zinc-600">Capital inicial (referência): {initialCash.toFixed(0)}</div>

          <div className="mt-3 border-t border-zinc-800/60 pt-1">
            <AccRow title="Desempenho" defaultOpen>
              {analytics.hasTradeDetail ? (
                <div className="space-y-3">
                  <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                    <div className="min-w-0">
                      <PnlWaterfallBlock all={analytics.all} />
                    </div>
                    <div className="min-w-0">
                      <WinLossDonutBlock
                        wins={analytics.all.wins}
                        losses={analytics.all.losses}
                        be={analytics.all.breakEven}
                      />
                    </div>
                  </div>
                  <PnlDistributionHistogram
                    pnlPcts={analytics.pnlPcts}
                    hist={analytics.histogram}
                    avgWin={analytics.avgWinPct}
                    avgLoss={analytics.avgLossPct}
                    hasData={analytics.hasTradeDetail && analytics.pnlPcts.length > 0}
                  />
                  <TradesDetailsTableBlock a={analytics} />
                </div>
              ) : (
                <p className="text-zinc-500">
                  Tabelas e gráficos de detalhe (estilo TradingView) com lucro/perda aproximam-se ao máximo
                  quando a lista de negócios vem da simulação Mínima no cliente. O job QuestDB, por agora, só
                  alimenta resumo: retorno {stats.return_pct.toFixed(2)}%, Sharpe {stats.sharpe.toFixed(2)}.
                </p>
              )}
            </AccRow>
            <AccRow title="Análise de negócios" defaultOpen>
              {analytics.hasTradeDetail ? (
                <div className="space-y-3">
                  <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                    <PnlDistributionHistogram
                      pnlPcts={analytics.pnlPcts}
                      hist={analytics.histogram}
                      avgWin={analytics.avgWinPct}
                      avgLoss={analytics.avgLossPct}
                      hasData
                    />
                    <WinLossDonutBlock
                      wins={analytics.all.wins}
                      losses={analytics.all.losses}
                      be={analytics.all.breakEven}
                    />
                  </div>
                  <TradeAveragesTable a={analytics} />
                </div>
              ) : (
                <p className="text-zinc-500">
                  {stats.trades} negócios (resumo). Abre a simulação Mínima com velas no gráfico para gráficos
                  Plotly completos.
                </p>
              )}
            </AccRow>
            <AccRow title="Eficiência de capital">
              <CapitalEfficiencyTableBlock a={analytics} initialCash={initialCash} />
            </AccRow>
            <AccRow title="Run-ups e drawdowns">
              <RunupDrawdownTableBlock r={analytics.runupDd} />
            </AccRow>
          </div>
        </div>

        <div className={tab === "metrics" ? "hidden" : "block"}>
          {tradeLog && tradeLog.length > 0 ? (
            <div className="app-scrollbar max-h-[min(50vh,28rem)] overflow-auto rounded-lg border border-zinc-800/80">
              <table className="w-full min-w-[20rem] border-collapse text-left text-[11px] text-zinc-300">
                <thead className="sticky top-0 z-1 bg-zinc-950/95 text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="p-1.5 pr-2">#</th>
                    <th className="p-1.5 pr-2">Lado</th>
                    <th className="p-1.5 pr-2">Entrada</th>
                    <th className="p-1.5 pr-2">Saída</th>
                    <th className="p-1.5 pr-2 text-right">P&amp;L %</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeLog.map((r, i) => (
                    <tr key={`${r.entryTime}-${r.exitTime}-${i}`} className="border-t border-zinc-800/50">
                      <td className="p-1.5 pr-2 tabular-nums text-zinc-500">{i + 1}</td>
                      <td className="p-1.5 pr-2 text-zinc-200">{r.side === "long" ? "Long" : "Short"}</td>
                      <td className="p-1.5 pr-2 tabular-nums text-zinc-400">{formatBarTime(r.entryTime)}</td>
                      <td className="p-1.5 pr-2 tabular-nums text-zinc-400">{formatBarTime(r.exitTime)}</td>
                      <td className={`p-1.5 pr-2 text-right font-medium tabular-nums ${pnlClass(r.pnl_pct)}`}>
                        {r.pnl_pct >= 0 ? "+" : ""}
                        {r.pnl_pct.toFixed(3)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-4 text-center text-[12px] text-zinc-500">
              Não há linhas de negócio nesta fonte. Na simulação Mínima RSI no cliente a lista preenche-se
              automaticamente. Para backtest QuestDB, o detalhamento pode vir a ser exposto na API.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
