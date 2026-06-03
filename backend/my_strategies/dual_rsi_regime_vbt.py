"""
dual_rsi_regime_vbt — tradução aproximada do Pine «My strategy» (bott72341):
dois RSI (lento/rápido), entradas por desvio do RSI rápido relativamente ao lento,
filtro de regime em torno de 50, saídas por RSI rápido vs. RSI no momento da entrada,
mais TP/SL em % no fecho.

O motor de backtest usa sempre ``compute_signals_vectorized``. A parte com memória
(``rsi_reg``) não se vectoriza por máscaras simples — por coluna de parâmetros corre-se
um pequeno estado bar-a-bar (aceitável para as grelhas típicas do site).

Para explorar **muitas** combinações no site: aumenta «Max tries» (ex.: 2000–5000) e usa
LHS. O backend reparte amostragem: indicadores ~(√N), thresholds ~N (ver ``build_param_grids``).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

try:
    import vectorbt as vbt

    vbt.settings.caching["enabled"] = True
except Exception:
    pass

STRATEGY_META = {
    "id": "dual_rsi_regime",
    "chart_label": "Dual RSI regime (Pine-like)",
    "kind": "swing",
}

# Períodos RSI recalculados por combo de indicadores (grelha ``ind_list``, ~√max_tries).
INDICATOR_PARAM_NAMES: frozenset[str] = frozenset({"rsi_slow_length", "rsi_fast_length"})


def get_strategy_parameters() -> dict:
    """
    Tuplas: (default, min, max, step, is_decimal, optimize).

    Intervalos largos para optimização agressiva; ajusta no JSON do chart ou presets se quiseres mais estreitos.
    """
    return {
        "rsi_slow_length": (49, 14, 160, 7, False, True),
        "rsi_fast_length": (9, 3, 34, 2, False, True),
        "rsi_entry_band": (9, 5, 50, 2, False, True),
        "rsi_exit_band": (28, 8, 60, 2, False, True),
        "regime": (6, 2, 30, 2, False, True),
        "tp_pct": (0.055, 0.005, 0.12, 0.005, True, True),
        "sl_pct": (0.11, 0.005, 0.12, 0.005, True, True),
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
    label = str(meta.get("chart_label") or meta.get("name") or "Dual RSI regime")
    slow = int(_param_default(p, "rsi_slow_length"))
    fast = int(_param_default(p, "rsi_fast_length"))
    return {
        "id": sid,
        "label": label,
        "indicators": [
            {"id": "rsi_slow", "label": f"RSI slow ({slow})", "group": "studies", "kind": "rsi", "params": {"period": slow}},
            {"id": "rsi_fast", "label": f"RSI fast ({fast})", "group": "studies", "kind": "rsi", "params": {"period": fast}},
        ],
        "vbt_strategy": "dual_rsi_regime",
    }


def _rsi_wilder(close: pd.Series, length: int) -> np.ndarray:
    delta = close.diff()
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
    try:
        close = df["Close"].astype(np.float64)
        slow = max(2, int(params["rsi_slow_length"]))
        fast = max(2, int(params["rsi_fast_length"]))
        rsi_slow = _rsi_wilder(close, slow)
        rsi_fast = _rsi_wilder(close, fast)
        return {
            "close": close.to_numpy(dtype=np.float64),
            "rsi": np.asarray(rsi_slow, dtype=np.float64),
            "rsi1": np.asarray(rsi_fast, dtype=np.float64),
        }
    except Exception as e:
        print(f"  ⚠️ dual_rsi_regime compute_indicators: {e}")
        return None


def _simulate_column(
    rsi: np.ndarray,
    rsi1: np.ndarray,
    RSI_entry: float,
    RSI_exit: float,
    regime: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Um só conjunto de thresholds — estado Pine por barra."""
    n = len(rsi)
    le = np.zeros(n, dtype=np.bool_)
    lx = np.zeros(n, dtype=np.bool_)
    se = np.zeros(n, dtype=np.bool_)
    sx = np.zeros(n, dtype=np.bool_)

    pos = 0  # 1 long, -1 short, 0 flat
    rsi_reg = np.nan

    for i in range(n):
        r = float(rsi[i])
        r1 = float(rsi1[i])
        if not np.isfinite(r) or not np.isfinite(r1):
            continue

        entry_long_lvl = r - RSI_entry
        entry_short_lvl = r + RSI_entry
        long_cond = r1 < entry_long_lvl and r > (50.0 + regime)
        short_cond = r1 > entry_short_lvl and r < (50.0 - regime)

        # Mesma ordem que no Pine: entrada long, entrada short, depois fechos por rsi_reg.
        if long_cond and (pos == 0 or pos < 0):
            if pos < 0:
                sx[i] = True
            le[i] = True
            pos = 1
            rsi_reg = r1

        if short_cond and (pos == 0 or pos > 0):
            if pos > 0:
                lx[i] = True
            se[i] = True
            pos = -1
            rsi_reg = r1

        if pos > 0 and np.isfinite(rsi_reg) and r1 > rsi_reg + RSI_exit:
            lx[i] = True
            pos = 0
            rsi_reg = np.nan

        if pos < 0 and np.isfinite(rsi_reg) and r1 < rsi_reg - RSI_exit:
            sx[i] = True
            pos = 0
            rsi_reg = np.nan

    return le, lx, se, sx


