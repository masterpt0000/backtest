from binance.client import Client
from configs.Sync_time import *
from configs.get_info_account import *
from configs.discords_alerts import install_discord_exception_hooks


class TradingBot:
    def __init__(self, api_key='', api_secret='', symbol='WLD/USDC:USDC', timeframe='1m', leverage=1, sl_percent=0.03, tp_percent=0.007, buyed=False, strategy_name='', type_strategy='', concurrent_bots=1, margin_wallet_share=0.80, margin_entry_buffer_ratio=0.06, one_trade_per_account=True):
        if ':' in symbol:
            base_part = symbol.split(':')[0]  # 'WLD/USDC'
            self.symbol_internal = base_part.replace('/', '')  # 'WLDUSDC'
        else:
            self.symbol_internal = symbol.replace('/', '')
        
        # Inicializar cliente Binance
        self.client = Client(api_key, api_secret)
        sync_time_with_binance(self)
        self.symbol = symbol  # Manter formato original para referência
        self.timeframe = timeframe
        self.leverage = leverage
        self.sl_percent = sl_percent
        self.tp_percent = tp_percent
        get_current_position(self)

        if self.position is None:
            self.client.futures_change_leverage(symbol=self.symbol_internal, leverage=self.leverage)
        self.buyed = buyed
        self.df_cache = None 
        self.cache_size = 5000
        self.ohlcv_refresh_interval_sec = 7200
        self.last_ohlcv_full_refresh = None
        self.strategy_name = strategy_name
        self.type_strategy = type_strategy
        self.concurrent_bots = max(1, int(concurrent_bots))
        self.margin_wallet_share = float(margin_wallet_share)
        self.margin_entry_buffer_ratio = float(margin_entry_buffer_ratio)
        # Se True, não abre posição nova neste par enquanto existir qualquer posição noutro símbolo na mesma conta futures.
        self.one_trade_per_account = bool(one_trade_per_account)
        self.buyed_before_slow = False
        self.entry_time = None          # datetime em que a posição actual foi aberta
        self.trade_direction = None     # 'LONG' ou 'SHORT'
        self._last_close_price = 0.0    # preço de fecho da última ordem LIMIT de saída
        self.sl_tp_guard_enabled = True
        self.sl_tp_guard_poll_sec = 3.0
        self.sl_tp_guard_limit_attempts = 6
        self.sl_tp_guard_timeout_sec = 8
        self.sl_tp_guard_market_fallback = True
        self.pre_entry_enabled = False
        self.pre_entry_dry_run = True
        self.pre_entry_poll_sec = 5.0
        self.pre_entry_close_safety_sec = 5.0
        self.pre_entry_max_distance_pct = 0.35
        self.pre_entry_reprice_pct = 0.03
        self.pre_entry_log_interval_sec = 15.0
        self.pre_entry_keep_unfilled_on_confirm = False
        self.pre_entry_order = {}
        # Excepções não capturadas → Discord (webhook Errors)
        try:
            install_discord_exception_hooks(
                strategy_name or 'TradingBot',
                symbol,
            )
        except Exception:
            pass