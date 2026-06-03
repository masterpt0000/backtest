"""
Score composto de tendência: vários presets normalizados (z-score rolling + tanh)
e pesos em percentagem que somam ~100%.
"""

from __future__ import annotations

from typing import Any, Literal

import numpy as np
import pandas as pd

TrendPreset = Literal["price_vs_sma_atr", "rsi_zscore", "macd_hist_zscore", "plus_di_minus_di"]


def _ema(x: np.ndarray, span: int) -> np.ndarray:
    if x.size == 0:
        return x
    s = pd.Series(np.asarray(x, dtype=np.float64), dtype=np.float64)
    return s.ewm(span=int(span), adjust=False).mean().to_numpy(dtype=np.float64)


def _wilder_rma(x: np.ndarray, length: int) -> np.ndarray:
    n = x.size
    out = np.full(n, np.nan, dtype=np.float64)
    if n == 0 or length < 1:
        return out
    if n < length:
        return out
    window = x[:length]
    out[length - 1] = float(np.nanmean(window))
    alpha = 1.0 / float(length)
    for i in range(length, n):
        out[i] = out[i - 1] + alpha * (x[i] - out[i - 1])
    return out


def _true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    n = int(high.size)
    tr = np.full(n, np.nan, dtype=np.float64)
    if n == 0:
        return tr
    tr[0] = high[0] - low[0]
    for i in range(1, n):
        a = high[i] - low[i]
        b = abs(high[i] - close[i - 1])
        c = abs(low[i] - close[i - 1])
        tr[i] = max(a, b, c)
    return tr


def _sma(x: np.ndarray, length: int) -> np.ndarray:
    if x.size == 0 or length < 1:
        return np.full_like(x, np.nan, dtype=np.float64)
    s = pd.Series(np.asarray(x, dtype=np.float64), dtype=np.float64)
    return s.rolling(window=length, min_periods=length).mean().to_numpy(dtype=np.float64)


def _rsi(close: np.ndarray, length: int) -> np.ndarray:
    if close.size == 0 or length < 2:
        return np.full_like(close, np.nan, dtype=np.float64)
    diff = np.diff(close, prepend=np.nan)
    gains = np.where(diff > 0, diff, 0.0)
    losses = np.where(diff < 0, -diff, 0.0)
    avg_gain = _wilder_rma(gains[1:], length)
    avg_loss = _wilder_rma(losses[1:], length)
    out = np.full(close.size, np.nan, dtype=np.float64)
    for i in range(1, close.size):
        gi = avg_gain[i - 1] if i - 1 < avg_gain.size else np.nan
        li = avg_loss[i - 1] if i - 1 < avg_loss.size else np.nan
        if not np.isfinite(gi) or not np.isfinite(li):
            continue
        if li <= 1e-14:
            out[i] = 100.0 if gi > 1e-14 else 50.0
        else:
            rs = gi / li
            out[i] = 100.0 - (100.0 / (1.0 + rs))
    return out


def _rolling_zscore_then_tanh(x: np.ndarray, window: int, clip: float) -> np.ndarray:
    w = max(5, int(window))
    c = max(0.25, float(clip))
    s = pd.Series(np.asarray(x, dtype=np.float64), dtype=np.float64)
    m = s.rolling(window=w, min_periods=w).mean()
    sd = s.rolling(window=w, min_periods=w).std(ddof=0)
    z = ((s - m) / sd.replace(0.0, np.nan)).to_numpy(dtype=np.float64)
    return np.tanh(z / c)


