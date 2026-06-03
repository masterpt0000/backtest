"use client";

import type { IndicatorCategory, IndicatorRegistryEntry } from "lightweight-charts-indicators";
import {
  countMapEntries,
  filterGrouped,
  formatLciCategoryTitle,
  groupLciRegistry,
  LCI_CATEGORY_ORDER,
  type LciGrouped,
} from "@/lib/lciSidebarTree";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

function IconChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      className={(className ?? "h-3.5 w-3.5") + " shrink-0 text-zinc-500 transition-transform " + (open ? "rotate-90" : "")}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 6l8 6-8 6V6z" />
    </svg>
  );
}

function SubAccordion({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-zinc-800/50 last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 py-1.5 pl-3 pr-2 text-left hover:bg-zinc-900/50"
        onClick={onToggle}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <IconChevron open={open} />
          <span className="truncate text-[11px] font-semibold tracking-wide text-zinc-300">{title}</span>
        </span>
        <span className="shrink-0 tabular-nums text-[10px] text-zinc-500">{count}</span>
      </button>
      {open ? <div className="border-t border-zinc-800/40 bg-zinc-950/40 pb-1 pl-2 pr-1">{children}</div> : null}
    </div>
  );
}

function TopSection({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-zinc-800/70">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-2 py-2 text-left hover:bg-zinc-900/45"
        onClick={onToggle}
      >
        <span className="flex min-w-0 items-center gap-2">
          <IconChevron open={open} className="h-4 w-4" />
          <span className="truncate text-xs font-semibold text-zinc-100">{label}</span>
        </span>
        <span className="shrink-0 tabular-nums text-[11px] text-zinc-500">{count}</span>
      </button>
      {open ? <div className="max-h-[min(70vh,520px)] overflow-y-auto overscroll-contain">{children}</div> : null}
    </div>
  );
}

function EntryButton({
  entry,
  disabled,
  disabledReason,
  onAdd,
}: {
  entry: IndicatorRegistryEntry;
  disabled?: boolean;
  disabledReason?: string;
  onAdd: (e: IndicatorRegistryEntry) => void;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        disabled={disabled}
        title={disabled ? disabledReason : entry.description}
        onClick={() => !disabled && onAdd(entry)}
        className={
          "w-full rounded-md border px-2 py-1.5 text-left transition-colors " +
          (disabled
            ? "cursor-not-allowed border-zinc-800/80 bg-zinc-900/20 opacity-50"
            : "border-zinc-800/80 bg-zinc-900/35 hover:border-zinc-600/70 hover:bg-zinc-900/60")
        }
      >
        <p className="text-[11px] font-semibold text-zinc-200">{entry.shortName || entry.name}</p>
        {entry.description ? (
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-zinc-500">{entry.description}</p>
        ) : null}
      </button>
    </li>
  );
}

function renderCategorySections(
  grouped: Map<IndicatorCategory, IndicatorRegistryEntry[]>,
  subOpen: Record<string, boolean>,
  toggleSub: (key: string) => void,
  onAdd: (e: IndicatorRegistryEntry) => void,
  keyPrefix: string,
  disableAdds: boolean,
  disableReason: string,
) {
  const keys = [...LCI_CATEGORY_ORDER.filter((c) => grouped.has(c)), ...[...grouped.keys()].filter(
    (c) => !LCI_CATEGORY_ORDER.includes(c),
  )];
  return keys.map((cat) => {
    const items = grouped.get(cat);
    if (!items?.length) return null;
    const sk = `${keyPrefix}:${cat}`;
    const open = subOpen[sk] ?? false;
    return (
      <SubAccordion
        key={sk}
        title={formatLciCategoryTitle(cat)}
        count={items.length}
        open={open}
        onToggle={() => toggleSub(sk)}
      >
        <ul className="max-h-48 space-y-1 overflow-y-auto overscroll-contain py-1">
          {items.map((e) => (
            <EntryButton
              key={e.id}
              entry={e}
              disabled={disableAdds}
              disabledReason={disableReason}
              onAdd={onAdd}
            />
          ))}
        </ul>
      </SubAccordion>
    );
  });
}

export type LciIndicatorLibraryPanelProps = {
  onAddEntry: (entry: IndicatorRegistryEntry) => void;
};

