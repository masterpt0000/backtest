"use client";

import type { BuilderEntryRule, ChartBuilderSpecV1 } from "@/lib/chartBuilderSpec";
import { defaultChartBuilderSpec, parseChartBuilderSpec } from "@/lib/chartBuilderSpec";
import { deleteLocalBuilderStrategy, upsertLocalBuilderStrategy } from "@/lib/chartBuilderLocalStorage";
import {
  BUILDER_BLOCK_KIND_LABEL,
  createBuilderBlock,
  factsFromBuilderRefs,
  fetchBuilderBlocks,
  refsFromBuilderLine,
  type BuilderBlock,
  type BuilderBlockKind,
} from "@/lib/chartBuilderBlocks";
import {
  createUserIndicatorFromTemplate,
  filterCatalog,
  type IndicatorCatalogEntry,
} from "@/lib/indicatorCatalog";
import { INDICATOR_TIMEFRAMES, normalizeTrendCompositeParams, type IndicatorTimeframe, type StrategyIndicator } from "@/lib/strategies";
import type { ChartIndicatorOverride } from "@/lib/chartIndicatorSettings";
import { apiFetch } from "@/lib/apiFetch";
import {
  chartStrategyPyDownloadBasename,
  generateTradingBotPyFromChartSpec,
} from "@/lib/exportChartBuilderTradingBotPy";
import { useCallback, useEffect, useMemo, useState } from "react";

export type ChartStrategyBuilderDraft =
  | { mode: "create" }
  | { mode: "edit"; uuid: string; spec: ChartBuilderSpecV1 };

type Props = {
  open: boolean;
  onClose: () => void;
  draft: ChartStrategyBuilderDraft | null;
  indicatorCatalog: IndicatorCatalogEntry[];
  indicatorOverridesForSave?: Record<string, ChartIndicatorOverride | undefined>;
  onSaved: (saved?: { uuid: string; spec: ChartBuilderSpecV1 }) => void;
  /** Após eliminar com sucesso (só edição). O parent deve actualizar a lista e limpar a selecção se for o caso. */
  onDeleted?: (uuid: string) => void;
  persistToLocalStorage: boolean;
};

const IF_HINT =
  "``close`` = fecho da vela (OHLC). Com **um** BBANDS TA-Lib na estratégia: ``bb.upper``, ``bb.mid``, ``bb.lower``; com **vários**, usa o id: ``t2.upper``, ``t3.lower``. Ex.: RSI ``t1 < 40``. [n] desloca indicador · ``t2_delta`` usa a variação Δ configurada no indicador ``t2`` · and / or · ( ). Operadores: > < >= <= ==. **Nota:** ``bb.upper < close and bb.lower > close`` é impossível (o fecho não pode estar acima da banda de cima **e** abaixo da de baixo). Entre bandas: ``close > bb.lower and close < bb.upper``; ruptura por cima: ``close > bb.upper``; por baixo: ``close < bb.lower``. " +
  "**Fact QuestDB (mesmo comprimento por vela):** ``feat_liq_*``, ``feat_tick_buy_vol`` / ``feat_tick_sell_vol``, ``feat_tick_buy_sell_ratio``, ``feat_tick_imbalance``, ``feat_oi_snap``, ``feat_mark_px``, ``feat_index_px``, ``feat_funding_rate``, ``feat_ob_*`` — requer ingest na QuestDB e API FastAPI.";

const EXIT_SNAP_HINT =
  "**Memorização:** com «Memorizar valores à entrada» activo podes usar ``entry(rsi)`` (valor na entrada) ou ``entry(rsi, -60)`` (= esse valor menos 60). Ex.: sair long quando ``rsi < entry(rsi, -60)``. Sintaxe igual para outros indicadores (por id: ``entry(t1, -10)``).";

const CATALOG_VISIBLE_MAX = 10;

const BLOCK_INSERT_KINDS: BuilderBlockKind[] = [
  "filter",
  "zone_long",
  "zone_short",
  "entry_long",
  "entry_short",
  "exit_long",
  "exit_short",
];

const DERIVED_TRANSFORMS = ["ema", "sma", "rsi", "delta", "roc", "abs", "normalize"] as const;
const TF_LABELS: Record<IndicatorTimeframe, string> = {
  chart: "Chart",
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

function applyIndicatorOverridesForSave(
  spec: ChartBuilderSpecV1,
  overrides: Record<string, ChartIndicatorOverride | undefined> | undefined,
): ChartBuilderSpecV1 {
  if (!overrides) return spec;
  return {
    ...spec,
    indicators: spec.indicators.map((ind) => {
      const o = overrides[ind.id];
      if (!o) return ind;
      const params: NonNullable<StrategyIndicator["params"]> = { ...(ind.params ?? {}) };
      if (o.source !== undefined) params.source = o.source;
      if (o.timeframe !== undefined) {
        if (o.timeframe === "chart") delete params.timeframe;
        else params.timeframe = o.timeframe;
      }
      if (o.period !== undefined) params.period = o.period;
      if (o.mult !== undefined) params.mult = o.mult;
      if (o.fast !== undefined) params.fast = o.fast;
      if (o.slow !== undefined) params.slow = o.slow;
      if (o.signal !== undefined) params.signal = o.signal;
      if (o.deltaLookbackBars !== undefined) params.deltaLookbackBars = o.deltaLookbackBars;
      if (o.deltaNormalizeByPrice !== undefined) params.deltaNormalizeByPrice = o.deltaNormalizeByPrice;
      if (o.trendComposite !== undefined) {
        params.trendComposite = normalizeTrendCompositeParams(o.trendComposite);
      }
      if (o.talibParams !== undefined) {
        params.talibParams = { ...(params.talibParams ?? {}), ...o.talibParams };
      }
      return { ...ind, params: Object.keys(params).length ? params : undefined };
    }),
  };
}

function FilterIfSection({
  filterIf,
  onChange,
}: {
  /** ``null`` = filtro desligado; ``string`` (pode ser ``""``) = ligado — com ``""`` usa-se ``rules.filter`` legado até preencheres a linha. */
  filterIf: string | null;
  onChange: (v: string | null) => void;
}) {
  const enabled = filterIf != null;
  return (
    <div className="space-y-2 rounded-lg border border-violet-900/40 bg-violet-950/15 p-3">
      <p className="text-[11px] font-semibold text-violet-200/90">Filtro de mercado</p>
      <p className="text-[10px] leading-snug text-zinc-500">
        Uma linha de condições. Só afecta entradas com «Exigir filtro» activo.
      </p>
      <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            onChange(e.target.checked ? filterIf ?? "rsi > 50" : null);
          }}
          className="rounded border-zinc-600"
        />
        Usar filtro de mercado
      </label>
      {enabled ? (
        <>
          <input
            type="text"
            spellCheck={false}
            className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 font-mono text-[12px] text-zinc-100 placeholder:text-zinc-600"
            placeholder="rsi > 50 and ema > ema[1]"
            value={filterIf ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
          <p className="text-[9px] leading-snug text-zinc-600">{IF_HINT}</p>
        </>
      ) : null}
    </div>
  );
}

