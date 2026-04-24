"use client";

import type { Strategy, StrategyIndicator } from "@/lib/strategies";

type Props = {
  strategy: Strategy;
  visibility: Record<string, boolean>;
  onToggle: (indicatorId: string) => void;
  /** Ids que o utilizador pode remover (indicadores da biblioteca). */
  removableUserIndicatorIds: ReadonlySet<string>;
  onRemoveUserIndicator?: (indicatorId: string) => void;
};

function groupLabel(g: StrategyIndicator["group"]): string {
  return g === "overlays" ? "Sobreposições" : "Estudos";
}

function ToggleBtn({
  ind,
  on,
  onToggle,
  showRemove,
  onRemove,
}: {
  ind: StrategyIndicator;
  on: boolean;
  onToggle: () => void;
  showRemove?: boolean;
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={onToggle}
        className={
          "rounded border px-2 py-1 text-[11px] font-medium transition-colors sm:text-xs " +
          (on
            ? "border-emerald-700/70 bg-emerald-950/35 text-emerald-200 hover:bg-emerald-950/50"
            : "border-zinc-600/90 bg-zinc-900/80 text-zinc-400 opacity-70 hover:border-zinc-500 hover:bg-zinc-800/80 hover:text-zinc-200 hover:opacity-100")
        }
      >
        {ind.label}
      </button>
      {showRemove && onRemove ? (
        <button
          type="button"
          aria-label={`Remover ${ind.label}`}
          title="Remover"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-zinc-700/70 bg-zinc-900/60 text-sm leading-none text-zinc-500 transition-colors hover:border-red-500/40 hover:bg-red-950/30 hover:text-red-300"
          onClick={(e) => {
            e.preventDefault();
            onRemove();
          }}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

export function ChartIndicatorToolbar({
  strategy,
  visibility,
  onToggle,
  removableUserIndicatorIds,
  onRemoveUserIndicator,
}: Props) {
  if (!strategy.indicators.length) return null;

  const overlays = strategy.indicators.filter((i) => i.group === "overlays");
  const studies = strategy.indicators.filter((i) => i.group === "studies");
  const canRemove = !!onRemoveUserIndicator;

  return (
    <div className="shrink-0 space-y-1 border-b border-zinc-800/80 bg-zinc-950 px-2 py-1 sm:px-3">
      {overlays.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="w-full shrink-0 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 sm:w-auto sm:pr-1">
            {groupLabel("overlays")}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {overlays.map((ind) => (
              <ToggleBtn
                key={ind.id}
                ind={ind}
                on={visibility[ind.id] !== false}
                onToggle={() => onToggle(ind.id)}
                showRemove={canRemove && removableUserIndicatorIds.has(ind.id)}
                onRemove={onRemoveUserIndicator ? () => onRemoveUserIndicator(ind.id) : undefined}
              />
            ))}
          </div>
        </div>
      ) : null}
      {studies.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="w-full shrink-0 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 sm:w-auto sm:pr-1">
            {groupLabel("studies")}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {studies.map((ind) => (
              <ToggleBtn
                key={ind.id}
                ind={ind}
                on={visibility[ind.id] !== false}
                onToggle={() => onToggle(ind.id)}
                showRemove={canRemove && removableUserIndicatorIds.has(ind.id)}
                onRemove={onRemoveUserIndicator ? () => onRemoveUserIndicator(ind.id) : undefined}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
