"use client";

import { useMemo, useState } from "react";

import type { BacktestChartLayer } from "@/lib/backtestChartLayer";
import { compareAlignedIndicatorSeries } from "@/lib/liveStrategy/chartSimIndicatorParams";

type Props = {
  jsLayer: BacktestChartLayer | null;
  vbtLayer: BacktestChartLayer | null;
  jsIndicators: Record<string, (number | null)[]> | null;
  barTimes: number[];
  serverLoading: boolean;
  serverErr: string | null;
  hasJsTradeEngine: boolean;
};

function formatBarTime(t: number): string {
  return new Date(t * 1000).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SimulationParityPanel({
  jsLayer,
  vbtLayer,
  jsIndicators,
  barTimes,
  serverLoading,
  serverErr,
  hasJsTradeEngine,
}: Props) {
  const [eps, setEps] = useState(0.05);
  const vbtInd = vbtLayer?.indicators ?? null;

  const indicatorDiffs = useMemo(() => {
    if (!jsIndicators || !vbtInd) return [];
    return compareAlignedIndicatorSeries(jsIndicators, vbtInd, barTimes, eps);
  }, [jsIndicators, vbtInd, barTimes, eps]);

  return (
    <div className="shrink-0 border-b border-zinc-800/80 bg-zinc-950/40 px-2 py-2 text-[11px] text-zinc-300">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-zinc-200">Paridade JS ↔ VBT</span>
        {serverLoading ? (
          <span className="text-sky-400/90">A carregar VBT…</span>
        ) : null}
        {serverErr ? <span className="text-red-400/90">VBT: {serverErr}</span> : null}
        <label className="ml-auto flex items-center gap-1 text-zinc-500">
          ε
          <input
            type="number"
            step={0.01}
            min={0}
            value={eps}
            onChange={(e) => setEps(Math.max(0, Number(e.target.value) || 0))}
            className="w-14 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-zinc-200"
          />
        </label>
      </div>

      {!hasJsTradeEngine ? (
        <p className="mb-2 text-amber-200/80">
          Sem motor JS para trades nesta estratégia — comparação foca-se nos indicadores; métricas JS
          abaixo podem estar vazias.
        </p>
      ) : null}

      <div className="mb-2">
        <div className="mb-0.5 font-medium text-zinc-400">Indicadores (prioridade)</div>
        {!jsIndicators || !vbtInd ? (
          <p className="text-zinc-500">
            {!vbtInd && !serverLoading
              ? "Aguarda resposta VBT com campo indicators."
              : "Sem séries JS ou VBT para comparar."}
          </p>
        ) : indicatorDiffs.length === 0 ? (
          <p className="text-zinc-500">Nenhuma chave comum (ex. rsi, close).</p>
        ) : (
          <div className="max-h-36 overflow-auto rounded border border-zinc-800/80">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500">
                  <th className="px-1.5 py-1">Série</th>
                  <th className="px-1.5 py-1">N</th>
                  <th className="px-1.5 py-1">MAE</th>
                  <th className="px-1.5 py-1">max |Δ|</th>
                  <th className="px-1.5 py-1">% &gt; ε</th>
                  <th className="px-1.5 py-1">1.º t falha</th>
                </tr>
              </thead>
              <tbody>
                {indicatorDiffs.map((r) => (
                  <tr key={r.key} className="border-b border-zinc-800/60">
                    <td className="px-1.5 py-1 font-mono text-zinc-200">{r.key}</td>
                    <td className="px-1.5 py-1">{r.comparedBars}</td>
                    <td className="px-1.5 py-1">{r.mae.toFixed(4)}</td>
                    <td className="px-1.5 py-1">{r.maxAbsDelta.toFixed(4)}</td>
                    <td className="px-1.5 py-1">{r.pctBad.toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-zinc-400">
                      {r.firstBadTime != null ? formatBarTime(r.firstBadTime) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div className="mb-0.5 font-medium text-zinc-400">Estratégia (secundário)</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
          <StatPair label="Return %" js={jsLayer?.stats.return_pct} vbt={vbtLayer?.stats.return_pct} />
          <StatPair label="Trades" js={jsLayer?.stats.trades} vbt={vbtLayer?.stats.trades} int />
          <StatPair label="Win %" js={jsLayer?.stats.win_rate} vbt={vbtLayer?.stats.win_rate} />
          <StatPair label="Max DD %" js={jsLayer?.stats.max_dd} vbt={vbtLayer?.stats.max_dd} />
        </div>
      </div>
    </div>
  );
}

function StatPair({
  label,
  js,
  vbt,
  int,
}: {
  label: string;
  js: number | undefined;
  vbt: number | undefined;
  int?: boolean;
}) {
  const fmt = (x: number | undefined) =>
    x == null || Number.isNaN(x) ? "—" : int ? String(Math.round(x)) : x.toFixed(2);
  return (
    <div className="rounded bg-zinc-900/50 px-1.5 py-1">
      <div className="text-zinc-500">{label}</div>
      <div className="font-mono text-[10px] text-emerald-400/90">JS {fmt(js)}</div>
      <div className="font-mono text-[10px] text-sky-400/90">VBT {fmt(vbt)}</div>
    </div>
  );
}
