# Chart Builder → bot Python (nome: "Nova estratégia")
# Requer: pip install TA-Lib (wrapper C talib).
# NATR (t2) usa high/low/close.
# t3 é EMA em timeframe superior e é alinhada por timestamp ao dataframe base.

from __future__ import annotations

import os
import time

import numpy as np
import pandas as pd
import talib

from configs.get_info_account import *  # noqa: F403
from configs.get_candles import *  # noqa: F403
from configs.Actions_trading import *  # noqa: F403
from configs.Sync_time import *  # noqa: F403
from configs.loop import *  # noqa: F403
from configs.Custom_indicators import *  # noqa: F403
from configs.bot_main import TradingBot

TAKE_PROFIT_PCT = 0.02
STOP_LOSS_PCT = 0.01
TRAILING_STOP_PCT = 0

ZONE_LONG_WAIT_CANDLES = 10
ZONE_SHORT_WAIT_CANDLES = 10

T3_TIMEFRAME = "15m"
T3_EMA_PERIOD = 300
T3_DELTA_LOOKBACK = 50
PRE_ENTRY_MAX_DISTANCE_PCT = 0.025
DEBUG_CSV_AFTER_SECONDS = 5 * 60
DEBUG_CSV_MAX_CANDLES = 2000
DEBUG_CSV_DIR = os.path.join(os.path.dirname(__file__), "indicator_debug")


def _htf_minutes(timeframe: str) -> int:
    unit = timeframe[-1].lower()
    value = int(timeframe[:-1])
    if unit == "m":
        return value
    if unit == "h":
        return value * 60
    if unit == "d":
        return value * 24 * 60
    raise ValueError(f"Timeframe não suportado para t3: {timeframe!r}")


def _min_1m_candles_for_t3(htf_timeframe: str = T3_TIMEFRAME) -> int:
    """Candles 1m mínimos: warmup EMA no HTF + shift do delta no timeframe base."""
    htf_min = _htf_minutes(htf_timeframe)
    return T3_EMA_PERIOD * htf_min + T3_DELTA_LOOKBACK + htf_min


def _ensure_ohlcv_columns(df: pd.DataFrame) -> pd.DataFrame:
    lowmap = {c.lower(): c for c in df.columns}
    need = ["open", "high", "low", "close", "volume"]
    missing = [x for x in need if x not in lowmap]
    if missing:
        raise ValueError(f"Nova_estrategia_v3: faltam colunas OHLCV: {missing} (tem {list(df.columns)})")
    return df.rename(columns={lowmap[x]: x for x in need})


def _timeframe_to_rule(timeframe: str) -> str:
    unit = timeframe[-1].lower()
    value = int(timeframe[:-1])
    if unit == "m":
        return f"{value}min"
    if unit == "h":
        return f"{value}h"
    if unit == "d":
        return f"{value}D"
    raise ValueError(f"Timeframe não suportado para t3: {timeframe!r}")


def _timeframe_seconds(raw: str | None) -> int | None:
    tf = (raw or "").strip().lower()
    if not tf or tf == "chart":
        return None
    unit = tf[-1]
    value = int(tf[:-1])
    if unit == "m":
        return value * 60
    if unit == "h":
        return value * 3600
    if unit == "d":
        return value * 86400
    return None


def _median_step_seconds(t_col: np.ndarray) -> float:
    if t_col.size < 2:
        return 0.0
    diffs = np.diff(np.sort(t_col))
    diffs = diffs[np.isfinite(diffs) & (diffs > 0)]
    if diffs.size == 0:
        return 0.0
    return float(np.median(diffs))


def _aggregate_ohlcv_to_timeframe(df: pd.DataFrame, t_col: np.ndarray, tf_sec: int) -> tuple[pd.DataFrame, np.ndarray]:
    bucket = np.floor(t_col / float(tf_sec)).astype(np.int64) * int(tf_sec)
    work = df[["open", "high", "low", "close", "volume"]].copy()
    work["_bucket"] = bucket
    grouped = work.groupby("_bucket", sort=True, as_index=True).agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
    )
    close_t = grouped.index.to_numpy(dtype=np.float64) + float(tf_sec)
    return grouped.reset_index(drop=True), close_t


def _align_closed_htf_to_base(base_t: np.ndarray, htf_close_t: np.ndarray, htf_values: np.ndarray) -> np.ndarray:
    out = np.full(base_t.size, np.nan, dtype=np.float64)
    j = 0
    last = np.nan
    for i, tv in enumerate(base_t):
        while j < htf_close_t.size and htf_close_t[j] <= tv:
            v = htf_values[j] if j < htf_values.size else np.nan
            last = float(v) if np.isfinite(v) else np.nan
            j += 1
        out[i] = last
    return out


