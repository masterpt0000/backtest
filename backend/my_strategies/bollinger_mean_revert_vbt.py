"""
Reversão à média com Bollinger (20, 2): long quando o fecho cruza de cima para baixo a banda inferior;
sai ao cruzar de baixo para cima a média. Short espelhado na banda superior.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

INDICATOR_PARAM_NAMES: frozenset[str] = frozenset()

PERIOD = 20
MULT = 2.0


def get_strategy_parameters() -> dict:
    return {}


def compute_indicators(df: pd.DataFrame, params: dict) -> dict:
    del params
    c = df["Close"].astype(np.float64)
    ma = c.rolling(PERIOD, min_periods=PERIOD).mean()
    std = c.rolling(PERIOD, min_periods=PERIOD).std()
    upper = ma + MULT * std
    lower = ma - MULT * std
    return {
        "close": c.to_numpy(dtype=np.float64),
        "basis": ma.to_numpy(dtype=np.float64),
        "upper": upper.to_numpy(dtype=np.float64),
        "lower": lower.to_numpy(dtype=np.float64),
    }


def compute_signals_vectorized(
    ind: dict,
    thr_params_list: list[dict],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    cl = np.asarray(ind["close"], dtype=np.float64)
    mid = np.asarray(ind["basis"], dtype=np.float64)
    up = np.asarray(ind["upper"], dtype=np.float64)
    lo = np.asarray(ind["lower"], dtype=np.float64)
    n = len(cl)
    nc = max(1, len(thr_params_list))

    pc = np.empty(n, dtype=np.float64)
    pm = np.empty(n, dtype=np.float64)
    pu = np.empty(n, dtype=np.float64)
    pl = np.empty(n, dtype=np.float64)
    pc[0] = cl[0]
    pm[0] = mid[0]
    pu[0] = up[0]
    pl[0] = lo[0]
    if n > 1:
        pc[1:] = cl[:-1]
        pm[1:] = mid[:-1]
        pu[1:] = up[:-1]
        pl[1:] = lo[:-1]

    ok = (
        np.isfinite(cl)
        & np.isfinite(mid)
        & np.isfinite(up)
        & np.isfinite(lo)
        & np.isfinite(pc)
    )

    long_e = ok & (cl <= lo) & (pc > pl)
    long_x = ok & (cl >= mid) & (pc < pm)
    short_e = ok & (cl >= up) & (pc < pu)
    short_x = ok & (cl <= mid) & (pc > pm)

    le = np.broadcast_to(long_e[:, None], (n, nc)).copy()
    lx = np.broadcast_to(long_x[:, None], (n, nc)).copy()
    se = np.broadcast_to(short_e[:, None], (n, nc)).copy()
    sx = np.broadcast_to(short_x[:, None], (n, nc)).copy()

    sl_arr = np.full(nc, 0.06, dtype=np.float64)
    tp_arr = np.full(nc, 0.06, dtype=np.float64)

    return le, lx, se, sx, sl_arr, tp_arr