export function LciIndicatorLibraryPanel({ onAddEntry }: LciIndicatorLibraryPanelProps) {
  const [registry, setRegistry] = useState<IndicatorRegistryEntry[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [topOpen, setTopOpen] = useState({ standard: true, candlestick: false, community: true });
  const [subOpen, setSubOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    void import("lightweight-charts-indicators")
      .then((m) => {
        if (!cancelled) setRegistry(m.indicatorRegistry);
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groupedFull = useMemo((): LciGrouped | null => {
    if (!registry) return null;
    return groupLciRegistry(registry);
  }, [registry]);

  const grouped = useMemo(() => {
    if (!groupedFull) return null;
    return filterGrouped(groupedFull, query);
  }, [groupedFull, query]);

  const counts = useMemo(() => {
    if (!groupedFull || !grouped) {
      return { standard: 0, community: 0, candle: 0, stdF: 0, comF: 0, candleF: 0 };
    }
    return {
      standard: countMapEntries(groupedFull.standard),
      community: countMapEntries(groupedFull.community),
      candle: groupedFull.candlestick.length,
      stdF: countMapEntries(grouped.standard),
      comF: countMapEntries(grouped.community),
      candleF: grouped.candlestick.length,
    };
  }, [grouped, groupedFull]);

  const toggleSub = useCallback((key: string) => {
    setSubOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  if (loadErr) {
    return (
      <p className="px-3 py-4 text-center text-[11px] text-red-400/90">
        Erro a carregar lightweight-charts-indicators: {loadErr}
      </p>
    );
  }

  if (!registry || !grouped) {
    return <p className="px-3 py-6 text-center text-[11px] text-zinc-500">A carregar indicadores…</p>;
  }

  const candleDisabledReason =
    "Padrões de velas: saída com marcadores/cores ainda não ligada ao gráfico.";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-zinc-800/90 px-3 py-2">
        <label htmlFor="lci-lib-search" className="sr-only">
          Pesquisar indicadores
        </label>
        <input
          id="lci-lib-search"
          type="search"
          autoComplete="off"
          placeholder="Pesquisar indicadores…"
          className="h-9 w-full rounded-lg border border-zinc-700/80 bg-zinc-900/90 px-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-600/55 focus:outline-none focus:ring-2 focus:ring-sky-600/20"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 py-0.5">
        <TopSection
          label="Standard"
          count={counts.stdF}
          open={topOpen.standard}
          onToggle={() => setTopOpen((o) => ({ ...o, standard: !o.standard }))}
        >
          {counts.stdF === 0 ? (
            <p className="px-3 py-3 text-[10px] text-zinc-500">Nenhum resultado.</p>
          ) : (
            renderCategorySections(
              grouped.standard,
              subOpen,
              toggleSub,
              onAddEntry,
              "std",
              false,
              "",
            )
          )}
        </TopSection>

        <TopSection
          label="Candlestick Patterns"
          count={counts.candleF}
          open={topOpen.candlestick}
          onToggle={() => setTopOpen((o) => ({ ...o, candlestick: !o.candlestick }))}
        >
          {counts.candleF === 0 ? (
            <p className="px-3 py-3 text-[10px] text-zinc-500">Nenhum resultado.</p>
          ) : (
            <ul className="space-y-1 px-2 py-2">
              {grouped.candlestick.map((e) => (
                <EntryButton
                  key={e.id}
                  entry={e}
                  disabled
                  disabledReason={candleDisabledReason}
                  onAdd={onAddEntry}
                />
              ))}
            </ul>
          )}
        </TopSection>

        <TopSection
          label="Community"
          count={counts.comF}
          open={topOpen.community}
          onToggle={() => setTopOpen((o) => ({ ...o, community: !o.community }))}
        >
          {counts.comF === 0 ? (
            <p className="px-3 py-3 text-[10px] text-zinc-500">Nenhum resultado.</p>
          ) : (
            renderCategorySections(
              grouped.community,
              subOpen,
              toggleSub,
              onAddEntry,
              "com",
              false,
              "",
            )
          )}
        </TopSection>
      </div>
      <p className="shrink-0 border-t border-zinc-800/80 px-3 py-2 text-[9px] leading-snug text-zinc-600">
        Fonte: pacote npm{" "}
        <span className="text-zinc-500">lightweight-charts-indicators</span> (cálculo local, sem API).
      </p>
    </div>
  );
}
