import importlib
import os
import sys
import time
import traceback
import pandas as pd
from configs.get_candles import *
from configs.Sync_time import *
from configs.Actions_trading import *
from configs.get_info_account import *
from configs.discords_alerts import send_bot_error


def _get_strategy_callable(self):
    """
    Carrega a função `strategy` do módulo indicado em self.strategy_name
    (nome do ficheiro sem .py, ex.: trader_trend_lateral_rsi_3min).
    """
    name = (getattr(self, 'strategy_name', None) or '').strip()
    if not name:
        raise ValueError(
            "Define self.strategy_name com o módulo onde está strategy(), "
            "ex.: 'trader_trend_lateral_rsi_3min'"
        )
    if name.endswith('.py'):
        name = name[:-3]
    key = name
    if getattr(self, '_strategy_cache_key', None) == key and getattr(self, '_strategy_fn', None) is not None:
        return self._strategy_fn
    traders_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if traders_root not in sys.path:
        sys.path.insert(0, traders_root)
    mod = importlib.import_module(name)
    if not hasattr(mod, 'strategy'):
        raise AttributeError(f"Módulo '{name}' não define a função strategy(self, df)")
    self._strategy_fn = mod.strategy
    self._strategy_cache_key = key
    return self._strategy_fn


def _get_pre_entry_callable(self):
    name = (getattr(self, 'strategy_name', None) or '').strip()
    if not name:
        return None
    if name.endswith('.py'):
        name = name[:-3]
    key = f"{name}:pre_entry"
    if getattr(self, '_pre_entry_cache_key', None) == key:
        return getattr(self, '_pre_entry_fn', None)
    traders_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if traders_root not in sys.path:
        sys.path.insert(0, traders_root)
    mod = importlib.import_module(name)
    fn = getattr(mod, 'pre_entry_signal', None)
    self._pre_entry_fn = fn if callable(fn) else None
    self._pre_entry_cache_key = key
    return self._pre_entry_fn


def _fetch_current_candle(self):
    timeframe_map = {
        '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
        '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h', '1d': '1d'
    }
    binance_timeframe = timeframe_map.get(self.timeframe, '1m')
    klines = self.client.futures_klines(symbol=self.symbol_internal, interval=binance_timeframe, limit=1)
    if not klines:
        return None
    df = pd.DataFrame(klines, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume',
                                        'close_time', 'quote_volume', 'trades', 'taker_buy_base',
                                        'taker_buy_quote', 'ignore'])
    df = df[['timestamp', 'open', 'high', 'low', 'close', 'volume']].copy()
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
    df[['open', 'high', 'low', 'close', 'volume']] = df[['open', 'high', 'low', 'close', 'volume']].astype(float)
    return df


def _sleep_with_sl_tp_guard(self, seconds):
    """Espera em pequenos intervalos para o guard SL/TP poder fechar posições rápidas."""
    deadline = time.time() + max(0.0, float(seconds or 0))
    poll_sec = max(1.0, float(getattr(self, 'sl_tp_guard_poll_sec', 3.0) or 3.0))
    guard_triggered = False
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            return guard_triggered
        try:
            guard_triggered = enforce_sl_tp_price_guard(self) or guard_triggered
        except Exception as e:
            print(f"⚠️ Erro no guard SL/TP durante espera: {e}")
        time.sleep(min(poll_sec, remaining))


def _wait_for_next_candle_with_guard(self):
    """Sincroniza com o próximo candle sem deixar de vigiar SL/TP local."""
    try:
        current = _fetch_current_candle(self)
        if current is None or len(current) == 0:
            _sleep_with_sl_tp_guard(self, get_timeframe_seconds(self))
            return

        tf_sec = get_timeframe_seconds(self)
        cur_open = current['timestamp'].iloc[-1]
        cur_close = cur_open + pd.Timedelta(seconds=tf_sec)
        wait_time = (cur_close - pd.Timestamp.now(tz='UTC')).total_seconds()
        if wait_time < 0:
            wait_time = tf_sec + wait_time
        if wait_time > tf_sec:
            wait_time = tf_sec
        _sleep_with_sl_tp_guard(self, wait_time if wait_time > 1 else 1)
    except Exception as e:
        print(f"⚠️ Erro ao sincronizar com candle com guard SL/TP: {e}. Usando sleep padrão.")
        _sleep_with_sl_tp_guard(self, get_timeframe_seconds(self))


