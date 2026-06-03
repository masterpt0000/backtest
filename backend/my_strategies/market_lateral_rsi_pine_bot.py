"""
Market Lateral RSI — porta do Pine v6 (bott72341) para o teu TradingBot (`configs.*`).

Para correr só precisas do pacote `configs` onde estiverem definidos os helpers custom
(`rsi`, `vwap_close_daily`, `adx_indicator`, etc.) como no ambiente atual do bot.

Uso rápido a partir da raiz onde `configs` é importável:
  set BOT_API_KEY / BOT_API_SECRET
  python -m backend.my_strategies.market_lateral_rsi_pine_bot

Ou copies este ficheiro para a pasta do bot e faz ``python market_lateral_rsi_pine_bot.py``.
"""

from __future__ import annotations

import os

import numpy as np
import pandas as pd

from configs.get_info_account import *  # noqa: F403
from configs.get_candles import *  # noqa: F403
from configs.Actions_trading import *  # noqa: F403
from configs.Sync_time import *  # noqa: F403
from configs.loop import *  # noqa: F403
from configs.Custom_indicators import *  # noqa: F403
from configs.bot_main import TradingBot

# ── Pine v6 "Market Lateral RSI" (bott72341): length_ema=100, length_ema2=1,
#    length_ema3=1000, dif_obv_norm = dif_obv / sma(volume,1000),
#    filter_trend inclui dif_pct2 ±0.8

LENGTH_ATR = 100
LENGTH_EMA_FAST = 100
LENGTH_EMA2 = 1
LENGTH_EMA_SLOW = 1000
DIF_EMA_SHIFT = 10
LEN_RSI = 9
RSI_VWAP_LEN = 1
LEN_ADX = 10  # definido aqui como no Pine original; DI/ADX chamado com período literal 10
LENGTH_FIB = 300
MULT_FIB = 1.1
VOL_SMA_OBV = 1000
RSI_OVER_SOLD = 25
RSI_OVER_BOUGHT = 75
RSI_VWAP_OS = 15
RSI_VWAP_OB = 85


def indicators(df):
    df = df.copy()
    df["atr"] = ma_function(true_range(df["high"], df["low"], df["close"]), LENGTH_ATR, "WMA")
    df["ema_fast"] = df["close"].ewm(span=LENGTH_EMA_FAST, min_periods=LENGTH_EMA_FAST, adjust=False).mean()
    df["ema"] = df["close"].ewm(span=LENGTH_EMA2, min_periods=max(1, LENGTH_EMA2), adjust=False).mean()
    df["ema_slow"] = df["close"].ewm(span=LENGTH_EMA_SLOW, min_periods=LENGTH_EMA_SLOW, adjust=False).mean()
    df["vwap_close"] = vwap_close_daily(df, df["close"], df["volume"])
    df["RSI_VWAP"] = rsi(df["vwap_close"], RSI_VWAP_LEN)
    rsi_arr = rsi(df["close"], LEN_RSI)
    df["rsi"] = pd.Series(rsi_arr, index=df.index).round(4)
    df["cumVol"] = df["volume"].fillna(0).cumsum()
    obv_raw = np.sign(df["close"].diff().fillna(0)) * df["volume"].fillna(0)
    df["obv"] = obv_raw.cumsum()
    df["dif_obv"] = df["obv"] - df["obv"].shift(1)

    df["dif_ema"] = df["ema_fast"] - df["ema_fast"].shift(DIF_EMA_SHIFT)
    df["dif_ema2"] = df["ema"] - df["ema"].shift(DIF_EMA_SHIFT)
    df["dif_ema3"] = df["ema_slow"] - df["ema_slow"].shift(DIF_EMA_SHIFT)
    df["atr_pct"] = (df["atr"] / df["close"]) * 100
    df["dif_pct"] = (df["dif_ema"] / df["ema_fast"]) * 100
    df["dif_pct2"] = (df["dif_ema2"] / df["ema"]) * 100
    di_plus, di_minus, adx = adx_indicator(df, LEN_ADX)
    df["DIPlus"] = di_plus.round(4)
    df["DIMinus"] = di_minus.round(4)
    df["ADX"] = adx.round(4)
    df["dif_ADX"] = df["ADX"] - df["ADX"].shift(5)
    upper_6, lower_6 = calc_envelope_fibonacci(df, LENGTH_FIB, MULT_FIB)
    df["upper_6"] = upper_6.round(4)
    df["lower_6"] = lower_6.round(4)
    vol_sma_obv = df["volume"].rolling(VOL_SMA_OBV, min_periods=1).mean()
    df["dif_obv_norm"] = (df["dif_obv"] / vol_sma_obv.replace({0: np.nan})).replace([np.inf, -np.inf], np.nan)
    return df


