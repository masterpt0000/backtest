# AVISOS EXPORTAÇÃO:
# Base: Pine «RSI Divergence Indicator» — LONG como no script original; SHORT com regras espelhadas
# (entrada em divergência bear + RSI alto; saída em crossunder para nível simétrico ou divergência bull).
# Pivots no RSI conforme pivothigh/low(osc, lbL, lbR), confirmados apos lbR barras.

import numpy as np
import pandas as pd
import talib

from configs.get_info_account import *
from configs.get_candles import *
from configs.Actions_trading import *
from configs.Sync_time import *
from configs.loop import *
from configs.Custom_indicators import *
from configs.bot_main import TradingBot

# ── RSI Divergence · WLD · 1m (TradingView RSI Period 17; pivots lbL=1 lbR=3)
# Pinescript defaults (nao usar trailing PERC/ATR no bot: SL/TP vêm dos % do TradingBot + ordens LIMIT)

RSI_PERIOD = 17
PLOT_BULL = True
PLOT_HIDDEN_BULL = True
PLOT_BEAR = True
# Espelha o lado bull (hidden bear activo para shorts simétricos aos longs com hidden bull)
PLOT_HIDDEN_BEAR = True
LB_L = 1
LB_R = 3
# Saída LONG: crossover RSI acima disto (Pine takeProfitRSILevel)
TAKE_PROFIT_RSI_LEVEL = 70
# Saída SHORT: crossunder RSI abaixo disto (espelho em torno de 50: 100 - 70)
TAKE_PROFIT_RSI_SHORT_LEVEL = 30
RANGE_UPPER = 60
RANGE_LOWER = 5
# Entrada LONG: RSI abaixo disto; entrada SHORT: RSI acima do espelho (100 - valor)
ENTRY_RSI_MAX = 40
ENTRY_RSI_MIN_FOR_SHORT = 100 - ENTRY_RSI_MAX

TAKE_PROFIT_PCT = 0.02
STOP_LOSS_PCT = 0.01
TRAILING_STOP_PCT = 0


def _confirmed_pivot_low(osc_arr, i_confirm: int, n: int) -> bool:
    """Pine pivotlow(osc, lbL, lbR): centro no indice p = i_confirm - lbR."""
    lb_l = LB_L
    lb_r = LB_R
    if i_confirm - lb_r < lb_l:
        return False
    if i_confirm >= n:
        return False
    p = i_confirm - lb_r
    if p + lb_r >= n:
        return False
    val = osc_arr[p]
    if not np.isfinite(val):
        return False
    for k in range(1, lb_l + 1):
        if not np.isfinite(osc_arr[p - k]):
            return False
        if osc_arr[p - k] < val:
            return False
    for k in range(1, lb_r + 1):
        if not np.isfinite(osc_arr[p + k]):
            return False
        if osc_arr[p + k] < val:
            return False
    return True


def _confirmed_pivot_high(osc_arr, i_confirm: int, n: int) -> bool:
    """Pine pivothigh."""
    lb_l = LB_L
    lb_r = LB_R
    if i_confirm - lb_r < lb_l:
        return False
    if i_confirm >= n:
        return False
    p = i_confirm - lb_r
    if p + lb_r >= n:
        return False
    val = osc_arr[p]
    if not np.isfinite(val):
        return False
    for k in range(1, lb_l + 1):
        if not np.isfinite(osc_arr[p - k]):
            return False
        if osc_arr[p - k] > val:
            return False
    for k in range(1, lb_r + 1):
        if not np.isfinite(osc_arr[p + k]):
            return False
        if osc_arr[p + k] > val:
            return False
    return True


def _collect_low_pivot_events(
    osc_arr, low_arr, upto_i: int, n: int
):
    """Lista (indice_confirmacao, rsi_no_pivot, low_no_pivot) ate upto_i inclusivo."""
    start = LB_L + LB_R
    out = []
    for ci in range(start, upto_i + 1):
        if not _confirmed_pivot_low(osc_arr, ci, n):
            continue
        p = ci - LB_R
        out.append((ci, float(osc_arr[p]), float(low_arr[p])))
    return out


def _collect_high_pivot_events(
    osc_arr, high_arr, upto_i: int, n: int
):
    start = LB_L + LB_R
    out = []
    for ci in range(start, upto_i + 1):
        if not _confirmed_pivot_high(osc_arr, ci, n):
            continue
        p = ci - LB_R
        out.append((ci, float(osc_arr[p]), float(high_arr[p])))
    return out


def indicators(df):
    df = df.copy()
    _rsi = talib.RSI(df["close"].astype(float).values, timeperiod=RSI_PERIOD)
    df["osc"] = pd.Series(_rsi, index=df.index).astype(float)
    return df


