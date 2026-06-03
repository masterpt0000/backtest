import pandas as pd
import numpy as np
from configs.get_info_account import *
from configs.get_candles import *
from configs.Actions_trading import *
from configs.Sync_time import *
from configs.bot_main import TradingBot
from configs.Custom_indicators import *
from configs.loop import *

# ==================== Parâmetros (espelho do backtest my_strategies/strong_3min.py) ====================
DIF_EMA_ABS_ENTRY    = 0.0003
FILTER_ADX_MIN       = 70       # LEN_ADX=10 → ADX mais reactivo, threshold alto
LIMIT_BARS           = 200
DIF_EMA_FLAT_ABS     = 0.0015
RSI_VWAP_OVER_SOLD   = 10
RSI_VWAP_OVER_BOUGHT = 90


def indicators(df):
    df['atr']        = ma_function(true_range(df['high'], df['low'], df['close']), 100, "WMA")
    df['ema_fast']   = df['close'].ewm(span=300, min_periods=300, adjust=False).mean()
    df['vwap_close'] = vwap_close_daily(df, df['close'], df['volume'])
    df['RSI_VWAP']   = rsi(df['vwap_close'], 200)
    df['rsi']        = pd.Series(rsi(df['close'], 26), index=df.index)
    df['rsi_higher'] = df['rsi'].rolling(100, min_periods=1).max()
    df['rsi_lower']  = df['rsi'].rolling(100, min_periods=1).min()
    df['vfima_vol']  = vfi_vfima(df, 130, 0.2, 2.5, 5, False)
    df['dif_ema']    = df['ema_fast'] - df['ema_fast'].shift(10)
    df['dif_ema2']   = df['ema_fast'] - df['ema_fast'].shift(10)   # span=300 (igual ao Pine)
    df['dif_rsi']    = df['rsi'] - df['rsi'].shift(20)
    di_plus, di_minus, adx = adx_indicator(df, 10)                 # LEN_ADX=10 (igual backtest)
    df['DIPlus']  = di_plus
    df['DIMinus'] = di_minus
    df['ADX']     = adx
    return df


