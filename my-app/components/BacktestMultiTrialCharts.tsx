"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, type ComponentType, type CSSProperties } from "react";

import type { BacktestTrialBatch, BacktestTrialCurve } from "@/lib/backtestTypes";

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: () => (
    <div className="flex h-52 w-full min-w-0 items-center justify-center rounded-lg border border-zinc-800/80 bg-zinc-950/50 text-[11px] text-zinc-500">
      A carregar gráficos…
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
const PLOT_PLOT = "#050506";

const plotConfig: Record<string, unknown> = {
  displayModeBar: true,
  displaylogo: false,
  modeBarButtonsToRemove: ["lasso2d", "select2d"],
  responsive: true,
};

function baseLayout(title: string, height: number): Record<string, unknown> {
  return {
    title: { text: title, font: { size: 12, color: PLOT_FON } },
    paper_bgcolor: PLOT_PAPER,
    plot_bgcolor: PLOT_PLOT,
    font: { color: PLOT_FON, size: 10 },
    margin: { t: 40, l: 52, r: 16, b: 44 },
    height,
    showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0, font: { size: 9 } },
  };
}

function trialLineColor(i: number, n: number): string {
  if (n <= 1) return "rgba(52, 211, 153, 0.55)";
  const h = Math.round((i * 277.0) % 360);
  return `hsla(${h}, 58%, 56%, 0.42)`;
}

function meanEquityCurve(trials: BacktestTrialCurve[]): { t: number; v: number }[] {
  if (trials.length === 0) return [];
  const lens = trials.map((tr) => tr.equity?.length ?? 0).filter((x) => x > 1);
  if (!lens.length) return [];
  const len = Math.min(...lens);
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < len; i++) {
    let s = 0;
    let tt = 0;
    let c = 0;
    for (const tr of trials) {
      const p = tr.equity[i];
      if (!p) continue;
      s += p.v;
      tt += p.t;
      c += 1;
    }
    if (c > 0) out.push({ t: Math.round(tt / c), v: s / c });
  }
  return out;
}

