"use client";

import dynamic from "next/dynamic";
import { useMemo, type ComponentType, type CSSProperties } from "react";

import type { ColMetrics, HistogramBin, RunupDrawdown, StrategyTesterAnalytics } from "@/lib/strategyTesterStats";
import { fmtCur, fmtPct } from "./strategyTesterFormat";

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: () => (
    <div className="flex h-48 w-full min-w-0 items-center justify-center rounded-lg border border-zinc-800/80 bg-zinc-950/50 text-[11px] text-zinc-500">
      A carregar gráfico…
    </div>
  ),
}) as ComponentType<{
  data: unknown;
  layout: unknown;
  config?: unknown;
  className?: string;
  style?: CSSProperties;
  useResizeHandler?: boolean;
}>;

const PLOT_FON = "#a1a1aa";
const PLOT_PAPER = "#08080a";
const PLOT_GRID = "#1a1a1f";
const C_GREEN = "#26a69a";
const C_RED = "#ef5350";
const C_AMBER = "#f59e0b";
const C_BLUE = "#3b82f6";

const baseLayout = (title: string, height = 260): Record<string, unknown> => ({
  title: { text: title, font: { size: 12, color: PLOT_FON } },
  paper_bgcolor: PLOT_PAPER,
  plot_bgcolor: PLOT_PLOT,
  font: { color: PLOT_FON, size: 10 },
  margin: { t: 40, l: 44, r: 20, b: 48 },
  height,
  showlegend: true,
  legend: { orientation: "h", y: -0.22, x: 0, font: { size: 10 } },
});

const PLOT_PLOT = "#050506";

const plotConfig: Record<string, unknown> = {
  displayModeBar: true,
  displaylogo: false,
  modeBarButtonsToRemove: ["lasso2d", "select2d"],
  responsive: true,
};

export function PnlWaterfallBlock({ all }: { all: ColMetrics }) {
  const { data, layout } = useMemo(() => {
    const gp = Math.max(0, all.grossProfitUsd);
    const gl = Math.max(0, all.grossLossUsd);
    const c = all.commissionUsd;
    const d = {
      type: "waterfall" as const,
      orientation: "v" as const,
      x: ["Lucro bruto", "Perda bruta", "Comissões", "P&L líquido"],
      y: [gp, -gl, -c, 0],
      measure: ["absolute" as const, "relative" as const, "relative" as const, "total" as const],
      text: [fmtCur(gp), fmtCur(-gl), fmtCur(-c), fmtCur(all.netPnlUsd)].map((s) =>
        String(s).replace("−", "-"),
      ),
      textposition: "outside" as const,
      connector: { line: { color: "#3f3f46", width: 1 } },
      increasing: { marker: { color: C_GREEN } },
      decreasing: { marker: { color: C_RED } },
      totals: { marker: { color: C_BLUE } },
    };
    return {
      data: [d],
      layout: {
        ...baseLayout("Estrutura do P&L (USD)", 300),
        yaxis: { title: "USD", gridcolor: PLOT_GRID, zeroline: true, zerolinecolor: "#3f3f46" },
      },
    };
  }, [all]);
  return <Plot data={data} layout={layout} config={plotConfig} className="w-full" useResizeHandler style={{ minHeight: 300 }} />;
}

export function PnlDistributionHistogram({
  pnlPcts,
  hist,
  avgWin,
  avgLoss,
  hasData,
}: {
  pnlPcts: number[];
  hist: HistogramBin[];
  avgWin: number;
  avgLoss: number;
  hasData: boolean;
}) {
  const { data, layout, annotation } = useMemo(() => {
    if (!hasData || hist.length === 0) {
      return { data: [], layout: { ...baseLayout("Distribuição P&L", 220) }, annotation: null as string | null };
    }
    const y = hist.map((h) => h.value);
    const colors = hist.map((h) => (h.isProfit ? C_GREEN : C_RED));
    const dBar = {
      type: "bar" as const,
      x: hist.map((h) => h.label),
      y,
      marker: { color: colors },
    };
    const note =
      pnlPcts.length > 0
        ? `Média ganhos: ${avgWin.toFixed(3)}% · Média perdas: ${avgLoss.toFixed(3)}%`
        : null;
    return {
      data: [dBar],
      layout: {
        ...baseLayout("Distribuição P&L (bin da amostra)", 300),
        xaxis: { title: "Retorno (%)", tickangle: -40, gridcolor: PLOT_GRID, automargin: true },
        yaxis: { title: "N.º", gridcolor: PLOT_GRID },
        showlegend: false,
      },
      annotation: note,
    };
  }, [hasData, hist, pnlPcts, avgWin, avgLoss]);
  if (!hasData) {
    return <p className="text-[11px] text-zinc-500">Sem negócios fechados para o histograma.</p>;
  }
  return (
    <div>
      {annotation ? <p className="mb-1 text-[10px] text-zinc-500">{annotation}</p> : null}
      <Plot data={data} layout={layout} config={plotConfig} className="w-full" useResizeHandler style={{ minHeight: 300 }} />
    </div>
  );
}

