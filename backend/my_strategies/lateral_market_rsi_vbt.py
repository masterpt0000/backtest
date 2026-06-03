"""
lateral_market_rsi_vbt — versão leve para testes: só RSI (Wilder) no fecho.
Entradas por *cruzamento*: RSI entra em sobre-venda / sobre-compra. Saídas ao cruzar 50.

O backtest e a simulação no gráfico usam sempre ``compute_signals_vectorized``;
se só alterares ``compute_signals`` (1D), o UI não muda.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import vectorbt as vbt

try:
    vbt.settings.caching["enabled"] = True
except Exception:
    pass

STRATEGY_META = {
    "id": "lateral_rsi_scalp",
    "chart_label": "Lateral Market RSI",
    "kind": "scalp",
    "timeframe": "3m",
    "symbols": ["WLD/USDC:USDC"],
    "leverage": 5,
    "margin_wallet_share": 0.80,
}

# Só o período do RSI vai para a grelha de indicadores (``ind_list``).
INDICATOR_PARAM_NAMES: frozenset[str] = frozenset({"rsi_close_length"})


def get_strategy_parameters():
    return {
        "rsi_close_length": (9, 5, 21, 2, False, True),
        "rsi_over_sold": (25, 15, 40, 2, False, True),
        "rsi_over_bought": (75, 60, 85, 2, False, True),
        "tp_pct": (0.03, 0.01, 0.07, 0.01, True, False),
        "sl_pct": (0.03, 0.01, 0.07, 0.01, True, True),
    }


def _param_default(params: dict, key: str) -> int | float:
    t = params[key]
    if not isinstance(t, tuple) or len(t) < 1:
        raise KeyError(key)
    v = t[0]
    if isinstance(v, bool):
        return int(v)
    return v


def get_chart_strategy_for_ui() -> dict:
    p = get_strategy_parameters()
    meta = STRATEGY_META
    sid = str(meta["id"])
    label = str(meta.get("chart_label") or meta.get("name") or "Estratégia")
    rsi_len = int(_param_default(p, "rsi_close_length"))
    return {
        "id": sid,
        "label": label,
        "indicators": [
            {
                "id": "rsi_close",
                "label": f"RSI close ({rsi_len})",
                "group": "studies",
                "kind": "rsi",
                "params": {"period": rsi_len},
            },
        ],
        "vbt_strategy": "lateral_market_rsi",
    }


def _rsi(series: pd.Series, length: int) -> np.ndarray:
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = (-delta).where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = (100 - (100 / (1 + rs))).to_numpy(dtype=np.float64)
    ag = avg_gain.to_numpy(dtype=np.float64)
    al = avg_loss.to_numpy(dtype=np.float64)
    rsi = np.where(al == 0, 100.0, rsi)
    rsi = np.where(ag == 0, 0.0, rsi)
    return rsi


def compute_indicators(df: pd.DataFrame, params: dict) -> dict | None:
    """Só fecho + RSI — evita ATR/envelope/VWAP/OBV (custava muito em milhares de velas)."""
    try:
        close = df["Close"].astype(np.float64)
        length = int(params["rsi_close_length"])
        rsi = _rsi(close, length)
        return {
            "close": close.to_numpy(dtype=np.float64),
            "rsi": np.asarray(rsi, dtype=np.float64),
        }
    except Exception as e:
        print(f"  ⚠️ lateral_market_rsi compute_indicators: {e}")
        return None


def compute_signals(
    ind: dict,
    params: dict,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    ri = np.nan_to_num(np.asarray(ind["rsi"], dtype=np.float64), nan=50.0)
    n = len(ri)
    prev = np.empty(n, dtype=np.float64)
    prev[0] = ri[0]
    if n > 1:
        prev[1:] = ri[:-1]

    os_ = float(params["rsi_over_sold"])
    ob_ = float(params["rsi_over_bought"])
    ok = np.isfinite(ri) & np.isfinite(prev)

    long_e = ok & (ri < os_) & (prev >= os_)
    short_e = ok & (ri > ob_) & (prev <= ob_)
    exit_long = ok & (ri > 50.0) & (prev <= 50.0)
    exit_short = ok & (ri < 50.0) & (prev >= 50.0)

    return long_e, exit_long, short_e, exit_short


def compute_signals_vectorized(
    ind: dict,
    thr_params_list: list[dict],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    nc = len(thr_params_list)
    ri = np.asarray(ind["rsi"], dtype=np.float64)
    n = len(ri)
    ri = np.nan_to_num(ri, nan=50.0)

    prev = np.empty(n, dtype=np.float64)
    prev[0] = ri[0]
    if n > 1:
        prev[1:] = ri[:-1]

    rsi_os = np.array([float(t["rsi_over_sold"]) for t in thr_params_list])
    rsi_ob = np.array([float(t["rsi_over_bought"]) for t in thr_params_list])
    sl_arr = np.array([float(t["sl_pct"]) for t in thr_params_list])
    tp_arr = np.array([float(t["tp_pct"]) for t in thr_params_list])

    ok = np.isfinite(ri) & np.isfinite(prev)

    long_e = ok[:, None] & (ri[:, None] < rsi_os[None, :]) & (prev[:, None] >= rsi_os[None, :])
    short_e = ok[:, None] & (ri[:, None] > rsi_ob[None, :]) & (prev[:, None] <= rsi_ob[None, :])

    exit_long = ok[:, None] & (ri[:, None] > 50.0) & (prev[:, None] <= 50.0)
    exit_short = ok[:, None] & (ri[:, None] < 50.0) & (prev[:, None] >= 50.0)

    return long_e, exit_long, short_e, exit_short, sl_arr, tp_arr
