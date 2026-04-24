"""
Compara tempo de compute_indicators + compute_signals_vectorized:
  legado = TR/OBV Pandas + VWAP ``groupby`` + flat_exit sem cache de consec.
  actual = lateral_market_rsi_vbt.py (versão actual).

Executar a partir da raíz do repo ou de backend/:
  python backend/benchmark_lateral_rsi_speed.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

_BACKEND = Path(__file__).resolve().parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from my_strategies import lateral_market_rsi_vbt as strat
from my_strategies.lateral_market_rsi_vbt import (
    _consecutive_count,
    _ema,
    _rsi,
    _vwma,
    _wma,
)


def _vwap_daily_pandas_groupby(
    close: pd.Series, volume: pd.Series, index
) -> np.ndarray:
    """Caminho antigo (DataFrame + groupby) só para o benchmark legado."""
    try:
        dates = pd.to_datetime(index, utc=True).date
    except Exception:
        dates = np.zeros(len(close), dtype=int)
    tmp = pd.DataFrame({"c": close.values, "v": volume.values, "d": dates})
    tmp["pv"] = tmp["c"] * tmp["v"]
    tmp["cum_pv"] = tmp.groupby("d")["pv"].cumsum()
    tmp["cum_vol"] = tmp.groupby("d")["v"].cumsum().replace(0, np.nan)
    return (tmp["cum_pv"] / tmp["cum_vol"]).replace([np.inf, -np.inf], np.nan).values


def _ind_params_defaults() -> dict:
    g = strat.get_strategy_parameters()
    return {k: t[0] for k, t in g.items() if isinstance(t, tuple)}


def _make_ohlcv(n_bars: int, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2020-01-01", periods=n_bars, freq="3min", tz="UTC")
    c = np.abs(np.cumsum(rng.standard_normal(n_bars))) + 1.0
    h = c + rng.random(n_bars) * 0.02
    l = c - rng.random(n_bars) * 0.02
    v = rng.random(n_bars) * 1e6 + 1.0
    return pd.DataFrame({"Close": c, "High": h, "Low": l, "Volume": v}, index=idx)


def compute_indicators_legacy(df: pd.DataFrame, params: dict) -> dict | None:
    """Igual ao actual excepto TR + OBV via Pandas (antes da optimização)."""
    try:
        close = df["Close"].astype(np.float64)
        high = df["High"].astype(np.float64)
        low = df["Low"].astype(np.float64)
        volume = df["Volume"].astype(np.float64)

        hl = (high - low).values
        hc = (high - close.shift(1)).abs().values
        lc = (low - close.shift(1)).abs().values
        tr = np.nanmax(np.column_stack([hl, hc, lc]), axis=1)
        atr = _wma(tr, params["atr_wma_length"])
        with np.errstate(divide="ignore", invalid="ignore"):
            atr_pct = np.where(close.values != 0, atr / close.values * 100, np.nan)

        shift = params["dif_ema_shift"]
        ema_fast = _ema(close, params["ema_fast_span"])
        ema_med = _ema(close, params["ema_span"])
        dif_ema = ema_fast - ema_fast.shift(shift)
        dif_ema2 = ema_med - ema_med.shift(shift)
        with np.errstate(divide="ignore", invalid="ignore"):
            dif_pct = np.where(ema_fast != 0, (dif_ema / ema_fast) * 100, np.nan)
            dif_pct2 = np.where(ema_med != 0, (dif_ema2 / ema_med) * 100, np.nan)

        vwap = pd.Series(_vwap_daily_pandas_groupby(close, volume, df.index), index=df.index)
        rsi_vwap = _rsi(vwap, 1)
        rsi_close = _rsi(close, params["rsi_close_length"])

        hlc3 = (high + low + close) / 3
        basis = _vwma(hlc3, volume, params["envelope_length"])
        dev = params["envelope_mult"] * hlc3.rolling(
            params["envelope_length"], min_periods=1
        ).std()
        upper6 = (basis + dev).values
        lower6 = (basis - dev).values

        sign_chg = np.sign(close.diff().fillna(0))
        obv = (sign_chg * volume).cumsum()
        dif_obv = obv.diff().fillna(0)
        vol_sma = volume.rolling(params["vol_sma_length"], min_periods=1).mean().replace(
            0, np.nan
        )
        dif_obv_n = (dif_obv / vol_sma).values

        c_vals = close.values
        get_out = (lower6 > c_vals) | (upper6 < c_vals)
        get_out_consec = _consecutive_count(get_out)

        return {
            "close": c_vals,
            "atr_pct": np.asarray(atr_pct, dtype=np.float64),
            "dif_pct": np.asarray(dif_pct, dtype=np.float64),
            "dif_pct2": np.asarray(dif_pct2, dtype=np.float64),
            "rsi": np.asarray(rsi_close, dtype=np.float64),
            "rsi_vwap": np.asarray(rsi_vwap, dtype=np.float64),
            "upper6": np.asarray(upper6, dtype=np.float64),
            "lower6": np.asarray(lower6, dtype=np.float64),
            "dif_obv_norm": np.asarray(dif_obv_n, dtype=np.float64),
            "get_out_consec": np.asarray(get_out_consec, dtype=np.int32),
        }
    except Exception:
        return None


def compute_signals_vectorized_legacy(
    ind: dict,
    thr_params_list: list[dict],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Versão anterior ao cache de _consecutive_count por flat_max."""
    nc = len(thr_params_list)
    atr_max = np.array([t["atr_pct_max"] for t in thr_params_list])
    dif_max = np.array([t["dif_pct_abs_max"] for t in thr_params_list])
    obv_max = np.array([t["dif_obv_norm_max"] for t in thr_params_list])
    flat_max = np.array([t["flat_ema2_pct_max"] for t in thr_params_list])
    flat_bars = np.array([t["flat_ema2_exit_bars"] for t in thr_params_list], dtype=int)
    get_out_bars = np.array([t["get_out_exit_bars"] for t in thr_params_list], dtype=int)
    rsi_os = np.array([t["rsi_over_sold"] for t in thr_params_list])
    rsi_ob = np.array([t["rsi_over_bought"] for t in thr_params_list])
    vwap_os = np.array([t["rsi_vwap_over_sold"] for t in thr_params_list])
    vwap_ob = np.array([t["rsi_vwap_over_bought"] for t in thr_params_list])
    sl_arr = np.array([t["sl_pct"] for t in thr_params_list])
    tp_arr = np.array([t["tp_pct"] for t in thr_params_list])

    atr = np.nan_to_num(ind["atr_pct"], nan=1e9)[:, None]
    dp = np.nan_to_num(ind["dif_pct"], nan=1e9)[:, None]
    dp2 = np.nan_to_num(ind["dif_pct2"], nan=1e9)
    obv = np.nan_to_num(ind["dif_obv_norm"], nan=1e9)[:, None]
    ri = np.nan_to_num(ind["rsi"], nan=50.0)
    rv = np.nan_to_num(ind["rsi_vwap"], nan=50.0)[:, None]
    c = ind["close"][:, None]
    up = np.nan_to_num(ind["upper6"], nan=1e9)[:, None]
    lo = np.nan_to_num(ind["lower6"], nan=-1e9)[:, None]
    goc = ind["get_out_consec"]

    filter_trend = (
        (up > c) & (lo < c) & (atr < atr_max) & (np.abs(dp) <= dif_max) & (np.abs(obv) <= obv_max)
    )
    long_entries = filter_trend & (ri[:, None] < rsi_os) & (rv < vwap_os)
    short_entries = filter_trend & (ri[:, None] > rsi_ob) & (rv > vwap_ob)
    exit_long = np.broadcast_to((ri > 50)[:, None], (len(ri), nc)).copy()
    exit_short = np.broadcast_to((ri < 50)[:, None], (len(ri), nc)).copy()

    flat_exit = np.zeros((len(ri), nc), dtype=bool)
    for u_max in np.unique(flat_max):
        for u_bars in np.unique(flat_bars):
            mask = (flat_max == u_max) & (flat_bars == u_bars)
            if not mask.any():
                continue
            ema2_flat = np.abs(dp2) <= u_max
            consec = _consecutive_count(ema2_flat)
            fe = (consec >= u_bars)[:, None]
            flat_exit[:, mask] = np.broadcast_to(fe, (len(ri), int(mask.sum())))

    get_out_exit = np.zeros((len(ri), nc), dtype=bool)
    for u_bars in np.unique(get_out_bars):
        mask = get_out_bars == u_bars
        if not mask.any():
            continue
        ge = (goc >= u_bars)[:, None]
        get_out_exit[:, mask] = np.broadcast_to(ge, (len(ri), int(mask.sum())))

    long_exits = exit_long | flat_exit | get_out_exit
    short_exits = exit_short | flat_exit | get_out_exit
    return long_entries, long_exits, short_entries, short_exits, sl_arr, tp_arr


