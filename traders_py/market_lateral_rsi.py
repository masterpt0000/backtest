# Chart Builder -> bot Python (nome: "Market Lateral RSI")
# Base: Pine Script "Market Lateral RSI".

from __future__ import annotations

import os

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

LENGTH_ATR = 100
SMOOTHING = "WMA"
LENGTH_EMA = 100
LENGTH_EMA2 = 1
LENGTH_EMA3 = 1000
RSI_VWAP_LENGTH = 1
RSI_VWAP_OVERSOLD = 15
RSI_VWAP_OVERBOUGHT = 85
RSI_OVERSOLD = 25
RSI_OVERBOUGHT = 75
LENGTH_FIBONACCI = 300
MULT_FIBONACCI = 1.1
TAKE_PROFIT_PCT = 0.03
STOP_LOSS_PCT = 0.02
TRAILING_STOP_PCT = 0
LEN_ADX = 10
LEN_RSI = 9


def _ensure_ohlcv_columns(df: pd.DataFrame) -> pd.DataFrame:
    lowmap = {c.lower(): c for c in df.columns}
    need = ["open", "high", "low", "close", "volume"]
    missing = [x for x in need if x not in lowmap]
    if missing:
        raise ValueError(f"market_lateral_rsi: faltam colunas OHLCV: {missing} (tem {list(df.columns)})")
    return df.rename(columns={lowmap[x]: x for x in need})


def _fv(ser, ji):
    n = len(ser)
    if ji < 0 or ji >= n:
        return float("nan")
    v = ser.iloc[int(ji)]
    return float(v) if pd.notna(v) else float("nan")


def _entry_snap_get(self, key):
    snap = getattr(self, "entry_snap", None)
    if not isinstance(snap, dict) or key not in snap:
        return float("nan")
    v = snap[key]
    return float(v) if pd.notna(v) else float("nan")


def _wma(series: pd.Series, length: int) -> pd.Series:
    weights = np.arange(1, length + 1, dtype=np.float64)
    return series.rolling(length).apply(lambda x: np.dot(x, weights) / weights.sum(), raw=True)


def _smooth(series: pd.Series, length: int, smoothing: str) -> pd.Series:
    smoothing = smoothing.upper()
    if smoothing == "RMA":
        return series.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()
    if smoothing == "SMA":
        return series.rolling(length).mean()
    if smoothing == "EMA":
        return series.ewm(span=length, adjust=False, min_periods=length).mean()
    return _wma(series, length)


def _rsi(series: pd.Series, length: int) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()
    avg_loss = loss.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    return 100.0 - (100.0 / (1.0 + rs))


def _vwma(price: pd.Series, volume: pd.Series, length: int) -> pd.Series:
    vol_sum = volume.rolling(length).sum()
    return (price * volume).rolling(length).sum() / vol_sum.replace(0.0, np.nan)


def _obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    direction = np.sign(close.diff()).fillna(0.0)
    return (direction * volume).cumsum()