export function WinLossDonutBlock({
  wins,
  losses,
  be,
}: {
  wins: number;
  losses: number;
  be: number;
}) {
  const { data, layout } = useMemo(() => {
    const tot = Math.max(1, wins + losses + be);
    return {
      data: [
        {
          type: "pie" as const,
          values: [wins, losses, be],
          labels: ["Ganhos", "Perdas", "Empate"],
          hole: 0.62,
          marker: { colors: [C_GREEN, C_RED, C_AMBER] },
          textinfo: "label+percent" as const,
        },
      ],
      layout: {
        ...baseLayout("Ganhos / perdas", 300),
        showlegend: true,
        annotations: [
          {
            x: 0.5,
            y: 0.45,
            text: `${tot} negócios`,
            showarrow: false,
            font: { size: 12, color: PLOT_FON },
            xref: "paper" as const,
            yref: "paper" as const,
          },
        ],
      },
    };
  }, [wins, losses, be]);
  return <Plot data={data} layout={layout} config={plotConfig} className="w-full" useResizeHandler style={{ minHeight: 300 }} />;
}

export function TradeAveragesTable({ a }: { a: StrategyTesterAnalytics }) {
  const { all, long, short } = a;
  const row = (label: string, f: (c: ColMetrics) => string) => (
    <tr className="hover:bg-zinc-900/50">
      <td className="p-1.5 text-zinc-400">{label}</td>
      <td className="p-1.5 text-right tabular-nums text-zinc-200">{f(all)}</td>
      <td className="p-1.5 text-right tabular-nums text-zinc-200">{f(long)}</td>
      <td className="p-1.5 text-right tabular-nums text-zinc-200">{f(short)}</td>
    </tr>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-[11px] text-zinc-300">
        <thead>
          <tr className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
            <th className="p-1.5 text-left">Métrica</th>
            <th className="p-1.5 text-right">Tudo</th>
            <th className="p-1.5 text-right">Long</th>
            <th className="p-1.5 text-right">Short</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/80">
          {row("P&L médio (%)", (c) => `${c.avgPnlPct.toFixed(3)}%`)}
          {row("P&L médio ganhador", (c) => `${c.avgWinPct.toFixed(3)}%`)}
          {row("P&L médio perdedor", (c) => `${c.avgLossPct.toFixed(3)}%`)}
          {row("Rácio ganho / perda méd.", (c) => c.ratioWinLoss.toFixed(3))}
          {row("Maior ganho (%)", (c) => `${c.largestWinPct.toFixed(3)}%`)}
          {row("Maior perda (%)", (c) => `${c.largestLossPct.toFixed(3)}%`)}
          {row("Maior ganho (USD)", (c) => fmtCur(c.largestWinUsd))}
          {row("Maior perda (USD)", (c) => fmtCur(c.largestLossUsd))}
          {row("Média barras / negócio", (c) => c.avgBarsInTrade.toFixed(1))}
          {row("Sharpe (trades)", (c) => c.sharpe.toFixed(3))}
          {row("Sortino (trades)", (c) => c.sortino.toFixed(3))}
        </tbody>
      </table>
    </div>
  );
}

