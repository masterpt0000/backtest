import pandas as pd
import numpy as np
from configs.bot_main import TradingBot
from configs.loop import *
from configs.Custom_indicators import *

def indicators(df):
    INPUT_RSI = 50
    INPUT_EMA = 10
    ROLL_RSI = 10

    df['rsi'] = pd.Series(rsi(df['close'], INPUT_RSI), index=df.index)
    df['ema'] = df['close'].ewm(span=INPUT_EMA, min_periods=INPUT_EMA, adjust=False).mean()
    df['lowest_rsi'] = df['rsi'].rolling(window=ROLL_RSI, min_periods=ROLL_RSI).min()
    df['highest_rsi'] = df['rsi'].rolling(window=ROLL_RSI, min_periods=ROLL_RSI).max()
    return df

def strategy(self, df):
    get_current_position(self)
    last_idx = -1

    df = indicators(df)
    current_rsi = df['rsi'].iloc[last_idx]
    current_ema = df['ema'].iloc[last_idx]
    prev_ema = df['ema'].iloc[last_idx - 1] if len(df) >= 2 else current_ema
    current_lowest_rsi = df['lowest_rsi'].iloc[last_idx]
    current_highest_rsi = df['highest_rsi'].iloc[last_idx]

    longCondition = current_lowest_rsi < 20
    shortCondition = current_highest_rsi > 80

    exit_long = current_ema < prev_ema and current_lowest_rsi > 40
    exit_short = current_ema > prev_ema and current_highest_rsi < 60

    print(f"RSI: {current_rsi}, lowest_rsi: {current_lowest_rsi}, highest_rsi: {current_highest_rsi}, EMA/EMA[1]: {current_ema}/{prev_ema}")

    signal_result = None

    if self.position == 'long' and exit_long and self.buyed:
        signal_result = 'sell'
        return signal_result

    if self.position == 'short' and exit_short and self.buyed:
        signal_result = 'sell'
        return signal_result

    if longCondition and (self.position == 'short' or self.position is None):
        signal_result = 'long'
        return signal_result

    if shortCondition and (self.position == 'long' or self.position is None):
        signal_result = 'short'
        return signal_result

    return signal_result

if __name__ == "__main__":
    bot = TradingBot(
        # api_key='oBCUcH7rlF4HIB0XMmN3UFYUUPjrxEBwbF3rJMbMQ552iqN1RSLVd0fz9HAr95Cd', # meu
        # api_secret='DoS1h2VUbqKK0OpqnZYyD71bunbUNUybR040c0WH2mkEhc5NwCAMa5V7jEDB3vZz',
        api_key='jIFrSBMR8rgFTp2zeIadPvMHXeuL9o6z075OhuGkIYr8lGg1tNCix36pSOC3rfDL',
        api_secret='JcG8eT9n9knHSsUKDkxsoRh3mfXIuFhjXkDsjmntnop6cktHOIBjE6HN3yalqQc6', # pai
        symbol='WLD/USDC:USDC',
        timeframe='30m',
        leverage=5,
        sl_percent=0.05,
        tp_percent=0.8,
        buyed=False,
        strategy_name='trader_trend_extreme_30min',
        type_strategy='fast',
    )
    run(bot)
