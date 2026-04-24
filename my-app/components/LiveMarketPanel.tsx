"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { bucketHeatColor, tapeBuyRatioBuckets } from "@/lib/liveTapeHeat";

function IconHelpCircle({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/**
 * Tooltip em posição fixa para não ser cortado por contentores com overflow.
 */
function HelpHint({ label, children }: { label: string; children: ReactNode }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState({ top: 0, left: 0, width: 300 });

  const position = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.min(300, Math.max(240, window.innerWidth - 24));
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const gap = 6;
    const estH = 200;
    const below = r.bottom + gap;
    const spaceBelow = window.innerHeight - below - 8;
    if (spaceBelow < 72 && r.top > estH + gap) {
      setBox({ top: Math.max(8, r.top - gap - estH), left, width: w });
    } else {
      setBox({ top: below, left, width: w });
    }
  }, []);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-600/70 bg-zinc-800/50 text-zinc-500 transition-colors hover:border-amber-500/50 hover:bg-zinc-800 hover:text-amber-400/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-500/80"
        aria-label={`Ajuda: ${label}`}
        onMouseEnter={() => {
          position();
          setOpen(true);
        }}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => {
          position();
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
      >
        <IconHelpCircle className="h-3 w-3" />
      </button>
      {open ? (
        <div
          role="tooltip"
          className="fixed z-[300] max-h-[min(45vh,280px)] overflow-y-auto rounded-lg border border-zinc-600 bg-zinc-900/98 px-2.5 py-2 text-left text-[11px] leading-relaxed text-zinc-200 shadow-2xl backdrop-blur-sm"
          style={{ top: box.top, left: box.left, width: box.width }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <p className="mb-1 font-semibold text-amber-400/95">{label}</p>
          <div className="space-y-1.5 text-zinc-300">{children}</div>
        </div>
      ) : null}
    </>
  );
}

export type LiveTick = {
  t: number;
  price: number;
  amount: number;
  trade_id: string;
  side?: string;
};

export type LiveSnapshot = {
  symbol_id: number;
  server_now_sec: number;
  last_tick_stale_sec: number | null;
  ticks: LiveTick[];
  funding: {
    t: number;
    mark_price: unknown;
    funding_rate: unknown;
    index_price: unknown;
    next_funding_time: number | null;
    exchange_ts: number | null;
  } | null;
  open_interest_series: { t: number; oi: number }[];
  order_book_series: {
    t: number;
    best_bid: number;
    best_ask: number;
    spread: number;
    bid_depth_1pct: number;
    ask_depth_1pct: number;
    imbalance: number | null;
  }[];
  liquidations: { t: number; price: number | null; contracts: number | null; side?: string }[];
  errors: string[];
  /** ``memory`` = CCXT directo; ``questdb`` = snapshot SQL (sem ``code`` no URL). */
  live_source?: string;
};

/** Bloco de pontuação devolvido pela estratégia scalp. */
export type LiveSignalFeatureBlock = {
  score: number;
  detail: string;
  imbalance?: number | null;
  rate?: number | null;
};

/** Resposta de ``/api/live/signal`` (scalp multistream ou demo RSI+ATR+livro). */
export type LiveSignal = {
  ok: boolean;
  error?: string;
  symbol_id: number;
  code: string;
  timeframe: string;
  strategy: string;
  disclaimer: string;
  live_source?: string;
  side?: "long" | "short" | "flat";
  reason?: string;
  last_bar_t?: number;
  entry_price?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
  rsi?: number;
  atr?: number;
  book_imbalance?: number | null;
  book_filter_applied?: boolean;
  params?: Record<string, number | boolean>;
  features?: {
    net_score: number;
    threshold: number;
    tape: LiveSignalFeatureBlock;
    book: LiveSignalFeatureBlock;
    book_trend: LiveSignalFeatureBlock;
    candles: LiveSignalFeatureBlock;
    funding: LiveSignalFeatureBlock;
    open_interest: LiveSignalFeatureBlock;
    liquidations: LiveSignalFeatureBlock;
  };
};

function signalStrategySubtitle(strategy: string): string {
  if (strategy === "scalp_multistream") {
    return "Scalp multistream (OHLCV + tape + livro + funding + OI + liqs)";
  }
  if (strategy === "demo_rsi_atr_book") {
    return "Demo RSI + ATR + livro";
  }
  return strategy;
}

function fmtNum(n: number | null | undefined, digits = 4): string {
  if (n == null || Number.isNaN(n)) return "—";
  const x = Number(n);
  if (Math.abs(x) >= 1e6) return x.toExponential(2);
  if (Math.abs(x) >= 1000) return x.toFixed(2);
  if (Math.abs(x) >= 1) return x.toFixed(digits);
  return x.toPrecision(4);
}

function fmtTime(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 19) + "Z";
}

