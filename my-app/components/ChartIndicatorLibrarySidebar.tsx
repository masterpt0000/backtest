"use client";

import {
  CUSTOM_INDICATOR_DRAFT_STORAGE_KEY,
  filterCatalogGrouped,
  INDICATOR_CATEGORY_LABEL,
  INDICATOR_CATEGORY_ORDER,
  type IndicatorCatalogEntry,
  type IndicatorCategory,
} from "@/lib/indicatorCatalog";
import { CHART_FACT_SERIES, type ChartFactSeriesEntry } from "@/lib/chartFactSeriesCatalog";
import { extractBuilderUuidFromStrategyId } from "@/lib/chartBuilderSpec";
import type { Strategy } from "@/lib/strategies";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

function IconClose({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path strokeWidth="2" strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function IconLayers({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
      />
    </svg>
  );
}

function IconPlus({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path strokeWidth="2" strokeLinecap="round" d="M12 6v12M6 12h12" />
    </svg>
  );
}

function IconCircleInfo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="9.5" strokeWidth="1.55" />
      <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v5.5M12 8.15h.01" />
    </svg>
  );
}

function IconGear({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 15a3 3 0 100-6 3 3 0 000 6z"
      />
      <path
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"
      />
    </svg>
  );
}

export type ChartLibraryHeaderButtonProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ChartLibraryHeaderButton({ open, onOpenChange }: ChartLibraryHeaderButtonProps) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls="chart-indicator-library"
      className={
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-900/90 text-zinc-400 shadow-inner shadow-black/20 transition-colors hover:border-zinc-600 hover:text-zinc-100 focus:border-emerald-600/70 focus:outline-none focus:ring-2 focus:ring-emerald-600/25 " +
        (open ? "border-sky-700/50 text-sky-300/90" : "")
      }
      title="Indicadores e estratégias"
      onClick={() => onOpenChange(!open)}
    >
      <IconLayers className="h-4 w-4" />
    </button>
  );
}

type SidebarProps = {
  onAddTemplate: (templateId: string) => void;
  /** Catálogo TA-Lib (servidor); vazio até a API responder. */
  talibCatalog: IndicatorCatalogEntry[];
  onClose: () => void;
  strategies: Strategy[];
  selectedStrategyId: string;
  onSelectStrategy: (strategyId: string) => void;
  /** PostgreSQL com tabela builder; se desligado, o botão de criar fica inactivo. */
  builderPostgres: "ok" | "disabled" | "unknown";
  onOpenBuilder: () => void;
  onEditBuilder: (uuid: string) => void;
  /** Visualizar séries facetas QuestDB (`feat_*`) como painel no gráfico. */
  featVisibility: Record<string, boolean>;
  onToggleFeatVisibility: (id: string, next: boolean) => void;
};

function CatalogRow({
  entry,
  onAdd,
}: {
  entry: IndicatorCatalogEntry;
  onAdd: () => void;
}) {
  const dis = !entry.implemented;
  return (
    <li>
      <button
        type="button"
        disabled={dis}
        title={dis ? "Indicador indisponível neste modo." : undefined}
        onClick={() => {
          if (!dis) onAdd();
        }}
        aria-label={
          dis ? `${entry.label} (indisponível)` : `Adicionar ${entry.label} ao gráfico`
        }
        className={
          "w-full rounded-lg border border-zinc-800/90 px-2.5 py-2 text-left transition-colors " +
          (dis
            ? "cursor-not-allowed bg-zinc-900/25 opacity-55"
            : "bg-zinc-900/40 hover:border-zinc-600/80 hover:bg-zinc-900/70 " +
              "focus:border-emerald-600/70 focus:outline-none focus:ring-2 focus:ring-emerald-600/25")
        }
      >
        <div className="min-w-0">
          <p className="text-xs font-semibold text-zinc-200">{entry.label}</p>
          <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">{entry.description}</p>
          {dis ? (
            <p className="mt-1 text-[9px] font-medium uppercase tracking-wide text-zinc-600">
              Em breve
            </p>
          ) : null}
        </div>
      </button>
    </li>
  );
}

