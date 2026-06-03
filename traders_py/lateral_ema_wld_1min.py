# Chart Builder → bot Python (nome: "lateral ema wld 1min")
#
# CORRECÇÃO (paridade com chart):
# - O export omitiu `t2_delta` porque as regras referem apenas d1/d2/t3/t1 — sem Δ o mercado ficava sempre bloqueado.
# - TA-Lib NATR usa high/low/close.
# - Fórmulas exportadas «max(t2_delta,500)» / «min(t2_delta,500)» literais fazem sempre falhar «d1<1.5 e d2>-1.5»
#   (clips errados nos sinais). Aqui «d1»= mínimo com +500 / «d2»= máximo com −500 = clip assimétrico do slope.
#
# Ajustar T2_DELTA_LOOKBACK ao «Δ barras» do indicador t2 no builder (effectiveDeltaLookbackBars).

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

TAKE_PROFIT_PCT = 0.01
STOP_LOSS_PCT = 0.01
TRAILING_STOP_PCT = 0

ZONE_LONG_WAIT_CANDLES = 10
ZONE_SHORT_WAIT_CANDLES = 10

# Igual a exportChartBuilderTradingBotPy: (t2 − shift(lb)) / fecho × 1000 quando normaliza pelo preço.
T2_DELTA_LOOKBACK = 10
T2_DELTA_CLIP = 500.0


def _ensure_ohlcv_columns(df: pd.DataFrame) -> pd.DataFrame:
    lowmap = {c.lower(): c for c in df.columns}
    need = ["open", "high", "low", "close", "volume"]
    missing = [x for x in need if x not in lowmap]
    if missing:
        raise ValueError(f"lateral_ema_wld_1min: faltam colunas OHLCV: {missing} (tem {list(df.columns)})")
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
        "t1": _fv(df["t1"], cur_i),
    }


def indicators(df):
    df = _ensure_ohlcv_columns(df.copy())

    hi = df["high"].astype(np.float64).values
    lo = df["low"].astype(np.float64).values
    cl = df["close"].astype(np.float64).values

    # t1: talib · RSI
    _t1_rsi = talib.RSI(cl, timeperiod=5)
    df["t1"] = pd.Series(_t1_rsi, index=df.index).astype(float)

    # t2: talib · EMA
    _t2_ema = talib.EMA(cl, timeperiod=100)
    df["t2"] = pd.Series(_t2_ema, index=df.index).astype(float)

    lb = max(1, min(500, int(T2_DELTA_LOOKBACK)))
    _d_raw = df["t2"] - df["t2"].shift(lb)
    df["t2_delta"] = (_d_raw / df["close"].replace(0.0, np.nan)) * 1000

    td = df["t2_delta"].astype(np.float64)
    # Filtro: d1 < 1.5 e d2 > -1.5 — clip outliers do slope antes de comparar à banda «lateral»
    df["d1"] = pd.Series(np.minimum(td, T2_DELTA_CLIP), index=df.index).astype(float)
    df["d2"] = pd.Series(np.maximum(td, -T2_DELTA_CLIP), index=df.index).astype(float)

    # t3: talib · NATR(22)
    _t3_natr = talib.NATR(hi, lo, cl, timeperiod=22)
    df["t3"] = pd.Series(_t3_natr, index=df.index).astype(float)
    print("df[t3].iloc[-1]:", df["t3"].iloc[-1])
    print("df[t1].iloc[-1]:", df["t1"].iloc[-1])
    print("df[t2].iloc[-1]:", df["t2"].iloc[-1])

    return df


def strategy(self, df):
    get_current_position(self)
    print(f"POSITION: {self.position}")
    last_idx = -1
    df = indicators(df)

    n = len(df)
    cur_i = n + last_idx

    def _filter_ok_at(j):
        return (
            ((_fv(df["d1"], j) < (1.5)) and (_fv(df["d2"], j) > (-1.5))) and ((_fv(df["t3"], j)) > (0.11) and ((_fv(df["t3"], j)) < (0.15)))
        )

    market_ok = _filter_ok_at(cur_i)
    zone_long_ok = True
    zone_short_ok = True

    long_signal = bool(((_fv(df["t1"], cur_i)) < (10))) and market_ok
    short_signal = bool(((_fv(df["t1"], cur_i)) > (90))) and market_ok

    exit_long = bool(
        (_fv(df["t1"], cur_i))
        > (((_entry_snap_get(self, "t1")) + 50) if pd.notna(_entry_snap_get(self, "t1")) else np.nan)
    )
    exit_short = bool(
        (_fv(df["t1"], cur_i))
        < (((_entry_snap_get(self, "t1")) + -50) if pd.notna(_entry_snap_get(self, "t1")) else np.nan)
    )

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
        leverage=10,
        sl_percent=STOP_LOSS_PCT,
        tp_percent=TAKE_PROFIT_PCT,
        buyed=False,
        strategy_name="lateral_ema_wld_1min",
        type_strategy="trend",
        one_trade_per_account=False,
    )
    if not hasattr(bot, "entry_snap"):
        bot.entry_snap = {}
    run(bot)
