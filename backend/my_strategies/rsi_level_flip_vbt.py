"""
RSI Wilder (14): long quando o RSI cruza para baixo de 30 (sobre-venda);
sai long ao cruzar para cima de 55. Short simétrico (cruza acima de 70, sai ao cruzar abaixo de 45).
Limites fixos para testes rápidos.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

INDICATOR_PARAM_NAMES: frozenset[str] = frozenset()

RSI_LEN = 14
LONG_ENTRY = 30.0
LONG_EXIT = 55.0
SHORT_ENTRY = 70.0
SHORT_EXIT = 45.0


def get_strategy_parameters() -> dict:
    return {}


def _rsi(close: np.ndarray, length: int) -> np.ndarray:
    s = pd.Series(close, dtype=np.float64)
    d = s.diff()
    up = d.clip(lower=0.0)
    down = -d.clip(upper=0.0)
    roll_up = up.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    roll_down = down.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    rs = roll_up / roll_down.replace(0, np.nan)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    return rsi.to_numpy()


def compute_indicators(df: pd.DataFrame, params: dict) -> dict:
    del params
    c = df["Close"].to_numpy(dtype=np.float64)
    return {"close": c, "rsi": _rsi(c, RSI_LEN)}


def compute_signals_vectorized(
    ind: dict,
    thr_params_list: list[dict],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rsi = np.asarray(ind["rsi"], dtype=np.float64)
    n = len(rsi)
    nc = max(1, len(thr_params_list))

    prev = np.empty(n, dtype=np.float64)
    prev[0] = rsi[0]
    if n > 1:
        prev[1:] = rsi[:-1]

    ok = np.isfinite(rsi) & np.isfinite(prev)
    long_e = ok & (rsi < LONG_ENTRY) & (prev >= LONG_ENTRY)
    long_x = ok & (rsi > LONG_EXIT) & (prev <= LONG_EXIT)
    short_e = ok & (rsi > SHORT_ENTRY) & (prev <= SHORT_ENTRY)
    short_x = ok & (rsi < SHORT_EXIT) & (prev >= SHORT_EXIT)

    le = np.broadcast_to(long_e[:, None], (n, nc)).copy()
    lx = np.broadcast_to(long_x[:, None], (n, nc)).copy()
    se = np.broadcast_to(short_e[:, None], (n, nc)).copy()
    sx = np.broadcast_to(short_x[:, None], (n, nc)).copy()

    sl_arr = np.full(nc, 0.10, dtype=np.float64)
    tp_arr = np.full(nc, 0.10, dtype=np.float64)

    return le, lx, se, sx, sl_arr, tp_arr
