"""
Sinal live **demonstrativo**: RSI + ATR + filtro opcional de desequilíbrio do livro.

Não é recomendação de investimento — apenas exemplo de como combinar OHLCV com microestrutura.
"""

from __future__ import annotations

from typing import Any, Literal

import numpy as np

Side = Literal["long", "short", "flat"]


def _last_wilder_rsi(closes: np.ndarray, period: int) -> float | None:
    n = int(closes.shape[0])
    if n < period + 1:
        return None
    deltas = np.diff(closes)
    gains = np.clip(deltas, 0, None)
    losses = np.clip(-deltas, 0, None)
    avg_g = float(gains[:period].mean())
    avg_l = float(losses[:period].mean())
    for i in range(period, len(deltas)):
        avg_g = (avg_g * (period - 1) + float(gains[i])) / period
        avg_l = (avg_l * (period - 1) + float(losses[i])) / period
    if avg_l < 1e-12:
        return 100.0 if avg_g > 0 else 50.0
    rs = avg_g / avg_l
    return float(100.0 - (100.0 / (1.0 + rs)))


def _last_wilder_atr(
    high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int
) -> float | None:
    n = int(close.shape[0])
    if n < period + 1:
        return None
    tr = np.zeros(n, dtype=np.float64)
    tr[0] = float(high[0] - low[0])
    for i in range(1, n):
        tr[i] = max(
            float(high[i] - low[i]),
            abs(float(high[i] - close[i - 1])),
            abs(float(low[i] - close[i - 1])),
        )
    atr = float(tr[:period].mean())
    for i in range(period, n):
        atr = (atr * (period - 1) + tr[i]) / period
    return atr


def evaluate_demo_signal(
    bars: list[dict[str, Any]],
    book_imbalance: float | None,
    *,
    rsi_period: int = 14,
    atr_period: int = 14,
    rsi_oversold: float = 35.0,
    rsi_overbought: float = 65.0,
    book_thresh: float = 0.05,
    sl_atr: float = 1.5,
    tp_atr: float = 2.5,
    use_book_filter: bool = True,
) -> dict[str, Any]:
    """
    ``bars``: objetos com ``t,o,h,l,c,v`` (floats).
    """
    min_len = max(rsi_period, atr_period) + 25
    if len(bars) < min_len:
        return {
            "ok": False,
            "error": f"Poucas velas ({len(bars)}); mínimo sugerido {min_len} para RSI/ATR estáveis.",
        }

    o = np.array([float(b["o"]) for b in bars], dtype=np.float64)
    h = np.array([float(b["h"]) for b in bars], dtype=np.float64)
    l = np.array([float(b["l"]) for b in bars], dtype=np.float64)
    c = np.array([float(b["c"]) for b in bars], dtype=np.float64)

    rsi_v = _last_wilder_rsi(c, rsi_period)
    atr_v = _last_wilder_atr(h, l, c, atr_period)
    if rsi_v is None or atr_v is None or atr_v <= 0:
        return {"ok": False, "error": "Não foi possível calcular RSI ou ATR."}

    last_t = int(bars[-1]["t"])
    entry = float(c[-1])

    raw: Side | None = None
    if rsi_v <= rsi_oversold:
        raw = "long"
    elif rsi_v >= rsi_overbought:
        raw = "short"

    side: Side = "flat"
    reason = ""

    if raw is None:
        reason = (
            f"RSI neutro ({rsi_v:.1f} na zona {rsi_oversold:.0f}–{rsi_overbought:.0f}) — "
            "sem setup de reversão demo."
        )
    else:
        book_ok = True
        if use_book_filter and book_imbalance is not None:
            if raw == "long":
                book_ok = book_imbalance > book_thresh
                if not book_ok:
                    reason = (
                        f"RSI oversold ({rsi_v:.1f}) mas desequilíbrio do livro "
                        f"({book_imbalance:+.2f}) não confirma compra (>{book_thresh})."
                    )
            else:
                book_ok = book_imbalance < -book_thresh
                if not book_ok:
                    reason = (
                        f"RSI overbought ({rsi_v:.1f}) mas desequilíbrio do livro "
                        f"({book_imbalance:+.2f}) não confirma venda (<−{book_thresh})."
                    )

        if raw is not None and book_ok:
            side = raw
            if side == "long":
                reason = f"RSI oversold ({rsi_v:.1f})"
                if book_imbalance is not None:
                    reason += f" e livro a favor (imb {book_imbalance:+.2f})."
                else:
                    reason += "."
                    if use_book_filter:
                        reason += " Livro indisponível — filtro ignorado."
            else:
                reason = f"RSI overbought ({rsi_v:.1f})"
                if book_imbalance is not None:
                    reason += f" e livro a favor (imb {book_imbalance:+.2f})."
                else:
                    reason += "."
                    if use_book_filter:
                        reason += " Livro indisponível — filtro ignorado."
        elif raw is not None and not book_ok:
            side = "flat"

    stop_loss: float | None = None
    take_profit: float | None = None
    if side == "long":
        stop_loss = entry - sl_atr * atr_v
        take_profit = entry + tp_atr * atr_v
    elif side == "short":
        stop_loss = entry + sl_atr * atr_v
        take_profit = entry - tp_atr * atr_v

    return {
        "ok": True,
        "side": side,
        "reason": reason,
        "last_bar_t": last_t,
        "entry_price": entry if side != "flat" else None,
        "stop_loss": stop_loss,
        "take_profit": take_profit,
        "rsi": round(rsi_v, 2),
        "atr": round(atr_v, 8),
        "book_imbalance": book_imbalance,
        "book_filter_applied": bool(use_book_filter),
        "params": {
            "rsi_period": rsi_period,
            "atr_period": atr_period,
            "rsi_oversold": rsi_oversold,
            "rsi_overbought": rsi_overbought,
            "book_thresh": book_thresh,
            "sl_atr": sl_atr,
            "tp_atr": tp_atr,
        },
    }
