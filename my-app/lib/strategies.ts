import { parseChartBuilderSpec } from "@/lib/chartBuilderSpec";
import type { ChartBuilderSpecV1 } from "@/lib/chartBuilderSpec";

/**
 * Indicadores no gráfico: apenas séries servidor (pandas) ou TA-Lib (`talib`).
 * Eliminados EMA/RSI/Bollinger nativos no browser e LCI.
 */
export type IndicatorKind = "sma" | "atr" | "macd" | "talib" | "derived" | "trend_composite";

export type TrendCompositePreset =
  | "price_vs_sma_atr"
  | "rsi_zscore"
  | "macd_hist_zscore"
  | "plus_di_minus_di";

export type TrendCompositeComponent = {
  cid: string;
  /** Percentagem (0–100); normalizada no servidor se a soma ≠ 100. */
  weight: number;
  preset: TrendCompositePreset;
  params?: Record<string, number>;
};

export type TrendCompositeParams = {
  normWindow: number;
  clip: number;
  outputScale: number;
  components: TrendCompositeComponent[];
};

const TREND_COMPOSITE_PRESETS = new Set<TrendCompositePreset>([
  "price_vs_sma_atr",
  "rsi_zscore",
  "macd_hist_zscore",
  "plus_di_minus_di",
]);

/** Presets alinhados ao plano: direcção, momentum, RSI, força (DI). */
export const DEFAULT_TREND_COMPOSITE: TrendCompositeParams = {
  normWindow: 60,
  clip: 2,
  outputScale: 100,
  components: [
    {
      cid: "dir",
      weight: 35,
      preset: "price_vs_sma_atr",
      params: { sma_period: 50, atr_period: 14 },
    },
    {
      cid: "macd",
      weight: 35,
      preset: "macd_hist_zscore",
      params: { fast: 12, slow: 26, signal: 9 },
    },
    {
      cid: "rsi",
      weight: 15,
      preset: "rsi_zscore",
      params: { rsi_period: 14 },
    },
    {
      cid: "dmi",
      weight: 15,
      preset: "plus_di_minus_di",
      params: { period: 14 },
    },
  ],
};

function cloneDefaultTrendComposite(): TrendCompositeParams {
  return {
    normWindow: DEFAULT_TREND_COMPOSITE.normWindow,
    clip: DEFAULT_TREND_COMPOSITE.clip,
    outputScale: DEFAULT_TREND_COMPOSITE.outputScale,
    components: DEFAULT_TREND_COMPOSITE.components.map((c) => ({
      cid: c.cid,
      weight: c.weight,
      preset: c.preset,
      params: c.params ? { ...c.params } : undefined,
    })),
  };
}

/** Parse / normalização do bloco guardado em ``params.trendComposite``. */
export function normalizeTrendCompositeParams(raw: unknown): TrendCompositeParams {
  const base = cloneDefaultTrendComposite();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const o = raw as Record<string, unknown>;
  if (typeof o.normWindow === "number" && Number.isFinite(o.normWindow)) {
    base.normWindow = clampInt(o.normWindow, 5, 500);
  }
  if (typeof o.norm_window === "number" && Number.isFinite(o.norm_window)) {
    base.normWindow = clampInt(o.norm_window, 5, 500);
  }
  if (typeof o.clip === "number" && Number.isFinite(o.clip)) {
    base.clip = Math.min(12, Math.max(0.25, o.clip));
  }
  if (typeof o.outputScale === "number" && Number.isFinite(o.outputScale)) {
    base.outputScale = Math.min(500, Math.max(1, o.outputScale));
  }
  if (typeof o.output_scale === "number" && Number.isFinite(o.output_scale)) {
    base.outputScale = Math.min(500, Math.max(1, o.output_scale));
  }
  const comps = o.components;
  if (!Array.isArray(comps) || comps.length === 0) return base;
  const outComp: TrendCompositeComponent[] = [];
  for (const item of comps) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const presetRaw = q.preset;
    if (typeof presetRaw !== "string" || !TREND_COMPOSITE_PRESETS.has(presetRaw as TrendCompositePreset)) {
      continue;
    }
    const w = Number(q.weight);
    const cid = typeof q.cid === "string" && q.cid.trim() ? q.cid.trim() : `c${outComp.length + 1}`;
    const pr = q.params;
    const params: Record<string, number> = {};
    if (pr && typeof pr === "object" && !Array.isArray(pr)) {
      for (const [k, v] of Object.entries(pr)) {
        if (typeof v === "number" && Number.isFinite(v)) params[k] = v;
      }
    }
    outComp.push({
      cid,
      weight: Number.isFinite(w) ? Math.min(100, Math.max(0, w)) : 0,
      preset: presetRaw as TrendCompositePreset,
      params: Object.keys(params).length ? params : undefined,
    });
  }
  if (outComp.length === 0) return base;
  if (outComp.every((c) => c.weight <= 0)) return base;
  base.components = outComp;
  return base;
}

