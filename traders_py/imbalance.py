# Chart Builder → bot Python (nome: "imbalance")
#
# CORRECÇÃO CRÍTICA: t2 era ``np.nan`` (TODO não preenchido). Sem Linha A/D real,
# ``t2_delta`` está sempre NaN e as zonas long/short **nunca** batem com o site.
#
# TA-Lib ``AD`` = Chaikin Accumulation/Distribution (usa OHLCV; **não** aceita timeperiod).
# O export ``params={"timeperiod":100}`` mistura com o **lookback** do delta em baixo (shift 100).
#
# Outras causas típicas de divergência vs site:
# - Histórico mais curto no bot → valores no último índice diferentes do chart “full history”.
# - Vela em formação vs fechada (chart por defeito pode usar só velas fechadas).
# - Volume/feeds diferentes por exchange.

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
STOP_LOSS_PCT = 0.01
TRAILING_STOP_PCT = 0

ZONE_LONG_WAIT_CANDLES = 0
ZONE_SHORT_WAIT_CANDLES = 0

# Igual ao builder exportado (Δ vs N barras ×1000).
T2_DELTA_LOOKBACK = 100
T3_DELTA_LOOKBACK = 30
T2_DELTA_SLOPE_LOOKBACK = 30  # comparação t2_delta[j] vs t2_delta[j−30]


def _ensure_ohlcv_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Normaliza nomes para minúsculas (o chart/API também aceita maiúsculas)."""
    lowmap = {c.lower(): c for c in df.columns}
    need = ["open", "high", "low", "close", "volume"]
    missing = [x for x in need if x not in lowmap]
    if missing:
        raise ValueError(f"imbalance: faltam colunas OHLCV: {missing} (tem {list(df.columns)})")
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
    vo = df["volume"].astype(np.float64).values
    vo = np.where(np.isfinite(vo), vo, 0.0)

    # t1: talib · RSI
    _t1_rsi = talib.RSI(cl, timeperiod=5)
    df["t1"] = pd.Series(_t1_rsi, index=df.index).astype(float)

    # t2: Chaikin A/D Line (TradingView «Accumulation/Distribution» compatível TA-Lib).
    _ad = talib.AD(hi, lo, cl, vo)
    df["t2"] = pd.Series(_ad, index=df.index).astype(float)

    # Se no futuro o chart usar média móvel sobre AD com período N, descomenta:
    # df["t2"] = df["t2"].rolling(N, min_periods=1).mean()

    # t3 / t4: EMA
    _t3_ema = talib.EMA(cl, timeperiod=30)
    df["t3"] = pd.Series(_t3_ema, index=df.index).astype(float)
    _t4_ema = talib.EMA(cl, timeperiod=10)
    df["t4"] = pd.Series(_t4_ema, index=df.index).astype(float)

    df["t2_delta"] = (df["t2"] - df["t2"].shift(T2_DELTA_LOOKBACK)) * 1000
    df["t3_delta"] = (df["t3"] - df["t3"].shift(T3_DELTA_LOOKBACK)) * 1000
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

    def _zone_long_ok():
        wait = ZONE_LONG_WAIT_CANDLES
        apply_zf = True
        last_true = -1
        for j in range(0, cur_i + 1):
            filter_ok_j = (not apply_zf) or _filter_ok_at(j)
            zone_raw_j = (
                (_fv(df["t2_delta"], j) > 200000000)
                and (_fv(df["t3_delta"], j) < 0)
                and (_fv(df["t2_delta"], j) > _fv(df["t2_delta"], j - T2_DELTA_SLOPE_LOOKBACK))
            )
            if filter_ok_j and zone_raw_j:
                last_true = j
        return last_true >= 0 and (cur_i - last_true) <= wait

    zone_long_ok = _zone_long_ok()

    def _zone_short_ok():
        wait = ZONE_SHORT_WAIT_CANDLES
        apply_zf = True
        last_true = -1
        for j in range(0, cur_i + 1):
            filter_ok_j = (not apply_zf) or _filter_ok_at(j)
            zone_raw_j = (
                (_fv(df["t2_delta"], j) < -200000000)
                and (_fv(df["t3_delta"], j) > 0)
                and (_fv(df["t2_delta"], j) < _fv(df["t2_delta"], j - T2_DELTA_SLOPE_LOOKBACK))
            )
            if filter_ok_j and zone_raw_j:
                last_true = j
        return last_true >= 0 and (cur_i - last_true) <= wait

    zone_short_ok = _zone_short_ok()

    long_signal = bool(_fv(df["t1"], cur_i) < 10)
    short_signal = bool(_fv(df["t1"], cur_i) > 90)

    exit_long = bool(
        (_fv(df["t1"], cur_i) > ((_entry_snap_get(self, "t1") + 50) if pd.notna(_entry_snap_get(self, "t1")) else np.nan))
    )
    exit_short = bool(
        (_fv(df["t1"], cur_i) < ((_entry_snap_get(self, "t1") + -50) if pd.notna(_entry_snap_get(self, "t1")) else np.nan))
    )

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
        strategy_name="imbalance",
        type_strategy="trend",
        one_trade_per_account=False,
    )
    if not hasattr(bot, "entry_snap"):
        bot.entry_snap = {}
    run(bot)