def indicators(df):
    df = _ensure_ohlcv_columns(df.copy())

    hi = df["high"].astype(np.float64)
    lo = df["low"].astype(np.float64)
    cl = df["close"].astype(np.float64)
    vol = df["volume"].astype(np.float64)

    prev_close = cl.shift(1)
    true_range = pd.concat(
        [
            hi - lo,
            (hi - prev_close).abs(),
            (lo - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    df["atr"] = _smooth(true_range, LENGTH_ATR, SMOOTHING)
    df["atr_pct"] = df["atr"] / cl.replace(0.0, np.nan) * 100.0

    df["rsi"] = pd.Series(talib.RSI(cl.values, timeperiod=LEN_RSI), index=df.index).astype(float)
    df["ema_fast"] = pd.Series(talib.EMA(cl.values, timeperiod=LENGTH_EMA), index=df.index).astype(float)
    if LENGTH_EMA2 == 1:
        df["ema"] = cl
    else:
        df["ema"] = pd.Series(talib.EMA(cl.values, timeperiod=LENGTH_EMA2), index=df.index).astype(float)
    df["ema_slow"] = pd.Series(talib.EMA(cl.values, timeperiod=LENGTH_EMA3), index=df.index).astype(float)

    # Pine ta.vwap(close), aproximado em dados contínuos por VWAP cumulativo.
    vwap = (cl * vol).cumsum() / vol.cumsum().replace(0.0, np.nan)
    df["rsi_vwap"] = _rsi(vwap, RSI_VWAP_LENGTH)

    df["dif_ema"] = df["ema_fast"] - df["ema_fast"].shift(10)
    df["dif_pct"] = df["dif_ema"] / df["ema_fast"].replace(0.0, np.nan) * 100.0
    df["dif_ema2"] = df["ema"] - df["ema"].shift(10)
    df["dif_pct2"] = df["dif_ema2"] / df["ema"].replace(0.0, np.nan) * 100.0
    df["dif_ema3"] = df["ema_slow"] - df["ema_slow"].shift(10)

    df["di_plus"] = pd.Series(talib.PLUS_DI(hi.values, lo.values, cl.values, timeperiod=LEN_ADX), index=df.index)
    df["di_minus"] = pd.Series(talib.MINUS_DI(hi.values, lo.values, cl.values, timeperiod=LEN_ADX), index=df.index)
    df["adx"] = pd.Series(talib.ADX(hi.values, lo.values, cl.values, timeperiod=LEN_ADX), index=df.index)
    df["dif_adx"] = df["adx"] - df["adx"].shift(5)

    hlc3 = (hi + lo + cl) / 3.0
    basis = _vwma(hlc3, vol, LENGTH_FIBONACCI)
    dev = MULT_FIBONACCI * hlc3.rolling(LENGTH_FIBONACCI).std()
    df["basis"] = basis
    df["upper_6"] = basis + dev
    df["lower_6"] = basis - dev

    df["obv"] = _obv(cl, vol)
    df["dif_obv"] = df["obv"] - df["obv"].shift(1)
    df["dif_obv_norm"] = df["dif_obv"] / vol.rolling(1000).mean().replace(0.0, np.nan)

    return df


def strategy(self, df):
    get_current_position(self)
    print(f"POSITION: {self.position}")
    last_idx = -1
    df = indicators(df)

    n = len(df)
    cur_i = n + last_idx
    warmup = max(LENGTH_EMA + 10, LEN_RSI + 10)
    if cur_i < warmup:
        print(f"⚠️ Barras insuficientes ({n}); minimo recomendado {warmup + 1}.")
        return None

    rsi_now = _fv(df["rsi"], cur_i)
    dif_pct_now = _fv(df["dif_pct"], cur_i)

    long_signal = bool((rsi_now < 40) and (dif_pct_now >= 0.8))
    short_signal = bool((rsi_now > 60) and (dif_pct_now <= -0.8))

    exit_long = bool(rsi_now > 70)
    exit_short = bool(rsi_now < 30)

    signal_result = None

    if self.position == "long" and exit_long:
        signal_result = "sell"
        return signal_result

    if self.position == "short" and exit_short:
        signal_result = "sell"
        return signal_result

    if long_signal and (self.position in (None, "short")):
        signal_result = "long"
        return signal_result

    if short_signal and (self.position in (None, "long")):
        signal_result = "short"
        return signal_result

    return signal_result


if __name__ == "__main__":
    bot = TradingBot(
        api_key='jIFrSBMR8rgFTp2zeIadPvMHXeuL9o6z075OhuGkIYr8lGg1tNCix36pSOC3rfDL',
        api_secret='JcG8eT9n9knHSsUKDkxsoRh3mfXIuFhjXkDsjmntnop6cktHOIBjE6HN3yalqQc6', # pai,
        symbol="WLD/USDC:USDC",
        timeframe="5m",
        leverage=5,
        sl_percent=STOP_LOSS_PCT,
        tp_percent=TAKE_PROFIT_PCT,
        # trailing_percent=TRAILING_STOP_PCT / 100.0,
        buyed=False,
        strategy_name="market_lateral_rsi",
        type_strategy="trend",
        one_trade_per_account=False,
    )
    if not hasattr(bot, "entry_snap"):
        bot.entry_snap = {}
    run(bot)