def _run_pre_entry_until_next_candle(self):
    pre_fn = _get_pre_entry_callable(self)
    if not getattr(self, 'pre_entry_enabled', False) or pre_fn is None:
        _wait_for_next_candle_with_guard(self)
        _sleep_with_sl_tp_guard(self, 5)
        return

    poll_sec = max(1.0, float(getattr(self, 'pre_entry_poll_sec', 5.0)))
    safety_sec = max(0.0, float(getattr(self, 'pre_entry_close_safety_sec', 5.0)))
    tf_sec = get_timeframe_seconds(self)
    started = False
    guard_triggered = False

    while True:
        current = _fetch_current_candle(self)
        if current is None or len(current) == 0:
            guard_triggered = _sleep_with_sl_tp_guard(self, min(poll_sec, 5.0)) or guard_triggered
            continue

        cur_open = current['timestamp'].iloc[-1]
        cur_close = cur_open + pd.Timedelta(seconds=tf_sec)
        now_utc = pd.Timestamp.now(tz='UTC')
        remaining = (cur_close - now_utc).total_seconds()
        if remaining <= safety_sec:
            break

        if enforce_sl_tp_price_guard(self):
            guard_triggered = True
            cancel_pre_entry_order(self, "guard SL/TP fechou posição")

        df_closed = self.df_cache.copy() if getattr(self, 'df_cache', None) is not None else fetch_ohlcv(self, limit=self.cache_size)
        if df_closed is None or len(df_closed) == 0:
            guard_triggered = _sleep_with_sl_tp_guard(self, min(poll_sec, max(1.0, remaining - safety_sec))) or guard_triggered
            continue

        if not guard_triggered:
            try:
                prediction = pre_fn(self, df_closed, current)
                manage_pre_entry_order(self, prediction)
                started = True
            except Exception as e:
                print(f"[PRE] erro no cálculo/gestão de pre-entry: {e}")

        sleep_for = min(poll_sec, max(1.0, remaining - safety_sec))
        guard_triggered = _sleep_with_sl_tp_guard(self, sleep_for) or guard_triggered

    if started:
        print("[PRE] candle a fechar; aguardar finalização OHLC.")
    _sleep_with_sl_tp_guard(self, safety_sec)