def _preset_raw_series(
    o: np.ndarray,
    h: np.ndarray,
    l: np.ndarray,
    c: np.ndarray,
    preset: TrendPreset,
    params: dict[str, float | int],
) -> np.ndarray:
    p = params or {}
    n = c.size
    out = np.full(n, np.nan, dtype=np.float64)

    if preset == "price_vs_sma_atr":
        sma_p = int(float(p.get("sma_period", p.get("smaPeriod", 50))))
        sma_p = max(2, min(500, sma_p))
        atr_p = int(float(p.get("atr_period", p.get("atrPeriod", 14))))
        atr_p = max(1, min(500, atr_p))
        sma = _sma(c, sma_p)
        tr = _true_range(h, l, c)
        atr = _wilder_rma(tr, atr_p)
        denom = np.where(np.isfinite(atr) & (atr > 1e-15), atr, np.nan)
        out = (c - sma) / denom
        return out

    if preset == "rsi_zscore":
        rlen = int(float(p.get("rsi_period", p.get("rsiPeriod", 14))))
        rlen = max(2, min(500, rlen))
        return _rsi(c, rlen)

    if preset == "macd_hist_zscore":
        fast = int(float(p.get("fast", 12)))
        slow = int(float(p.get("slow", 26)))
        sig = int(float(p.get("signal", 9)))
        fast = max(1, min(200, fast))
        slow = max(1, min(500, slow))
        sig = max(1, min(200, sig))
        fe = _ema(c, fast)
        se = _ema(c, slow)
        macd = fe - se
        sigl = _ema(macd, sig)
        return macd - sigl

    if preset == "plus_di_minus_di":
        period = int(float(p.get("period", p.get("adx_period", 14))))
        period = max(2, min(500, period))
        try:
            import talib  # type: ignore[import-not-found]

            pdi = talib.PLUS_DI(
                h.astype(float),
                l.astype(float),
                c.astype(float),
                timeperiod=period,
            )
            mdi = talib.MINUS_DI(
                h.astype(float),
                l.astype(float),
                c.astype(float),
                timeperiod=period,
            )
            out = (np.asarray(pdi, dtype=np.float64) - np.asarray(mdi, dtype=np.float64)) / 100.0
            return out
        except Exception:
            pass
        # Fallback aproximado (Wilder) se TA-Lib indisponível
        plus_dm = np.zeros(n, dtype=np.float64)
        minus_dm = np.zeros(n, dtype=np.float64)
        for i in range(1, n):
            up_move = h[i] - h[i - 1]
            down_move = l[i - 1] - l[i]
            if up_move > down_move and up_move > 0:
                plus_dm[i] = up_move
            if down_move > up_move and down_move > 0:
                minus_dm[i] = down_move
        tr = _true_range(h, l, c)
        tr_s = _wilder_rma(tr, period)
        pdm_s = _wilder_rma(plus_dm, period)
        mdm_s = _wilder_rma(minus_dm, period)
        with np.errstate(divide="ignore", invalid="ignore"):
            pdi = np.where(tr_s > 1e-15, 100.0 * pdm_s / tr_s, np.nan)
            mdi = np.where(tr_s > 1e-15, 100.0 * mdm_s / tr_s, np.nan)
        return (pdi - mdi) / 100.0

    return out


def compute_trend_composite_score(
    df: pd.DataFrame,
    *,
    components: list[dict[str, Any]],
    norm_window: int,
    clip: float,
    output_scale: float,
) -> np.ndarray:
    """
    ``df`` com colunas ``open, high, low, close`` (minúsculas) ou ``Open, High, Low, Close``.
    """
    cols = {c.lower(): c for c in df.columns}

    def col(name: str) -> pd.Series:
        k = cols.get(name)
        if k is None:
            raise ValueError(f"trend_composite: falta coluna {name}")
        return df[k]

    o = col("open").to_numpy(dtype=np.float64)
    h = col("high").to_numpy(dtype=np.float64)
    l = col("low").to_numpy(dtype=np.float64)
    c = col("close").to_numpy(dtype=np.float64)
    n = c.size
    if n == 0:
        return np.array([], dtype=np.float64)

    weights = [float(x.get("weight") or 0) for x in components]
    wsum = float(np.sum(weights))
    if wsum <= 0:
        raise ValueError("trend_composite: soma de pesos deve ser > 0")
    wnorm = np.asarray([w / wsum for w in weights], dtype=np.float64)

    acc = np.zeros(n, dtype=np.float64)
    any_ok = np.zeros(n, dtype=bool)

    for i, comp in enumerate(components):
        preset = comp.get("preset")
        if preset not in (
            "price_vs_sma_atr",
            "rsi_zscore",
            "macd_hist_zscore",
            "plus_di_minus_di",
        ):
            raise ValueError(f"trend_composite: preset inválido: {preset!r}")
        praw = _preset_raw_series(o, h, l, c, preset, dict(comp.get("params") or {}))
        sub = _rolling_zscore_then_tanh(praw, int(norm_window), float(clip))
        m = np.isfinite(sub)
        acc[m] += wnorm[i] * sub[m]
        any_ok |= m

    scale = float(output_scale)
    out = np.full(n, np.nan, dtype=np.float64)
    out[any_ok] = acc[any_ok] * scale
    return out


def components_from_pydantic(models: list[Any]) -> list[dict[str, Any]]:
    """Converte modelos Pydantic ``TaTrendComponent`` em dicts."""
    out: list[dict[str, Any]] = []
    for m in models:
        if hasattr(m, "model_dump"):
            d = m.model_dump(mode="python")
        else:
            d = dict(m)
        out.append(
            {
                "cid": str(d.get("cid") or ""),
                "weight": float(d.get("weight", 0)),
                "preset": d.get("preset"),
                "params": {str(k): v for k, v in (d.get("params") or {}).items()},
            }
        )
    return out
