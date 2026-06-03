import pandas as pd
import numpy as np
from configs.bot_main import TradingBot
from configs.loop import *
from configs.Custom_indicators import *


def indicators(df):
    INPUT_RSI = 21
    df['rsi'] = pd.Series(rsi(df['close'], INPUT_RSI), index=df.index)
    df['dif_rsi'] = (df['rsi'] - df['rsi'].shift(1)).round(4)
    return df

def strategy(self, df):
    get_current_position(self)
    last_idx = -1

    df = indicators(df)
    current_rsi = df['rsi'].iloc[last_idx]
    current_dif_rsi = df['dif_rsi'].iloc[last_idx]

    filter_trend = True
    longCondition = filter_trend and current_dif_rsi < -15
    shortCondition = filter_trend and current_dif_rsi > 15

    strategy_exit_long = (
        self.rsi_reg is not None and current_rsi > self.rsi_reg + 10
    )
    strategy_exit_short = (
        self.rsi_reg is not None and current_rsi < self.rsi_reg - 10
    )

    print(f"DIF_RSI: {current_dif_rsi}, RSI: {current_rsi}, rsi_reg: {self.rsi_reg}")

    signal_result = None

    if self.position == 'long' and strategy_exit_long and self.buyed:
        signal_result = 'sell'
        self.rsi_reg = None
        self.buyed = False
        return signal_result

    if self.position == 'short' and strategy_exit_short and self.buyed:
        signal_result = 'sell'
        self.rsi_reg = None
        self.buyed = False
        return signal_result

    if longCondition and (self.position == 'short' or self.position is None):
        signal_result = 'long'
        self.rsi_reg = current_rsi
        self.buyed = True
        return signal_result

    if shortCondition and (self.position == 'long' or self.position is None):
        signal_result = 'short'
        self.rsi_reg = current_rsi
        self.buyed = True
        return signal_result

    return signal_result

if __name__ == "__main__":
    bot = TradingBot(
        # api_key='oBCUcH7rlF4HIB0XMmN3UFYUUPjrxEBwbF3rJMbMQ552iqN1RSLVd0fz9HAr95Cd', # meu
        # api_secret='DoS1h2VUbqKK0OpqnZYyD71bunbUNUybR040c0WH2mkEhc5NwCAMa5V7jEDB3vZz',
        api_key='jIFrSBMR8rgFTp2zeIadPvMHXeuL9o6z075OhuGkIYr8lGg1tNCix36pSOC3rfDL',
        api_secret='JcG8eT9n9knHSsUKDkxsoRh3mfXIuFhjXkDsjmntnop6cktHOIBjE6HN3yalqQc6', # pai
        symbol='WLD/USDC:USDC',
        timeframe='15m',
        leverage=5,
        sl_percent=0.04,
        tp_percent=0.05,
        buyed=False,
        strategy_name='trader_trend_fast_15min',
        type_strategy='fast',
    )
    bot.rsi_reg = None
    run(bot)