function ZoneIfSection({
  title,
  borderClass,
  titleClass,
  description,
  zoneIf,
  applyFilter,
  waitCandles,
  onZoneChange,
  onApplyFilterChange,
  onWaitChange,
}: {
  title: string;
  borderClass: string;
  titleClass: string;
  description: string;
  zoneIf: string | null;
  applyFilter: boolean;
  waitCandles: number;
  onZoneChange: (v: string | null) => void;
  onApplyFilterChange: (v: boolean) => void;
  onWaitChange: (n: number) => void;
}) {
  const enabled = zoneIf != null;
  return (
    <div className={`space-y-2 rounded-lg border p-3 ${borderClass}`}>
      <p className={`text-[11px] font-semibold ${titleClass}`}>{title}</p>
      <p className="text-[10px] leading-snug text-zinc-500">{description}</p>
      <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            onZoneChange(e.target.checked ? zoneIf ?? "rsi > 40" : null);
          }}
          className="rounded border-zinc-600"
        />
        Usar {title}
      </label>
      {enabled ? (
        <>
          <input
            type="text"
            spellCheck={false}
            className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 font-mono text-[12px] text-zinc-100 placeholder:text-zinc-600"
            placeholder="Condição da zona (uma linha)"
            value={zoneIf ?? ""}
            onChange={(e) => onZoneChange(e.target.value)}
          />
          <label className="flex cursor-pointer items-center gap-2 text-[10px] text-zinc-400">
            <input
              type="checkbox"
              checked={applyFilter}
              onChange={(e) => onApplyFilterChange(e.target.checked)}
              className="rounded border-zinc-600"
            />
            Usar filtro de mercado nesta zona
          </label>
          <p className="text-[9px] leading-snug text-zinc-600">{IF_HINT}</p>
          <label className="block text-[11px] font-medium text-zinc-400">
            Espera máxima (velas após última zona activa)
            <input
              type="number"
              min={0}
              max={500}
              step={1}
              className="mt-1 h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
              value={waitCandles}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                onWaitChange(Math.max(0, Math.min(500, Math.round(v))));
              }}
            />
          </label>
          <p className="text-[9px] leading-snug text-zinc-600">
            A entrada pode ocorrer até N velas depois da última em que a zona foi verdadeira, mesmo que a
            zona já não se cumpra. Passado esse limite, só volta a ser possível após uma nova zona.{" "}
            <span className="text-zinc-500">0 = só na própria vela em que a zona é true.</span>
          </p>
        </>
      ) : null}
    </div>
  );
}

function EntryIfSection({
  title,
  rule,
  onRule,
}: {
  title: string;
  rule: BuilderEntryRule | null;
  onRule: (r: BuilderEntryRule | null) => void;
}) {
  const enabled = rule != null && rule.enabled !== false;
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800/80 bg-zinc-950/40 p-3">
      <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const on = e.target.checked;
            if (!on) {
              if (rule) {
                onRule({ ...rule, enabled: false });
              } else {
                onRule(null);
              }
              return;
            }
            onRule(
              rule
                ? { ...rule, enabled: true }
                : {
                    applyFilter: false,
                    ifLine: "rsi < 30",
                    expr: null,
                  },
            );
          }}
          className="rounded border-zinc-600"
        />
        {title}
      </label>
      {enabled && rule ? (
        <>
          <label className="flex cursor-pointer items-center gap-2 border-t border-zinc-800/60 pt-2 text-[10px] text-zinc-400">
            <input
              type="checkbox"
              checked={rule.applyFilter}
              onChange={(e) => onRule({ ...rule, applyFilter: e.target.checked })}
              className="rounded border-zinc-600"
            />
            Exigir filtro de mercado
          </label>
          <input
            type="text"
            spellCheck={false}
            className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 font-mono text-[12px] text-zinc-100 placeholder:text-zinc-600"
            placeholder="rsi < 30 and ema[1] > ema"
            value={rule.ifLine ?? ""}
            onChange={(e) => onRule({ ...rule, ifLine: e.target.value })}
          />
          <p className="text-[9px] leading-snug text-zinc-600">{IF_HINT}</p>
        </>
      ) : null}
    </div>
  );
}

