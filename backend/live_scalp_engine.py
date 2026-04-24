"""
Scalping **multistream** (exemplo): combina OHLCV, tape, funding, OI, livro e liquidações.

Pontuação contínua (positiva = viés long, negativa = viés short). Só entra se |score| ≥ limiar.
TP/SL apertados vs ATR curto — típico de scalp de minutos.

Não é aconselhamento financeiro.
"""

from __future__ import annotations

import math
from typing import Any, Literal

import numpy as np

from live_signal_engine import _last_wilder_atr

Side = Literal["long", "short", "flat"]


def _ema_last(closes: np.ndarray, span: int) -> float:
    k = 2.0 / (span + 1)
    v = float(closes[0])
    for x in closes[1:]:
        v = k * float(x) + (1.0 - k) * v
    return v


def _tape_score(
    ticks: list[dict[str, Any]], now_sec: int, window_sec: int
) -> tuple[float, str]:
    buy_v = 0.0
    sell_v = 0.0
    for t in ticks:
        try:
            ts = int(t["t"])
        except (KeyError, TypeError, ValueError):
            continue
        if now_sec - ts > window_sec:
            continue
        try:
            amt = float(t.get("amount") or 0.0)
        except (TypeError, ValueError):
            amt = 0.0
        s = str(t.get("side") or "").lower()
        if "buy" in s:
            buy_v += amt
        elif "sell" in s:
            sell_v += amt
        else:
            buy_v += amt * 0.5
            sell_v += amt * 0.5
    tot = buy_v + sell_v
    if tot < 1e-12:
        return 0.0, "tape: sem volume na janela"
    r = (buy_v - sell_v) / tot
    sc = max(-1.6, min(1.6, r * 1.85))
    return sc, f"tape {window_sec}s Δvol {r:+.2f}"


def _book_score(book_rows: list[dict[str, Any]]) -> tuple[float, str, float | None]:
    if not book_rows:
        return 0.0, "livro: —", None
    last = book_rows[-1]
    raw_im = last.get("imbalance")
    if raw_im is None:
        return 0.0, "livro: imb n/d", None
    try:
        imb = float(raw_im)
    except (TypeError, ValueError):
        return 0.0, "livro: imb inv.", None
    sc = max(-1.55, min(1.55, imb * 2.25))
    return sc, f"imb {imb:+.2f}", imb


def _book_trend_score(book_rows: list[dict[str, Any]]) -> tuple[float, str]:
    if len(book_rows) < 3:
        return 0.0, ""
    imbs: list[float] = []
    for r in book_rows[-4:]:
        x = r.get("imbalance")
        if x is None:
            continue
        try:
            imbs.append(float(x))
        except (TypeError, ValueError):
            continue
    if len(imbs) < 3:
        return 0.0, ""
    a, b, c = imbs[-3], imbs[-2], imbs[-1]
    if a < b < c:
        return 0.42, "livro imb ↗"
    if a > b > c:
        return -0.42, "livro imb ↘"
    return 0.0, ""


def _candle_score(bars: list[dict[str, Any]]) -> tuple[float, str]:
    if len(bars) < 24:
        return 0.0, "velas: poucas para EMA"
    c = np.array([float(b["c"]) for b in bars], dtype=np.float64)
    e5 = _ema_last(c, 5)
    e13 = _ema_last(c, 13)
    lc = float(c[-1])
    lo = float(bars[-1]["o"])
    if lc > e5 > e13:
        s = 1.35
        d = "close>EMA5>EMA13"
    elif lc < e5 < e13:
        s = -1.35
        d = "close<EMA5<EMA13"
    elif lc > e5:
        s = 0.55
        d = "close>EMA5"
    elif lc < e5:
        s = -0.55
        d = "close<EMA5"
    else:
        s = 0.0
        d = "EMA neutro"
    body = abs(lc - lo)
    rng = float(bars[-1]["h"]) - float(bars[-1]["l"])
    if rng > 1e-12 and body / rng < 0.22:
        s *= 0.65
        d += "; doji-like"
    return s, d


def _funding_score(funding: dict[str, Any] | None) -> tuple[float, str]:
    if not funding:
        return 0.0, "funding: —"
    fr = funding.get("funding_rate")
    if fr is None:
        return 0.0, "funding: n/d"
    try:
        f = float(fr)
    except (TypeError, ValueError):
        return 0.0, "funding: n/d"
    if not math.isfinite(f) or abs(f) < 1e-8:
        return 0.0, f"fund ~0 ({f:.6f})"
    # Longs pagam (f>0) → mercado crowded long → ligeiro viés contrarian short
    adj = -math.copysign(min(abs(f) / 2.8e-4, 1.0), f) * 0.85
    return float(adj), f"fund {f:.5f} (contrarian)"


def _oi_score(
    oi_series: list[dict[str, Any]], bars: list[dict[str, Any]]
) -> tuple[float, str]:
    if len(oi_series) < 4 or not bars:
        return 0.0, "OI: série curta"
    try:
        o0 = float(oi_series[-4]["oi"])
        o1 = float(oi_series[-1]["oi"])
    except (KeyError, TypeError, ValueError):
        return 0.0, "OI: inv."
    if o0 < 1e-12:
        return 0.0, "OI: —"
    pct = (o1 - o0) / o0
    lc = float(bars[-1]["c"])
    lo = float(bars[-1]["o"])
    bull_bar = lc >= lo
    if pct > 0.0008:
        sc = 0.95 if bull_bar else -0.95
        return sc, f"ΔOI +{pct*100:.2f}% + vela {'↑' if bull_bar else '↓'}"
    if pct < -0.0008:
        sc = -0.45 if bull_bar else 0.45
        return sc, f"ΔOI {pct*100:.2f}% (unwind)"
    return 0.0, f"ΔOI {pct*100:.2f}% (flat)"