/** Campo de preço usado no cálculo (TradingView-style). */
export const INDICATOR_SOURCES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"] as const;
export type IndicatorSource = (typeof INDICATOR_SOURCES)[number];
export const INDICATOR_TIMEFRAMES = ["chart", "1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
export type IndicatorTimeframe = (typeof INDICATOR_TIMEFRAMES)[number];

export type StrategyIndicator = {
  id: string;
  label: string;
  group: "overlays" | "studies";
  kind: IndicatorKind;
  params?: {
    period?: number;
    mult?: number;
    source?: IndicatorSource;
    timeframe?: IndicatorTimeframe;
    fast?: number;
    slow?: number;
    signal?: number;
    /** Nome canónico TA-Lib (ex. ``RSI``, ``MACD``). */
    talibFunction?: string;
    /** Parâmetros numéricos TA-Lib (ex. ``timeperiod``); opcional — por defeito usa a lib. */
    talibParams?: Record<string, number>;
    deltaLookbackBars?: number;
    deltaNormalizeByPrice?: boolean;
    /** Indicador composto criado pelo user: cadeia simples ou fórmula. */
    derived?: {
      mode: "chain" | "formula";
      inputRef?: string;
      transform?: "ema" | "sma" | "rsi" | "delta" | "roc" | "abs" | "normalize";
      params?: Record<string, number>;
      formula?: string;
    };
    /** Score de tendência (−scale…+scale): definido em ``trendComposite``. */
    trendComposite?: TrendCompositeParams;
  };
};

export type Strategy = {
  id: string;
  label: string;
  indicators: StrategyIndicator[];
  /**
   * Identificador da estratégia vectorbt (ex. ``lateral_market_rsi``), igual ao id em Backtests.
   * Se definido, o overlay de compra/venda + equity no gráfico só aparece se o job concluído
   * usou o mesmo ``vbt_strategy``.
   */
  vbt_strategy?: string;
  /** Estratégia do construtor (PostgreSQL); avaliação no browser (motor do builder). */
  isBuilderStrategy?: boolean;
  /** Spec v1 carregada da API (necessária para simular). */
  builderSpec?: ChartBuilderSpecV1;
};

/** Opção “sem estratégia” (sempre primeiro no select). */
export const NONE_STRATEGY: Strategy = { id: "", label: "Nenhuma", indicators: [] };

export function getStrategyById(strategies: Strategy[], id: string): Strategy {
  return strategies.find((s) => s.id === id) ?? NONE_STRATEGY;
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * Migra RSI/EMA/Bollinger (antigos, JS) para TA-Lib; omite ``lci``.
 * Params já normalizados (period, mult, …).
 */
export function migrateLegacyIndicatorToTalib(si: Omit<StrategyIndicator, "kind"> & { kind: string }): StrategyIndicator | null {
  const { id, label, group, params } = si;
  const p = params;
  const source =
    p?.source &&
    (INDICATOR_SOURCES as readonly string[]).includes(p.source as IndicatorSource)
      ? (p.source as IndicatorSource)
      : undefined;
  const timeframe =
    p?.timeframe &&
    (INDICATOR_TIMEFRAMES as readonly string[]).includes(p.timeframe as IndicatorTimeframe)
      ? (p.timeframe as IndicatorTimeframe)
      : undefined;

  if (si.kind === "lci") return null;

  if (si.kind === "rsi") {
    const tp = clampInt(Number(p?.period ?? 14), 2, 500);
    return {
      id,
      label: label?.trim() || "RSI",
      group,
      kind: "talib",
      params: {
        talibFunction: "RSI",
        talibParams: { timeperiod: tp },
        ...(source ? { source } : {}),
        ...(timeframe ? { timeframe } : {}),
      },
    };
  }
  if (si.kind === "ema") {
    const tp = clampInt(Number(p?.period ?? 14), 1, 500);
    return {
      id,
      label: label?.trim() || "EMA",
      group,
      kind: "talib",
      params: {
        talibFunction: "EMA",
        talibParams: { timeperiod: tp },
        ...(source ? { source } : {}),
        ...(timeframe ? { timeframe } : {}),
      },
    };
  }
  if (si.kind === "bollinger") {
    const tp = clampInt(Number(p?.period ?? 20), 2, 500);
    const m = typeof p?.mult === "number" && Number.isFinite(p.mult) ? p.mult : 2;
    return {
      id,
      label: label?.trim() || "Bollinger",
      group,
      kind: "talib",
      params: {
        talibFunction: "BBANDS",
        talibParams: { timeperiod: tp, nbdevup: m, nbdevdn: m },
        ...(source ? { source } : {}),
        ...(timeframe ? { timeframe } : {}),
      },
    };
  }

  if (si.kind === "derived") {
    const d = p?.derived;
    if (!d || (d.mode !== "chain" && d.mode !== "formula")) return null;
    return {
      id,
      label: label?.trim() || "Derivado",
      group,
      kind: "derived",
      params: { derived: d },
    };
  }

  if (si.kind === "trend_composite") {
    const tc = normalizeTrendCompositeParams(p?.trendComposite ?? p);
    return {
      id,
      label: label?.trim() || "Trend composite",
      group,
      kind: "trend_composite",
      params: {
        trendComposite: tc,
        ...(source ? { source } : {}),
        ...(timeframe ? { timeframe } : {}),
        ...(typeof p?.deltaLookbackBars === "number" && Number.isFinite(p.deltaLookbackBars)
          ? { deltaLookbackBars: p.deltaLookbackBars }
          : {}),
        ...(typeof p?.deltaNormalizeByPrice === "boolean" ? { deltaNormalizeByPrice: p.deltaNormalizeByPrice } : {}),
      },
    };
  }

  if (si.kind === "talib" || si.kind === "sma" || si.kind === "atr" || si.kind === "macd") {
    return { id, label, group, kind: si.kind as IndicatorKind, params: p };
  }
  return null;
}

/** Normaliza resposta da API (params opcionais) e migra indicadores antigos para TA-Lib onde aplicável. */
export function parseStrategiesPayload(raw: unknown): Strategy[] {
  if (!raw || typeof raw !== "object") return [NONE_STRATEGY];
  const list = (raw as { strategies?: unknown }).strategies;
  if (!Array.isArray(list)) return [NONE_STRATEGY];
  const out: Strategy[] = [NONE_STRATEGY];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id) continue;
    const label = typeof o.label === "string" ? o.label : id;
    const vbtRaw = o.vbt_strategy;
    const vbt_strategy =
      typeof vbtRaw === "string" && vbtRaw.trim() ? vbtRaw.trim() : undefined;

    if (o.isBuilderStrategy === true && o.builderSpec != null && typeof o.builderSpec === "object") {
      const parsed = parseChartBuilderSpec(o.builderSpec);
      if (parsed.ok) {
        out.push({
          id,
          label,
          indicators: parsed.spec.indicators,
          isBuilderStrategy: true,
          builderSpec: parsed.spec,
          ...(vbt_strategy != null ? { vbt_strategy } : {}),
        });
        continue;
      }
      continue;
    }

    const indicatorsRaw = o.indicators;
    const indicators: StrategyIndicator[] = [];
    if (Array.isArray(indicatorsRaw)) {
      for (const ir of indicatorsRaw) {
        if (!ir || typeof ir !== "object") continue;
        const ind = ir as Record<string, unknown>;
        const legacyKind =
          typeof ind.kind === "string" ? ind.kind : "__invalid__";

        const group = ind.group as StrategyIndicator["group"];
        if (group !== "overlays" && group !== "studies") continue;
        const iid = typeof ind.id === "string" ? ind.id : "";
        const ilabel = typeof ind.label === "string" ? ind.label : iid;
        if (!iid) continue;

        const pr = ind.params;
        let params: StrategyIndicator["params"];
        if (pr && typeof pr === "object") {
          const p = pr as Record<string, unknown>;
          params = {};
          if (typeof p.period === "number" && Number.isFinite(p.period)) params.period = p.period;
          if (typeof p.mult === "number" && Number.isFinite(p.mult)) params.mult = p.mult;
          if (typeof p.fast === "number" && Number.isFinite(p.fast)) params.fast = p.fast;
          if (typeof p.slow === "number" && Number.isFinite(p.slow)) params.slow = p.slow;
          if (typeof p.signal === "number" && Number.isFinite(p.signal)) params.signal = p.signal;
          if (typeof p.deltaLookbackBars === "number" && Number.isFinite(p.deltaLookbackBars)) {
            params.deltaLookbackBars = p.deltaLookbackBars;
          }
          if (typeof p.deltaNormalizeByPrice === "boolean") params.deltaNormalizeByPrice = p.deltaNormalizeByPrice;
          if (typeof p.talibFunction === "string" && p.talibFunction.trim()) {
            params.talibFunction = p.talibFunction.trim();
          }
          const derived = p.derived;
          if (derived && typeof derived === "object" && !Array.isArray(derived)) {
            const d = derived as Record<string, unknown>;
            const mode = d.mode === "formula" ? "formula" : d.mode === "chain" ? "chain" : null;
            if (mode) {
              const out: NonNullable<NonNullable<StrategyIndicator["params"]>["derived"]> = { mode };
              if (typeof d.inputRef === "string" && d.inputRef.trim()) out.inputRef = d.inputRef.trim();
              if (typeof d.transform === "string" && d.transform.trim()) {
                const tr = d.transform.trim().toLowerCase();
                if (["ema", "sma", "rsi", "delta", "roc", "abs", "normalize"].includes(tr)) {
                  out.transform = tr as NonNullable<typeof out.transform>;
                }
              }
              if (typeof d.formula === "string" && d.formula.trim()) out.formula = d.formula.trim();
              const dp = d.params;
              if (dp && typeof dp === "object" && !Array.isArray(dp)) {
                const numMap: Record<string, number> = {};
                for (const [k, v] of Object.entries(dp as Record<string, unknown>)) {
                  if (typeof v === "number" && Number.isFinite(v)) numMap[k] = v;
                }
                if (Object.keys(numMap).length) out.params = numMap;
              }
              params.derived = out;
            }
          }
          const tp = p.talibParams;
          if (tp && typeof tp === "object" && !Array.isArray(tp)) {
            const numMap: Record<string, number> = {};
            for (const [k, v] of Object.entries(tp as Record<string, unknown>)) {
              if (typeof v === "number" && Number.isFinite(v)) numMap[k] = v;
            }
            if (Object.keys(numMap).length) params.talibParams = numMap;
          }
          if (
            typeof p.source === "string" &&
            (INDICATOR_SOURCES as readonly string[]).includes(p.source)
          ) {
            params.source = p.source as IndicatorSource;
          }
          if (
            typeof p.timeframe === "string" &&
            (INDICATOR_TIMEFRAMES as readonly string[]).includes(p.timeframe)
          ) {
            params.timeframe = p.timeframe as IndicatorTimeframe;
          }
          if (legacyKind === "trend_composite") {
            params.trendComposite = normalizeTrendCompositeParams(
              (p as Record<string, unknown>).trendComposite ?? p,
            );
          }
          if (Object.keys(params).length === 0) params = undefined;
        } else {
          params = undefined;
        }

        let migrated = migrateLegacyIndicatorToTalib({
          id: iid,
          label: ilabel,
          group,
          kind: legacyKind,
          params,
        });
        if (!migrated) continue;
        if (migrated.kind === "talib" && (!migrated.params?.talibFunction?.trim())) continue;
        if (migrated.kind === "trend_composite") {
          const cur = migrated.params?.trendComposite;
          migrated = {
            ...migrated,
            params: {
              ...migrated.params,
              trendComposite: cur ? normalizeTrendCompositeParams(cur) : normalizeTrendCompositeParams(undefined),
            },
          };
        }
        indicators.push(migrated);
      }
    }
    out.push({ id, label, indicators, ...(vbt_strategy != null ? { vbt_strategy } : {}) });
  }
  return out;
}