THRESHOLD_DEFAULTS: dict[str, float] = {
    "rsi_entry_band": 20.0,
    "rsi_exit_band": 30.0,
    "regime": 10.0,
    "tp_pct": 0.03,
    "sl_pct": 0.03,
}


def compute_signals_vectorized(
    ind: dict,
    thr_params_list: list[dict],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rsi = np.asarray(ind["rsi"], dtype=np.float64)
    rsi1 = np.asarray(ind["rsi1"], dtype=np.float64)
    n = len(rsi)

    rows: list[dict] = []
    if thr_params_list:
        for t in thr_params_list:
            merged = {**THRESHOLD_DEFAULTS, **{k: float(v) for k, v in t.items()}}
            rows.append(merged)
    else:
        rows.append(dict(THRESHOLD_DEFAULTS))

    nc = len(rows)

    Re = np.array([float(r["rsi_entry_band"]) for r in rows], dtype=np.float64)
    Rx = np.array([float(r["rsi_exit_band"]) for r in rows], dtype=np.float64)
    Rg = np.array([float(r["regime"]) for r in rows], dtype=np.float64)
    tp_arr = np.array([float(r["tp_pct"]) for r in rows], dtype=np.float64)
    sl_arr = np.array([float(r["sl_pct"]) for r in rows], dtype=np.float64)

    le = np.zeros((n, nc), dtype=np.bool_)
    lx = np.zeros((n, nc), dtype=np.bool_)
    se = np.zeros((n, nc), dtype=np.bool_)
    sx = np.zeros((n, nc), dtype=np.bool_)

    for c in range(nc):
        a, b, d, e = _simulate_column(rsi, rsi1, float(Re[c]), float(Rx[c]), float(Rg[c]))
        le[:, c] = a
        lx[:, c] = b
        se[:, c] = d
        sx[:, c] = e

    return le, lx, se, sx, sl_arr, tp_arr


def compute_signals(
    ind: dict,
    params: dict,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Versão 1D para debugging local — não usada pelo job/UI."""
    thr = [
        {
            "rsi_entry_band": float(params["rsi_entry_band"]),
            "rsi_exit_band": float(params["rsi_exit_band"]),
            "regime": float(params["regime"]),
            "tp_pct": float(params["tp_pct"]),
            "sl_pct": float(params["sl_pct"]),
        }
    ]
    le, lx, se, sx, _, _ = compute_signals_vectorized(ind, thr)
    return le[:, 0], lx[:, 0], se[:, 0], sx[:, 0]
