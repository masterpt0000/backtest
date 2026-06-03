
# AVISOS EXPORTAÇÃO:
# - Deslocamento [1] em «t3»: em timeframe superior o builder alinha por tempo; aqui usa-se índice simples j−1.
# - Deslocamento [1] em «t3_delta»: em timeframe superior o builder alinha por tempo; aqui usa-se índice simples j−1.
# - Deslocamento [1] em «t3»: em timeframe superior o builder alinha por tempo; aqui usa-se índice simples j−1.
# - Deslocamento [1] em «t3_delta»: em timeframe superior o builder alinha por tempo; aqui usa-se índice simples j−1.
# - Deslocamento [1] em «t3»: em timeframe superior o builder alinha por tempo; aqui usa-se índice simples j−1.
# - Deslocamento [1] em «t3_delta»: em timeframe superior o builder alinha por tempo; aqui usa-se índice simples j−1.
# - Deslocamento [1] em «t3»: em timeframe superior o builder alinha por tempo; aqui usa-se índice simples j−1.
# - Deslocamento [1] em «t3_delta»: em timeframe superior o builder alinha por tempo; aqui usa-se índice simples j−1.
# - Saídas usam entry(...): self.entry_snap é preenchido em cada entrada (ver _capture_entry_snap).

import os
import pandas as pd
import numpy as np
import talib
from configs.get_info_account import *
from configs.get_candles import *
from configs.Actions_trading import *
from configs.Sync_time import *
from configs.loop import *
from configs.Custom_indicators import *
from configs.bot_main import TradingBot

# ── Chart Builder → bot Python (nome: "only ema")
# Requer: pip install TA-Lib (wrapper C talib).
# Séries feat_* ficam NaN até ligares dados QuestDB no teu pipeline.

TAKE_PROFIT_PCT = 100
STOP_LOSS_PCT = 1.5
TRAILING_STOP_PCT = 0

ZONE_LONG_WAIT_CANDLES = 3
ZONE_SHORT_WAIT_CANDLES = 3


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
    df = df.copy()
    # --- OHLCV esperado: open, high, low, close, volume ---
    # t1: talib · RSI
    _t1_rsi = talib.RSI(df["close"].astype(float).values, timeperiod=30)
    df["t1"] = pd.Series(_t1_rsi, index=df.index).astype(float)
    # t2: talib · EMA
    _t2_ema = talib.EMA(df["close"].astype(float).values, timeperiod=10)
    df["t2"] = pd.Series(_t2_ema, index=df.index).astype(float)
    # t3: talib · EMA
    _t3_ema = talib.EMA(df["close"].astype(float).values, timeperiod=100)
    df["t3"] = pd.Series(_t3_ema, index=df.index).astype(float)
    df["t3_delta"] = (df["t3"] - df["t3"].shift(100)) * 1000
    df["t2_delta"] = (df["t2"] - df["t2"].shift(10)) * 1000
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
        wait = 3
        apply_zf = False
        last_true = -1
        for j in range(0, cur_i + 1):
            filter_ok_j = (not apply_zf) or _filter_ok_at(j)
            zone_raw_j = (((((_fv(df["t3"], j)) > (_fv(df["t3"], (j - 1)))) and ((_fv(df["t3_delta"], j)) > (1))) and ((_fv(df["t3_delta"], j)) > (_fv(df["t3_delta"], (j - 1))))))
            if filter_ok_j and zone_raw_j:
                last_true = j
        return last_true >= 0 and (cur_i - last_true) <= wait

    zone_long_ok = _zone_long_ok()

    def _zone_short_ok():
        wait = 3
        apply_zf = True
        last_true = -1
        for j in range(0, cur_i + 1):
            filter_ok_j = (not apply_zf) or _filter_ok_at(j)
            zone_raw_j = (((((_fv(df["t3"], j)) < (_fv(df["t3"], (j - 1)))) and ((_fv(df["t3_delta"], j)) < (-0.4))) and ((_fv(df["t3_delta"], j)) < (_fv(df["t3_delta"], (j - 1))))))
            if filter_ok_j and zone_raw_j:
                last_true = j
        return last_true >= 0 and (cur_i - last_true) <= wait

    zone_short_ok = _zone_short_ok()

    long_signal = bool(((((_fv(df["t2_delta"], cur_i)) < (-0.3)) and ((_fv(df["t2_delta"], cur_i)) > (-0.6))) and ((_fv(df["t1"], cur_i)) > (50))))
    short_signal = bool(((((_fv(df["t2_delta"], cur_i)) > (0.3)) and ((_fv(df["t2_delta"], cur_i)) < (0.6))) and ((_fv(df["t1"], cur_i)) < (50))))

    exit_long = bool(((_fv(df["t2_delta"], cur_i)) > (((_entry_snap_get(self, "t2_delta")) + 1) if pd.notna(_entry_snap_get(self, "t2_delta")) else np.nan)))
    exit_short = bool(((_fv(df["t2_delta"], cur_i)) < (((_entry_snap_get(self, "t2_delta")) + -1) if pd.notna(_entry_snap_get(self, "t2_delta")) else np.nan)))

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
        api_secret='JcG8eT9n9knHSsUKDkxsoRh3mfXIuFhjXkDsjmntnop6cktHOIBjE6HN3yalqQc6', # pai
        symbol="WLD/USDC:USDC",
        timeframe="1m",
        leverage=5,
        sl_percent=STOP_LOSS_PCT / 100.0,
        tp_percent=TAKE_PROFIT_PCT / 100.0,
        # trailing_percent=TRAILING_STOP_PCT / 100.0,
        buyed=False,
        strategy_name="only_ema",
        type_strategy="trend",
        one_trade_per_account=False,
    )
    if not hasattr(bot, "entry_snap"):
        bot.entry_snap = {}
    run(bot)