function num(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number.parseFloat(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type MetricKey = "profit_fct" | "win_rate" | "sharpe" | "return_pct";

function buildMetricFig(
  trials: BacktestTrialCurve[],
  metric: MetricKey,
  title: string,
  height: number,
): { data: Record<string, unknown>[]; layout: Record<string, unknown> } | null {
  if (!trials.length) return null;
  const ys = trials.map((t) => num(t[metric]) ?? 0);
  const xs = trials.map((_, i) => i);
  const avg = ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length);
  const traces: Record<string, unknown>[] = [
    {
      type: "scatter",
      mode: "lines+markers",
      x: xs,
      y: ys,
      line: { width: 1, color: "rgba(167, 139, 250, 0.65)" },
      marker: { size: 5, color: "rgba(167, 139, 250, 0.85)" },
      name: "Por teste",
      hovertemplate: `Teste %{x}<br>${title}: %{y:.3f}<extra></extra>`,
    },
  ];
  const layout = {
    ...baseLayout(title, height),
    xaxis: {
      title: "Índice do teste",
      gridcolor: PLOT_GRID,
      zeroline: false,
    },
    yaxis: { title: title.split("(")[0]?.trim() ?? title, gridcolor: PLOT_GRID },
    shapes: [
      {
        type: "line",
        xref: "paper",
        x0: 0,
        x1: 1,
        y0: avg,
        y1: avg,
        line: { color: "rgba(228, 228, 231, 0.35)", width: 1, dash: "dot" },
      },
    ],
    annotations: [
      {
        x: 1,
        xref: "paper",
        y: avg,
        yref: "y",
        text: `μ ${avg.toFixed(2)}`,
        showarrow: false,
        xanchor: "right",
        font: { size: 9, color: PLOT_FON },
      },
    ],
  };
  return { data: traces, layout };
}

export function BacktestMultiTrialCharts({ batches }: { batches: BacktestTrialBatch[] | null }) {
  const usable = useMemo(() => (Array.isArray(batches) ? batches.filter((b) => (b.trials?.length ?? 0) > 0) : []), [
    batches,
  ]);
  const [symIdx, setSymIdx] = useState(0);

  useEffect(() => {
    setSymIdx((i) => {
      const max = Math.max(0, usable.length - 1);
      return Math.min(Math.max(0, i), max);
    });
  }, [usable.length]);

  const batch = usable[symIdx] ?? null;
  const trials = useMemo(() => {
    if (!batch?.trials?.length) return [];
    return batch.trials.filter((t) => Array.isArray(t.equity) && t.equity.length > 1);
  }, [batch]);

  const equityFig = useMemo(() => {
    if (!trials.length) return null;
    const data: Record<string, unknown>[] = [];
    const n = trials.length;
    trials.forEach((tr, i) => {
      const x = tr.equity.map((p) => new Date(p.t * 1000));
      const y = tr.equity.map((p) => p.v);
      data.push({
        type: "scatter",
        mode: "lines",
        x,
        y,
        line: { width: 1, color: trialLineColor(i, n) },
        name: `#${tr.trial_index ?? i}`,
        showlegend: i < Math.min(12, n),
        hovertemplate:
          `<b>#${tr.trial_index ?? i}</b><br>%{x|%Y-%m-%d %H:%M}<br>Equity %{y:.2f}<extra></extra>`,
      });
    });
    const meanEq = meanEquityCurve(trials);
    if (meanEq.length > 1) {
      data.push({
        type: "scatter",
        mode: "lines",
        x: meanEq.map((p) => new Date(p.t * 1000)),
        y: meanEq.map((p) => p.v),
        line: { width: 2.5, color: "rgba(250, 250, 250, 0.92)" },
        name: "Média dos testes",
        hovertemplate: "%{y:.2f}<extra>média</extra>",
      });
    }
    return {
      data,
      layout: {
        ...baseLayout(`Equity (${n} curvas)`, 320),
        xaxis: { gridcolor: PLOT_GRID, showgrid: true },
        yaxis: { title: "Valor", gridcolor: PLOT_GRID },
      },
    };
  }, [trials]);

  const figPf = useMemo(() => buildMetricFig(trials, "profit_fct", "Profit factor", 260), [trials]);
  const figWr = useMemo(() => buildMetricFig(trials, "win_rate", "Win rate (%)", 260), [trials]);
  const figSh = useMemo(() => buildMetricFig(trials, "sharpe", "Sharpe", 260), [trials]);
  const figRet = useMemo(() => buildMetricFig(trials, "return_pct", "Retorno total (%)", 260), [trials]);

  if (!usable.length) return null;

  return (
    <section className="mt-6 flex flex-col gap-4 rounded-xl border border-zinc-800/90 bg-zinc-900/20 p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-300">Visualização multi-teste</h2>
          <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-zinc-500">
            Cada linha semi-transparente na curva de equity corresponde a um teste válido (passou o mínimo de
            trades). A linha clara espessa é a média dos valores por timestamp. Os outros gráficos mostram métricas
            escalares por índice de teste (ligação para ver dispersão).
          </p>
        </div>
        {usable.length > 1 ? (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zinc-500">Par</span>
            <select
              className="rounded-lg border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-600/60"
              value={symIdx}
              onChange={(e) => setSymIdx(Number(e.target.value))}
            >
              {usable.map((b, i) => (
                <option key={`${b.symbol_id}-${b.timeframe ?? "tf"}-${i}`} value={i}>
                  {b.symbol}
                  {b.timeframe ? ` · ${b.timeframe}` : ""} ({b.trials?.length ?? 0} testes)
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {!trials.length ? (
        <p className="text-xs text-zinc-500">
          Sem curvas por teste para este par (nenhum trial passou o filtro ou só há um ponto por equity).
        </p>
      ) : (
        <>
          {equityFig ? (
            <Plot data={equityFig.data} layout={equityFig.layout} config={plotConfig} useResizeHandler className="w-full min-w-0" />
          ) : null}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {figPf ? (
              <Plot data={figPf.data} layout={figPf.layout} config={plotConfig} useResizeHandler className="w-full min-w-0" />
            ) : null}
            {figWr ? (
              <Plot data={figWr.data} layout={figWr.layout} config={plotConfig} useResizeHandler className="w-full min-w-0" />
            ) : null}
            {figSh ? (
              <Plot data={figSh.data} layout={figSh.layout} config={plotConfig} useResizeHandler className="w-full min-w-0" />
            ) : null}
            {figRet ? (
              <Plot data={figRet.data} layout={figRet.layout} config={plotConfig} useResizeHandler className="w-full min-w-0" />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
