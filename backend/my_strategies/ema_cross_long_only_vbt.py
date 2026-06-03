"""
Cruzamento EMA rápida / lenta — só long: entra quando a rápida cruza para cima da lenta;
sai quando cruza para baixo. Períodos fixos 9 e 21 (teste de pipeline).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

INDICATOR_PARAM_NAMES: frozenset[str] = frozenset()

FAST = 9
SLOW = 21


def get_strategy_parameters() -> dict:
    return {}


def _ema(close: np.ndarray, span: int) -> np.ndarray:
    s = pd.Series(close, dtype=np.float64)
    return s.ewm(span=int(span), min_periods=int(span), adjust=False).mean().to_numpy()


def compute_indicators(df: pd.DataFrame, params: dict) -> dict:
    del params
    c = df["Close"].to_numpy(dtype=np.float64)
    ef = _ema(c, FAST)
    es = _ema(c, SLOW)
    return {"close": c, "ema_fast": ef, "ema_slow": es}


def compute_signals_vectorized(
    ind: dict,
    thr_params_list: list[dict],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    ef = np.asarray(ind["ema_fast"], dtype=np.float64)
    es = np.asarray(ind["ema_slow"], dtype=np.float64)
    n = len(ef)
    nc = max(1, len(thr_params_list))

    prev_f = np.empty(n, dtype=np.float64)
    prev_s = np.empty(n, dtype=np.float64)
    prev_f[0] = ef[0]
    prev_s[0] = es[0]
    if n > 1:
        prev_f[1:] = ef[:-1]
        prev_s[1:] = es[:-1]

    ok = np.isfinite(ef) & np.isfinite(es) & np.isfinite(prev_f) & np.isfinite(prev_s)
    long_e = ok & (ef > es) & (prev_f <= prev_s)
    long_x = ok & (ef < es) & (prev_f >= prev_s)

    le = np.broadcast_to(long_e[:, None], (n, nc)).copy()
    lx = np.broadcast_to(long_x[:, None], (n, nc)).copy()
    se = np.zeros((n, nc), dtype=bool)
    sx = np.zeros((n, nc), dtype=bool)

    sl_arr = np.full(nc, 0.08, dtype=np.float64)
    tp_arr = np.full(nc, 0.15, dtype=np.float64)

    return le, lx, se, sx, sl_arr, tp_arr
