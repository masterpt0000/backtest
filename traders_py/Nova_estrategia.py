# Chart Builder → bot Python (nome: "Nova estratégia")
# Requer: pip install TA-Lib (wrapper C talib).
# NATR (t2) usa high/low/close.

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

TAKE_PROFIT_PCT = 0.02
STOP_LOSS_PCT = 0.02
TRAILING_STOP_PCT = 0

ZONE_LONG_WAIT_CANDLES = 10
ZONE_SHORT_WAIT_CANDLES = 10


def _ensure_ohlcv_columns(df: pd.DataFrame) -> pd.DataFrame:
    lowmap = {c.lower(): c for c in df.columns}
    need = ["open", "high", "low", "close", "volume"]
    missing = [x for x in need if x not in lowmap]
    if missing:
        raise ValueError(f"Nova_estrategia: faltam colunas OHLCV: {missing} (tem {list(df.columns)})")
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



def indicators(df):
    df = _ensure_ohlcv_columns(df.copy())

    hi = df["high"].astype(np.float64).values
    lo = df["low"].astype(np.float64).values
    cl = df["close"].astype(np.float64).values

    # t1: talib · RSI(10)
    _t1_rsi = talib.RSI(cl, timeperiod=10)
    df["t1"] = pd.Series(_t1_rsi, index=df.index).astype(float)

    # t2: talib · NATR(5)
    _t2_natr = talib.NATR(hi, lo, cl, timeperiod=5)
    df["t2"] = pd.Series(_t2_natr, index=df.index).astype(float)

    return df


def strategy(self, df):
    get_current_position(self)
    print(f"POSITION: {self.position}")
    last_idx = -1
    df = indicators(df)

    n = len(df)
    cur_i = n + last_idx

    def _filter_ok_at(j):
        return (((_fv(df["t2"], j)) > (0.6)))

    market_ok = _filter_ok_at(cur_i)
    zone_long_ok = True
    zone_short_ok = True

    long_signal = bool(((_fv(df["t1"], cur_i)) < (30))) and market_ok
    short_signal = bool(((_fv(df["t1"], cur_i)) > (70))) and market_ok

    exit_long = bool(False)
    exit_short = bool(False)

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
        return signal_result

    if short_signal and zone_short_ok and (self.position in (None, "long")):
        signal_result = "short"
        return signal_result

    return signal_result



if __name__ == "__main__":
    bot = TradingBot(
        api_key='jIFrSBMR8rgFTp2zeIadPvMHXeuL9o6z075OhuGkIYr8lGg1tNCix36pSOC3rfDL',
        api_secret='JcG8eT9n9knHSsUKDkxsoRh3mfXIuFhjXkDsjmntnop6cktHOIBjE6HN3yalqQc6', # pai
        symbol="WLD/USDC:USDC",
        timeframe="1m",
        leverage=10,
        sl_percent=STOP_LOSS_PCT,
        tp_percent=TAKE_PROFIT_PCT,
        # trailing_percent=TRAILING_STOP_PCT / 100.0,
        buyed=False,
        strategy_name="Nova_estrategia",
        type_strategy="trend",
        one_trade_per_account=False,
    )
    if not hasattr(bot, "entry_snap"):
        bot.entry_snap = {}
    run(bot)
