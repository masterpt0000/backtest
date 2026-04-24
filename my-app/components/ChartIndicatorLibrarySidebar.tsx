"use client";

import {
  CUSTOM_INDICATOR_DRAFT_STORAGE_KEY,
  filterCatalog,
  type IndicatorCatalogEntry,
} from "@/lib/indicatorCatalog";
import type { Strategy } from "@/lib/strategies";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  onClose: () => void;
  strategies: Strategy[];
  selectedStrategyId: string;
  onSelectStrategy: (strategyId: string) => void;
};

function CatalogRow({
  entry,
  onAdd,
}: {
  entry: IndicatorCatalogEntry;
  onAdd: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onAdd}
        aria-label={`Adicionar ${entry.label} ao gráfico`}
        className={
          "w-full rounded-lg border border-zinc-800/90 bg-zinc-900/40 px-2.5 py-2 text-left transition-colors " +
          "hover:border-zinc-600/80 hover:bg-zinc-900/70 " +
          "focus:border-emerald-600/70 focus:outline-none focus:ring-2 focus:ring-emerald-600/25"
        }
      >
        <div className="min-w-0">
          <p className="text-xs font-semibold text-zinc-200">{entry.label}</p>
          <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">{entry.description}</p>
          <p className="mt-1 text-[9px] uppercase tracking-wide text-zinc-600">
            {entry.group === "overlays" ? "Sobreposição" : "Estudo"} · {entry.kind}
          </p>
        </div>
      </button>
    </li>
  );
}

function StrategyRow({
  strategy,
  selected,
  onSelect,
}: {
  strategy: Strategy;
  selected: boolean;
  onSelect: () => void;
}) {
  const n = strategy.indicators.length;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={
          "flex w-full items-start justify-between gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors " +
          (selected
            ? "border-emerald-700/60 bg-emerald-950/25"
            : "border-zinc-800/90 bg-zinc-900/40 hover:border-zinc-600/80 hover:bg-zinc-900/70")
        }
      >
        <div className="min-w-0">
          <p className="text-xs font-semibold text-zinc-200">{strategy.label}</p>
          {strategy.id ? (
            <p className="mt-0.5 text-[10px] text-zinc-500">
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
    </li>
  );
}

export function ChartIndicatorLibrarySidebar({
  onAddTemplate,
  onClose,
  strategies,
  selectedStrategyId,
  onSelectStrategy,
}: SidebarProps) {
  const [tab, setTab] = useState<"indicators" | "strategies">("indicators");
  const [query, setQuery] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customCode, setCustomCode] = useState("");

  const filtered = useMemo(() => filterCatalog(query), [query]);

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
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2" role="tabpanel">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-[11px] text-zinc-500">Nenhum resultado.</p>
          ) : (
            <ul className="space-y-2">
              {filtered.map((e) => (
                <CatalogRow key={e.templateId} entry={e} onAdd={() => onAddTemplate(e.templateId)} />
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2" role="tabpanel">
          <p className="mb-2 px-1 text-[10px] leading-snug text-zinc-500">
            Escolhe a estratégia carregada pelo servidor. &quot;Nenhuma&quot; mostra só os teus indicadores da
            biblioteca.
          </p>
          <ul className="space-y-2">
            {strategies.map((s) => (
              <StrategyRow
                key={s.id || "none"}
                strategy={s}
                selected={selectedStrategyId === s.id}
                onSelect={() => onSelectStrategy(s.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
