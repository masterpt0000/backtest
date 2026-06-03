/**
 * Séries facetas QuestDB (`feat_*`) por vela — API Python `/api/chart/bar-features`.
 * Íds alinhados a `backend/chart_bar_features_routes.py`.
 */
export type ChartFactSeriesEntry = {
  id: string;
  label: string;
  color: string;
  /** Texto curto para tooltip / acessibilidade. */
  description: string;
};

export const CHART_FACT_SERIES: ChartFactSeriesEntry[] = [
  {
    id: "feat_liq_long",
    label: "Liq long",
    color: "#22d3ee",
    description:
      "Somatório de contracts de liquidações de posições long (lado long) na vela, agregados em [t, t+Δ).",
  },
  {
    id: "feat_liq_short",
    label: "Liq short",
    color: "#fb7185",
    description:
      "Somatório de contracts de liquidações de posições short na vela — pressão de fecho forçado no sentido oposto ao long.",
  },
  {
    id: "feat_tick_buy_vol",
    label: "Tick buy vol",
    color: "#4ade80",
    description: "Volume agressivo de compra no tape (fills do lado buy) somado na vela.",
  },
  {
    id: "feat_tick_sell_vol",
    label: "Tick sell vol",
    color: "#f87171",
    description: "Volume agressivo de venda no tape (fills do lado sell) somado na vela.",
  },
  {
    id: "feat_tick_buy_sell_ratio",
    label: "Tape buy/sell",
    color: "#e879f9",
    description:
      "Razão compra/venda do tape: volume_buy ÷ volume_sell (valores altos = mais compra relativa; teto numérico quando não há venda).",
  },
  {
    id: "feat_tick_imbalance",
    label: "Tape imbalance",
    color: "#c084fc",
    description:
      "Imbalanço normalizado (compra − venda) ÷ (compra + venda), entre −1 (só venda) e +1 (só compra). Bom para condições tipo «fluxo > 0».",
  },
  {
    id: "feat_oi_snap",
    label: "OI (snap)",
    color: "#a78bfa",
    description:
      "Último valor reportado de open interest no intervalo da vela (forward-fill até ao próximo snapshot).",
  },
  {
    id: "feat_mark_px",
    label: "Mark price",
    color: "#fbbf24",
    description: "Mark da troca (último snapshot no intervalo), preenchido à frente se necessário.",
  },
  {
    id: "feat_index_px",
    label: "Index price",
    color: "#f472b6",
    description: "Índice ou index price de referência associado ao contrato, por bucket.",
  },
  {
    id: "feat_funding_rate",
    label: "Funding rate",
    color: "#94a3b8",
    description: "Funding por intervalo (último valor no bucket da vela) — premia long vs short em perpétuos.",
  },
  {
    id: "feat_ob_spread_avg",
    label: "OB spread médio",
    color: "#2dd4bf",
    description: "Spread médio calculado a partir do livro de ordens durante a vela.",
  },
  {
    id: "feat_ob_imb_snap",
    label: "OB imb (snap)",
    color: "#38bdf8",
    description:
      "Imbalanço de profundidade (ex. bid vs ask) no último snapshot por vela: positivo = mais liquidez compradora relativa.",
  },
];

function compactVolUi(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

function pxTickUi(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(2);
  if (a >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

/** HUD / tooltip junto ao crosshair para valores facetas. */
export function formatFeatHudValue(id: string, v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (id.endsWith("_px") || id === "feat_mark_px" || id === "feat_index_px") return pxTickUi(v);
  if (
    id === "feat_liq_long" ||
    id === "feat_liq_short" ||
    id === "feat_tick_buy_vol" ||
    id === "feat_tick_sell_vol" ||
    id === "feat_oi_snap"
  ) {
    return compactVolUi(v);
  }
  if (id === "feat_tick_buy_sell_ratio") {
    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
    return v.toFixed(2);
  }
  if (id === "feat_tick_imbalance") return v.toFixed(4);
  if (id === "feat_funding_rate") return v.toFixed(8);
  if (id === "feat_ob_imb_snap") return v.toFixed(4);
  if (id === "feat_ob_spread_avg") return pxTickUi(v);
  return String(v);
}