function ExitIfSection({
  title,
  ifLine,
  enabled,
  onEnabled,
  onLine,
}: {
  title: string;
  ifLine: string | null;
  enabled: boolean;
  onEnabled: (on: boolean) => void;
  onLine: (v: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800/80 bg-zinc-950/40 p-3">
      <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const on = e.target.checked;
            onEnabled(on);
          }}
          className="rounded border-zinc-600"
        />
        {title}
      </label>
      {enabled ? (
        <>
          <input
            type="text"
            spellCheck={false}
            className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 font-mono text-[12px] text-zinc-100 placeholder:text-zinc-600"
            placeholder="rsi > 70"
            value={ifLine ?? ""}
            onChange={(e) => onLine(e.target.value)}
          />
          <p className="text-[9px] leading-snug text-zinc-600">{IF_HINT}</p>
          <p className="text-[9px] leading-snug text-zinc-600">{EXIT_SNAP_HINT}</p>
          <p className="text-[9px] leading-snug text-zinc-600">
            Na mesma vela: SL antes de TP; depois saídas; depois entradas.
          </p>
        </>
      ) : null}
    </div>
  );
}

function nextDerivedId(indicators: readonly StrategyIndicator[]): string {
  const used = new Set(indicators.map((x) => x.id));
  let n = 1;
  while (used.has(`d${n}`)) n++;
  return `d${n}`;
}

function baseRef(ref: string): string {
  return ref.split("[", 1)[0]!.split(".", 1)[0]!;
}