export function TradesDetailsTableBlock({ a }: { a: StrategyTesterAnalytics }) {
  const { all, long, short } = a;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-[11px] text-zinc-300">
        <thead>
          <tr className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
            <th className="p-1.5 text-left">Métrica</th>
            <th className="p-1.5 text-right">Tudo</th>
            <th className="p-1.5 text-right">Long</th>
            <th className="p-1.5 text-right">Short</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/80">
          <tr className="hover:bg-zinc-900/50">
            <td className="p-1.5 text-zinc-400">P&amp;L líquido (USD / %)</td>
            <td className={`p-1.5 text-right tabular-nums ${all.netPnlUsd >= 0 ? "text-emerald-400" : "text-rose-300"}`}>
              {fmtCur(all.netPnlUsd)} / {fmtPct(all.netPnlPct)}
            </td>
            <td className={`p-1.5 text-right tabular-nums ${long.netPnlUsd >= 0 ? "text-emerald-400" : "text-rose-300"}`}>
              {fmtCur(long.netPnlUsd)} / {fmtPct(long.netPnlPct)}
            </td>
            <td className={`p-1.5 text-right tabular-nums ${short.netPnlUsd >= 0 ? "text-emerald-400" : "text-rose-300"}`}>
              {fmtCur(short.netPnlUsd)} / {fmtPct(short.netPnlPct)}
            </td>
          </tr>
          <tr className="hover:bg-zinc-900/50">
            <td className="p-1.5 text-zinc-400">Lucro bruto</td>
            <td className="p-1.5 text-right tabular-nums text-emerald-400">{fmtCur(all.grossProfitUsd)}</td>
            <td className="p-1.5 text-right tabular-nums text-emerald-400">{fmtCur(long.grossProfitUsd)}</td>
            <td className="p-1.5 text-right tabular-nums text-emerald-400">{fmtCur(short.grossProfitUsd)}</td>
          </tr>
          <tr className="hover:bg-zinc-900/50">
            <td className="p-1.5 text-zinc-400">Perda bruta</td>
            <td className="p-1.5 text-right tabular-nums text-rose-300">{fmtCur(all.grossLossUsd)}</td>
            <td className="p-1.5 text-right tabular-nums text-rose-300">{fmtCur(long.grossLossUsd)}</td>
            <td className="p-1.5 text-right tabular-nums text-rose-300">{fmtCur(short.grossLossUsd)}</td>
          </tr>
          <tr className="hover:bg-zinc-900/50">
            <td className="p-1.5 text-zinc-400">Profit factor</td>
            <td className="p-1.5 text-right tabular-nums">{all.profitFactor.toFixed(3)}</td>
            <td className="p-1.5 text-right tabular-nums">{long.profitFactor.toFixed(3)}</td>
            <td className="p-1.5 text-right tabular-nums">{short.profitFactor.toFixed(3)}</td>
          </tr>
          <tr className="hover:bg-zinc-900/50">
            <td className="p-1.5 text-zinc-400">Comissão</td>
            <td className="p-1.5 text-right tabular-nums">{fmtCur(all.commissionUsd)}</td>
            <td className="p-1.5 text-right tabular-nums">—</td>
            <td className="p-1.5 text-right tabular-nums">—</td>
          </tr>
          <tr className="hover:bg-zinc-900/50">
            <td className="p-1.5 text-zinc-400">Ganhos / Perdas / Empate</td>
            <td className="p-1.5 text-right tabular-nums text-zinc-200">
              {all.wins} / {all.losses} / {all.breakEven}
            </td>
            <td className="p-1.5 text-right tabular-nums text-zinc-200">
              {long.wins} / {long.losses} / {long.breakEven}
            </td>
            <td className="p-1.5 text-right tabular-nums text-zinc-200">
              {short.wins} / {short.losses} / {short.breakEven}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function CapitalEfficiencyTableBlock({ a, initialCash }: { a: StrategyTesterAnalytics; initialCash: number }) {
  const { all, long, short } = a;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-[11px] text-zinc-300">
        <tbody className="divide-y divide-zinc-800/80">
          <tr>
            <td className="p-1.5 text-zinc-400">Retorno s/ capital inicial</td>
            <td className="p-1.5 text-right tabular-nums">{fmtPct(all.netPnlPct)}</td>
            <td className="p-1.5 text-right tabular-nums">{fmtPct(long.netPnlPct)}</td>
            <td className="p-1.5 text-right tabular-nums">{fmtPct(short.netPnlPct)}</td>
          </tr>
          <tr>
            <td className="p-1.5 text-zinc-400">Capital inicial (ref.)</td>
            <td className="p-1.5 text-right tabular-nums text-zinc-200" colSpan={3}>
              {fmtCur(initialCash)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function RunupDrawdownTableBlock({ r }: { r: RunupDrawdown }) {
  return (
    <div className="overflow-x-auto text-[11px] text-zinc-300">
      <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Run-ups</h4>
      <table className="mb-3 w-full border-collapse">
        <tbody>
          <tr>
            <td className="p-1 text-zinc-400">Máx. run-up (série)</td>
            <td className="p-1 text-right font-medium tabular-nums text-zinc-200">
              {fmtCur(r.maxRunupUsd)} / {r.maxRunupPct.toFixed(2)}%
            </td>
          </tr>
        </tbody>
      </table>
      <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Drawdowns</h4>
      <table className="w-full border-collapse">
        <tbody>
          <tr>
            <td className="p-1 text-zinc-400">Máx. drawdown (pico &gt; ponto)</td>
            <td className="p-1 text-right font-medium tabular-nums text-rose-300">
              {fmtCur(r.maxDrawdownUsd)} / {r.maxDrawdownPct.toFixed(2)}%
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