def strategy(self, df):
    get_current_position(self)
    last_idx = -1
    df = indicators(df)

    atr_value          = round(float(df['atr'].iloc[last_idx]),        4)
    current_dif_ema    = round(float(df['dif_ema'].iloc[last_idx]),    4)
    current_dif_ema2   = round(float(df['dif_ema2'].iloc[last_idx]),   4)
    current_dif_rsi    = round(float(df['dif_rsi'].iloc[last_idx]),    4)
    current_rsi_vwap   = round(float(df['RSI_VWAP'].iloc[last_idx]),   4)
    prev_rsi_vwap      = round(float(df['RSI_VWAP'].iloc[-2]) if len(df) >= 2 else current_rsi_vwap, 4)
    current_rsi        = round(float(df['rsi'].iloc[last_idx]),        4)
    current_rsi_higher = round(float(df['rsi_higher'].iloc[last_idx]), 4)
    current_rsi_lower  = round(float(df['rsi_lower'].iloc[last_idx]),  4)
    current_adx        = round(float(df['ADX'].iloc[last_idx]),        4)

    # ── filter_trend (espelho backtest) ──────────────────────────────────
    filter_trend = (
        current_adx > FILTER_ADX_MIN
        and (current_dif_ema >= 0.0006 or current_dif_ema <= -0.0006)
        and (current_rsi_lower > 25 and current_rsi_higher < 75)
        and (current_dif_rsi < 20 and current_dif_rsi > -20)
    )

    de = float(current_dif_ema)
    long_condition  = de >= DIF_EMA_ABS_ENTRY  and filter_trend
    short_condition = de <= -DIF_EMA_ABS_ENTRY and filter_trend

    print(f"ATR: {atr_value}")
    print(f"ADX: {current_adx}")
    print(f"FILTER_TREND (ADX>{FILTER_ADX_MIN}): {filter_trend}")
    print(f"DIF_EMA: {current_dif_ema}, RSI: {current_rsi}, RSI_VWAP: {current_rsi_vwap}")
    print(f"rsi_higher/lower: {current_rsi_higher}/{current_rsi_lower}")
    print(f"LONG CONDITION: {long_condition}")
    print(f"SHORT CONDITION: {short_condition}")
    print(f"buyed: {self.buyed}")

    # ── Saída por DIF_EMA flat (71 candles) ──────────────────────────────
    if self.position is not None and self.buyed:
        dif_ema_series = df['dif_ema'].dropna()
        if len(dif_ema_series) >= 71:
            last_71 = dif_ema_series.iloc[-71:].values
            if np.all((last_71 <= 0.0003) & (last_71 >= -0.0003)):
                print(f"📤 Saída: DIF_EMA flat (71 candles)")
                return 'sell'

    # EMA2 flat count (rastreio)
    ema2_is_flat = abs(current_dif_ema2) <= DIF_EMA_FLAT_ABS
    if self.position is not None:
        self.flat_ema2_count = self.flat_ema2_count + 1 if ema2_is_flat else 0
    else:
        self.flat_ema2_count = 0

    signal_result = None

    # ── Limpar flag entratada ─────────────────────────────────────────────
    if self.buyed and self.position == 'long'  and self.entratada_fora_rsi_vwap and current_rsi_vwap > RSI_VWAP_OVER_BOUGHT:
        self.entratada_fora_rsi_vwap = False
    if self.buyed and self.position == 'short' and self.entratada_fora_rsi_vwap and current_rsi_vwap < RSI_VWAP_OVER_SOLD:
        self.entratada_fora_rsi_vwap = False

    # ── Saída RSI_VWAP (Pine: só se entratada_fora_rsi_vwap == False) ────
    if self.position == 'long'  and current_rsi_vwap < RSI_VWAP_OVER_BOUGHT and not self.entratada_fora_rsi_vwap and self.buyed:
        self.buyed = False
        self.entratada_fora_rsi_vwap = False
        return 'sell'

    if self.position == 'short' and current_rsi_vwap > RSI_VWAP_OVER_SOLD   and not self.entratada_fora_rsi_vwap and self.buyed:
        self.buyed = False
        self.entratada_fora_rsi_vwap = False
        return 'sell'

    # ── Pending signals (Pine: só activa com posição flat) ───────────────
    if long_condition  and not self.pending_long  and self.position is None:
        self.pending_long  = True
        self.pending_short = False
        self.bars_since_signal = 0
    elif short_condition and not self.pending_short and self.position is None:
        self.pending_short = True
        self.pending_long  = False
        self.bars_since_signal = 0

    if self.pending_long or self.pending_short:
        self.bars_since_signal += 1

    if self.bars_since_signal > LIMIT_BARS:
        self.pending_long  = False
        self.pending_short = False
        self.bars_since_signal = 0

    confirmation_long  = self.pending_long  and current_rsi < 50 and self.bars_since_signal < LIMIT_BARS
    confirmation_short = self.pending_short and current_rsi > 50 and self.bars_since_signal < LIMIT_BARS

    print(f"pending_long: {self.pending_long}, pending_short: {self.pending_short}, bars: {self.bars_since_signal}")
    print(f"confirmation_long: {confirmation_long}, confirmation_short: {confirmation_short}")

    # ── Entradas ──────────────────────────────────────────────────────────
    if confirmation_long and (self.position is None or (self.position == 'short' and self.buyed)):
        self.pending_long  = False
        self.pending_short = False
        self.bars_since_signal = 0
        if current_rsi_vwap < RSI_VWAP_OVER_BOUGHT:
            self.entratada_fora_rsi_vwap = True
        return 'long'

    if confirmation_short and (self.position is None or (self.position == 'long' and self.buyed)):
        self.pending_long  = False
        self.pending_short = False
        self.bars_since_signal = 0
        if current_rsi_vwap > RSI_VWAP_OVER_SOLD:
            self.entratada_fora_rsi_vwap = True
        return 'short'

    return signal_result


if __name__ == "__main__":
    exit()
    bot = TradingBot(
        # api_key='oBCUcH7rlF4HIB0XMmN3UFYUUPjrxEBwbF3rJMbMQ552iqN1RSLVd0fz9HAr95Cd', # meu
        # api_secret='DoS1h2VUbqKK0OpqnZYyD71bunbUNUybR040c0WH2mkEhc5NwCAMa5V7jEDB3vZz',
        api_key='jIFrSBMR8rgFTp2zeIadPvMHXeuL9o6z075OhuGkIYr8lGg1tNCix36pSOC3rfDL',
        api_secret='JcG8eT9n9knHSsUKDkxsoRh3mfXIuFhjXkDsjmntnop6cktHOIBjE6HN3yalqQc6', # pai
        symbol='WLD/USDC:USDC',
        timeframe='3m',
        leverage=5,
        sl_percent=0.01,
        tp_percent=0.5,
        buyed=False,
        strategy_name='trader_trend_strong_3min',
        type_strategy='slow',
    )
    bot.entratada_fora_rsi_vwap = False
    bot.pending_long     = False
    bot.pending_short    = False
    bot.bars_since_signal = 0
    bot.flat_ema2_count  = 0
    bot.wait_candle      = 0
    run(bot)