export function ChartStrategyBuilderModal({
  open,
  onClose,
  draft,
  indicatorCatalog,
  indicatorOverridesForSave,
  onSaved,
  onDeleted,
  persistToLocalStorage,
}: Props) {
  const [spec, setSpec] = useState<ChartBuilderSpecV1>(defaultChartBuilderSpec);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<BuilderBlock[]>([]);
  const [blockErr, setBlockErr] = useState<string | null>(null);
  const [derivedBaseRef, setDerivedBaseRef] = useState("close");
  const [derivedTransform, setDerivedTransform] = useState<(typeof DERIVED_TRANSFORMS)[number]>("ema");
  const [derivedPeriod, setDerivedPeriod] = useState(9);
  const [derivedTimeframe, setDerivedTimeframe] = useState<IndicatorTimeframe>("chart");
  const [derivedFormula, setDerivedFormula] = useState("ema(rsi1, 9)");

  useEffect(() => {
    if (!open || !draft) return;
    if (draft.mode === "edit") setSpec(migrateLegacySpec(draft.spec));
    else setSpec(defaultChartBuilderSpec());
    setCatalogSearch("");
  }, [open, draft]);

  useEffect(() => {
    if (!open || persistToLocalStorage) return;
    let cancelled = false;
    setBlockErr(null);
    void fetchBuilderBlocks()
      .then((rows) => {
        if (!cancelled) setBlocks(rows);
      })
      .catch((e) => {
        if (!cancelled) setBlockErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, persistToLocalStorage]);

  const setExitIf = useCallback((key: "exitLongIf" | "exitShortIf", line: string | null) => {
    setSpec((s) => ({
      ...s,
      rules: {
        ...s.rules,
        [key]: line,
        ...(key === "exitLongIf" ? { exitLong: null } : { exitShort: null }),
      },
    }));
  }, []);

  const addIndicator = useCallback(
    (templateId: string) => {
      setSpec((s) => {
        const ind = createUserIndicatorFromTemplate(templateId, s.indicators, indicatorCatalog);
        if (!ind) return s;
        return { ...s, indicators: [...s.indicators, ind] };
      });
    },
    [indicatorCatalog],
  );

  const removeIndicator = useCallback((id: string) => {
    setSpec((s) => ({
      ...s,
      indicators: s.indicators.filter((x) => x.id !== id),
    }));
  }, []);

  const [catalogSearch, setCatalogSearch] = useState("");

  const catalogMatches = useMemo(() => {
    const m = filterCatalog(catalogSearch, indicatorCatalog);
    return [...m].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
  }, [catalogSearch, indicatorCatalog]);

  const catalogVisible = useMemo(
    () => catalogMatches.slice(0, CATALOG_VISIBLE_MAX),
    [catalogMatches],
  );

  const addDerivedChain = useCallback(() => {
    setSpec((s) => {
      const id = nextDerivedId(s.indicators);
      const period = Math.max(1, Math.min(1000, Math.round(Number(derivedPeriod) || 1)));
      const label = `${derivedTransform.toUpperCase()}(${derivedBaseRef})`;
      return {
        ...s,
        indicators: [
          ...s.indicators,
          {
            id,
            label,
            group: "studies",
            kind: "derived",
            params: {
              derived: {
                mode: "chain",
                inputRef: derivedBaseRef.trim() || "close",
                transform: derivedTransform,
                params:
                  derivedTransform === "delta" || derivedTransform === "roc"
                    ? { lookback: period }
                    : { period },
              },
              ...(derivedTimeframe !== "chart" ? { timeframe: derivedTimeframe } : {}),
            },
          },
        ],
      };
    });
  }, [derivedBaseRef, derivedPeriod, derivedTimeframe, derivedTransform]);

  const addDerivedFormula = useCallback(() => {
    const formula = derivedFormula.trim();
    if (!formula) return;
    setSpec((s) => {
      const id = nextDerivedId(s.indicators);
      return {
        ...s,
        indicators: [
          ...s.indicators,
          {
            id,
            label: `Derivado ${id}`,
            group: "studies",
            kind: "derived",
            params: {
              derived: { mode: "formula", formula },
              ...(derivedTimeframe !== "chart" ? { timeframe: derivedTimeframe } : {}),
            },
          },
        ],
      };
    });
  }, [derivedFormula, derivedTimeframe]);

  const lineForKind = useCallback(
    (kind: BuilderBlockKind): { line: string | null; waitCandles?: number | null } => {
      if (kind === "filter") return { line: spec.rules.filterIf };
      if (kind === "zone_long") return { line: spec.rules.zoneLongIf, waitCandles: spec.rules.zoneLongWaitCandles };
      if (kind === "zone_short") return { line: spec.rules.zoneShortIf, waitCandles: spec.rules.zoneShortWaitCandles };
      if (kind === "entry_long") return { line: spec.rules.long?.ifLine ?? null };
      if (kind === "entry_short") return { line: spec.rules.short?.ifLine ?? null };
      if (kind === "exit_long") return { line: spec.rules.exitLongIf };
      if (kind === "exit_short") return { line: spec.rules.exitShortIf };
      return { line: null };
    },
    [spec.rules],
  );

  const saveCurrentBlock = useCallback(
    async (kind: BuilderBlockKind) => {
      if (persistToLocalStorage) {
        setBlockErr("Blocos reutilizáveis precisam de PostgreSQL activo.");
        return;
      }
      const current = lineForKind(kind);
      const line = current.line?.trim();
      if (!line) {
        setBlockErr("Não há condição para guardar neste bloco.");
        return;
      }
      const name = window.prompt("Nome do bloco", `${BUILDER_BLOCK_KIND_LABEL[kind]} ${line.slice(0, 32)}`);
      if (!name?.trim()) return;
      const refs = refsFromBuilderLine(line);
      const requiredIndicators = spec.indicators.filter((i) => refs.some((r) => baseRef(r) === i.id));
      try {
        const saved = await createBuilderBlock({
          name: name.trim(),
          kind,
          description: "",
          spec: {
            ifLine: line,
            waitCandles: current.waitCandles ?? null,
            requiredRefs: refs,
            requiredFacts: factsFromBuilderRefs(refs),
            requiredIndicators,
          },
        });
        setBlocks((rows) => [saved, ...rows.filter((x) => x.id !== saved.id)]);
        setBlockErr(null);
      } catch (e) {
        setBlockErr(e instanceof Error ? e.message : String(e));
      }
    },
    [lineForKind, persistToLocalStorage, spec.indicators],
  );

  const applyBlock = useCallback(
    (block: BuilderBlock, mode: "replace" | "and" | "or" = "replace") => {
      const line = block.spec.ifLine.trim();
      if (!line) return;
      setSpec((s) => {
        const existingIds = new Set(s.indicators.map((i) => i.id));
        const added = (block.spec.requiredIndicators ?? []).filter((i) => !existingIds.has(i.id));
        const mergeLine = (oldLine: string | null | undefined) => {
          const old = oldLine?.trim();
          if (mode === "replace" || !old) return line;
          return `(${old}) ${mode} (${line})`;
        };
        const next = { ...s, indicators: [...s.indicators, ...added] };
        if (block.kind === "filter") {
          return { ...next, rules: { ...next.rules, filterIf: mergeLine(next.rules.filterIf), filter: null } };
        }
        if (block.kind === "zone_long") {
          return {
            ...next,
            rules: {
              ...next.rules,
              zoneLongIf: mergeLine(next.rules.zoneLongIf),
              zoneLong: null,
              zoneLongWaitCandles: block.spec.waitCandles ?? next.rules.zoneLongWaitCandles,
            },
          };
        }
        if (block.kind === "zone_short") {
          return {
            ...next,
            rules: {
              ...next.rules,
              zoneShortIf: mergeLine(next.rules.zoneShortIf),
              zoneShort: null,
              zoneShortWaitCandles: block.spec.waitCandles ?? next.rules.zoneShortWaitCandles,
            },
          };
        }
        if (block.kind === "entry_long") {
          const cur = next.rules.long ?? { applyFilter: false, ifLine: null, expr: null };
          return { ...next, rules: { ...next.rules, long: { ...cur, ifLine: mergeLine(cur.ifLine), expr: null } } };
        }
        if (block.kind === "entry_short") {
          const cur = next.rules.short ?? { applyFilter: false, ifLine: null, expr: null };
          return { ...next, rules: { ...next.rules, short: { ...cur, ifLine: mergeLine(cur.ifLine), expr: null } } };
        }
        if (block.kind === "exit_long") {
          return { ...next, rules: { ...next.rules, exitLongIf: mergeLine(next.rules.exitLongIf), exitLong: null } };
        }
        if (block.kind === "exit_short") {
          return { ...next, rules: { ...next.rules, exitShortIf: mergeLine(next.rules.exitShortIf), exitShort: null } };
        }
        return next;
      });
    },
    [],
  );

  const canSave = useMemo(() => spec.indicators.length > 0, [spec.indicators.length]);

  const exportTradingBotPy = useCallback(() => {
    setErr(null);
    const bodySpec = applyIndicatorOverridesForSave(
      { ...spec, name: spec.name.trim() || "Sem nome" },
      indicatorOverridesForSave,
    );
    const parsed = parseChartBuilderSpec(bodySpec);
    if (!parsed.ok) {
      setErr(parsed.errors.join("; "));
      return;
    }
    const content = generateTradingBotPyFromChartSpec(parsed.spec);
    const basename = chartStrategyPyDownloadBasename(parsed.spec);
    const blob = new Blob([content], { type: "text/x-python;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = basename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [indicatorOverridesForSave, spec]);

  const save = useCallback(async () => {
    setErr(null);
    const bodySpec = applyIndicatorOverridesForSave(
      { ...spec, name: spec.name.trim() || "Sem nome" },
      indicatorOverridesForSave,
    );
    const parsed = parseChartBuilderSpec(bodySpec);
    if (!parsed.ok) {
      setErr(parsed.errors.join("; "));
      return;
    }
    setSaving(true);
    try {
      let savedUuid = draft?.mode === "edit" ? draft.uuid : "";
      if (persistToLocalStorage) {
        try {
          savedUuid = upsertLocalBuilderStrategy(
            draft?.mode === "edit" ? draft.uuid : null,
            parsed.spec,
          );
        } catch (e) {
          throw new Error(
            e instanceof Error
              ? e.message
              : "Não foi possível guardar no armazenamento local (localStorage).",
          );
        }
      } else if (draft?.mode === "edit") {
        const r = await apiFetch(`/api/chart/builder-strategies/${draft.uuid}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ spec: parsed.spec }),
        });
        const j = (await r.json()) as { id?: string; error?: string };
        if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : r.statusText);
        savedUuid = typeof j.id === "string" ? j.id : savedUuid;
      } else {
        const r = await apiFetch("/api/chart/builder-strategies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ spec: parsed.spec }),
        });
        const j = (await r.json()) as { id?: string; error?: string };
        if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : r.statusText);
        savedUuid = typeof j.id === "string" ? j.id : savedUuid;
      }
      if (savedUuid) onSaved({ uuid: savedUuid, spec: parsed.spec });
      else onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, indicatorOverridesForSave, onSaved, persistToLocalStorage, spec]);

  const deleteStrategy = useCallback(async () => {
    if (draft?.mode !== "edit") return;
    const uuid = draft.uuid;
    const ok = window.confirm(
      persistToLocalStorage
        ? "Eliminar esta estratégia deste browser (localStorage)? Esta acção não pode ser desfeita."
        : "Eliminar esta estratégia da base de dados? Esta acção não pode ser desfeita.",
    );
    if (!ok) return;
    setErr(null);
    setDeleting(true);
    try {
      if (persistToLocalStorage) {
        deleteLocalBuilderStrategy(uuid);
      } else {
        const r = await apiFetch(`/api/chart/builder-strategies/${uuid}`, { method: "DELETE" });
        const j = (await r.json()) as { error?: string; deleted?: boolean };
        if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : r.statusText);
      }
      onDeleted?.(uuid);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }, [draft, onClose, onDeleted, persistToLocalStorage]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const exitLongOn = spec.rules.exitLongIf != null || spec.rules.exitLong != null;
  const exitShortOn = spec.rules.exitShortIf != null || spec.rules.exitShort != null;

  return (
    <div
      className="pointer-events-none fixed bottom-0 left-0 top-14 z-[80] flex min-h-0"
      role="region"
      aria-labelledby="chart-builder-title"
    >
      <div
        className="pointer-events-auto flex h-full min-h-0 w-[min(100vw,28rem)] max-w-full shrink-0 flex-col overflow-hidden border-r border-zinc-800 bg-zinc-950/98 shadow-2xl sm:w-[min(100vw,36rem)] sm:rounded-r-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 id="chart-builder-title" className="text-sm font-semibold text-zinc-100">
            {draft?.mode === "edit" ? "Editar estratégia (builder)" : "Nova estratégia (builder)"}
            {persistToLocalStorage ? (
              <span className="ml-2 text-[11px] font-normal text-zinc-500">· só neste browser</span>
            ) : null}
          </h2>
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            onClick={onClose}
          >
            Fechar
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {err ? (
            <p className="mb-3 rounded-lg border border-red-900/50 bg-red-950/40 px-2 py-1.5 text-[11px] text-red-200">
              {err}
            </p>
          ) : null}

          <label className="block text-[11px] font-medium text-zinc-400">
            Nome
            <input
              className="mt-1 h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
              value={spec.name}
              onChange={(e) => setSpec((s) => ({ ...s, name: e.target.value }))}
            />
          </label>

          <div className="mt-4">
            <p className="text-[11px] font-medium text-zinc-400">Indicadores</p>
            <p className="mt-0.5 text-[10px] leading-snug text-zinc-600">
              Pesquisa e vê no máximo {CATALOG_VISIBLE_MAX} sugestões; afinar o texto filtra a lista.
              Os parâmetros dos indicadores são definidos na engrenagem de definições e gravados com a estratégia.
            </p>
            <input
              type="search"
              placeholder="Pesquisar indicador (ex. RSI, MACD, BBANDS)…"
              autoComplete="off"
              spellCheck={false}
              value={catalogSearch}
              onChange={(e) => setCatalogSearch(e.target.value)}
              className="mt-2 h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-100 placeholder:text-zinc-600"
            />
            <p className="mt-1 text-[10px] text-zinc-500">
              {indicatorCatalog.length === 0
                ? "Catálogo vazio — confirma TA-Lib no backend."
                : catalogMatches.length === 0
                  ? "Nenhum resultado — tenta outro termo."
                  : catalogMatches.length > CATALOG_VISIBLE_MAX
                    ? `A mostrar ${CATALOG_VISIBLE_MAX} de ${catalogMatches.length} resultados. Afinar a pesquisa para listar menos.`
                    : `${catalogMatches.length} resultado${catalogMatches.length === 1 ? "" : "s"}.`}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {catalogVisible.map((e) => (
                <button
                  key={e.templateId}
                  type="button"
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-300 hover:border-emerald-700/50 hover:text-emerald-200/90"
                  onClick={() => addIndicator(e.templateId)}
                >
                  + {e.label}
                </button>
              ))}
            </div>
            <div className="mt-3 rounded-lg border border-fuchsia-900/40 bg-fuchsia-950/10 p-2">
              <p className="text-[11px] font-semibold text-fuchsia-200/90">Indicador composto</p>
              <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">
                Cria séries a partir de outras séries, como EMA de RSI ou delta de volume. Em fórmula:{" "}
                <span className="font-mono text-zinc-400">max(s, n)</span> /{" "}
                <span className="font-mono text-zinc-400">min(s, n)</span> com{" "}
                <span className="font-mono">n</span> inteiro = extremo móvel nos últimos{" "}
                <span className="font-mono">n</span> valores; com duas séries = elemento a elemento.
              </p>
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                <input
                  className="h-8 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-[11px] text-zinc-100"
                  value={derivedBaseRef}
                  onChange={(e) => setDerivedBaseRef(e.target.value)}
                  placeholder="base: close, rsi1..."
                />
                <select
                  className="h-8 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-[11px] text-zinc-100"
                  value={derivedTransform}
                  onChange={(e) => setDerivedTransform(e.target.value as (typeof DERIVED_TRANSFORMS)[number])}
                >
                  {DERIVED_TRANSFORMS.map((x) => (
                    <option key={x} value={x}>
                      {x.toUpperCase()}
                    </option>
                  ))}
                </select>
                <select
                  className="h-8 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-[11px] text-zinc-100"
                  value={derivedTimeframe}
                  onChange={(e) => setDerivedTimeframe(e.target.value as IndicatorTimeframe)}
                  title="Timeframe do indicador composto"
                >
                  {INDICATOR_TIMEFRAMES.map((tf) => (
                    <option key={tf} value={tf}>
                      {TF_LABELS[tf]}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  className="h-8 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-[11px] text-zinc-100"
                  value={derivedPeriod}
                  onChange={(e) => setDerivedPeriod(Number(e.target.value))}
                />
              </div>
              <button
                type="button"
                className="mt-1.5 rounded-md border border-fuchsia-800/60 px-2 py-1 text-[10px] text-fuchsia-200 hover:bg-fuchsia-950/40"
                onClick={addDerivedChain}
              >
                + Adicionar composto simples
              </button>
              <div className="mt-2 flex gap-1.5">
                <input
                  className="h-8 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 font-mono text-[11px] text-zinc-100"
                  value={derivedFormula}
                  onChange={(e) => setDerivedFormula(e.target.value)}
                  placeholder="max(t2_delta, 5) · min(rsi1, t1[3]) · ema(close, 20)"
                />
                <button
                  type="button"
                  className="rounded-md border border-fuchsia-800/60 px-2 py-1 text-[10px] text-fuchsia-200 hover:bg-fuchsia-950/40"
                  onClick={addDerivedFormula}
                >
                  + Fórmula
                </button>
              </div>
            </div>
            <ul className="mt-3 space-y-2">
              {spec.indicators.map((i) => (
                <li
                  key={i.id}
                  className="rounded-lg border border-zinc-800/80 bg-zinc-900/30 px-2.5 py-2 text-[11px] text-zinc-300"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-medium text-zinc-200">{i.label}</span>
                      <span className="text-zinc-500"> · </span>
                      <span className="font-mono text-zinc-400">{i.id}</span>
                      <span className="text-zinc-600"> · {i.kind}</span>
                      {i.kind === "talib" && i.params?.talibFunction ? (
                        <span className="text-zinc-500"> ({i.params.talibFunction})</span>
                      ) : null}
                      {i.kind === "derived" && i.params?.derived ? (
                        <span className="text-zinc-500">
                          {" "}
                          (
                          {i.params.derived.mode === "formula"
                            ? i.params.derived.formula
                            : `${i.params.derived.transform?.toUpperCase()}(${i.params.derived.inputRef})`}
                          )
                        </span>
                      ) : null}
                      <p className="mt-1 text-[10px] leading-snug text-zinc-500">
                        Nas condições usa o id (ex. {i.id}) ou o alias do indicador se for único.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-[10px] text-red-400/90 hover:text-red-300"
                      onClick={() => removeIndicator(i.id)}
                    >
                      Remover
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-5 rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[11px] font-semibold text-emerald-200/90">Blocos reutilizáveis</p>
                <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">
                  Guarda filtros, zonas, entradas e saídas como templates. Ao inserir, é copiado um snapshot para a estratégia.
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800"
                onClick={() => {
                  void fetchBuilderBlocks()
                    .then(setBlocks)
                    .catch((e) => setBlockErr(e instanceof Error ? e.message : String(e)));
                }}
              >
                Recarregar
              </button>
            </div>
            {blockErr ? <p className="mt-2 text-[10px] text-amber-300">{blockErr}</p> : null}
            {persistToLocalStorage ? (
              <p className="mt-2 text-[10px] text-amber-300">Blocos precisam de PostgreSQL; esta estratégia está em modo local.</p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1">
              {BLOCK_INSERT_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className="rounded-md border border-emerald-900/60 px-2 py-1 text-[10px] text-emerald-100/90 hover:bg-emerald-950/40"
                  onClick={() => void saveCurrentBlock(k)}
                >
                  Guardar {BUILDER_BLOCK_KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <div className="mt-2 space-y-1.5">
              {blocks.length === 0 ? (
                <p className="text-[10px] text-zinc-600">Ainda não há blocos guardados.</p>
              ) : (
                blocks.slice(0, 12).map((b) => (
                  <div key={b.id} className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-medium text-zinc-200">
                          {b.name} <span className="font-normal text-zinc-500">· {BUILDER_BLOCK_KIND_LABEL[b.kind]}</span>
                        </p>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">{b.spec.ifLine}</p>
                        {b.spec.requiredFacts?.length ? (
                          <p className="mt-0.5 text-[9px] text-amber-300/80">
                            Requer QuestDB facts: {b.spec.requiredFacts.join(", ")}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          className="rounded border border-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-300 hover:bg-zinc-800"
                          onClick={() => applyBlock(b, "replace")}
                        >
                          Usar
                        </button>
                        <button
                          type="button"
                          className="rounded border border-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-300 hover:bg-zinc-800"
                          onClick={() => applyBlock(b, "and")}
                        >
                          AND
                        </button>
                        <button
                          type="button"
                          className="rounded border border-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-300 hover:bg-zinc-800"
                          onClick={() => applyBlock(b, "or")}
                        >
                          OR
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-5 space-y-4">
            <FilterIfSection
              filterIf={spec.rules.filterIf}
              onChange={(v) =>
                setSpec((s) => ({
                  ...s,
                  rules: { ...s.rules, filterIf: v, filter: null },
                }))
              }
            />

            <ZoneIfSection
              title="Zona long"
              borderClass="border-amber-900/45 bg-amber-950/10"
              titleClass="text-amber-200/95"
              description="Contexto para entradas long: a condição de entrada long só conta dentro da janela após a última vez que a zona foi verdadeira."
              zoneIf={spec.rules.zoneLongIf}
              applyFilter={spec.rules.zoneLongApplyFilter !== false}
              waitCandles={spec.rules.zoneLongWaitCandles ?? 10}
              onZoneChange={(v) =>
                setSpec((s) => ({
                  ...s,
                  rules: {
                    ...s.rules,
                    zoneLongIf: v,
                    zoneLong: null,
                    zoneLongWaitCandles: s.rules.zoneLongWaitCandles ?? 10,
                  },
                }))
              }
              onApplyFilterChange={(v) =>
                setSpec((s) => ({
                  ...s,
                  rules: { ...s.rules, zoneLongApplyFilter: v },
                }))
              }
              onWaitChange={(n) =>
                setSpec((s) => ({
                  ...s,
                  rules: { ...s.rules, zoneLongWaitCandles: n },
                }))
              }
            />

            <ZoneIfSection
              title="Zona short"
              borderClass="border-sky-900/45 bg-sky-950/10"
              titleClass="text-sky-200/95"
              description="Contexto para entradas short: análogo à zona long, para o lado vendedor."
              zoneIf={spec.rules.zoneShortIf}
              applyFilter={spec.rules.zoneShortApplyFilter !== false}
              waitCandles={spec.rules.zoneShortWaitCandles ?? 10}
              onZoneChange={(v) =>
                setSpec((s) => ({
                  ...s,
                  rules: {
                    ...s.rules,
                    zoneShortIf: v,
                    zoneShort: null,
                    zoneShortWaitCandles: s.rules.zoneShortWaitCandles ?? 10,
                  },
                }))
              }
              onApplyFilterChange={(v) =>
                setSpec((s) => ({
                  ...s,
                  rules: { ...s.rules, zoneShortApplyFilter: v },
                }))
              }
              onWaitChange={(n) =>
                setSpec((s) => ({
                  ...s,
                  rules: { ...s.rules, zoneShortWaitCandles: n },
                }))
              }
            />

            <EntryIfSection
              title="Entrada long"
              rule={spec.rules.long}
              onRule={(r) => setSpec((s) => ({ ...s, rules: { ...s.rules, long: r } }))}
            />
            <EntryIfSection
              title="Entrada short"
              rule={spec.rules.short}
              onRule={(r) => setSpec((s) => ({ ...s, rules: { ...s.rules, short: r } }))}
            />

            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-amber-900/35 bg-amber-950/15 px-3 py-2 text-[11px] text-zinc-300">
              <input
                type="checkbox"
                checked={spec.rules.entrySnapEnabled === true}
                onChange={(e) =>
                  setSpec((s) => ({
                    ...s,
                    rules: { ...s.rules, entrySnapEnabled: e.target.checked },
                  }))
                }
                className="rounded border-zinc-600"
              />
              Memorizar valores dos indicadores na entrada (uso com{" "}
              <span className="font-mono text-[10px] text-amber-100/90">entry(...)</span> nas saídas)
            </label>

            <ExitIfSection
              title="Saída long"
              ifLine={spec.rules.exitLongIf}
              enabled={exitLongOn}
              onEnabled={(on) => {
                if (!on) setExitIf("exitLongIf", null);
                else
                  setSpec((s) => ({
                    ...s,
                    rules: {
                      ...s.rules,
                      exitLongIf: s.rules.exitLongIf ?? "rsi > 70",
                      exitLong: null,
                    },
                  }));
              }}
              onLine={(v) =>
                setSpec((s) => ({
                  ...s,
                  rules: { ...s.rules, exitLongIf: v, exitLong: null },
                }))
              }
            />
            <ExitIfSection
              title="Saída short"
              ifLine={spec.rules.exitShortIf}
              enabled={exitShortOn}
              onEnabled={(on) => {
                if (!on) setExitIf("exitShortIf", null);
                else
                  setSpec((s) => ({
                    ...s,
                    rules: {
                      ...s.rules,
                      exitShortIf: s.rules.exitShortIf ?? "rsi < 30",
                      exitShort: null,
                    },
                  }));
              }}
              onLine={(v) =>
                setSpec((s) => ({
                  ...s,
                  rules: { ...s.rules, exitShortIf: v, exitShort: null },
                }))
              }
            />
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3">
            <label className="text-[11px] text-zinc-400">
              Take profit %
              <input
                type="number"
                min={0}
                step="0.1"
                className="mt-1 h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                value={spec.risk.takeProfitPct}
                onChange={(e) =>
                  setSpec((s) => ({
                    ...s,
                    risk: { ...s.risk, takeProfitPct: Number(e.target.value) },
                  }))
                }
              />
            </label>
            <label className="text-[11px] text-zinc-400">
              Stop loss %
              <input
                type="number"
                min={0}
                step="0.1"
                className="mt-1 h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                value={spec.risk.stopLossPct}
                onChange={(e) =>
                  setSpec((s) => ({
                    ...s,
                    risk: { ...s.risk, stopLossPct: Number(e.target.value) },
                  }))
                }
              />
            </label>
            <label className="text-[11px] text-zinc-400">
              Trailing %
              <input
                type="number"
                min={0}
                step="0.1"
                className="mt-1 h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                value={spec.risk.trailingStopPct ?? 0}
                onChange={(e) =>
                  setSpec((s) => ({
                    ...s,
                    risk: { ...s.risk, trailingStopPct: Number(e.target.value) },
                  }))
                }
              />
            </label>
          </div>
          <p className="mt-2 text-[9px] leading-snug text-zinc-600">
            TP/SL/Trailing 0 % desactiva essa perna. O trailing usa extremos já fechados anteriormente para evitar repaint.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-800 px-4 py-3">
          {draft?.mode === "edit" ? (
            <button
              type="button"
              disabled={deleting || saving}
              className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs font-medium text-red-300/95 hover:bg-red-950/50 disabled:opacity-40"
              onClick={() => void deleteStrategy()}
            >
              {deleting
                ? "A eliminar…"
                : persistToLocalStorage
                  ? "Eliminar deste browser"
                  : "Eliminar da base de dados"}
            </button>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canSave || saving || deleting}
              title="Descarrega um .py no formato TradingBot (imports configs/, indicators + strategy esqueleto, JSON da estratégia embutido)."
              className="rounded-lg border border-sky-800/70 bg-sky-950/25 px-3 py-2 text-xs font-medium text-sky-200/95 hover:bg-sky-950/45 disabled:opacity-40"
              onClick={exportTradingBotPy}
            >
              Exportar .py (bot)
            </button>
            <button
              type="button"
              disabled={deleting}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800"
              onClick={onClose}
            >
              Fechar
            </button>
            <button
              type="button"
              disabled={!canSave || saving || deleting}
              className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
              onClick={() => void save()}
            >
              {saving ? "A guardar…" : "Guardar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Garante campos novos ao editar JSON antigo. */
function migrateLegacySpec(s: ChartBuilderSpecV1): ChartBuilderSpecV1 {
  const r = s.rules as Record<string, unknown>;
  let filterIf =
    (r.filterIf as string | null | undefined) ?? (s.rules.filter ? "" : null);
  if (typeof filterIf === "string" && !filterIf.trim() && !s.rules.filter) filterIf = null;
  const zlw = s.rules.zoneLongWaitCandles;
  const zoneLongWaitCandles =
    typeof zlw === "number" && Number.isFinite(zlw)
      ? Math.max(0, Math.min(500, Math.round(zlw)))
      : 10;
  const zsw = s.rules.zoneShortWaitCandles;
  const zoneShortWaitCandles =
    typeof zsw === "number" && Number.isFinite(zsw)
      ? Math.max(0, Math.min(500, Math.round(zsw)))
      : 10;

  let zoneLongIf = (s.rules.zoneLongIf as string | null | undefined) ?? null;
  if (
    typeof zoneLongIf === "string" &&
    !zoneLongIf.trim() &&
    s.rules.zoneLong == null
  ) {
    zoneLongIf = null;
  }
  let zoneShortIf = (s.rules.zoneShortIf as string | null | undefined) ?? null;
  if (
    typeof zoneShortIf === "string" &&
    !zoneShortIf.trim() &&
    s.rules.zoneShort == null
  ) {
    zoneShortIf = null;
  }

  return {
    ...s,
    risk: {
      takeProfitPct: s.risk.takeProfitPct ?? 0,
      stopLossPct: s.risk.stopLossPct ?? 0,
      trailingStopPct: s.risk.trailingStopPct ?? 0,
    },
    rules: {
      filterIf,
      filter: s.rules.filter ?? null,
      zoneLongIf,
      zoneLong: s.rules.zoneLong ?? null,
      zoneLongApplyFilter: s.rules.zoneLongApplyFilter !== false,
      zoneLongWaitCandles,
      zoneShortIf,
      zoneShort: s.rules.zoneShort ?? null,
      zoneShortApplyFilter: s.rules.zoneShortApplyFilter !== false,
      zoneShortWaitCandles,
      long: s.rules.long
        ? {
            applyFilter: s.rules.long.applyFilter,
            ...(s.rules.long.enabled === false ? { enabled: false as const } : {}),
            ifLine: s.rules.long.ifLine ?? (s.rules.long.expr ? "" : null),
            expr: s.rules.long.expr,
          }
        : null,
      short: s.rules.short
        ? {
            applyFilter: s.rules.short.applyFilter,
            ...(s.rules.short.enabled === false ? { enabled: false as const } : {}),
            ifLine: s.rules.short.ifLine ?? (s.rules.short.expr ? "" : null),
            expr: s.rules.short.expr,
          }
        : null,
      exitLongIf: (() => {
        const x =
          (r.exitLongIf as string | null | undefined) ?? (s.rules.exitLong ? "" : null);
        return typeof x === "string" && !x.trim() && !s.rules.exitLong ? null : x;
      })(),
      exitShortIf: (() => {
        const x =
          (r.exitShortIf as string | null | undefined) ?? (s.rules.exitShort ? "" : null);
        return typeof x === "string" && !x.trim() && !s.rules.exitShort ? null : x;
      })(),
      exitLong: s.rules.exitLong ?? null,
      exitShort: s.rules.exitShort ?? null,
      entrySnapEnabled: r.entrySnapEnabled === true,
    },
  };
}