function PanelCard({
  title,
  subtitle,
  children,
  className,
  help,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  help?: ReactNode;
}) {
  return (
    <div
      className={
        "flex min-h-0 min-w-0 flex-col rounded-lg border border-zinc-800/90 bg-zinc-900/35 " +
        (className ?? "")
      }
    >
      <div className="flex shrink-0 items-start justify-between gap-1 border-b border-zinc-800/80 px-2 py-1">
        <div className="min-w-0 pr-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{title}</h3>
          {subtitle ? <p className="text-[9px] text-zinc-600">{subtitle}</p> : null}
        </div>
        {help ? <HelpHint label={title}>{help}</HelpHint> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5">{children}</div>
    </div>
  );
}

function NumericHeatRow({
  values,
  zeroOne,
}: {
  values: number[];
  /** Se true, valor já 0..1 (ex. imbalance mapeado). */
  zeroOne?: boolean;
}) {
  if (values.length < 2) {
    return <p className="text-[10px] text-zinc-600">Poucos pontos.</p>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return (
    <div className="flex h-6 w-full gap-px rounded border border-zinc-800/80 bg-zinc-950 p-px" aria-hidden>
      {values.map((v, i) => {
        const n = zeroOne ? Math.max(0, Math.min(1, v)) : (v - min) / range;
        return (
          <div
            key={i}
            className="min-w-0 flex-1 rounded-[1px]"
            style={{ backgroundColor: bucketHeatColor(zeroOne ? n : n) }}
            title={String(v)}
          />
        );
      })}
    </div>
  );
}

function FundingMarkerBar({ rate }: { rate: number | null }) {
  if (rate == null || Number.isNaN(rate)) {
    return <div className="h-2 w-full rounded bg-zinc-800" />;
  }
  const x = Math.max(-1, Math.min(1, rate / 0.00025));
  const pct = ((x + 1) / 2) * 100;
  return (
    <div
      className="relative h-2.5 w-full overflow-hidden rounded bg-gradient-to-r from-emerald-700 via-zinc-600 to-rose-700"
      title={`Funding ${rate}`}
    >
      <div
        className="absolute top-0 z-10 h-full w-px -translate-x-1/2 bg-white shadow"
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}

function LiqTimeline({ rows }: { rows: LiveSnapshot["liquidations"] }) {
  const intensities = useMemo(() => {
    const n = 36;
    const span = 36 * 60;
    const now = Math.floor(Date.now() / 1000);
    const start = now - span;
    const w = span / n;
    const vol = new Array(n).fill(0);
    for (const r of rows) {
      if (r.t < start) continue;
      const c = Math.abs(Number(r.contracts) || 0);
      const i = Math.min(n - 1, Math.max(0, Math.floor((r.t - start) / w)));
      vol[i] += c;
    }
    const mx = Math.max(...vol, 1e-9);
    return vol.map((v) => v / mx);
  }, [rows]);

  return (
    <div
      className="flex h-8 w-full gap-px rounded border border-zinc-800/80 bg-zinc-950 p-px sm:h-10"
      title="Liquidações: últimos 36 min (opacidade = volume relativo)"
      aria-hidden
    >
      {intensities.map((a, i) => (
        <div
          key={i}
          className="min-w-0 flex-1 rounded-[1px] bg-fuchsia-500"
          style={{ opacity: 0.15 + a * 0.85 }}
        />
      ))}
    </div>
  );
}

function SignalBanner({
  signal,
  loading,
  err,
}: {
  signal: LiveSignal | null;
  loading: boolean;
  err: string | null;
}) {
  if (err) {
    return (
      <div className="shrink-0 rounded-lg border border-rose-500/35 bg-rose-500/10 px-2.5 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-300/95">Sinal live</p>
        <p className="mt-0.5 text-[11px] text-rose-200/95">{err}</p>
      </div>
    );
  }
  if (loading && !signal) {
    return (
      <div className="shrink-0 rounded-lg border border-zinc-700/80 bg-zinc-900/50 px-2.5 py-2">
        <p className="text-[11px] text-zinc-500">A calcular sinal (feed multistream)…</p>
      </div>
    );
  }
  if (!signal || !signal.ok) {
    const msg = signal && !signal.ok ? signal.error ?? "Indisponível" : "Sem dados.";
    return (
      <div className="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-400/90">Sinal live</p>
        <p className="mt-0.5 text-[11px] text-amber-100/90">{msg}</p>
      </div>
    );
  }

  const side = signal.side ?? "flat";
  const sideLabel =
    side === "long" ? "Long" : side === "short" ? "Short" : "Fora — não entrar";
  const sideCls =
    side === "long"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
      : side === "short"
        ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
        : "border-zinc-600/80 bg-zinc-900/60 text-zinc-300";

  const feat = signal.features;
  const stratSub = signalStrategySubtitle(signal.strategy);

  return (
    <div className={`shrink-0 rounded-lg border px-2.5 py-2 ${sideCls}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Sinal live</p>
          <p className="truncate text-[9px] text-zinc-500">{stratSub}</p>
        </div>
        {loading ? <span className="text-[9px] text-sky-400/90">atual…</span> : null}
      </div>
      <p className="mt-1 text-[13px] font-semibold leading-tight">{sideLabel}</p>
      <p className="mt-1 text-[11px] leading-snug opacity-95">{signal.reason}</p>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-200/95 sm:grid-cols-4">
        {feat ? (
          <div>
            <span className="text-zinc-500">Score</span> {feat.net_score.toFixed(2)}{" "}
            <span className="text-zinc-600">(±{feat.threshold.toFixed(2)})</span>
          </div>
        ) : (
          <div>
            <span className="text-zinc-500">RSI</span> {signal.rsi != null ? signal.rsi.toFixed(1) : "—"}
          </div>
        )}
        <div>
          <span className="text-zinc-500">ATR</span> {signal.atr != null ? fmtNum(signal.atr, 6) : "—"}
        </div>
        <div>
          <span className="text-zinc-500">Imb livro</span>{" "}
          {signal.book_imbalance != null ? signal.book_imbalance.toFixed(2) : "—"}
        </div>
        <div>
          <span className="text-zinc-500">TF</span> {signal.timeframe}
        </div>
      </div>
      {feat ? (
        <div className="mt-2 max-h-[min(28vh,200px)] overflow-y-auto border-t border-white/10 pt-2">
          <p className="mb-1 text-[9px] font-medium uppercase tracking-wide text-zinc-500">Contribuições (viés long + / short −)</p>
          <table className="w-full border-collapse font-mono text-[9px] text-zinc-300">
            <tbody>
              {(
                [
                  ["Tape", feat.tape],
                  ["Livro", feat.book],
                  ["Livro tend.", feat.book_trend],
                  ["Velas", feat.candles],
                  ["Funding", feat.funding],
                  ["OI", feat.open_interest],
                  ["Liqs", feat.liquidations],
                ] as const
              ).map(([label, b]) => (
                <tr key={label} className="border-b border-zinc-800/60">
                  <td className="py-0.5 pr-2 align-top text-zinc-500">{label}</td>
                  <td className="py-0.5 pr-1 align-top text-zinc-200">{b.score >= 0 ? "+" : ""}{b.score.toFixed(2)}</td>
                  <td className="py-0.5 align-top text-zinc-500">{b.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {side !== "flat" && signal.entry_price != null ? (
        <div className="mt-2 space-y-0.5 border-t border-white/10 pt-2 font-mono text-[11px]">
          <div>
            <span className="text-zinc-500">Entrada (último close)</span>{" "}
            <span className="text-zinc-100">{fmtNum(signal.entry_price)}</span>
          </div>
          <div>
            <span className="text-zinc-500">Stop (ATR)</span>{" "}
            <span className="text-rose-300/95">{signal.stop_loss != null ? fmtNum(signal.stop_loss) : "—"}</span>
          </div>
          <div>
            <span className="text-zinc-500">TP (ATR)</span>{" "}
            <span className="text-emerald-300/95">{signal.take_profit != null ? fmtNum(signal.take_profit) : "—"}</span>
          </div>
        </div>
      ) : null}
      <p className="mt-2 text-[9px] leading-snug text-zinc-500">{signal.disclaimer}</p>
    </div>
  );
}

export function LiveMarketPanel({
  snapshot,
  loading,
  error,
  storeRunning,
  storePid,
  signal,
  signalLoading,
  signalError,
}: {
  snapshot: LiveSnapshot | null;
  loading: boolean;
  error: string | null;
  storeRunning: boolean;
  storePid: number | null;
  signal?: LiveSignal | null;
  signalLoading?: boolean;
  signalError?: string | null;
}) {
  const hints = useMemo(() => {
    if (!snapshot) return [];
    const out: string[] = [];
    const stale = snapshot.last_tick_stale_sec;
    if (stale != null && stale > 60) {
      out.push(`Tape ~${stale}s`);
    }
    const fr = snapshot.funding?.funding_rate;
    const frn = typeof fr === "number" ? fr : fr != null ? Number(fr) : null;
    if (frn != null && !Number.isNaN(frn)) {
      out.push(frn > 0 ? "fund+" : "fund−");
    }
    const book = snapshot.order_book_series;
    if (book.length) {
      const im = book[book.length - 1].imbalance;
      if (im != null && Math.abs(im) > 0.15) {
        out.push(im > 0 ? "depth bid" : "depth ask");
      }
    }
    return out.slice(0, 4);
  }, [snapshot]);

  const oiValues = snapshot?.open_interest_series.map((x) => x.oi) ?? [];
  const spreadValues = snapshot?.order_book_series.map((x) => x.spread) ?? [];
  const imbMapped =
    snapshot?.order_book_series
      .map((x) => (x.imbalance != null ? (x.imbalance + 1) / 2 : 0.5))
      .filter((x) => x >= 0 && x <= 1) ?? [];

  const tapeRatios = useMemo(
    () => (snapshot ? tapeBuyRatioBuckets(snapshot.ticks, 24, 24 * 60) : []),
    [snapshot],
  );

  const frNum = snapshot?.funding
    ? typeof snapshot.funding.funding_rate === "number"
      ? snapshot.funding.funding_rate
      : Number(snapshot.funding.funding_rate)
    : null;

  return (
    <div className="flex min-h-0 flex-col border-t border-zinc-800/90 bg-zinc-950/95">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800/80 px-2 py-1 sm:px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Live</span>
        <span
          className={
            "rounded-full px-2 py-0.5 text-[9px] font-medium " +
            (storeRunning ? "bg-emerald-500/15 text-emerald-400" : "bg-zinc-800 text-zinc-500")
          }
        >
          store {storeRunning ? "ON" : "OFF"}
          {storePid != null ? ` · ${storePid}` : ""}
        </span>
        {loading ? <span className="text-[9px] text-sky-400/90">sync…</span> : null}
        {hints.length ? (
          <span className="ml-auto truncate text-[9px] text-zinc-500">{hints.join(" · ")}</span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-1.5 sm:p-2">
        {error ? (
          <p className="shrink-0 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
            {error}
          </p>
        ) : null}
        {!snapshot && !error ? (
          <p className="shrink-0 text-[11px] text-zinc-500">À espera do primeiro snapshot…</p>
        ) : null}
        {snapshot?.errors?.length ? (
          <ul className="mb-0 shrink-0 list-inside list-disc text-[10px] text-amber-200/90">
            {snapshot.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        ) : null}

        <SignalBanner
          signal={signal ?? null}
          loading={Boolean(signalLoading)}
          err={signalError ?? null}
        />

        {snapshot ? (
          <>
          <div className="grid max-h-[min(32vh,280px)] min-h-0 shrink-0 grid-cols-1 gap-1.5 overflow-y-auto overscroll-contain md:grid-cols-2 xl:grid-cols-4 xl:gap-2">
            <PanelCard
              title="Tape"
              subtitle="Heat 24m + últimos trades"
              help={
                <>
                  <p>
                    Lista de <strong>negócios executados</strong> na exchange (últimos ticks
                    ingeridos). Não é o livro de ordens — são trades já fechados.
                  </p>
                  <p>
                    <span className="text-zinc-400">Hora</span> — tempo UTC (Z).{" "}
                    <span className="text-zinc-400">Preço</span> e{" "}
                    <span className="text-zinc-400">Qty</span> do print.{" "}
                    <span className="text-zinc-400">Lado</span> — quem foi agressor:{" "}
                    <span className="text-emerald-400">buy</span> = ordem de compra que bateu no ask;{" "}
                    <span className="text-rose-400">sell</span> = venda que bateu no bid.
                  </p>
                  <p>
                    O <strong>heat</strong> acima resume ~24 minutos (1 coluna ≈ 1 min): mais{" "}
                    <span className="text-emerald-400">verde</span> = nesse minuto houve mais volume
                    agressor de compra; mais <span className="text-rose-400">vermelho</span> = mais
                    agressor de venda.
                  </p>
                </>
              }
            >
              {tapeRatios.length ? (
                <div className="mb-1.5 flex h-5 gap-px rounded border border-zinc-800/80 bg-zinc-950 p-px">
                  {tapeRatios.map((r, i) => (
                    <div
                      key={i}
                      className="min-w-0 flex-1 rounded-[1px]"
                      style={{ backgroundColor: bucketHeatColor(r) }}
                    />
                  ))}
                </div>
              ) : null}
              <table className="w-full border-collapse font-mono text-[10px]">
                <tbody>
                  {snapshot.ticks.slice(0, 14).map((x) => (
                    <tr key={`${x.t}-${x.trade_id}`} className="border-b border-zinc-800/50">
                      <td className="py-0.5 pr-1 text-zinc-500">{fmtTime(x.t)}</td>
                      <td className="py-0.5 pr-1 text-zinc-200">{fmtNum(x.price)}</td>
                      <td className="py-0.5 pr-1 text-zinc-500">{fmtNum(x.amount)}</td>
                      <td
                        className={
                          String(x.side || "").toLowerCase().includes("buy")
                            ? "text-emerald-400"
                            : "text-rose-400"
                        }
                      >
                        {(x.side || "—").slice(0, 4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {snapshot.ticks.length === 0 ? (
                <p className="text-[10px] text-zinc-600">Sem ticks.</p>
              ) : null}
            </PanelCard>

            <PanelCard
              title="Funding · Mark"
              subtitle="Barra = funding (centro neutro)"
              help={
                <>
                  <p>
                    Dados de <strong>perpetual</strong>: o <strong>mark price</strong> é o preço de
                    marcação usado para PnL e liquidações (aproxima o índice / spot).
                  </p>
                  <p>
                    <strong>Funding rate</strong> — taxa trocada entre longs e shorts em cada
                    período. Tipicamente: <span className="text-rose-300">positivo</span> = longs
                    pagam shorts (muita compra alavancada);{" "}
                    <span className="text-emerald-300">negativo</span> = shorts pagam longs. O
                    marcador branco na barra gradiente mostra onde está o valor atual vs extremos da
                    escala fixa do gráfico.
                  </p>
                  <p>
                    <strong>Next</strong> — próximo pagamento de funding (UTC).{" "}
                    <strong>Spread série</strong> — heat do spread bid–ask agregado (snapshots do
                    livro): cores mostram o quão “largo” ou “apertado” esteve o spread na janela.
                  </p>
                </>
              }
            >
              <FundingMarkerBar rate={frNum != null && Number.isFinite(frNum) ? frNum : null} />
              <div className="mt-2 space-y-1 font-mono text-[11px] text-zinc-200">
                <div>mark {fmtNum(Number(snapshot.funding?.mark_price))}</div>
                <div className="text-zinc-500">
                  fund {snapshot.funding?.funding_rate != null ? String(snapshot.funding.funding_rate) : "—"}
                </div>
                {snapshot.funding?.next_funding_time ? (
                  <div className="text-[10px] text-zinc-600">
                    next {fmtTime(snapshot.funding.next_funding_time)}
                  </div>
                ) : null}
              </div>
              <div className="mt-2 text-[9px] uppercase text-zinc-600">Spread série</div>
              <NumericHeatRow values={spreadValues} />
            </PanelCard>

            <PanelCard
              title="Open interest"
              subtitle="Heat = nível na janela"
              help={
                <>
                  <p>
                    <strong>Open interest (OI)</strong> — total de contratos abertos num lado do
                    mercado (posições ainda não fechadas). Não diz direção (long/short isolado);
                    mede <em>quantidade de posição agregada</em>.
                  </p>
                  <p>
                    <strong>Subir OI</strong> com preço a subir costuma indicar entrada de novas
                    posições; <strong>descer OI</strong> com movimento de preço pode ser unwind
                    (fechos). Cruzar sempre com volume, funding e contexto do teu timeframe.
                  </p>
                  <p>
                    O <strong>heat</strong> colore a série ao longo do tempo: compara níveis
                    relativos na janela (mais quente = OI mais alto na escala local da amostra).
                  </p>
                </>
              }
            >
              <NumericHeatRow values={oiValues} />
              <table className="mt-2 w-full border-collapse font-mono text-[10px]">
                <tbody>
                  {snapshot.open_interest_series.slice(-8).map((r) => (
                    <tr key={r.t} className="border-b border-zinc-800/50">
                      <td className="py-0.5 text-zinc-500">{fmtTime(r.t)}</td>
                      <td className="py-0.5 text-right text-zinc-300">{fmtNum(r.oi)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PanelCard>

            <PanelCard
              title="Order book"
              subtitle="Heat = desequilíbrio ±1%"
              help={
                <>
                  <p>
                    Não é o livro nível a nível: são <strong>snapshots agregados</strong> —
                    melhor bid/ask, spread e profundidade numa banda de ~±1% em torno do mid (dados
                    gravados pelo store).
                  </p>
                  <p>
                    <span className="text-zinc-400">Bid / Ask</span> — topo do livro.{" "}
                    <span className="text-zinc-400">Spread</span> — ask − bid (liquidez e custo
                    implícito). Linhas mais recentes no topo da tabela.
                  </p>
                  <p>
                    O <strong>heat de desequilímbrio</strong> usa a métrica bid vs ask depth na
                    banda: mais <span className="text-emerald-400">verde</span> = relativamente
                    mais liquidez/compradores na banda; mais{" "}
                    <span className="text-rose-400">vermelho</span> = mais lado vendedor.
                  </p>
                </>
              }
            >
              <NumericHeatRow values={imbMapped.length ? imbMapped : [0.5, 0.5]} zeroOne />
              <table className="mt-2 w-full border-collapse font-mono text-[10px]">
                <tbody>
                  {[...snapshot.order_book_series].reverse().slice(0, 10).map((r) => (
                    <tr key={r.t} className="border-b border-zinc-800/50">
                      <td className="py-0.5 text-zinc-500">{fmtTime(r.t)}</td>
                      <td className="py-0.5 text-zinc-300">{fmtNum(r.best_bid)}</td>
                      <td className="py-0.5 text-zinc-300">{fmtNum(r.best_ask)}</td>
                      <td className="py-0.5 text-zinc-600">{fmtNum(r.spread)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PanelCard>
          </div>

          <div className="flex min-h-[12rem] min-w-0 flex-1 flex-col overflow-hidden border-t border-zinc-800/70 pt-2">
            <PanelCard
              className="min-h-0 flex-1"
              title="Liquidações"
              subtitle="Gráfico: setas + barras cor-de-rosa/vermelho; abaixo lista completa na janela"
              help={
                <>
                  <p>
                    <strong>Liquidações forçadas</strong> — posições fechadas pela exchange quando a
                    margem não cobre o risco. Não são ordens tuas; são eventos de mercado.
                  </p>
                  <p>
                    Em muitas UIs, <span className="text-rose-300">long liquidated</span> empurra
                    preço para baixo (venda forçada);{" "}
                    <span className="text-fuchsia-300">short liquidated</span> pode empurrar para
                    cima. O rótulo <span className="text-zinc-400">Side</span> depende do que a API
                    envia — cruza com o gráfico (setas L↓ / S↑ no candlestick).
                  </p>
                  <p>
                    <strong>Timeline</strong> — cada coluna ≈ 1 minuto; opacidade maior = mais
                    volume liquidado nesse minuto. <strong>Sz</strong> — tamanho em contratos (ou
                    unidade reportada pela exchange).
                  </p>
                </>
              }
            >
              <LiqTimeline rows={snapshot.liquidations} />
              <table className="mt-2 w-full border-collapse font-mono text-[11px] leading-snug">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    <th className="py-1 text-left font-medium">T</th>
                    <th className="py-1 text-left font-medium">Px</th>
                    <th className="py-1 text-left font-medium">Sz</th>
                    <th className="py-1 text-left font-medium">Side</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.liquidations.slice(0, 40).map((x, i) => (
                    <tr key={`${x.t}-${i}`} className="border-b border-zinc-800/50">
                      <td className="py-1 text-zinc-500">{fmtTime(x.t)}</td>
                      <td className="py-1 text-zinc-100">{x.price != null ? fmtNum(x.price) : "—"}</td>
                      <td className="py-1 text-zinc-400">
                        {x.contracts != null ? fmtNum(x.contracts) : "—"}
                      </td>
                      <td className="py-1 text-zinc-400">{x.side ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {snapshot.liquidations.length === 0 ? (
                <p className="text-[11px] text-zinc-600">Sem liquidações na janela.</p>
              ) : null}
            </PanelCard>
          </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