def _indicator_frame_like_site(df: pd.DataFrame, timeframe: str | None) -> tuple[pd.DataFrame, np.ndarray, np.ndarray | None]:
    base_ts = pd.to_datetime(df["timestamp"], utc=True)
    t_col = (base_ts.astype("int64") // 10**9).to_numpy(dtype=np.float64)
    tf_sec = _timeframe_seconds(timeframe)
    if tf_sec is None:
        return df, t_col, None
    base_step = _median_step_seconds(t_col)
    if base_step <= 0 or tf_sec <= base_step * 1.5:
        return df, t_col, None
    calc_df, close_t = _aggregate_ohlcv_to_timeframe(df, t_col, tf_sec)
    return calc_df, t_col, close_t


def _align_like_site(base_t: np.ndarray, close_t: np.ndarray | None, values: np.ndarray) -> np.ndarray:
    if close_t is None:
        return np.asarray(values, dtype=np.float64)
    return _align_closed_htf_to_base(base_t, close_t, np.asarray(values, dtype=np.float64))


def _talib_single(function: str, df: pd.DataFrame, params: dict[str, int | float] | None = None) -> np.ndarray:
    fn = getattr(talib, function.strip().upper())
    kwargs = dict(params or {})
    if function.strip().upper() == "NATR":
        return np.asarray(
            fn(
                df["high"].to_numpy(dtype=np.float64),
                df["low"].to_numpy(dtype=np.float64),
                df["close"].to_numpy(dtype=np.float64),
                **kwargs,
            ),
            dtype=np.float64,
        )
    return np.asarray(fn(df["close"].to_numpy(dtype=np.float64), **kwargs), dtype=np.float64)


def _indicator_delta_like_site(
    scalar: np.ndarray,
    close_px: np.ndarray,
    lookback: int,
    normalize_by_price: bool = True,
) -> np.ndarray:
    n = int(scalar.shape[0])
    out = np.full(n, np.nan, dtype=np.float64)
    lb = max(1, int(lookback))
    c = np.asarray(close_px, dtype=np.float64)
    s = np.asarray(scalar, dtype=np.float64)
    for i in range(lb, n):
        v = s[i]
        v0 = s[i - lb]
        if not (np.isfinite(v) and np.isfinite(v0)):
            continue
        d = float(v - v0)
        if normalize_by_price:
            ci = c[i]
            if not np.isfinite(ci) or abs(ci) < 1e-15:
                continue
            d /= float(ci)
        out[i] = d * 1000.0
    return out


def _ema_delta_on_timeframe(df: pd.DataFrame, timeframe: str) -> tuple[pd.Series, pd.Series]:
    """EMA no HTF fechado; delta igual ao HUD/Δ do site."""
    cl_base = df["close"].astype(np.float64)

    if "timestamp" not in df.columns:
        ema = pd.Series(talib.EMA(cl_base.values, timeperiod=T3_EMA_PERIOD), index=df.index).astype(float)
        delta = _indicator_delta_like_site(ema.to_numpy(dtype=np.float64), cl_base.to_numpy(dtype=np.float64), T3_DELTA_LOOKBACK, True)
        return ema, delta.astype(float)

    calc_df, base_t, close_t = _indicator_frame_like_site(df, timeframe)
    htf_ema = _talib_single("EMA", calc_df, {"timeperiod": T3_EMA_PERIOD})
    aligned = _align_like_site(base_t, close_t, htf_ema)
    aligned_ema = pd.Series(aligned, index=df.index).astype(float)
    aligned_delta = _indicator_delta_like_site(aligned, cl_base.to_numpy(dtype=np.float64), T3_DELTA_LOOKBACK, True)
    return aligned_ema.astype(float), aligned_delta.astype(float)


def _fv(ser, ji):
    n = len(ser)
    if ji < 0 or ji >= n:
        return float("nan")
    v = ser.iloc[int(ji)]
    return float(v) if pd.notna(v) else float("nan")


def _maybe_dump_indicator_debug_csv(self, df: pd.DataFrame) -> None:
    if getattr(self, "_indicator_debug_csv_written", False):
        return
    start_ts = getattr(self, "_indicator_debug_started_at", None)
    now = time.time()
    if start_ts is None:
        self._indicator_debug_started_at = now
        return
    if now - float(start_ts) < DEBUG_CSV_AFTER_SECONDS:
        return
    try:
        os.makedirs(DEBUG_CSV_DIR, exist_ok=True)
        out = df.tail(DEBUG_CSV_MAX_CANDLES).copy()
        cols = ["timestamp", "open", "high", "low", "close", "volume", "t1", "t2", "t3", "t3_delta"]
        out = out[[c for c in cols if c in out.columns]]
        stamp = pd.Timestamp.utcnow().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(DEBUG_CSV_DIR, f"nova_estrategia_v3_indicators_{stamp}.csv")
        out.to_csv(path, index=False)
        self._indicator_debug_csv_written = True
        print(f"[DEBUG CSV] Indicadores exportados: {path} ({len(out)} candles)")
    except Exception as e:
        print(f"[DEBUG CSV] Falha ao exportar indicadores: {e}")


def _entry_snap_get(self, key):
    snap = getattr(self, "entry_snap", None)
    if not isinstance(snap, dict) or key not in snap:
        return float("nan")
    v = snap[key]
    return float(v) if pd.notna(v) else float("nan")


def _capture_entry_snap(df, cur_i):
    return {
        "t1": _fv(df["t1"], cur_i),
    }


def indicators(df):
    df = _ensure_ohlcv_columns(df.copy())

    # t1: TA-Lib RSI(10), pela mesma forma de input que o backend TA do site.
    _t1_rsi = _talib_single("RSI", df, {"timeperiod": 10})
    df["t1"] = pd.Series(_t1_rsi, index=df.index).astype(float)

    # t2: TA-Lib NATR(5), idem backend TA do site.
    _t2_natr = _talib_single("NATR", df, {"timeperiod": 5})
    df["t2"] = pd.Series(_t2_natr, index=df.index).astype(float)

    # t3: TA-Lib EMA em timeframe superior, agregada/alinhada como `/api/chart/ta-series`.
    df["t3"], df["t3_delta"] = _ema_delta_on_timeframe(df, T3_TIMEFRAME)

    return df


def _append_candidate_candle(df, candle, close_px: float) -> pd.DataFrame:
    if df is None or len(df) == 0 or candle is None or len(candle) == 0:
        return pd.DataFrame()
    row = candle.iloc[-1].copy()
    px = float(close_px)
    row["close"] = px
    row["high"] = max(float(row["high"]), px)
    row["low"] = min(float(row["low"]), px)
    return pd.concat([df, pd.DataFrame([row])], ignore_index=True)


def _pre_entry_conditions_at(df_candidate: pd.DataFrame, side: str) -> bool:
    if df_candidate is None or len(df_candidate) == 0:
        return False
    calc = indicators(df_candidate)
    i = len(calc) - 1
    t1 = _fv(calc["t1"], i)
    t2 = _fv(calc["t2"], i)
    t3d = _fv(calc["t3_delta"], i)
    if not np.isfinite(t1) or not np.isfinite(t2) or not np.isfinite(t3d):
        return False
    market_ok = t2 > 0.6
    if side == "short":
        return bool(t1 > 80 and t3d < 1 and market_ok)
    if side == "long":
        return bool(t1 < 20 and t3d > -1 and market_ok)
    return False


def _find_trigger_price(df_closed, current_candle, side: str) -> dict | None:
    cur = current_candle.iloc[-1]
    cur_close = float(cur["close"])
    cur_high = float(cur["high"])
    cur_low = float(cur["low"])
    if cur_close <= 0:
        return None

    if _pre_entry_conditions_at(_append_candidate_candle(df_closed, current_candle, cur_close), side):
        trigger = cur_close
    else:
        if side == "short":
            lo = max(cur_close, cur_low)
            hi = max(cur_high, cur_close * (1.0 + PRE_ENTRY_MAX_DISTANCE_PCT))
            if not _pre_entry_conditions_at(_append_candidate_candle(df_closed, current_candle, hi), side):
                return None
            for _ in range(24):
                mid = (lo + hi) / 2.0
                if _pre_entry_conditions_at(_append_candidate_candle(df_closed, current_candle, mid), side):
                    hi = mid
                else:
                    lo = mid
            trigger = hi
        elif side == "long":
            hi = min(cur_close, cur_high)
            lo = min(cur_low, cur_close * (1.0 - PRE_ENTRY_MAX_DISTANCE_PCT))
            if not _pre_entry_conditions_at(_append_candidate_candle(df_closed, current_candle, lo), side):
                return None
            for _ in range(24):
                mid = (lo + hi) / 2.0
                if _pre_entry_conditions_at(_append_candidate_candle(df_closed, current_candle, mid), side):
                    lo = mid
                else:
                    hi = mid
            trigger = lo
        else:
            return None

    calc = indicators(_append_candidate_candle(df_closed, current_candle, trigger))
    i = len(calc) - 1
    distance_pct = abs(trigger / cur_close - 1.0) * 100.0
    return {
        "side": side,
        "price": float(trigger),
        "current_price": cur_close,
        "distance_pct": float(distance_pct),
        "rsi": _fv(calc["t1"], i),
        "natr": _fv(calc["t2"], i),
        "t3_delta": _fv(calc["t3_delta"], i),
        "timestamp": cur["timestamp"],
    }


def pre_entry_signal(self, df_closed, current_candle):
    """Preço LIMIT estimado antes do fecho; a estratégia confirmada continua em strategy()."""
    get_current_position(self)
    if self.position not in (None, "long", "short"):
        return None
    candidates = []
    for side in ("long", "short"):
        if side == "long" and self.position == "long":
            continue
        if side == "short" and self.position == "short":
            continue
        got = _find_trigger_price(df_closed, current_candle, side)
        if got is not None:
            candidates.append(got)
    if not candidates:
        return None
    candidates.sort(key=lambda x: x["distance_pct"])
    return candidates[0]


def strategy(self, df):
    get_current_position(self)
    print(f"POSITION: {self.position}")
    last_idx = -1
    df = indicators(df)
    # _maybe_dump_indicator_debug_csv(self, df)

    n = len(df)
    cur_i = n + last_idx

    def _filter_ok_at(j):
        return (((_fv(df["t2"], j)) > (0.7)))

    market_ok = _filter_ok_at(cur_i)
    print(f"market_ok: {market_ok}")
    zone_long_ok = True
    zone_short_ok = True
    print(
        "OHLCV:",
        _fv(df["open"], cur_i),
        _fv(df["high"], cur_i),
        _fv(df["low"], cur_i),
        _fv(df["close"], cur_i),
        _fv(df["volume"], cur_i),
    )
    print (f"t1: {_fv(df["t1"], cur_i)}")
    print (f"t2: {_fv(df["t2"], cur_i)}")
    print (f"t3: {_fv(df["t3"], cur_i)}")
    print(f"t3_delta: {_fv(df["t3_delta"], cur_i)}")

    long_signal = bool((((_fv(df["t1"], cur_i)) < (20)) and ((_fv(df["t3_delta"], cur_i)) > (-1)))) and market_ok
    short_signal = bool((((_fv(df["t1"], cur_i)) > (80)) and ((_fv(df["t3_delta"], cur_i)) < (1)))) and market_ok
    print (f"long_signal: {long_signal}")
    print (f"short_signal: {short_signal}")
    exit_long = bool(((_fv(df["t1"], cur_i)) > (((_entry_snap_get(self, "t1")) + 40) if pd.notna(_entry_snap_get(self, "t1")) else np.nan)))
    exit_short = bool(((_fv(df["t1"], cur_i)) < (((_entry_snap_get(self, "t1")) - 40) if pd.notna(_entry_snap_get(self, "t1")) else np.nan)))
    print (f"exit_long: {exit_long}")
    print (f"exit_short: {exit_short}")
    signal_result = None

    # Saídas por regra, depois entradas (motor Chart Builder; sem TP/SL intrabar aqui).

    if self.position == "long" and exit_long:
        signal_result = "sell"
        return signal_result

    if self.position == "short" and exit_short:
        signal_result = "sell"
        return signal_result

    if long_signal and zone_long_ok and (self.position in (None, "short")):
        signal_result = "long"
        self.entry_snap = _capture_entry_snap(df, cur_i)
        return signal_result

    if short_signal and zone_short_ok and (self.position in (None, "long")):
        signal_result = "short"
        self.entry_snap = _capture_entry_snap(df, cur_i)
        return signal_result

    return signal_result



if __name__ == "__main__":
    bot = TradingBot(
        api_key='jIFrSBMR8rgFTp2zeIadPvMHXeuL9o6z075OhuGkIYr8lGg1tNCix36pSOC3rfDL',
        api_secret='JcG8eT9n9knHSsUKDkxsoRh3mfXIuFhjXkDsjmntnop6cktHOIBjE6HN3yalqQc6', # pai,
        symbol="WLD/USDC:USDC",
        timeframe="1m",
        leverage=5,
        sl_percent=STOP_LOSS_PCT,
        tp_percent=TAKE_PROFIT_PCT,
        # trailing_percent=TRAILING_STOP_PCT / 100.0,
        buyed=False,
        strategy_name="Nova_estrategia_v3",
        type_strategy="trend",
        one_trade_per_account=False,
    )
    min_cache = _min_1m_candles_for_t3()
    if bot.cache_size < min_cache:
        bot.cache_size = min_cache
    bot.pre_entry_enabled = True
    bot.pre_entry_dry_run = True
    bot.pre_entry_max_distance_pct = 0.35
    bot.pre_entry_poll_sec = 5.0
    if not hasattr(bot, "entry_snap"):
        bot.entry_snap = {}
    run(bot)