function IndicatorCategoryAccordion({
  category,
  title,
  open,
  onToggle,
  children,
}: {
  category: IndicatorCategory;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-zinc-800/70 last:border-b-0">
      <button
        type="button"
        id={`chart-lib-acc-${category}`}
        aria-expanded={open}
        aria-controls={`chart-lib-acc-panel-${category}`}
        className="flex w-full items-center justify-between gap-2 px-1 py-2 text-left transition-colors hover:bg-zinc-900/40"
        onClick={onToggle}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/90">
          {title}
        </span>
        <svg
          className={
            "h-4 w-4 shrink-0 text-zinc-500 transition-transform " + (open ? "rotate-180" : "")
          }
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          aria-hidden
        >
          <path strokeWidth="2" strokeLinecap="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div
        id={`chart-lib-acc-panel-${category}`}
        role="region"
        aria-labelledby={`chart-lib-acc-${category}`}
        className={open ? "pb-1" : "hidden"}
      >
        {children}
      </div>
    </div>
  );
}

function FactSeriesAccordion({
  open,
  onToggle,
  catalog,
  visibility,
  onToggleRow,
}: {
  open: boolean;
  onToggle: () => void;
  catalog: ChartFactSeriesEntry[];
  visibility: Record<string, boolean>;
  onToggleRow: (id: string, next: boolean) => void;
}) {
  return (
    <div className="mb-2 border-b border-zinc-800/70 pb-2 last:mb-0">
      <button
        type="button"
        id="chart-lib-acc-feat"
        aria-expanded={open}
        aria-controls="chart-lib-acc-panel-feat"
        className="flex w-full items-center justify-between gap-2 px-1 py-2 text-left transition-colors hover:bg-zinc-900/40"
        onClick={onToggle}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-cyan-300/90">
          QuestDB (feat)
        </span>
        <svg
          className={
            "h-4 w-4 shrink-0 text-zinc-500 transition-transform " + (open ? "rotate-180" : "")
          }
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          aria-hidden
        >
          <path strokeWidth="2" strokeLinecap="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div
        id="chart-lib-acc-panel-feat"
        role="region"
        aria-labelledby="chart-lib-acc-feat"
        className={open ? "" : "hidden"}
      >
        <p className="mb-2 px-1 text-[10px] leading-snug text-zinc-500">
          Séries facetas por vela (API Python); aparecem no painel de estudo sob RSI/MACD/Δ quando activas. O ícone de
          informação mostra o que cada uma mede.
        </p>
        <ul className="space-y-1.5 px-0.5">
          {catalog.map((e) => {
            const on = visibility[e.id] === true;
            return (
              <li key={e.id} className="relative">
                <div className="relative z-[1] flex gap-1">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-zinc-800/90 bg-zinc-900/35 px-2.5 py-2 transition-colors hover:bg-zinc-900/65">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 accent-cyan-500"
                      checked={on}
                      onChange={() => onToggleRow(e.id, !on)}
                    />
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: e.color }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-medium text-zinc-200">{e.label}</span>
                      <p className="mt-0.5 font-mono text-[9px] text-zinc-600">{e.id}</p>
                    </div>
                  </label>
                  {/* À esquerda do ícone (`right-full`): o texto cresce para dentro do painel, não para fora da borda direita. */}
                  <div className="group/feat-tip relative shrink-0 pt-2">
                    <button
                      type="button"
                      className="rounded p-1 text-zinc-600 outline-none transition-colors hover:bg-zinc-800/80 hover:text-cyan-400 focus-visible:ring-2 focus-visible:ring-cyan-600/40"
                      title={e.description}
                      aria-describedby={`feat-tip-${e.id}`}
                      aria-label={`Informação: ${e.label}`}
                      onClick={(ev) => ev.preventDefault()}
                    >
                      <IconCircleInfo className="h-3.5 w-3.5 shrink-0" />
                    </button>
                    <div
                      id={`feat-tip-${e.id}`}
                      className="
                        pointer-events-none invisible absolute bottom-full right-full z-[70] mr-2 mb-1.5
                        max-h-[70vh] w-[min(15.5rem,80vw)] max-w-[calc(100vw-4rem)] sm:max-w-[15.5rem]
                        overflow-y-auto rounded-md border border-zinc-600/95 bg-[#141416]
                        px-2.5 py-1.5 text-left text-[10px] leading-snug tracking-tight text-zinc-100 shadow-xl opacity-0 ring-1 ring-black/35
                        transition-opacity duration-150 group-hover/feat-tip:visible group-hover/feat-tip:opacity-100
                        group-focus-within/feat-tip:visible group-focus-within/feat-tip:opacity-100"
                      role="tooltip"
                    >
                      <span className="block whitespace-normal break-words">{e.description}</span>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function StrategyRow({
  strategy,
  selected,
  onSelect,
  builderUuid,
  onEditBuilder,
}: {
  strategy: Strategy;
  selected: boolean;
  onSelect: () => void;
  builderUuid: string | null;
  onEditBuilder: (uuid: string) => void;
}) {
  const n = strategy.indicators.length;
  const rowClass =
    "flex w-full min-w-0 items-stretch overflow-hidden rounded-lg border transition-colors " +
    (selected
      ? "border-emerald-700/60 bg-emerald-950/25"
      : "border-zinc-800/90 bg-zinc-900/40 hover:border-zinc-600/80 hover:bg-zinc-900/70");
  return (
    <li>
      <div className={rowClass}>
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-start justify-between gap-2 px-2.5 py-2 text-left focus:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/30"
        >
          <div className="min-w-0">
            <p className="text-xs font-semibold text-zinc-200">{strategy.label}</p>
            {strategy.id ? (
              <p className="mt-0.5 text-[10px] text-zinc-500">
                {builderUuid ? "Builder · " : ""}
                {n} indicador{n === 1 ? "" : "es"} na estratégia
              </p>
            ) : (
              <p className="mt-0.5 text-[10px] text-zinc-500">Só indicadores que adicionares à biblioteca</p>
            )}
          </div>
          {selected ? (
            <span className="shrink-0 text-[10px] font-medium text-emerald-400/90">Activa</span>
          ) : null}
        </button>
        {builderUuid ? (
          <button
            type="button"
            title="Editar no construtor"
            aria-label={`Editar «${strategy.label}» no construtor`}
            className={
              "flex shrink-0 items-center justify-center border-l border-zinc-800/80 px-2.5 text-zinc-500 transition-colors " +
              "hover:bg-zinc-800/60 hover:text-sky-300/95 focus:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-600/35"
            }
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onEditBuilder(builderUuid);
            }}
          >
            <IconGear className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function ChartIndicatorLibrarySidebar({
  onAddTemplate,
  talibCatalog,
  onClose,
  strategies,
  selectedStrategyId,
  onSelectStrategy,
  builderPostgres,
  onOpenBuilder,
  onEditBuilder,
  featVisibility,
  onToggleFeatVisibility,
}: SidebarProps) {
  const [tab, setTab] = useState<"indicators" | "strategies">("indicators");
  const [query, setQuery] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customCode, setCustomCode] = useState("");
  const [accOpen, setAccOpen] = useState<Record<IndicatorCategory, boolean>>(() => ({
    trend: true,
    momentum: true,
    volatility: true,
    volume: true,
  }));
  const [featAccOpen, setFeatAccOpen] = useState(true);

  const grouped = useMemo(
    () => filterCatalogGrouped(query, talibCatalog),
    [query, talibCatalog],
  );
  const groupedTotal = useMemo(
    () => INDICATOR_CATEGORY_ORDER.reduce((n, c) => n + grouped[c].length, 0),
    [grouped],
  );

  useEffect(() => {
    try {
      const s = localStorage.getItem(CUSTOM_INDICATOR_DRAFT_STORAGE_KEY);
      if (s) setCustomCode(s);
    } catch {
      /* ignore */
    }
  }, []);

  const persistDraft = useCallback((code: string) => {
    try {
      localStorage.setItem(CUSTOM_INDICATOR_DRAFT_STORAGE_KEY, code);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <aside
      id="chart-indicator-library"
      role="complementary"
      aria-label="Indicadores e estratégias"
      className="flex h-full min-h-0 w-full min-w-0 flex-col border-l border-zinc-800/90 bg-zinc-950/98 shadow-[inset_1px_0_0_rgba(255,255,255,0.03)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800/90 px-3 py-2.5">
        <h2 className="text-sm font-semibold text-zinc-200">Biblioteca</h2>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800/80 hover:text-zinc-200"
          aria-label="Fechar biblioteca"
          onClick={onClose}
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Secções da biblioteca"
        className="flex shrink-0 gap-1 border-b border-zinc-800/90 px-2 py-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "indicators"}
          className={
            "min-w-0 flex-1 rounded-lg px-2 py-2 text-center text-xs font-medium transition-colors " +
            (tab === "indicators"
              ? "bg-zinc-800/90 text-zinc-100"
              : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300")
          }
          onClick={() => setTab("indicators")}
        >
          Indicadores
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "strategies"}
          className={
            "min-w-0 flex-1 rounded-lg px-2 py-2 text-center text-xs font-medium transition-colors " +
            (tab === "strategies"
              ? "bg-zinc-800/90 text-zinc-100"
              : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300")
          }
          onClick={() => setTab("strategies")}
        >
          Estratégias
        </button>
      </div>

      {tab === "indicators" ? (
        <div className="flex shrink-0 items-center justify-end border-b border-zinc-800/90 px-2 py-1.5">
          <button
            type="button"
            className={
              "flex h-8 w-8 items-center justify-center rounded-lg border text-zinc-400 transition-colors hover:bg-zinc-800/80 hover:text-zinc-100 " +
              (customOpen
                ? "border-sky-600/50 bg-sky-950/30 text-sky-300"
                : "border-zinc-700/80 bg-zinc-900/50")
            }
            title="Criar com código (rascunho)"
            aria-expanded={customOpen}
            onClick={() => setCustomOpen((v) => !v)}
          >
            <IconPlus className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {tab === "indicators" ? (
        <div className="shrink-0 border-b border-zinc-800/90 px-3 py-2">
          <label htmlFor="chart-lib-search" className="sr-only">
            Pesquisar indicador
          </label>
          <input
            id="chart-lib-search"
            type="search"
            autoComplete="off"
            placeholder="Pesquisar…"
            className="h-9 w-full rounded-lg border border-zinc-700/80 bg-zinc-900/90 px-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-600/60 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}

      {tab === "indicators" && customOpen ? (
        <div className="shrink-0 space-y-2 border-b border-zinc-800/90 bg-zinc-900/30 px-3 py-3">
          <p className="text-xs font-medium text-zinc-300">Indicador personalizado</p>
          <p className="text-[10px] leading-snug text-zinc-500">
            Escreve aqui o teu código (ex. lógica em Python ou JS). A execução no gráfico ainda não está
            ligada — isto serve como rascunho guardado neste browser.
          </p>
          <textarea
            className="min-h-[120px] w-full resize-y rounded-lg border border-zinc-700/80 bg-[#0a0a0c] p-2 font-mono text-[11px] leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-600/50 focus:outline-none focus:ring-1 focus:ring-emerald-600/25"
            placeholder="# Ex.: def plot_rsi(bars, period=14): ..."
            spellCheck={false}
            value={customCode}
            onChange={(e) => {
              const v = e.target.value;
              setCustomCode(v);
              persistDraft(v);
            }}
          />
          <button
            type="button"
            className="text-[10px] font-medium text-emerald-500/90 hover:text-emerald-400"
            onClick={() => persistDraft(customCode)}
          >
            Guardar rascunho
          </button>
        </div>
      ) : null}

      {tab === "indicators" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-1" role="tabpanel">
          <div className="px-0.5 pb-1">
            <FactSeriesAccordion
              open={featAccOpen}
              onToggle={() => setFeatAccOpen((v) => !v)}
              catalog={CHART_FACT_SERIES}
              visibility={featVisibility}
              onToggleRow={onToggleFeatVisibility}
            />
          </div>
          {groupedTotal === 0 ? (
            <p className="px-2 py-6 text-center text-[11px] text-zinc-500">
              {talibCatalog.length === 0
                ? "Sem catálogo TA-Lib (servidor sem TA-Lib ou API em falta). Com TA-Lib instalado no backend, aparecem aqui todas as funções da biblioteca."
                : "Nenhum resultado."}
            </p>
          ) : (
            <div className="px-0.5">
              {INDICATOR_CATEGORY_ORDER.map((cat) => {
                const items = grouped[cat];
                if (items.length === 0) return null;
                return (
                  <IndicatorCategoryAccordion
                    key={cat}
                    category={cat}
                    title={INDICATOR_CATEGORY_LABEL[cat]}
                    open={accOpen[cat]}
                    onToggle={() =>
                      setAccOpen((prev) => ({
                        ...prev,
                        [cat]: !prev[cat],
                      }))
                    }
                  >
                    <ul className="space-y-2 px-0.5 pt-0.5">
                      {items.map((e) => (
                        <CatalogRow
                          key={e.templateId}
                          entry={e}
                          onAdd={() => onAddTemplate(e.templateId)}
                        />
                      ))}
                    </ul>
                  </IndicatorCategoryAccordion>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2" role="tabpanel">
          <p className="mb-2 px-1 text-[10px] leading-snug text-zinc-500">
            Escolhe a estratégia carregada pelo servidor. &quot;Nenhuma&quot; mostra só os teus indicadores da
            biblioteca. Estratégias &quot;builder&quot; avaliam nas velas com TA-Lib da API; com PostgreSQL ficam na BD, sem ele
            guardam-se neste browser (localStorage).
          </p>
          {builderPostgres === "disabled" ? (
            <p className="mb-2 rounded border border-sky-900/35 bg-sky-950/20 px-2 py-1 text-[10px] text-sky-100/90">
              Sem PostgreSQL no backend: podes criar e editar estratégias builder à mesma — ficam guardadas só
              neste browser. Para partilhar entre máquinas ou fazer cópia de segurança, define{" "}
              <code className="text-sky-300/90">DATABASE_URL</code> no <code className="text-sky-300/90">.env</code>{" "}
              do backend.
            </p>
          ) : null}
          <button
            type="button"
            disabled={builderPostgres === "unknown"}
            title={
              builderPostgres === "unknown"
                ? "A carregar estado do servidor…"
                : builderPostgres === "disabled"
                  ? "Guardar neste browser (localStorage)"
                  : "Criar nova estratégia com regras e TP/SL (PostgreSQL)"
            }
            className={
              "mb-3 w-full rounded-lg border px-2.5 py-2 text-left text-[11px] font-semibold transition-colors " +
              (builderPostgres === "unknown"
                ? "cursor-wait border-zinc-800/80 bg-zinc-900/30 text-zinc-600"
                : "border-sky-800/60 bg-sky-950/30 text-sky-200 hover:border-sky-700/80 hover:bg-sky-950/50")
            }
            onClick={onOpenBuilder}
          >
            + Nova estratégia (builder)
          </button>
          <ul className="space-y-2">
            {strategies.map((s) => (
              <StrategyRow
                key={s.id || "none"}
                strategy={s}
                selected={selectedStrategyId === s.id}
                onSelect={() => onSelectStrategy(s.id)}
                builderUuid={extractBuilderUuidFromStrategyId(s.id)}
                onEditBuilder={onEditBuilder}
              />
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
