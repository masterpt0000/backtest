/**
 * Dados de um resultado de backtest vectorbt alinhados ao gráfico OHLCV.
 * O campo `chart_overlay` vem de ``monthly_scanner_vbt.chart_overlay_from_pf`` (API / jobs).
 */
/** Por vela, alinhado às mesmas barras da simulação do construtor. */
export type StrategyBarShading = {
  t: number;
  /** Regra de filtro definida e verdadeira nesta vela. */
  filter: boolean;
  /** Zona long (expressão bruta) verdadeira. */
  zoneLong: boolean;
  /** Zona short (expressão bruta) verdadeira. */
  zoneShort: boolean;
};

export type BacktestChartOverlay = {
  markers: Array<{
    time: number;
    position: "aboveBar" | "belowBar" | "inBar";
    color: string;
    shape: "arrowUp" | "arrowDown" | "circle" | "square";
    text?: string;
  }>;
  equity: Array<{ t: number; v: number }>;
  initial_cash?: number;
  /** Fundo por vela (filtro azul, zonas verde/vermelho) — simulação construtor no cliente. */
  strategyShading?: StrategyBarShading[];
};

export type BacktestStatsStrip = {
  return_pct: number;
  win_rate: number;
  trades: number;
  max_dd: number;
  sharpe: number;
  profit_fct: number;
};

/** Presente em simulações no cliente; opcional no overlay QuestDB. */
export type BacktestTradeRow = {
  entryTime: number;
  exitTime: number;
  side: "long" | "short";
  /** P&L do round em % (v. ex. 1.2 ou -0.3). */
  pnl_pct: number;
};

export type BacktestChartLayer = {
  overlay: BacktestChartOverlay;
  stats: BacktestStatsStrip;
  /** Lista de negócios (quando disponível). */
  tradeLog?: BacktestTradeRow[] | null;
  /** Séries de ``compute_indicators`` (simulação VBT no gráfico), alinhadas às barras. */
  indicators?: Record<string, (number | null)[]> | null;
};

type ApiResultRow = Record<string, unknown>;

function symbolsMatchForOverlay(apiSymbol: string, chartCode: string): boolean {
  const a = apiSymbol.trim();
  const b = chartCode.trim();
  if (a === b) return true;
  const ab = a.split("/")[0]?.toUpperCase() ?? "";
  const bb = b.split("/")[0]?.toUpperCase() ?? "";
  if (ab.length > 0 && ab === bb) return true;
  const norm = (s: string) => s.replace(/[/:\s-]/g, "").toUpperCase();
  return norm(a) === norm(b);
}

/** Normaliza identificador vectorbt (módulo completo, stem ou atalho) para o mesmo eixo. */
function normalizeVbtStem(spec: string): string {
  let t = spec.trim();
  if (t.includes(".")) {
    const last = t.split(".").pop() ?? t;
    t = last;
  }
  return t.replace(/_vbt$/i, "").toLowerCase();
}

function vbtStrategiesMatch(chartSpec: string, jobSpec: string): boolean {
  return normalizeVbtStem(chartSpec) === normalizeVbtStem(jobSpec);
}

export type PickBacktestLayerOpts = {
  /** ``run.vbt_strategy`` do job concluído (contexto BacktestJob). */
  jobVbtStrategy?: string | null;
  /** Indicador opcional vindo da estratégia do gráfico (``Strategy.vbt_strategy``). */
  chartVbt?: string | null;
};

/**
 * Escolhe o overlay do último job cujo `symbol` bate com o par do gráfico e (se definido
 * na estratégia do chart) cujo backtest usou a mesma estratégia vectorbt.
 */
export function pickBacktestLayerForSymbol(
  results: unknown[] | null | undefined,
  chartCode: string | null | undefined,
  opts?: PickBacktestLayerOpts | null,
): BacktestChartLayer | null {
  const chartV = opts?.chartVbt?.trim() ?? "";
  const jobV = opts?.jobVbtStrategy?.trim() ?? "";

  if (!results?.length || !chartCode) return null;
  const row = [...results]
    .reverse()
    .find((r) => {
      if (!r || typeof r !== "object") return false;
      const o = r as ApiResultRow;
      const sym = o.symbol;
      if (typeof sym !== "string" || !symbolsMatchForOverlay(sym, chartCode)) return false;
      if (o.chart_overlay == null) return false;
      if (chartV.length > 0) {
        const rowV = typeof o.vbt_strategy === "string" ? o.vbt_strategy.trim() : "";
        const eff = rowV || jobV;
        if (!eff || !vbtStrategiesMatch(chartV, eff)) return false;
      }
      return true;
    });
  if (!row) return null;
  const o = row as ApiResultRow;
  const overlay = o.chart_overlay as BacktestChartOverlay | undefined;
  if (!overlay?.markers || !overlay?.equity) return null;
  return {
    overlay,
    stats: {
      return_pct: Number(o.return_pct ?? 0),
      win_rate: Number(o.win_rate ?? 0),
      trades: Number(o.trades ?? 0),
      max_dd: Number(o.max_dd ?? 0),
      sharpe: Number(o.sharpe ?? 0),
      profit_fct: Number(o.profit_fct ?? 0),
    },
  };
}

/** Resposta de ``POST /api/chart/simulate-bars`` (camada já no formato do gráfico). */
export function parseBacktestChartLayerPayload(raw: unknown): BacktestChartLayer | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const overlay = root.overlay as BacktestChartOverlay | undefined;
  const stats = root.stats as Record<string, unknown> | undefined;
  if (!overlay?.markers || !overlay?.equity || !stats) return null;
  const tradeLogRaw = root.trade_log;
  let tradeLog: BacktestTradeRow[] | null | undefined;
  if (Array.isArray(tradeLogRaw)) {
    tradeLog = [];
    for (const tr of tradeLogRaw) {
      if (!tr || typeof tr !== "object") continue;
      const r = tr as Record<string, unknown>;
      const side = r.side === "short" ? "short" : "long";
      tradeLog.push({
        entryTime: Number(r.entryTime),
        exitTime: Number(r.exitTime),
        side,
        pnl_pct: Number(r.pnl_pct),
      });
    }
  }
  let indicators: Record<string, (number | null)[]> | null | undefined;
  const indRaw = root.indicators;
  if (indRaw && typeof indRaw === "object" && !Array.isArray(indRaw)) {
    indicators = {};
    for (const [k, v] of Object.entries(indRaw as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      indicators[k] = v.map((x) => {
        if (x == null) return null;
        const n = Number(x);
        return Number.isFinite(n) ? n : null;
      });
    }
    if (Object.keys(indicators).length === 0) indicators = undefined;
  }
  return {
    overlay,
    stats: {
      return_pct: Number(stats.return_pct ?? 0),
      win_rate: Number(stats.win_rate ?? 0),
      trades: Number(stats.trades ?? 0),
      max_dd: Number(stats.max_dd ?? 0),
      sharpe: Number(stats.sharpe ?? 0),
      profit_fct: Number(stats.profit_fct ?? 0),
    },
    tradeLog: tradeLog?.length ? tradeLog : undefined,
    indicators: indicators ?? undefined,
  };
}
