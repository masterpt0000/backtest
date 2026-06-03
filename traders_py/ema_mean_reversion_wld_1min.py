# Chart Builder → bot Python (nome: "ema mean reversion wld 1min")
#
# Notas MTF/deslocamentos: no builder, [n] em séries Δ alinha por tempo no timeframe superior;
# aqui usa-se apenas índice j−n na série 1m.
#
# Saídas usam entry(...): ``self.entry_snap`` é definido em cada entrada (``_capture_entry_snap``).

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

# Requer: pip install TA-Lib (wrapper C talib).

TAKE_PROFIT_PCT = 0.02
STOP_LOSS_PCT = 0.02
TRAILING_STOP_PCT = 0

ZONE_LONG_WAIT_CANDLES = 0
ZONE_SHORT_WAIT_CANDLES = 0

T2_DELTA_LOOKBACK = 10


def _ensure_ohlcv_columns(df: pd.DataFrame) -> pd.DataFrame:
    lowmap = {c.lower(): c for c in df.columns}
    need = ["open", "high", "low", "close", "volume"]
    missing = [x for x in need if x not in lowmap]
    if missing:
        raise ValueError(f"ema_mean_reversion_wld_1min: faltam colunas OHLCV: {missing} (tem {list(df.columns)})")
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


def _capture_entry_snap(df, cur_i):
    return {
        "t2_delta": _fv(df["t2_delta"], cur_i),
    }


def indicators(df):
    df = _ensure_ohlcv_columns(df.copy())
    cl = df["close"].astype(np.float64).values

    _t1_rsi = talib.RSI(cl, timeperiod=9)
    df["t1"] = pd.Series(_t1_rsi, index=df.index).astype(float)
    _t2_ema = talib.EMA(cl, timeperiod=200)
    df["t2"] = pd.Series(_t2_ema, index=df.index).astype(float)
    lb = max(1, min(500, int(T2_DELTA_LOOKBACK)))
    _d_raw = df["t2"] - df["t2"].shift(lb)
    df["t2_delta"] = (_d_raw / df["close"].replace(0.0, np.nan)) * 1000
    return df


def strategy(self, df):
    get_current_position(self)
    print(f"POSITION: {self.position}")
    last_idx = -1
    df = indicators(df)

    n = len(df)
    cur_i = n + last_idx

    def _filter_ok_at(j):
        return True

    market_ok = True

    def _zone_long_ok():
        wait = 0
        apply_zf = True
        last_true = -1
        for j in range(0, cur_i + 1):
            filter_ok_j = (not apply_zf) or _filter_ok_at(j)
            zone_raw_j = (_fv(df["t2_delta"], (j - 1))) < (-3)
            if filter_ok_j and zone_raw_j:
                last_true = j
        return last_true >= 0 and (cur_i - last_true) <= wait

    zone_long_ok = _zone_long_ok()

    def _zone_short_ok():
        wait = 0
        apply_zf = True
        last_true = -1
        for j in range(0, cur_i + 1):
            filter_ok_j = (not apply_zf) or _filter_ok_at(j)
            zone_raw_j = (_fv(df["t2_delta"], (j - 1))) > (3)
            if filter_ok_j and zone_raw_j:
                last_true = j
        return last_true >= 0 and (cur_i - last_true) <= wait

    zone_short_ok = _zone_short_ok()

    long_signal = bool(
        ((_fv(df["t2_delta"], (cur_i - 2))) < (_fv(df["t2_delta"], (cur_i - 3))))
        and ((_fv(df["t2_delta"], cur_i)) > (_fv(df["t2_delta"], (cur_i - 1))))
    )
    short_signal = bool(
        ((_fv(df["t2_delta"], (cur_i - 2))) > (_fv(df["t2_delta"], (cur_i - 3))))
        and ((_fv(df["t2_delta"], cur_i)) < (_fv(df["t2_delta"], (cur_i - 1))))
    )

    snap = _entry_snap_get(self, "t2_delta")
    exit_long = bool((_fv(df["t2_delta"], cur_i)) > (((snap) + 1.2) if pd.notna(snap) else np.nan))
    exit_short = bool((_fv(df["t2_delta"], cur_i)) < (((snap) + -1.2) if pd.notna(snap) else np.nan))

    signal_result = None

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
        api_secret='JcG8eT9n9knHSsUKDkxsoRh3mfXIuFhjXkDsjmntnop6cktHOIBjE6HN3yalqQc6', # pai
        symbol="WLD/USDC:USDC",
        timeframe="1m",
        leverage=10,
        sl_percent=STOP_LOSS_PCT,
        tp_percent=TAKE_PROFIT_PCT,
        buyed=False,
        strategy_name="ema_mean_reversion_wld_1min",
        type_strategy="trend",
        one_trade_per_account=False,
    )
    if not hasattr(bot, "entry_snap"):
        bot.entry_snap = {}
    run(bot)
