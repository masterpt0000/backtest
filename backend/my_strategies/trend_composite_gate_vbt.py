"""
Demonstração de *gate* por score de tendência composta — mesma fórmula que ``/api/chart/ta-series``
(``kind: trend_composite``). Entradas quando o score atravessa limiares; saídas ao cruzar 0.

Optimização (modo «Optimizar» nos backtests): chaves ``tc_*`` na grelha de **indicadores** (~√max tries):
normWindow, clip, outputScale, períodos por preset, **pesos dos componentes** (cid dir/macd/rsi/dmi);
continuações ``long_threshold`` / ``short_threshold`` / SL / TP na grelha de thresholds.

Nota: o **timeframe** da velada é escolhido no job de backtest (pares × TF), não dentro deste score.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from trend_composite import compute_trend_composite_score

STRATEGY_META = {
    "id": "trend_composite_gate",
    "chart_label": "Trend composite gate",
    "kind": "swing",
}

INDICATOR_PARAM_NAMES: frozenset[str] = frozenset(
    {
        "tc_norm_window",
        "tc_clip",
        "tc_output_scale",
        "tc_w_dir",
        "tc_w_macd",
        "tc_w_rsi",
        "tc_w_dmi",
        "tc_sma_period",
        "tc_atr_period",
        "tc_macd_fast",
        "tc_macd_slow",
        "tc_macd_signal",
        "tc_rsi_period",
        "tc_adx_period",
    }
)


def _pick_int(params: dict, key: str, default: int) -> int:
    if key not in params:
        return int(default)
    try:
        return int(round(float(params[key])))
    except (TypeError, ValueError):
        return int(default)


def _pick_float(params: dict, key: str, default: float) -> float:
    if key not in params:
        return float(default)
    try:
        return float(params[key])
    except (TypeError, ValueError):
        return float(default)


def _normalize_four_weights(w_dir: float, w_macd: float, w_rsi: float, w_dmi: float) -> tuple[float, float, float, float]:
    """Igual ao fluxo da UI: pesos ≥ 0; se a soma for 0 usa o default 35/35/15/15."""
    a = max(0.0, float(w_dir))
    b = max(0.0, float(w_macd))
    c = max(0.0, float(w_rsi))
    d = max(0.0, float(w_dmi))
    s = a + b + c + d
    if s <= 1e-12:
        return 35.0, 35.0, 15.0, 15.0
    scale = 100.0 / s
    return a * scale, b * scale, c * scale, d * scale


def _tc_components_from_params(params: dict) -> list[dict]:
    sma = max(2, min(500, _pick_int(params, "tc_sma_period", 50)))
    atr_p = max(1, min(500, _pick_int(params, "tc_atr_period", 14)))
    mf = max(1, min(200, _pick_int(params, "tc_macd_fast", 12)))
    ms = max(1, min(500, _pick_int(params, "tc_macd_slow", 26)))
    mx = max(1, min(200, _pick_int(params, "tc_macd_signal", 9)))
    rsi = max(2, min(500, _pick_int(params, "tc_rsi_period", 14)))
    adx = max(2, min(500, _pick_int(params, "tc_adx_period", 14)))

    wd = _pick_float(params, "tc_w_dir", 35.0)
    wm = _pick_float(params, "tc_w_macd", 35.0)
    wr = _pick_float(params, "tc_w_rsi", 15.0)
    wx = _pick_float(params, "tc_w_dmi", 15.0)
    nw_dir, nw_macd, nw_rsi, nw_dmi = _normalize_four_weights(wd, wm, wr, wx)

    return [
        {
            "weight": nw_dir,
            "preset": "price_vs_sma_atr",
            "params": {"sma_period": sma, "atr_period": atr_p},
        },
        {
            "weight": nw_macd,
            "preset": "macd_hist_zscore",
            "params": {"fast": mf, "slow": ms, "signal": mx},
        },
        {
            "weight": nw_rsi,
            "preset": "rsi_zscore",
            "params": {"rsi_period": rsi},
        },
        {
            "weight": nw_dmi,
            "preset": "plus_di_minus_di",
            "params": {"period": adx},
        },
    ]


def _norm_clip_scale_from_params(params: dict) -> tuple[int, float, float]:
    nw = max(5, min(500, _pick_int(params, "tc_norm_window", 60)))
    clip = max(0.25, min(12.0, _pick_float(params, "tc_clip", 2.0)))
    oscl = max(1.0, min(500.0, _pick_float(params, "tc_output_scale", 100.0)))
    return nw, clip, oscl


_TREND_COMPOSITE_UI: dict = {
    "normWindow": 60,
    "clip": 2,
    "outputScale": 100,
    "components": [
        {
            "cid": "dir",
            "weight": 35,
            "preset": "price_vs_sma_atr",
            "params": {"sma_period": 50, "atr_period": 14},
        },
        {
            "cid": "macd",
            "weight": 35,
            "preset": "macd_hist_zscore",
            "params": {"fast": 12, "slow": 26, "signal": 9},
        },
        {
            "cid": "rsi",
            "weight": 15,
            "preset": "rsi_zscore",
            "params": {"rsi_period": 14},
        },
        {
            "cid": "dmi",
            "weight": 15,
            "preset": "plus_di_minus_di",
            "params": {"period": 14},
        },
    ],
}


def get_strategy_parameters() -> dict:
    """
    Tuplas: (default, min, max, step, is_decimal, optimize).
    ``tc_*`` entram na grelha de indicadores; limiares e risco na grelha de thresholds.
    """
    return {
        # --- Trend composite (ind_list): igual ao painel «Score composto» ---
        "tc_norm_window": (60, 20, 200, 5, False, True),
        "tc_clip": (2.0, 0.5, 6.0, 0.25, True, True),
        "tc_output_scale": (100, 50, 250, 10, False, True),
        # Pesos % por componente (cid); no motor normalizam-se a soma 100 (como «Normalizar para 100%»).
        "tc_w_dir": (35, 0, 70, 5, False, True),
        "tc_w_macd": (35, 0, 70, 5, False, True),
        "tc_w_rsi": (15, 0, 45, 5, False, True),
        "tc_w_dmi": (15, 0, 45, 5, False, True),
        "tc_sma_period": (50, 10, 200, 5, False, True),
        "tc_atr_period": (14, 5, 50, 2, False, True),
        "tc_macd_fast": (12, 6, 24, 2, False, True),
        "tc_macd_slow": (26, 12, 48, 2, False, True),
        "tc_macd_signal": (9, 3, 18, 2, False, True),
        "tc_rsi_period": (14, 5, 35, 2, False, True),
        "tc_adx_period": (14, 5, 35, 2, False, True),
        # --- Sinais / risco (thr_list) ---
        "long_threshold": (25.0, 5.0, 55.0, 2.0, True, True),
        "short_threshold": (-25.0, -55.0, -5.0, 2.0, True, True),
        "sl_pct": (0.06, 0.01, 0.12, 0.005, True, True),
        "tp_pct": (0.06, 0.01, 0.12, 0.005, True, True),
    }


def compute_indicators(df: pd.DataFrame, params: dict) -> dict | None:
    try:
        work = df.rename(
            columns={
                "Open": "open",
                "High": "high",
                "Low": "low",
                "Close": "close",
            }
        )
        components = _tc_components_from_params(params)
        nw, clip, out_s = _norm_clip_scale_from_params(params)
        score = compute_trend_composite_score(
            work,
            components=components,
            norm_window=nw,
            clip=clip,
            output_scale=out_s,
        )
        close = df["Close"].to_numpy(dtype=np.float64)
        return {"close": close, "trend_score": np.asarray(score, dtype=np.float64)}
    except Exception as e:
        print(f"  ⚠️ trend_composite_gate compute_indicators: {e}")
        return None


def compute_signals_vectorized(
    ind: dict,
    thr_params_list: list[dict],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    sc = np.asarray(ind["trend_score"], dtype=np.float64)
    n = len(sc)
    nc = max(1, len(thr_params_list))
    sc = np.nan_to_num(sc, nan=0.0)

    prev = np.empty(n, dtype=np.float64)
    prev[0] = sc[0]
    if n > 1:
        prev[1:] = sc[:-1]

    lt = np.array([float(t["long_threshold"]) for t in thr_params_list])
    st = np.array([float(t["short_threshold"]) for t in thr_params_list])
    sl_arr = np.array([float(t["sl_pct"]) for t in thr_params_list])
    tp_arr = np.array([float(t["tp_pct"]) for t in thr_params_list])

    ok = np.isfinite(sc) & np.isfinite(prev)

    long_e = ok[:, None] & (sc[:, None] > lt[None, :]) & (prev[:, None] <= lt[None, :])
    short_e = ok[:, None] & (sc[:, None] < st[None, :]) & (prev[:, None] >= st[None, :])
    exit_long = ok[:, None] & (sc[:, None] < 0.0) & (prev[:, None] >= 0.0)
    exit_short = ok[:, None] & (sc[:, None] > 0.0) & (prev[:, None] <= 0.0)

    return long_e, exit_long, short_e, exit_short, sl_arr, tp_arr


def get_chart_strategy_for_ui() -> dict:
    meta = STRATEGY_META
    return {
        "id": str(meta["id"]) + "_demo",
        "label": str(meta.get("chart_label") or "Trend composite gate"),
        "vbt_strategy": str(meta["id"]),
        "indicators": [
            {
                "id": "trend_score",
                "label": "Trend composite",
                "group": "studies",
                "kind": "trend_composite",
                "params": {"trendComposite": _TREND_COMPOSITE_UI},
            }
        ],
    }