def _liq_score(
    liqs: list[dict[str, Any]], now_sec: int, window_sec: int
) -> tuple[float, str]:
    long_liq = 0.0
    short_liq = 0.0
    for x in liqs:
        try:
            ts = int(x["t"])
        except (KeyError, TypeError, ValueError):
            continue
        if now_sec - ts > window_sec:
            continue
        try:
            c = float(x.get("contracts") or 0.0) or 0.0
        except (TypeError, ValueError):
            c = 0.0
        s = str(x.get("side") or "").lower()
        if "sell" in s:
            long_liq += c
        elif "buy" in s:
            short_liq += c
        else:
            long_liq += c * 0.5
            short_liq += c * 0.5
    tot = long_liq + short_liq
    if tot < 1e-9:
        return 0.0, f"liqs: nada em {window_sec}s"
    r = (long_liq - short_liq) / tot
    sc = max(-1.25, min(1.25, r * 1.15))
    return sc, f"liqs L/S vol {long_liq:.4f}/{short_liq:.4f}"


def evaluate_scalp_signal(
    bars: list[dict[str, Any]],
    ticks: list[dict[str, Any]],
    funding: dict[str, Any] | None,
    oi_series: list[dict[str, Any]],
    book_rows: list[dict[str, Any]],
    liquidations: list[dict[str, Any]],
    now_sec: int,
    *,
    atr_period: int = 7,
    min_abs_score: float = 2.35,
    sl_atr: float = 0.68,
    tp_atr: float = 1.05,
    tape_window_sec: int = 72,
    liq_window_sec: int = 160,
) -> dict[str, Any]:
    min_bars = max(atr_period, 13) + 20
    if len(bars) < min_bars:
        return {
            "ok": False,
            "error": f"Poucas velas ({len(bars)}); mínimo ~{min_bars} para scalp.",
        }

    h = np.array([float(b["h"]) for b in bars], dtype=np.float64)
    l = np.array([float(b["l"]) for b in bars], dtype=np.float64)
    c = np.array([float(b["c"]) for b in bars], dtype=np.float64)
    atr_v = _last_wilder_atr(h, l, c, atr_period)
    if atr_v is None or atr_v <= 0:
        return {"ok": False, "error": "ATR inválido."}

    st_tape, d_tape = _tape_score(ticks, now_sec, tape_window_sec)
    st_book, d_book, last_imb = _book_score(book_rows)
    st_btrend, d_btrend = _book_trend_score(book_rows)
    st_candle, d_candle = _candle_score(bars)
    st_fund, d_fund = _funding_score(funding)
    st_oi, d_oi = _oi_score(oi_series, bars)
    st_liq, d_liq = _liq_score(liquidations, now_sec, liq_window_sec)

    net = (
        st_tape
        + st_book
        + st_btrend
        + st_candle
        + st_fund
        + st_oi
        + st_liq
    )

    side: Side = "flat"
    if net >= min_abs_score:
        side = "long"
    elif net <= -min_abs_score:
        side = "short"

    last_t = int(bars[-1]["t"])
    entry = float(c[-1])

    fr = None
    if funding and funding.get("funding_rate") is not None:
        try:
            fr = float(funding["funding_rate"])
        except (TypeError, ValueError):
            fr = None

    features = {
        "net_score": round(net, 3),
        "threshold": min_abs_score,
        "tape": {"score": round(st_tape, 3), "detail": d_tape},
        "book": {"score": round(st_book, 3), "detail": d_book, "imbalance": last_imb},
        "book_trend": {"score": round(st_btrend, 3), "detail": d_btrend or "—"},
        "candles": {"score": round(st_candle, 3), "detail": d_candle},
        "funding": {"score": round(st_fund, 3), "detail": d_fund, "rate": fr},
        "open_interest": {"score": round(st_oi, 3), "detail": d_oi},
        "liquidations": {"score": round(st_liq, 3), "detail": d_liq},
    }

    parts = [
        f"tape {st_tape:+.2f}",
        f"livro {st_book:+.2f}" + (f" ({d_btrend})" if d_btrend else ""),
        f"velas {st_candle:+.2f}",
        f"funding {st_fund:+.2f}",
        f"OI {st_oi:+.2f}",
        f"liqs {st_liq:+.2f}",
    ]
    summary = "; ".join(parts)

    if side == "flat":
        reason = (
            f"Sem scalp: score líquido {net:+.2f} (limiar ±{min_abs_score}). "
            f"Mix: {summary}"
        )
        stop_loss = None
        take_profit = None
        entry_out = None
    else:
        dir_lbl = "Long" if side == "long" else "Short"
        reason = f"Scalp {dir_lbl}: score {net:+.2f}. {summary}"
        entry_out = entry
        if side == "long":
            stop_loss = entry - sl_atr * atr_v
            take_profit = entry + tp_atr * atr_v
        else:
            stop_loss = entry + sl_atr * atr_v
            take_profit = entry - tp_atr * atr_v

    return {
        "ok": True,
        "side": side,
        "reason": reason,
        "last_bar_t": last_t,
        "entry_price": entry_out,
        "stop_loss": stop_loss,
        "take_profit": take_profit,
        "atr": round(atr_v, 8),
        "book_imbalance": last_imb,
        "features": features,
        "params": {
            "atr_period": atr_period,
            "min_abs_score": min_abs_score,
            "sl_atr": sl_atr,
            "tp_atr": tp_atr,
            "tape_window_sec": tape_window_sec,
            "liq_window_sec": liq_window_sec,
        },
    }