def strategy(self, df):
    get_current_position(self)
    print(f"POSITION: {self.position}")

    df = indicators(df)
    osc = df["osc"]
    osc_arr = osc.to_numpy(dtype=float)
    low_arr = df["low"].to_numpy(dtype=float)
    high_arr = df["high"].to_numpy(dtype=float)

    n = len(df)
    cur_i = n - 1
    warmup = RSI_PERIOD + LB_L + LB_R + 10
    if cur_i < warmup:
        print(f"⚠️ Barras insuficientes ({n}); minimo recomendado {warmup + 50}.")
        return None

    pl_found = bool(_confirmed_pivot_low(osc_arr, cur_i, n))
    ph_found = bool(_confirmed_pivot_high(osc_arr, cur_i, n))

    low_events = _collect_low_pivot_events(osc_arr, low_arr, cur_i, n)
    high_events = _collect_high_pivot_events(osc_arr, high_arr, cur_i, n)

    bull_cond = False
    hidden_bull_cond = False
    bear_cond = False
    hidden_bear_cond = False

    if (
        pl_found
        and len(low_events) >= 2
        and low_events[-1][0] == cur_i
    ):
        _ci_prev, rsi_prev, low_prev = low_events[-2]
        _ci_curr, rsi_cur, low_cur = low_events[-1]
        dgap = _ci_curr - _ci_prev
        pivot_in_range = RANGE_LOWER <= dgap <= RANGE_UPPER
        osc_hl = rsi_cur > rsi_prev
        price_ll = low_cur < low_prev
        osc_ll = rsi_cur < rsi_prev
        price_hl = low_cur > low_prev
        if PLOT_BULL:
            bull_cond = pivot_in_range and osc_hl and price_ll
        if PLOT_HIDDEN_BULL:
            hidden_bull_cond = pivot_in_range and osc_ll and price_hl

    if (
        ph_found
        and len(high_events) >= 2
        and high_events[-1][0] == cur_i
    ):
        _ci_prev_h, rsi_prev_h, high_prev_h = high_events[-2]
        _ci_curr_h, rsi_cur_h, high_cur_h = high_events[-1]
        hgap = _ci_curr_h - _ci_prev_h
        pivot_in_range_h = RANGE_LOWER <= hgap <= RANGE_UPPER
        osc_lh = rsi_cur_h < rsi_prev_h
        price_hh = high_cur_h > high_prev_h
        osc_hh_r = rsi_cur_h > rsi_prev_h
        price_lh_r = high_cur_h < high_prev_h
        if PLOT_BEAR:
            bear_cond = pivot_in_range_h and osc_lh and price_hh
        if PLOT_HIDDEN_BEAR:
            hidden_bear_cond = pivot_in_range_h and osc_hh_r and price_lh_r

    rsi_now = float(osc_arr[cur_i])
    rsi_prev_bar = float(osc_arr[cur_i - 1])
    long_condition = (
        (bull_cond or hidden_bull_cond)
        and np.isfinite(rsi_now)
        and rsi_now < ENTRY_RSI_MAX
    )
    rsi_cross_above_tp = (
        np.isfinite(rsi_now)
        and np.isfinite(rsi_prev_bar)
        and rsi_prev_bar < TAKE_PROFIT_RSI_LEVEL
        and rsi_now > TAKE_PROFIT_RSI_LEVEL
    )
    # Saída SHORT espelhada: crossunder abaixo do nível «oversold» ou divergência bull (como o long usava bear)
    rsi_cross_below_short_tp = (
        np.isfinite(rsi_now)
        and np.isfinite(rsi_prev_bar)
        and rsi_prev_bar > TAKE_PROFIT_RSI_SHORT_LEVEL
        and rsi_now < TAKE_PROFIT_RSI_SHORT_LEVEL
    )
    long_close_strategy = rsi_cross_above_tp or bear_cond
    short_close_strategy = rsi_cross_below_short_tp or bull_cond

    short_condition = (
        (bear_cond or hidden_bear_cond)
        and np.isfinite(rsi_now)
        and rsi_now > ENTRY_RSI_MIN_FOR_SHORT
    )

    if pl_found or ph_found:
        tags = []
        if bull_cond:
            tags.append("bull")
        if hidden_bull_cond:
            tags.append("h_bull")
        if bear_cond:
            tags.append("bear")
        if hidden_bear_cond:
            tags.append("h_bear")
        if tags:
            print(f"Pivots: pl={pl_found} ph={ph_found} | RSI={rsi_now:.2f} | " + ",".join(tags))

    # Saídas primeiro, depois entradas (igual aos outros bots)
    if self.position == "long" and long_close_strategy:
        return "sell"

    if self.position == "short" and short_close_strategy:
        return "sell"

    if long_condition and self.position in (None, "short"):
        return "long"

    if short_condition and self.position in (None, "long"):
        return "short"

    return None


if __name__ == "__main__":
    bot = TradingBot(
        api_key='jIFrSBMR8rgFTp2zeIadPvMHXeuL9o6z075OhuGkIYr8lGg1tNCix36pSOC3rfDL',
        api_secret='JcG8eT9n9knHSsUKDkxsoRh3mfXIuFhjXkDsjmntnop6cktHOIBjE6HN3yalqQc6', # pai
        symbol="WLD/USDC:USDC",
        timeframe="5m",
        leverage=10,
        sl_percent=STOP_LOSS_PCT,
        tp_percent=TAKE_PROFIT_PCT,
        buyed=False,
        strategy_name="rsi_divergence_wld_1min",
        type_strategy="trend",
        one_trade_per_account=False,
    )
    run(bot)
