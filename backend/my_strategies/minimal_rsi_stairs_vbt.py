"""
Estratégia mínima para testar o pipeline (chart + backtest + overlay).

Regras (RSI Wilder, período 14 no preço de fecho):
  • **Long** na barra em que o RSI *cruza* para ≤ 30 (vindo de cima de 30).
  • **Short** na barra em que o RSI *cruza* para ≥ 70 (vindo de baixo de 70).
  • **Sair long** na barra em que o RSI *cruza* para ≥ 50 (a partir de abaixo de 50) — "vender" ao 50.
  • **Sair short** na barra em que o RSI *cruza* para ≤ 50 (a partir de acima de 50).

SL/TP: percentagens fixas e largas (10%) para não dominar a lógica de saída por RSI 50.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

INDICATOR_PARAM_NAMES: frozenset[str] = frozenset({"rsi_period"})


def get_strategy_parameters() -> dict:
    """Período do RSI (Wilder) alinhado ao slider do gráfico via ``indicator_params``."""
    return {
        "rsi_period": (14, 2, 50, 1, False, False),
    }


def _rsi_1d(close: np.ndarray, length: int = 14) -> np.ndarray:
    close = np.asarray(close, dtype=np.float64)
    s = pd.Series(close)
    d = s.diff()
    up = d.clip(lower=0.0)
    down = -d.clip(upper=0.0)
    roll_up = up.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    roll_down = down.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    rs = roll_up / roll_down.replace(0, np.nan)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    return rsi.to_numpy()


def compute_indicators(df: pd.DataFrame, params: dict) -> dict:
    length = int(params.get("rsi_period", 14))
    length = max(2, min(length, 200))
    c = df["Close"].to_numpy(dtype=np.float64)
    rsi = _rsi_1d(c, length)
    return {
        "close": c,
        "rsi": rsi,
    }


def compute_signals_vectorized(
    ind: dict,
    thr_params_list: list[dict],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Um ou vários “combos” (em geral 1) — limites 30/70/50 fixos; thr_params_list ignora o conteúdo.
    """
    rsi = np.asarray(ind["rsi"], dtype=np.float64)
    n = len(rsi)
    nc = max(1, len(thr_params_list))

    prev = np.empty(n, dtype=np.float64)
    prev[0] = rsi[0]
    if n > 1:
        prev[1:] = rsi[:-1]

    # entradas por cruzamento
    long_e = (rsi <= 40.0) & (prev > 40.0)
    short_e = (rsi >= 60.0) & (prev < 60.0)
    # saídas a 50
    long_x = (rsi >= 50.0) & (prev < 50.0)
    short_x = (rsi <= 50.0) & (prev > 50.0)

    le = np.broadcast_to(long_e[:, None], (n, nc)).copy()
    se = np.broadcast_to(short_e[:, None], (n, nc)).copy()
    lx = np.broadcast_to(long_x[:, None], (n, nc)).copy()
    sx = np.broadcast_to(short_x[:, None], (n, nc)).copy()

    sl_arr = np.full(nc, 0.10, dtype=np.float64)
    tp_arr = np.full(nc, 0.10, dtype=np.float64)

    return le, lx, se, sx, sl_arr, tp_arr