def run(self):
    print(f"🚀 Starting trading bot for {self.symbol} on {self.timeframe} timeframe.")
    
    # Primeira execução imediata
    first_run = True
    
    while True:
        try:
            if not first_run:
                _run_pre_entry_until_next_candle(self)

                now_sec = time.time()
                need_full_refresh = (
                    self.last_ohlcv_full_refresh is None or
                    (now_sec - self.last_ohlcv_full_refresh) >= self.ohlcv_refresh_interval_sec
                )

                if need_full_refresh:
                    # De 1h em 1h ou 2h em 2h: apagar todo o OHLC e buscar tudo de novo
                    sync_time_with_binance(self)
                    self.df_cache = None
                    df_fresh = fetch_ohlcv(self, limit=self.cache_size)
                    if df_fresh is not None and len(df_fresh) > 0:
                        self.df_cache = df_fresh.copy()
                        self.last_ohlcv_full_refresh = now_sec
                        df = self.df_cache.copy()
                        print(f"[REFRESH] OHLC completo recarregado ({len(df)} candles).")
                    else:
                        print(f"[AVISO] Falha no refresh completo OHLC. Usando cache...")
                        if self.df_cache is not None:
                            df = self.df_cache.copy()
                        else:
                            continue
                else:
                    # Fetch completo a cada ciclo: evita junção antigo+novo que corrompe RSI/indicadores
                    df_fresh = fetch_ohlcv(self, limit=self.cache_size)
                    if df_fresh is not None and len(df_fresh) > 0:
                        self.df_cache = df_fresh.copy()
                        df = self.df_cache.copy()
                    else:
                        print(f"[AVISO] Falha no fetch OHLC. Usando cache...")
                        if self.df_cache is not None:
                            df = self.df_cache.copy()
                        else:
                            continue
            else:
                first_run = False
                df = fetch_ohlcv(self, limit=self.cache_size)
                self.df_cache = df.copy()
                self.last_ohlcv_full_refresh = time.time()
                if len(df) < self.cache_size:
                    self.cache_size = len(df)
            if df is None or len(df) == 0:
                print(f"⚠️ Nenhum dado disponível. Aguardando...")
                continue
            last_candle_open = df['timestamp'].iloc[-1]
            tf_sec = get_timeframe_seconds(self)
            last_candle_close = last_candle_open + pd.Timedelta(seconds=tf_sec)
            now_utc = pd.Timestamp.now(tz='UTC')
            # Se estamos muito além do fecho da última vela, forçar refresh completo (evitar ficar preso)
            if (now_utc - last_candle_close).total_seconds() > tf_sec + 30 and self.df_cache is not None:
                df_refresh = fetch_ohlcv(self, limit=self.cache_size)
                if df_refresh is not None and len(df_refresh) > 0:
                    self.df_cache = df_refresh.copy()
                    df = self.df_cache.copy()
                    last_candle_open = df['timestamp'].iloc[-1]
                    last_candle_close = last_candle_open + pd.Timedelta(seconds=tf_sec)
                    print(f"🔄 Cache atualizado por refresh (último candle já fechado há mais de 1 ciclo).")
            last_close_str = last_candle_close.strftime('%Y-%m-%d %H:%M:%S') if hasattr(last_candle_close, 'strftime') else str(last_candle_close)
            print(f"coin: {self.symbol} strategy: {self.strategy_name}")
            print(f"📊 Último candle: abertura {last_candle_open} → fechou às {last_close_str} (Total: {len(df)} candles)")
            print(f"⏰ Hora atual: {now_utc.strftime('%Y-%m-%d %H:%M:%S')} UTC")
            
            # Verificar se SL/TP foi atingido desde o último ciclo
            check_sl_tp_hit(self)
            if enforce_sl_tp_price_guard(self):
                cancel_pre_entry_order(self, "guard SL/TP fechou posição")
                continue
            reconcile_pre_entry_order(self)

            signal = _get_strategy_callable(self)(self, df)
            if signal:
                if not getattr(self, 'pre_entry_keep_unfilled_on_confirm', False):
                    cancel_pre_entry_order(self, "sinal confirmado; execução normal")
            else:
                cancel_pre_entry_order(self, "sinal não confirmou no fecho")
            if signal:
                # Log adicional quando trade é executado
                # execute_trade já faz múltiplas tentativas internas (LIMIT maker).
                # Repetir em loop quando a falha é pré-entrada (minQty/margem) só gera spam no Discord.
                status = execute_trade(self, signal)
                if status != "ok":
                    print(f"⚠️ Trade não executada (status={status!r}). A aguardar próximo candle.")
                
        except Exception as e:
            print(f"❌ Error: {e}")
            try:
                send_bot_error(
                    getattr(self, 'strategy_name', 'Bot'),
                    getattr(self, 'symbol', '?'),
                    context="loop.run (ciclo principal)",
                    exception=e,
                    traceback_text=traceback.format_exc(),
                )
            except Exception as ex_disc:
                print(f"[Discord] Falha ao enviar erro do ciclo principal: {ex_disc}")
            # Em caso de erro, espera o timeframe antes de tentar novamente
            time.sleep(get_timeframe_seconds(self))