def strategy(self, df):
    get_current_position(self)
    print(f"POSITION: {self.position}")

    if not hasattr(self, "flat_ema2_count"):
        self.flat_ema2_count = 0
    if not hasattr(self, "get_out_count"):
        self.get_out_count = 0
    if not hasattr(self, "wait_candle"):
        self.wait_candle = 0

    last_idx = -1
    df = indicators(df)

    atr_value = float(df["atr"].iloc[last_idx])
    atr_pct_value = float(df["atr_pct"].iloc[last_idx])
    current_dif_ema = float(df["dif_ema"].iloc[last_idx])
    current_dif_pct = float(df["dif_pct"].iloc[last_idx])
    current_dif_ema2 = float(df["dif_ema2"].iloc[last_idx])
    current_dif_pct2 = float(df["dif_pct2"].iloc[last_idx])
    current_rsi_vwap = df["RSI_VWAP"].iloc[last_idx]
    current_rsi = df["rsi"].iloc[last_idx]
    current_adx = df["ADX"].iloc[last_idx]
    current_upper_6 = df["upper_6"].iloc[last_idx]
    current_lower_6 = df["lower_6"].iloc[last_idx]
    current_close = df["close"].iloc[last_idx]
    current_obv = df["obv"].iloc[last_idx]
    current_dif_obv = df["dif_obv"].iloc[last_idx]
    current_dif_obv_norm = df["dif_obv_norm"].iloc[last_idx]

    ema2_is_flat = abs(float(current_dif_pct2)) <= 0.55
    if self.position is not None:
        self.flat_ema2_count = self.flat_ema2_count + 1 if ema2_is_flat else 0
    else:
        self.flat_ema2_count = 0

    filter_trend = bool(
        atr_pct_value < 1
        and current_lower_6 < current_close
        and current_upper_6 > current_close
        and current_dif_pct <= 0.18
        and current_dif_pct >= -0.18
        and pd.notna(current_dif_obv_norm)
        and float(current_dif_obv_norm) < 8.5
        and float(current_dif_obv_norm) > -8.5
        and pd.notna(current_dif_pct2)
        and current_dif_pct2 <= 0.8
        and current_dif_pct2 >= -0.8
    )

    get_out = (current_lower_6 > current_close or current_upper_6 < current_close) and (not filter_trend)
    if self.position is not None:
        self.get_out_count = self.get_out_count + 1 if get_out else 0
    else:
        self.get_out_count = 0

    if getattr(self, "wait_candle", 0) > 0:
        self.wait_candle = self.wait_candle - 1

    print(f"ATR: {atr_value}")
    print(f"ATR_PCT: {atr_pct_value}")
    print(f"DIF_PCT: {current_dif_pct}")
    print(f"DIF_PCT2: {current_dif_pct2}")
    print(f"ADX: {current_adx}")
    print(f"LOWER_6: {current_lower_6}")
    print(f"UPPER_6: {current_upper_6}")
    print(f"FILTER_TREND: {filter_trend}")

    cr = float(current_rsi) if pd.notna(current_rsi) else np.nan
    crv = float(current_rsi_vwap) if pd.notna(current_rsi_vwap) else np.nan
    longCondition = (
        filter_trend and pd.notna(cr) and cr < RSI_OVER_SOLD and pd.notna(crv) and crv < RSI_VWAP_OS
    )
    shortCondition = (
        filter_trend and pd.notna(cr) and cr > RSI_OVER_BOUGHT and pd.notna(crv) and crv > RSI_VWAP_OB
    )

    print(f"RSI: {current_rsi}")
    print(f"RSI_VWAP: {current_rsi_vwap}")
    print(f"OBV: {current_obv}, DIF_OBV: {current_dif_obv}, DIF_OBV_NORM: {current_dif_obv_norm}")
    print(f"LONG CONDITION: {longCondition}")
    print(f"SHORT CONDITION: {shortCondition}")
    print(f"buyed: {self.buyed}")

    signal_result = None
    exit_long = current_rsi > 50
    exit_short = current_rsi < 50

    if longCondition and (self.position == "short" or self.position is None):
        signal_result = "long"
        return signal_result

    if shortCondition and (self.position == "long" or self.position is None):
        signal_result = "short"
        return signal_result

    if self.position is not None and self.flat_ema2_count >= 15 and self.buyed:
        signal_result = "sell"
        self.wait_candle = 5
        print(f"📤 Saída: EMA2 flat (>=15 candles) (flat_ema2_count={self.flat_ema2_count})")
        return signal_result

    if self.position is not None and self.get_out_count >= 5 and self.buyed:
        signal_result = "sell"
        self.wait_candle = 10
        print(f"📤 Saída: get_out (>=5 candles) (get_out_count={self.get_out_count})")
        return signal_result

    if self.position == "long" and exit_long and self.buyed:
        signal_result = "sell"
        return signal_result

    if self.position == "short" and exit_short and self.buyed:
        signal_result = "sell"
        return signal_result

    return signal_result


if __name__ == "__main__":
    api_key = os.environ.get("BOT_API_KEY", "")
    api_secret = os.environ.get("BOT_API_SECRET", "")
    if not api_key or not api_secret:
        raise SystemExit(
            "Define BOT_API_KEY e BOT_API_SECRET no ambiente antes de correr este script."
        )
    bot = TradingBot(
        api_key=api_key,
        api_secret=api_secret,
        symbol="WLD/USDC:USDC",
        timeframe="3m",
        leverage=10,
        sl_percent=0.03,
        tp_percent=0.03,
        buyed=False,
        strategy_name="trader_trend_lateral_rsi_3min",
        type_strategy="trend",
        one_trade_per_account=False,
    )

    bot.wait_candle = 0
    bot.flat_ema2_count = 0
    bot.get_out_count = 0
    run(bot)