def _thr_grid(n_flat_max: int, n_flat_bars: int, base: dict) -> list[dict]:
    """Grelha de thresholds para stressar o loop flat_exit (muitas chamadas _consecutive_count no legado)."""
    fm = np.linspace(0.15, 1.2, n_flat_max)
    fb = np.arange(5, 5 + n_flat_bars * 3, 3, dtype=int)
    out: list[dict] = []
    for a in fm:
        for b in fb:
            t = dict(base)
            t["flat_ema2_pct_max"] = float(a)
            t["flat_ema2_exit_bars"] = int(b)
            out.append(t)
    return out


def _assert_ind_equal(a: dict, b: dict) -> None:
    for k in a:
        if np.issubdtype(a[k].dtype, np.floating):
            ok = np.allclose(a[k], b[k], equal_nan=True, rtol=1e-12, atol=1e-12)
        else:
            ok = np.array_equal(a[k], b[k])
        assert ok, k


def main() -> None:
    n_bars = 50_000
    params = _ind_params_defaults()
    df = _make_ohlcv(n_bars)

    base_thr = {
        "atr_pct_max": float(params["atr_pct_max"]),
        "dif_pct_abs_max": float(params["dif_pct_abs_max"]),
        "dif_obv_norm_max": float(params["dif_obv_norm_max"]),
        "flat_ema2_pct_max": float(params["flat_ema2_pct_max"]),
        "flat_ema2_exit_bars": int(params["flat_ema2_exit_bars"]),
        "get_out_exit_bars": int(params["get_out_exit_bars"]),
        "rsi_over_sold": float(params["rsi_over_sold"]),
        "rsi_over_bought": float(params["rsi_over_bought"]),
        "rsi_vwap_over_sold": float(params["rsi_vwap_over_sold"]),
        "rsi_vwap_over_bought": float(params["rsi_vwap_over_bought"]),
        "sl_pct": float(params["sl_pct"]),
        "tp_pct": float(params["tp_pct"]),
    }
    thr_list = _thr_grid(8, 10, base_thr)
    nc = len(thr_list)

    # Warm-up Numba / JIT
    il = compute_indicators_legacy(df, params)
    ia = strat.compute_indicators(df, params)
    assert il is not None and ia is not None
    _assert_ind_equal(il, ia)
    sl = compute_signals_vectorized_legacy(il, thr_list)
    sa = strat.compute_signals_vectorized(ia, thr_list)
    for x, y in zip(sl, sa):
        assert x.shape == y.shape and np.array_equal(x, y), (x.shape, y.shape)

    reps_ind = 25
    t0 = time.perf_counter()
    for _ in range(reps_ind):
        compute_indicators_legacy(df, params)
    t_legacy_ind = (time.perf_counter() - t0) / reps_ind

    t0 = time.perf_counter()
    for _ in range(reps_ind):
        strat.compute_indicators(df, params)
    t_new_ind = (time.perf_counter() - t0) / reps_ind

    ind = strat.compute_indicators(df, params)
    reps_sig = 80
    t0 = time.perf_counter()
    for _ in range(reps_sig):
        compute_signals_vectorized_legacy(ind, thr_list)
    t_legacy_sig = (time.perf_counter() - t0) / reps_sig

    t0 = time.perf_counter()
    for _ in range(reps_sig):
        strat.compute_signals_vectorized(ind, thr_list)
    t_new_sig = (time.perf_counter() - t0) / reps_sig

    total_old = t_legacy_ind + t_legacy_sig
    total_new = t_new_ind + t_new_sig

    print(f"Dataset: {n_bars:,} barras | thr combos: {nc}")
    print()
    print(f"compute_indicators        legado: {t_legacy_ind*1000:7.2f} ms  |  actual: {t_new_ind*1000:7.2f} ms  |  {t_legacy_ind/t_new_ind:.2f}x")
    print(f"compute_signals_vectorized legado: {t_legacy_sig*1000:7.2f} ms  |  actual: {t_new_sig*1000:7.2f} ms  |  {t_legacy_sig/t_new_sig:.2f}x")
    print(f"ind + signals (soma)       legado: {total_old*1000:7.2f} ms  |  actual: {total_new*1000:7.2f} ms  |  {total_old/total_new:.2f}x")


if __name__ == "__main__":
    main()
