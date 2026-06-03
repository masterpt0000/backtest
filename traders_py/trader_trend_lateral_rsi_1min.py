from binance.client import Client
import time
import pandas as pd
import numpy as np
import os
from datetime import datetime

class TradingBot:
    def __init__(self, exchange_name='binance', api_key='', api_secret='', symbol='WLD/USDC:USDC', timeframe='1m', leverage=1, sl_percent=0.01, tp_percent=0.02, input_confirmation_rsi=False, entry_limit_timeout=90, entry_aggressive_after_sec=25, entry_market_fallback=True):
        # Converter símbolo ccxt para formato Binance
        # Exemplo: 'WLD/USDC:USDC' -> 'WLDUSDC'
        if ':' in symbol:
            base_part = symbol.split(':')[0]  # 'WLD/USDC'
            self.symbol_internal = base_part.replace('/', '')  # 'WLDUSDC'
        else:
            self.symbol_internal = symbol.replace('/', '')
        
        # Inicializar cliente Binance
        self.client = Client(api_key, api_secret)
        self._sync_time_with_binance()
        self.symbol = symbol  # Manter formato original para referência
        self.timeframe = timeframe
        self.leverage = leverage
        self.sl_percent = sl_percent
        self.tp_percent = tp_percent
        # Entrada: tempo total para limit (s), após N s coloca limit mais agressiva, e fallback MARKET se não preencher
        self.entry_limit_timeout = entry_limit_timeout
        self.entry_aggressive_after_sec = entry_aggressive_after_sec
        self.entry_market_fallback = entry_market_fallback
        self.get_current_position()

        if self.position is None:
            self.client.futures_change_leverage(symbol=self.symbol_internal, leverage=self.leverage)
        self.buyed = False
        # Cache de dados OHLCV para otimização
        self.df_cache = None  # DataFrame em cache com candles históricos
        self.cache_size = 1000  # Número fixo de candles a manter no cache
        # Refresh completo OHLC: a cada X horas apagar tudo e buscar de novo (evitar dados incorretos)
        self.ohlcv_refresh_interval_sec = 7200  # 2h (ou 3600 para 1h)
        self.last_ohlcv_full_refresh = None
        # Contador de candles consecutivos com EMA2 flat (saída por lateralização)
        self.flat_ema2_count = 0

    def _sync_time_with_binance(self):
        """Sincroniza o relogio local com o servidor Binance para evitar erro -1021 (Timestamp ahead)."""
        try:
            server_time = self.client.futures_time()
            server_ms = server_time['serverTime']
            local_ms = int(time.time() * 1000)
            offset = server_ms - local_ms
            self.client.timestamp_offset = offset
            if abs(offset) > 1000:
                print(f"[TIME] Hora sincronizada: offset {offset}ms ({offset/1000:.1f}s) com servidor Binance")
        except Exception as e:
            print(f"[AVISO] Nao foi possivel sincronizar hora com Binance: {e}")

    def _get_position_quantity(self):
        """
        Obtém a quantidade real da posição atual e retorna ajustada conforme precisão.
        Retorna None se não houver posição aberta.
        """
        try:
            positions = self.client.futures_position_information(symbol=self.symbol_internal)
            if positions and len(positions) > 0:
                pos_data = positions[0]
                position_amt = float(pos_data['positionAmt'])
                
                if abs(position_amt) > 0:
                    # Ajustar quantidade conforme precisão
                    return self._adjust_quantity(abs(position_amt))
            return None
        except Exception as e:
            print(f"⚠️ Erro ao obter quantidade da posição: {e}")
            return None

    def _adjust_quantity(self, quantity):
        """
        Ajusta a quantidade conforme os filtros do símbolo (stepSize, minQty).
        Retorna a quantidade como string formatada corretamente.
        """
        try:
            # Obter informações do símbolo
            exchange_info = self.client.futures_exchange_info()
            symbol_info = None
            for s in exchange_info.get('symbols', []):
                if s['symbol'] == self.symbol_internal:
                    symbol_info = s
                    break
            
            if symbol_info:
                # Encontrar filtro LOT_SIZE
                for f in symbol_info.get('filters', []):
                    if f['filterType'] == 'LOT_SIZE':
                        step_size = float(f['stepSize'])
                        min_qty = float(f['minQty'])
                        
                        # Encontrar número de casas decimais do stepSize
                        step_str = str(step_size)
                        if '.' in step_str:
                            # Contar todos os dígitos após o ponto decimal
                            decimals = len(step_str.split('.')[1])
                        else:
                            decimals = 0
                        
                        # Ajustar quantidade para múltiplo de stepSize usando arredondamento
                        # Evitar problemas de precisão de ponto flutuante
                        quantity = round(quantity / step_size) * step_size
                        quantity = round(quantity, decimals)
                        
                        # Verificar quantidade mínima
                        if quantity < min_qty:
                            print(f"⚠️ Quantidade ({quantity}) abaixo do mínimo ({min_qty})")
                            return None
                        
                        # Formatar com precisão exata conforme stepSize
                        if decimals == 0:
                            return f"{int(quantity)}"
                        else:
                            # Manter exatamente o número de casas decimais do stepSize
                            return f"{quantity:.{decimals}f}"
            
            # Se não conseguir ajustar, retornar quantidade arredondada como string
            return str(round(quantity, 1))
        except Exception as e:
            print(f"⚠️ Erro ao ajustar quantidade: {e}. Usando quantidade sem ajuste.")
            return str(round(quantity, 1))

    def get_total_balance(self):
        account = self.client.futures_account()
        # Usar availableBalance (o que podes usar para novas posições); evita -2019 Margin is insufficient
        available = account.get('availableBalance')
        total = account.get('totalWalletBalance', 0)
        balance_to_use = float(available) if available is not None and str(available).strip() != '' else float(total)
        # Usar só 80% do disponível: deixa margem para fees, arredondamentos, reserva da exchange e ordens em aberto
        # (95% dava -2019 em contas pequenas quando a Binance reserva um pouco mais)
        self.quantity = balance_to_use * 0.80
        self._last_available_balance = balance_to_use
        # print(f"🔄 Available: {balance_to_use}, Quantity (margin to use): {self.quantity}")

    def get_current_position(self):
        self.position = None
        self.entry_price = 0
        self.sl_order_id = None
        self.tp_order_id = None
        self.get_total_balance()
        try:
            # Obter posições
            positions = self.client.futures_position_information(symbol=self.symbol_internal)
            if positions and len(positions) > 0:
                pos_data = positions[0]
                position_amt = float(pos_data['positionAmt'])
                
                if abs(position_amt) > 0:
                    if position_amt > 0:
                        self.position = 'long'
                    else:
                        self.position = 'short'
                    
                    self.entry_price = float(pos_data.get('entryPrice', 0))
            
            # Obter ordens abertas TP/SL: REST (STOP, TAKE_PROFIT) e/ou algo (STOP_MARKET, TAKE_PROFIT_MARKET)
            open_orders = []
            try:
                all_orders = self.client.futures_get_open_orders(symbol=self.symbol_internal)
                for o in all_orders:
                    t = o.get('type') or o.get('orderType', '')
                    if t in ('STOP', 'TAKE_PROFIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'):
                        open_orders.append(o)
            except Exception:
                pass
            if not open_orders:
                try:
                    open_orders = self.client.futures_get_open_algo_orders(symbol=self.symbol_internal)
                except (AttributeError, Exception):
                    pass
            for order in open_orders:
                order_type = order.get('type') or order.get('orderType', '')
                oid = order.get('algoId') or order.get('algoOrderId') or order.get('orderId')
                if order_type in ('STOP', 'STOP_MARKET'):
                    self.sl_order_id = oid
                elif order_type in ('TAKE_PROFIT', 'TAKE_PROFIT_MARKET'):
                    self.tp_order_id = oid
            
            # print(f"🔄 SL order ID: {self.sl_order_id}, TP order ID: {self.tp_order_id}")
            # print(f"🔄 Posição atual: {self.position}, Quantidade: {self.quantity}, Preço de entrada: {self.entry_price}")
        except Exception as e:
            print(f"⚠️ Erro ao obter posição atual: {e}")

    def fetch_ohlcv(self, limit=1000):
        # Converter timeframe para formato Binance
        timeframe_map = {
            '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
            '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h', '1d': '1d'
        }
        binance_timeframe = timeframe_map.get(self.timeframe, '1m')
        
        klines = self.client.futures_klines(symbol=self.symbol_internal, interval=binance_timeframe, limit=limit)
        df = pd.DataFrame(klines, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume', 
                                           'close_time', 'quote_volume', 'trades', 'taker_buy_base', 
                                           'taker_buy_quote', 'ignore'])
        df = df[['timestamp', 'open', 'high', 'low', 'close', 'volume']].copy()
        df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
        df[['open', 'high', 'low', 'close', 'volume']] = df[['open', 'high', 'low', 'close', 'volume']].astype(float)
        
        # Verificar se o último candle já fechou e está finalizado na API (Binance demora alguns segundos)
        if len(df) > 0:
            last_candle_timestamp = df['timestamp'].iloc[-1]
            timeframe_seconds = self.get_timeframe_seconds()
            safety_margin = pd.Timedelta(seconds=5)
            
            candle_close_time = last_candle_timestamp + pd.Timedelta(seconds=timeframe_seconds)
            current_time = pd.Timestamp.now(tz='UTC')
            
            # Só manter candle se fechou há mais de 10s (OHLC finalizado, igual ao TradingView)
            if current_time < (candle_close_time + safety_margin):
                # print(f"⚠️ Último candle ainda não fechou (fecha em {candle_close_time}). Removendo candle não fechado...")
                df = df.iloc[:-1].copy()  # Remove o último candle
                if len(df) == 0:
                    print(f"❌ Nenhum candle fechado disponível ainda.")
                    return df
        
        return df
    
    def fetch_latest_candle(self):
        """
        Busca o último candle já fechado (comportamento tipo TradingView: decisão no fecho, execução no open seguinte).
        Com limit=1 a API devolve o candle em formação, por isso pedimos 2: [penúltimo, atual].
        Devolve o candle mais recente que já tenha fechado (último ou penúltimo).
        """
        timeframe_map = {
            '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
            '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h', '1d': '1d'
        }
        binance_timeframe = timeframe_map.get(self.timeframe, '1m')
        
        # Precisamos de 2 candles: o último da API é o candle atual (em formação)
        klines = self.client.futures_klines(symbol=self.symbol_internal, interval=binance_timeframe, limit=2)
        if not klines or len(klines) < 2:
            return None
        
        df = pd.DataFrame(klines, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume',
                                          'close_time', 'quote_volume', 'trades', 'taker_buy_base',
                                          'taker_buy_quote', 'ignore'])
        df = df[['timestamp', 'open', 'high', 'low', 'close', 'volume']].copy()
        df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
        df[['open', 'high', 'low', 'close', 'volume']] = df[['open', 'high', 'low', 'close', 'volume']].astype(float)
        
        current_time = pd.Timestamp.now(tz='UTC')
        timeframe_seconds = self.get_timeframe_seconds()
        safety_margin = pd.Timedelta(seconds=10)
        
        last_candle = df.iloc[-1]
        penultimate_candle = df.iloc[-2]
        last_close_time = last_candle['timestamp'] + pd.Timedelta(seconds=timeframe_seconds)
        penultimate_close_time = penultimate_candle['timestamp'] + pd.Timedelta(seconds=timeframe_seconds)
        
        # Se o último candle da API já fechou (raro logo após o open), devolver esse
        if current_time >= (last_close_time + safety_margin):
            return df.iloc[[-1]].copy()
        # Senão, o que acabou de fechar é o penúltimo (o atual está em formação)
        if current_time >= (penultimate_close_time + safety_margin):
            return df.iloc[[-2]].copy()
        return None

    def refresh_cache_tail(self, num_candles=30):
        """
        Re-busca os ultimos N candles da API e substitui no cache.
        Garante que RSI/ADX etc. usam dados iguais aos de um fetch completo (evita drift ao longo do tempo).
        """
        if self.df_cache is None or len(self.df_cache) == 0:
            return False
        fresh = self.fetch_ohlcv(limit=num_candles)
        if fresh is None or len(fresh) == 0:
            return False
        n = min(len(fresh), len(self.df_cache), num_candles)
        if n == 0:
            return False
        self.df_cache = pd.concat([
            self.df_cache.iloc[:-n],
            fresh.tail(n)
        ], ignore_index=True)
        return True

    def update_ohlcv_cache(self, new_candle_df):
        """
        Atualiza o cache de candles com um novo candle.
        Remove o candle mais antigo para manter sempre o mesmo número de candles.
        """
        if self.df_cache is None:
            # Se não há cache, inicializar com o novo candle
            self.df_cache = new_candle_df.copy()
            return
        
        # Verificar se o novo candle já existe no cache (evitar duplicados)
        new_timestamp = new_candle_df['timestamp'].iloc[-1]
        if len(self.df_cache) > 0:
            last_cached_timestamp = self.df_cache['timestamp'].iloc[-1]
            
            # Se é o mesmo candle, não adicionar
            if new_timestamp == last_cached_timestamp:
                print(f"ℹ️ Candle {new_timestamp} já está no cache. Pulando...")
                return
            
            # Se o novo candle é mais antigo que o último no cache, algo está errado
            if new_timestamp < last_cached_timestamp:
                print(f"⚠️ Novo candle ({new_timestamp}) é mais antigo que o último no cache ({last_cached_timestamp}). Recarregando cache...")
                self.df_cache = None
                return
        
        # Adicionar novo candle ao cache
        self.df_cache = pd.concat([self.df_cache, new_candle_df], ignore_index=True)
        
        # Remover o candle mais antigo para manter sempre o mesmo número
        if len(self.df_cache) > self.cache_size:
            # Remover o primeiro candle (mais antigo)
            self.df_cache = self.df_cache.iloc[1:].copy()
            self.df_cache.reset_index(drop=True, inplace=True)        
    
    def get_timeframe_seconds(self):
        """Converte o timeframe para segundos"""
        timeframe_map = {
            '1m': 60,
            '3m': 180,
            '5m': 300,
            '15m': 900,
            '30m': 1800,
            '1h': 3600,
            '2h': 7200,
            '4h': 14400,
            '6h': 21600,
            '8h': 28800,
            '12h': 43200,
            '1d': 86400,
        }
        return timeframe_map.get(self.timeframe, 300)  # Default 5m
    
    def wait_for_next_candle(self):
        """
        Sincroniza com o fechamento do próximo candle da Binance.
        Calcula quando o próximo candle fecha e espera até esse momento.
        """
        try:
            # Buscar o último candle para obter o timestamp
            timeframe_map = {
                '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
                '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h', '1d': '1d'
            }
            binance_timeframe = timeframe_map.get(self.timeframe, '1m')
            
            klines = self.client.futures_klines(symbol=self.symbol_internal, interval=binance_timeframe, limit=1)
            if not klines:
                # Se não conseguir dados, espera o timeframe padrão
                time.sleep(self.get_timeframe_seconds())
                return
            
            last_candle_timestamp = klines[-1][0]  # Timestamp do último candle em ms
            timeframe_seconds = self.get_timeframe_seconds()
            next_candle_time = (last_candle_timestamp / 1000) + timeframe_seconds  # Próximo fechamento em segundos
            
            current_time = time.time()
            wait_time = next_candle_time - current_time
            
            # Se já passou do tempo (pode acontecer por latência), espera apenas um pouco
            if wait_time < 0:
                # Se já passou, espera até o próximo ciclo
                wait_time = timeframe_seconds + wait_time
            
            # Não esperar mais que o timeframe (caso de erro de cálculo)
            if wait_time > timeframe_seconds:
                wait_time = timeframe_seconds
            
            # Esperar pelo menos 1 segundo para evitar requisições muito frequentes
            if wait_time > 1:
                # print(f"⏳ Aguardando {wait_time:.1f}s até o próximo candle fechar...")
                time.sleep(wait_time)
            else:
                # Se falta menos de 1 segundo, espera um pouco para garantir que o candle fechou
                time.sleep(1)
                
        except Exception as e:
            print(f"⚠️ Erro ao sincronizar com candle: {e}. Usando sleep padrão.")
            time.sleep(self.get_timeframe_seconds())

    def strategy(self, df):
        self.get_current_position()
        # Calcular indicadores
        last_idx = -1

        def ma_function(source, length, smoothing_kind):
            if smoothing_kind == "RMA":
                # Wilder's Smoothing (RMA)
                ma = source.copy().astype(np.float64)
                rma = ma.ewm(alpha=1/length, adjust=False).mean()
                return rma.astype(np.float64)
            elif smoothing_kind == "SMA":
                return source.rolling(window=length, min_periods=length).mean()
            elif smoothing_kind == "EMA":
                return source.ewm(span=length, min_periods=length, adjust=False).mean()
            else:  # WMA
                # WMA: peso maior para valores mais recentes
                # No TradingView, WMA usa pesos [1, 2, 3, ..., length] onde length é o peso do valor mais recente
                def weighted_ma(x):
                    if len(x) < length:
                        return np.nan
                    # x vem na ordem cronológica (mais antigo primeiro)
                    # Aplicar pesos [1, 2, 3, ..., length] onde length é o peso do mais recente
                    weights = np.arange(1, len(x) + 1, dtype=np.float64)
                    weighted_sum = np.dot(x, weights)
                    weights_sum = weights.sum()
                    return weighted_sum / weights_sum
                return source.rolling(window=length, min_periods=length).apply(weighted_ma, raw=True)

        def true_range(high, low, close):
            hl = high - low
            hc = (high - close.shift(1)).abs()
            lc = (low - close.shift(1)).abs()
            tr = pd.concat([hl, hc, lc], axis=1).max(axis=1)
            return tr

        def rsi(series, length):
            """
            RSI calculation emulating TradingView (Wilder's smoothing).
            This implementation matches the real TradingView RSI formula and output.
            """
            s = pd.Series(series)
            delta = s.diff()

            # Positive gains (up) and negative gains (down)
            gain = delta.where(delta > 0, 0.0)
            loss = -delta.where(delta < 0, 0.0)

            # Wilder smoothing (RMA), as in TradingView
            avg_gain = gain.ewm(alpha=1/length, min_periods=length, adjust=False).mean()
            avg_loss = loss.ewm(alpha=1/length, min_periods=length, adjust=False).mean()

            rs = avg_gain / avg_loss

            # Avoid division by zero: if avg_loss == 0 set RSI to 100 (as TV does)
            rsi_val = 100 - (100 / (1 + rs))
            rsi_val = np.where(avg_loss == 0, 100, rsi_val)
            rsi_val = np.where(avg_gain == 0, 0, rsi_val)  # If both are 0 then RSI is 0

            return rsi_val

        def vwap_close_daily(close: pd.Series, volume: pd.Series) -> pd.Series:
            """
            Calcula o VWAP usando apenas o preço de fechamento, 
            com reset diário (anchor por dia), igual ao TradingView ta.vwap.
            """
            # Usar timestamp do DataFrame para calcular as datas (em UTC)
            # O DataFrame tem coluna 'timestamp' que já está em UTC
            if 'timestamp' in df.columns:
                # Converter para datetime UTC e extrair apenas a data (sem hora)
                timestamps = pd.to_datetime(df['timestamp'], utc=True)
                dates = timestamps.dt.date.values
            else:
                # Se não houver timestamp, usar o índice
                dates = pd.to_datetime(close.index, utc=True).date
            
            # Criar DataFrame temporário para garantir ordem correta após groupby
            temp_df = pd.DataFrame({
                'close': close.values,
                'volume': volume.values,
                'date': dates
            })
            
            # Calcular price_volume
            temp_df['price_volume'] = temp_df['close'] * temp_df['volume']
            
            # Groupby por data e calcular cumsum (mantém ordem original)
            temp_df['cum_price_vol'] = temp_df.groupby('date')['price_volume'].cumsum()
            temp_df['cum_vol'] = temp_df.groupby('date')['volume'].cumsum()
            
            # Calcular VWAP
            vwap = temp_df['cum_price_vol'] / temp_df['cum_vol'].replace(0, np.nan)
            vwap = vwap.replace([np.inf, -np.inf], np.nan)
            # Não arredondar aqui - deixar o RSI trabalhar com valores precisos
            # vwap_rounded = vwap.round(4)  # Arredondar pode causar pequenas diferenças
            
            # Retornar como Series com o índice original do close
            return pd.Series(vwap.values, index=close.index)

        def wilder_sma(values, period):
            values = np.asarray(values, dtype=np.float64)
            n = len(values)
            result = np.full(n, np.nan, dtype=np.float64)
            if n < period:
                return result
            # Inicializa com média simples dos primeiros 'period' valores
            initial = np.mean(values[:period])
            result[period - 1] = initial
            # Depois aplica a fórmula recursiva
            for i in range(period, n):
                result[i] = result[i - 1] * (period - 1) / period + values[i]
            return result


        def adx_indicator(df, length):
            high_arr = df['high'].values.astype(np.float64)
            low_arr = df['low'].values.astype(np.float64)
            close_arr = df['close'].values.astype(np.float64)
            n = len(close_arr)

            # True Range
            close_prev = np.concatenate([[0.0], close_arr[:-1]])
            tr1 = high_arr - low_arr
            tr2 = np.abs(high_arr - close_prev)
            tr3 = np.abs(low_arr - close_prev)
            TrueRange = np.maximum(tr1, np.maximum(tr2, tr3))

            # Directional Movement
            high_prev = np.concatenate([[0.0], high_arr[:-1]])
            low_prev = np.concatenate([[0.0], low_arr[:-1]])

            high_diff = high_arr - high_prev
            low_diff = low_prev - low_arr

            plus_condition = high_diff > low_diff
            minus_condition = low_diff > high_diff

            DirectionalMovementPlus = np.where(plus_condition, np.maximum(high_diff, 0.0), 0.0)
            DirectionalMovementMinus = np.where(minus_condition, np.maximum(low_diff, 0.0), 0.0)

            # Smoothing (Wilder)
            SmoothedTrueRange = wilder_sma(TrueRange, length)
            SmoothedDirectionalMovementPlus = wilder_sma(DirectionalMovementPlus, length)
            SmoothedDirectionalMovementMinus = wilder_sma(DirectionalMovementMinus, length)

            # DI+ e DI-
            DIPlus = np.full(n, np.nan, dtype=np.float64)
            DIMinus = np.full(n, np.nan, dtype=np.float64)

            valid_mask = np.isfinite(SmoothedTrueRange) & (SmoothedTrueRange > 0)
            DIPlus[valid_mask] = 100 * SmoothedDirectionalMovementPlus[valid_mask] / SmoothedTrueRange[valid_mask]
            DIMinus[valid_mask] = 100 * SmoothedDirectionalMovementMinus[valid_mask] / SmoothedTrueRange[valid_mask]

            # DX
            DX = np.full(n, np.nan, dtype=np.float64)
            di_sum = DIPlus + DIMinus
            di_diff = np.abs(DIPlus - DIMinus)
            valid_dx = np.isfinite(di_sum) & (di_sum > 0)
            DX[valid_dx] = 100 * di_diff[valid_dx] / di_sum[valid_dx]

            # ADX com SMA
            ADX = np.full(n, np.nan, dtype=np.float64)
            for i in range(length - 1, n):
                start_idx = i - length + 1
                window = DX[start_idx:i + 1]
                if len(window) == length and np.all(np.isfinite(window)):
                    ADX[i] = np.mean(window)

            return pd.Series(DIPlus, index=df.index), pd.Series(DIMinus, index=df.index), pd.Series(ADX, index=df.index)

        def vwma(source, volume, length):
            vol_sum = volume.rolling(window=length, min_periods=1).sum()
            price_vol_sum = (source * volume).rolling(window=length, min_periods=1).sum()
            return price_vol_sum / vol_sum

        def calc_envelope_fibonacci(df, length_fibonacci, mult_fibonacci):
            """
            Calcula bandas superior e inferior baseadas em VWMA +/− std para um envelope tipo Fibonacci.
            Parâmetros:
                df: DataFrame, espera colunas high, low, close, volume
                length_fibonacci: int, janela para VWMA e desvio padrão
                mult_fibonacci: float, multiplicador para o desvio padrão
            Retorna:
                upper_6, lower_6 (pandas Series/alinhados com df)
            """
            hlc3 = (df['high'] + df['low'] + df['close']) / 3
            basis = vwma(hlc3, df['volume'], length_fibonacci)
            dev = mult_fibonacci * hlc3.rolling(window=length_fibonacci, min_periods=1).std()
            upper_6 = basis + dev
            lower_6 = basis - dev
            return upper_6, lower_6

        
        tr_series = true_range(df['high'], df['low'], df['close'])
        atr = ma_function(tr_series, 5, "WMA")
        df['atr'] = round(atr, 4)

        # --- Fast EMA ---
        ema_fast = df['close'].ewm(span=90, min_periods=90, adjust=False).mean()
        df['ema_fast'] = round(ema_fast, 4)
        ema = df['close'].ewm(span=10, min_periods=10, adjust=False).mean()
        df['ema'] = round(ema, 4)
        ema_slow = df['close'].ewm(span=1000, min_periods=1000, adjust=False).mean()

        df['vwap_close'] = vwap_close_daily(df['close'], df['volume'])
        rsi_vwap_series = rsi(df['vwap_close'], 1)
        rsi_vwap_series = pd.Series(rsi_vwap_series, index=df.index)
        df['RSI_VWAP'] = rsi_vwap_series.round(4)

        df['rsi'] = rsi(df['close'], 19)
        df['rsi'] = df['rsi'].round(4)
        df['dif_ema'] = round(df['ema_fast'] - df['ema_fast'].shift(10), 4)
        df['dif_ema2'] = round(df['ema'] - df['ema'].shift(30), 4)
        df['dif_ema3'] = round(ema_slow - ema_slow.shift(10), 4)

        di_plus, di_minus, adx = adx_indicator(df, 10)
        df['DIPlus'] = di_plus.round(4)
        df['DIMinus'] = di_minus.round(4)
        df['ADX'] = adx.round(4)
        df['dif_ADX'] = round(df['ADX'] - df['ADX'].shift(5), 4)
        df['dif_plus_minus'] = round(df['DIPlus'] - df['DIMinus'], 4)

        upper_6, lower_6 = calc_envelope_fibonacci(df, 300, 1)
        df['upper_6'] = upper_6.round(5)
        df['lower_6'] = lower_6.round(5)

        # OBV (On-Balance Volume): cumVol, obv, dif_obv
        df['cumVol'] = df['volume'].fillna(0).cumsum()
        obv_raw = np.sign(df['close'].diff().fillna(0)) * df['volume'].fillna(0)
        df['obv'] = obv_raw.cumsum()
        df['dif_obv'] = df['obv'] - df['obv'].shift(1)

        RSI_VWAP_overSold = 15
        RSI_VWAP_overBought = 85

        atr_value = df['atr'].iloc[last_idx]
        current_dif_ema = df['dif_ema'].iloc[last_idx]
        current_dif_ema2 = df['dif_ema2'].iloc[last_idx]
        current_rsi_vwap = df['RSI_VWAP'].iloc[last_idx]
        current_rsi = df['rsi'].iloc[last_idx]
        current_adx = df['ADX'].iloc[last_idx]
        current_upper_6 = df['upper_6'].iloc[last_idx]
        current_lower_6 = df['lower_6'].iloc[last_idx]
        current_close = df['close'].iloc[last_idx]
        current_volume = df['volume'].iloc[last_idx]
        current_high = df['high'].iloc[last_idx]
        current_low = df['low'].iloc[last_idx]
        current_open = df['open'].iloc[last_idx]
        current_obv = df['obv'].iloc[last_idx]
        current_dif_obv = df['dif_obv'].iloc[last_idx]
        current_dif_plus_minus = df['dif_plus_minus'].iloc[last_idx]

        # Lógica de contagem EMA2 flat (saída por lateralização)
        ema2_is_flat = abs(float(current_dif_ema2)) <= 0.0015
        if self.position is not None:
            self.flat_ema2_count = self.flat_ema2_count + 1 if ema2_is_flat else 0
        else:
            self.flat_ema2_count = 0
        
        filter_trend = (
            current_lower_6 < current_close and current_upper_6 > current_close
            and current_dif_ema2 < 0.002 and current_dif_ema2 > -0.002
            and current_adx < 30
            and current_dif_plus_minus < 40 and current_dif_plus_minus > -40
            and current_dif_ema <= 0.0002 and current_dif_ema >= -0.0002
        )

        print(f"UPPER_6: {current_upper_6} LOWER_6: {current_lower_6}")
        print(f"ADX: {current_adx} DIF_PLUS_MINUS: {current_dif_plus_minus} FILTER_TREND: {filter_trend}")
        # ************************************* Strategies first Entry *************************************
        longCondition = filter_trend and current_rsi < 38 and current_rsi_vwap < RSI_VWAP_overSold
        shortCondition = filter_trend and current_rsi > 62 and current_rsi_vwap > RSI_VWAP_overBought

        print(f"RSI: {current_rsi} RSI_VWAP: {current_rsi_vwap} DIF_EMA2: {current_dif_ema2}")
        for i, row in df.tail(5).iterrows():
            ts = row['timestamp'].strftime('%H:%M') if hasattr(row['timestamp'], 'strftime') else str(row['timestamp'])
            print(f"  [{ts}] O:{row['open']:.4f} H:{row['high']:.4f} L:{row['low']:.4f} C:{row['close']:.4f} V:{row['volume']:.1f}")
        # ************************************* Strategies first Exit *************************************
        signal_result = None
        exit_long = current_rsi > 50
        exit_short = current_rsi < 50

        # ************************************* Do Entry *************************************
        # if (longCondition and (strategy.position_size == 0 or strategy.position_size < 0))
        if (longCondition and (self.position is None or self.position == 'short')):
            signal_result = 'long'
            return signal_result

        # if (shortCondition and (strategy.position_size == 0 or strategy.position_size > 0))
        if (shortCondition and (self.position is None or self.position == 'long')):
            signal_result = 'short'
            return signal_result

        # ************************************* Do Exit *************************************
        # self.buyed só é alterado em execute_trade (após entrada/fecho efectivos)

        # Saída por lateralização: EMA2 flat 20 candles consecutivos
        # if self.position is not None and self.flat_ema2_count >= 15 and self.buyed:
        #     signal_result = 'sell'
        #     print(f"Saida: EMA2 flat 20 candles (flat_ema2_count={self.flat_ema2_count})")
        #     return signal_result

        if self.position == 'long' and exit_long and self.buyed:
            signal_result = 'sell'
            return signal_result

        # Pine Script: if math.abs(strategy.position_size) >= 1 and exit_short
        if self.position == 'short' and exit_short and self.buyed:
            signal_result = 'sell'
            return signal_result

        return signal_result

    def _get_tick_size(self):
        """Retorna tick_size (float) e price_precision (int) para o símbolo."""
        try:
            exchange_info = self.client.futures_exchange_info()
            for s in exchange_info.get('symbols', []):
                if s['symbol'] == self.symbol_internal:
                    for f in s.get('filters', []):
                        if f['filterType'] == 'PRICE_FILTER':
                            tick = f.get('tickSize')
                            if tick is not None:
                                tick_size = float(tick)
                                if tick_size >= 1:
                                    return tick_size, 0
                                dec = len(str(tick_size).split('.')[-1].rstrip('0'))
                                return tick_size, dec
                    break
        except Exception as e:
            print(f"⚠️ Erro ao obter tick size: {e}")
        return 0.01, 2

    def _round_price(self, price):
        """Arredonda preço ao tick do símbolo (para ordens limit = maker)."""
        tick_size, precision = self._get_tick_size()
        if tick_size <= 0:
            return round(price, precision)
        return round(round(price / tick_size) * tick_size, precision)

    def _get_bid_ask(self):
        """Retorna (best_bid, best_ask) para ordens limit (maker)."""
        try:
            # Binance Futures: depth limit deve ser 5, 10, 20, 50, 100 ou 500 (não 1)
            book = self.client.futures_order_book(symbol=self.symbol_internal, limit=5)
            bids = book.get('bids') or []
            asks = book.get('asks') or []
            if bids and asks:
                bid = float(bids[0][0])
                ask = float(asks[0][0])
                return self._round_price(bid), self._round_price(ask)
        except Exception as e:
            print(f"⚠️ Erro ao obter book: {e}")
        ticker = self.client.futures_symbol_ticker(symbol=self.symbol_internal)
        p = float(ticker['price'])
        return self._round_price(p), self._round_price(p)

    def _wait_for_order_fill(self, order_id, timeout_seconds=60, poll_interval=2):
        """Aguarda ordem ser preenchida. Retorna True se FILLED, False se timeout/cancelada."""
        order_id = int(order_id) if order_id is not None else None
        if order_id is None:
            return False
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            try:
                order = self.client.futures_get_order(symbol=self.symbol_internal, orderId=order_id)
                status = (order.get('status') or '').strip().upper()
                if status == 'FILLED':
                    return True
                if status in ('CANCELED', 'EXPIRED', 'REJECTED'):
                    return False
                # Preenchimento parcial pode indicar que está a preencher
                exec_qty = float(order.get('executedQty') or 0)
                orig_qty = float(order.get('origQty') or 0)
                if orig_qty > 0 and exec_qty >= orig_qty:
                    return True
            except Exception as e:
                print(f"[AVISO] Erro ao consultar ordem: {e}")
            time.sleep(poll_interval)
        # Uma última verificação após timeout (ordem pode ter preenchido no último segundo)
        try:
            order = self.client.futures_get_order(symbol=self.symbol_internal, orderId=order_id)
            status = (order.get('status') or '').strip().upper()
            if status == 'FILLED':
                return True
        except Exception:
            pass
        return False

    def cancel_sl_tp(self):
        """
        Cancela TODAS as ordens SL e TP abertas do símbolo (incluindo órfãs de trades já fechados).
        Assim evita erro 'Unknown order' ao tentar cancelar por ID e remove TP/SL antigos antes de nova trade.
        """
        self.sl_order_id = None
        self.tp_order_id = None
        sl_tp_types = ('STOP', 'TAKE_PROFIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET')
        try:
            open_orders = self.client.futures_get_open_orders(symbol=self.symbol_internal)
            for o in open_orders:
                t = o.get('type') or o.get('orderType', '')
                if t not in sl_tp_types:
                    continue
                oid = o.get('orderId') or o.get('order_id')
                if not oid:
                    continue
                try:
                    self.client.futures_cancel_order(symbol=self.symbol_internal, orderId=oid)
                    print(f"✅ Cancelada ordem {t} (ID: {oid})")
                except Exception as e:
                    # -2011 Unknown order = ordem já não existe (preenchida ou cancelada)
                    err_code = getattr(e, 'code', None) or getattr(e, 'error_code', None)
                    is_unknown = err_code == -2011 or '-2011' in str(e)
                    if is_unknown:
                        pass  # ordem já desapareceu, ignorar
                    else:
                        print(f"⚠️ Erro ao cancelar ordem {oid}: {e}")
        except Exception as e:
            print(f"⚠️ Erro ao listar/cancelar ordens SL/TP: {e}")
        # Cancelar também ordens algo (STOP_MARKET/TAKE_PROFIT_MARKET) se existirem
        try:
            algo_orders = self.client.futures_get_open_algo_orders(symbol=self.symbol_internal)
        except (AttributeError, Exception):
            algo_orders = []
        for o in algo_orders:
            algo_id = o.get('algoId') or o.get('algoOrderId') or o.get('orderId')
            if not algo_id:
                continue
            try:
                self.client.futures_cancel_algo_order(symbol=self.symbol_internal, algoId=algo_id)
                print(f"✅ Cancelada ordem algo (ID: {algo_id})")
            except Exception as e:
                if '-2011' in str(e) or getattr(e, 'code', None) == -2011:
                    pass
                else:
                    print(f"⚠️ Erro ao cancelar ordem algo {algo_id}: {e}")
    
    def _create_algo_order(self, symbol, side, order_type, trigger_price, close_position=True, working_type='CONTRACT_PRICE'):
        """
        Cria uma ordem algorítmica tentando diferentes métodos dependendo da versão da biblioteca.
        """
        order_params = {
            'symbol': symbol,
            'side': side,
            'type': order_type,
            'triggerPrice': str(trigger_price),
            'closePosition': close_position,
            'workingType': working_type
        }
        
        # Tentar diferentes métodos dependendo da versão da biblioteca
        try:
            if hasattr(self.client, 'futures_create_algo_order'):
                return self.client.futures_create_algo_order(**order_params)
        except AttributeError:
            pass
        
        try:
            if hasattr(self.client, 'new_order_algo'):
                return self.client.new_order_algo(**order_params)
        except AttributeError:
            pass
        
        try:
            if hasattr(self.client, 'futures_new_order_algo'):
                return self.client.futures_new_order_algo(**order_params)
        except AttributeError:
            pass
        
        raise AttributeError("Nenhum método de criação de ordem algorítmica disponível nesta versão da biblioteca python-binance")
    
    def _set_sl_tp_ids_from_open_orders(self):
        """Preenche sl_order_id e tp_order_id a partir das ordens abertas (fallback se API não devolver orderId)."""
        try:
            orders = self.client.futures_get_open_orders(symbol=self.symbol_internal)
            for o in orders:
                t = o.get('type') or o.get('orderType', '')
                oid = o.get('orderId') or o.get('order_id')
                if not oid:
                    continue
                if t == 'STOP':
                    self.sl_order_id = oid
                elif t == 'TAKE_PROFIT':
                    self.tp_order_id = oid
        except Exception as e:
            print(f"⚠️ Erro ao obter ordens abertas para SL/TP: {e}")

    def place_sl_tp(self, position_type, entry_price):
        """
        Coloca SL e TP como ordens LIMIT (TAKE_PROFIT e STOP) para fees maker mais baixas.
        Usa quantity + reduceOnly em vez de closePosition.
        """
        try:
            position_qty = self._get_position_quantity()
            if position_qty is None:
                print("❌ Não foi possível obter quantidade da posição para SL/TP.")
                return
            if position_type == 'long':
                sl_price = self._round_price(entry_price * (1 - self.sl_percent))
                tp_price = self._round_price(entry_price * (1 + self.tp_percent))
                print(f"📊 Configurando SL/TP LIMIT para LONG:")
                print(f"   Entry: {entry_price}, SL: {sl_price}, TP: {tp_price} (qty: {position_qty})")
                # TAKE_PROFIT limit: quando mark >= stopPrice, coloca limit sell em price
                tp_result = self.client.futures_create_order(
                    symbol=self.symbol_internal,
                    side='SELL',
                    type='TAKE_PROFIT',
                    quantity=position_qty,
                    price=str(tp_price),
                    stopPrice=str(tp_price),
                    timeInForce='GTC',
                    reduceOnly=True
                )
                self.tp_order_id = tp_result.get('orderId') or tp_result.get('order_id')
                if self.tp_order_id is None:
                    self._set_sl_tp_ids_from_open_orders()
                print(f"✅ TP LIMIT colocado em {tp_price} (ID: {self.tp_order_id})")
                # STOP limit: quando mark <= stopPrice, coloca limit sell em price
                sl_result = self.client.futures_create_order(
                    symbol=self.symbol_internal,
                    side='SELL',
                    type='STOP',
                    quantity=position_qty,
                    price=str(sl_price),
                    stopPrice=str(sl_price),
                    timeInForce='GTC',
                    reduceOnly=True
                )
                self.sl_order_id = sl_result.get('orderId') or sl_result.get('order_id')
                if self.sl_order_id is None:
                    self._set_sl_tp_ids_from_open_orders()
                print(f"✅ SL LIMIT colocado em {sl_price} (ID: {self.sl_order_id})")
            elif position_type == 'short':
                sl_price = self._round_price(entry_price * (1 + self.sl_percent))
                tp_price = self._round_price(entry_price * (1 - self.tp_percent))
                print(f"📊 Configurando SL/TP LIMIT para SHORT:")
                print(f"   Entry: {entry_price}, SL: {sl_price}, TP: {tp_price} (qty: {position_qty})")
                tp_result = self.client.futures_create_order(
                    symbol=self.symbol_internal,
                    side='BUY',
                    type='TAKE_PROFIT',
                    quantity=position_qty,
                    price=str(tp_price),
                    stopPrice=str(tp_price),
                    timeInForce='GTC',
                    reduceOnly=True
                )
                self.tp_order_id = tp_result.get('orderId') or tp_result.get('order_id')
                if self.tp_order_id is None:
                    self._set_sl_tp_ids_from_open_orders()
                print(f"✅ TP LIMIT colocado em {tp_price} (ID: {self.tp_order_id})")
                sl_result = self.client.futures_create_order(
                    symbol=self.symbol_internal,
                    side='BUY',
                    type='STOP',
                    quantity=position_qty,
                    price=str(sl_price),
                    stopPrice=str(sl_price),
                    timeInForce='GTC',
                    reduceOnly=True
                )
                self.sl_order_id = sl_result.get('orderId') or sl_result.get('order_id')
                if self.sl_order_id is None:
                    self._set_sl_tp_ids_from_open_orders()
                print(f"✅ SL LIMIT colocado em {sl_price} (ID: {self.sl_order_id})")
            else:
                print(f"❌ Tipo de posição inválido: {position_type}")
        except Exception as e:
            print(f"❌ Erro ao configurar SL/TP: {e}")
            import traceback
            traceback.print_exc()

    def _place_limit_close_and_wait(self, side, quantity_str, num_attempts=4, timeout_per_attempt=5):
        """Fecha posição com ordem LIMIT (maker). Várias tentativas com preço atualizado para entrar dentro do candle actual (sem fees).
        side='BUY' para fechar short, 'SELL' para fechar long."""
        for attempt in range(1, num_attempts + 1):
            bid, ask = self._get_bid_ask()
            price = str(bid) if side == 'BUY' else str(ask)
            try:
                order = self.client.futures_create_order(
                    symbol=self.symbol_internal,
                    side=side,
                    type='LIMIT',
                    quantity=quantity_str,
                    price=price,
                    timeInForce='GTC',
                    reduceOnly=True
                )
            except Exception as e:
                print(f"[AVISO] Erro ao colocar ordem LIMIT (tentativa {attempt}/{num_attempts}): {e}")
                time.sleep(2)
                continue
            order_id = order.get('orderId')
            if self._wait_for_order_fill(order_id, timeout_seconds=timeout_per_attempt):
                print(f"[OK] Posicao fechada com LIMIT (maker) ao preco {price} (tentativa {attempt})")
                return True
            try:
                self.client.futures_cancel_order(symbol=self.symbol_internal, orderId=order_id)
            except Exception:
                pass
            if attempt < num_attempts:
                time.sleep(1)  # breve pausa antes da próxima tentativa
        print(f"[AVISO] Ordem LIMIT de fecho nao preenchida em {num_attempts} tentativas de {timeout_per_attempt}s cada.")
        return False

    def _place_market_entry(self, side, quantity_str):
        """Abre posição com ordem MARKET (taker). Garante entrada; paga mais fees. Retorna (success, entry_price)."""
        try:
            order = self.client.futures_create_order(
                symbol=self.symbol_internal,
                side=side,
                type='MARKET',
                quantity=quantity_str
            )
            order_id = order.get('orderId') or order.get('order_id')
            if order_id is None:
                return False, 0.0
            # MARKET normalmente preenche de imediato; confirmar
            if self._wait_for_order_fill(order_id, timeout_seconds=15):
                try:
                    filled = self.client.futures_get_order(symbol=self.symbol_internal, orderId=int(order_id))
                    avg = filled.get('avgPrice')
                    entry = float(avg) if avg else 0.0
                except Exception:
                    entry = 0.0
                if entry and entry > 0:
                    print(f"✅ Entrada MARKET (taker) executada ao preço ~{entry}")
                    return True, entry
            self.get_current_position()
            if self.entry_price and self.entry_price > 0:
                print(f"✅ Entrada MARKET executada (entry ~{self.entry_price})")
                return True, self.entry_price
        except Exception as e:
            print(f"❌ Erro ao colocar ordem MARKET de entrada: {e}")
        return False, 0.0

    def _place_limit_entry_and_wait(self, side, quantity_str, timeout=None):
        """Abre posição com LIMIT (maker). Fase 1: limit ao touch; se não preencher, fase 2: limit de novo com preço fresco; opcionalmente fallback MARKET. Retorna (success, entry_price)."""
        timeout = timeout if timeout is not None else getattr(self, 'entry_limit_timeout', 90)
        aggressive_after = getattr(self, 'entry_aggressive_after_sec', 25)
        market_fallback = getattr(self, 'entry_market_fallback', False)

        def wait_and_return_fill(order_id, price_float, phase_name, wait_seconds):
            if order_id is None:
                return False, 0.0
            if self._wait_for_order_fill(order_id, timeout_seconds=wait_seconds):
                try:
                    filled = self.client.futures_get_order(symbol=self.symbol_internal, orderId=int(order_id))
                    avg = filled.get('avgPrice')
                    entry = float(avg) if avg else price_float
                except Exception:
                    entry = price_float
                print(f"✅ Entrada LIMIT ({phase_name}) ao preço ~{entry}")
                return True, entry
            try:
                self.client.futures_cancel_order(symbol=self.symbol_internal, orderId=int(order_id))
            except Exception as e:
                err_code = getattr(e, 'code', None) or getattr(e, 'error_code', None)
                if err_code == -2011 or '-2011' in str(e):
                    try:
                        filled = self.client.futures_get_order(symbol=self.symbol_internal, orderId=int(order_id))
                        if (filled.get('status') or '').strip().upper() == 'FILLED':
                            avg = filled.get('avgPrice')
                            entry = float(avg) if avg else price_float
                            print(f"✅ Entrada LIMIT ({phase_name}) preenchida (após cancel) ~{entry}")
                            return True, entry
                    except Exception:
                        pass
                    self.get_current_position()
                    if self.entry_price and self.entry_price > 0:
                        return True, self.entry_price
            return False, 0.0

        # Fase 1: limit ao bid (BUY) / ask (SELL) para maximizar preenchimento como maker
        bid, ask = self._get_bid_ask()
        price = self._round_price(bid) if side == 'BUY' else self._round_price(ask)
        price_str = str(price)
        wait_sec = min(aggressive_after, timeout)
        order = self.client.futures_create_order(
            symbol=self.symbol_internal,
            side=side,
            type='LIMIT',
            quantity=quantity_str,
            price=price_str,
            timeInForce='GTC'
        )
        order_id = order.get('orderId') or order.get('order_id')
        ok, entry = wait_and_return_fill(order_id, float(price_str), "fase 1", wait_sec)
        if ok:
            return True, entry

        # Fase 2: nova limit com preço atualizado (mercado pode ter movido)
        remaining = timeout - wait_sec
        if remaining <= 0:
            if market_fallback:
                print("⏱️ Timeout na limit; a usar MARKET para não perder a trade.")
                return self._place_market_entry(side, quantity_str)
            return False, 0.0

        bid, ask = self._get_bid_ask()
        price = self._round_price(bid) if side == 'BUY' else self._round_price(ask)
        price_str = str(price)
        order = self.client.futures_create_order(
            symbol=self.symbol_internal,
            side=side,
            type='LIMIT',
            quantity=quantity_str,
            price=price_str,
            timeInForce='GTC'
        )
        order_id = order.get('orderId') or order.get('order_id')
        ok, entry = wait_and_return_fill(order_id, float(price_str), "fase 2", remaining)
        if ok:
            return True, entry

        if market_fallback:
            print("⏱️ Limit não preenchida no tempo; a usar MARKET para não perder a trade.")
            return self._place_market_entry(side, quantity_str)
        print(f"⚠️ Ordem LIMIT de entrada não preenchida em {timeout}s (cancelada).")
        return False, 0.0

    def execute_trade(self, signal):
        self.get_current_position()
        if signal == 'long':
            if self.position == 'long':
                print("⚠️ Já está em posição LONG.")
                return
            self.cancel_sl_tp()
            if self.position == 'short':
                position_qty = self._get_position_quantity()
                if position_qty is None:
                    print("⚠️ Não foi possível obter quantidade da posição para fechar.")
                    return
                if not self._place_limit_close_and_wait('BUY', position_qty):
                    return
                self.buyed = False  # fecho efectuado antes de abrir long
                time.sleep(1)
                self.get_current_position()

            try:
                self.get_total_balance()
                ticker = self.client.futures_symbol_ticker(symbol=self.symbol_internal)
                current_price = float(ticker['price'])
                quantity = (self.quantity * self.leverage) / current_price
                quantity_str = self._adjust_quantity(quantity)
                if quantity_str is None:
                    print("❌ Quantidade inválida ou saldo insuficiente.")
                    return
                bal = getattr(self, '_last_available_balance', None)
                if bal is not None:
                    print(f"💰 Margem disponível: {bal:.2f} | A usar (80%): {self.quantity:.2f} | qty(base): {quantity_str}")
                print(f"📤 Ordem LIMIT BUY (maker) para LONG qty={quantity_str}...")
                ok, self.entry_price = self._place_limit_entry_and_wait('BUY', quantity_str)
                if not ok:
                    return
                self.buyed = True  # só após entrada efectiva
                time.sleep(1)
                self.get_current_position()
                print(f"🔧 Configurando SL/TP LIMIT para LONG...")
                self.place_sl_tp('long', self.entry_price)
                print(f"✅ LONG concluído (entrada + SL/TP em limit).")
            except Exception as e:
                print(f"❌ Erro ao abrir LONG: {e}")
                import traceback
                traceback.print_exc()
                return

        elif signal == 'short':
            if self.position == 'short':
                print("⚠️ Já está em posição SHORT.")
                return
            self.cancel_sl_tp()
            if self.position == 'long':
                position_qty = self._get_position_quantity()
                if position_qty is None:
                    print("⚠️ Não foi possível obter quantidade da posição para fechar.")
                    return
                if not self._place_limit_close_and_wait('SELL', position_qty):
                    return
                self.buyed = False  # fecho efectuado antes de abrir short
                time.sleep(1)
                self.get_current_position()

            try:
                self.get_total_balance()
                ticker = self.client.futures_symbol_ticker(symbol=self.symbol_internal)
                current_price = float(ticker['price'])
                quantity = (self.quantity * self.leverage) / current_price
                quantity_str = self._adjust_quantity(quantity)
                if quantity_str is None:
                    print("❌ Quantidade inválida ou saldo insuficiente.")
                    return
                bal = getattr(self, '_last_available_balance', None)
                if bal is not None:
                    print(f"💰 Margem disponível: {bal:.2f} | A usar (80%): {self.quantity:.2f} | qty(base): {quantity_str}")
                print(f"📤 Ordem LIMIT SELL (maker) para SHORT qty={quantity_str}...")
                ok, self.entry_price = self._place_limit_entry_and_wait('SELL', quantity_str)
                if not ok:
                    return
                self.buyed = True  # só após entrada efectiva
                time.sleep(1)
                self.get_current_position()
                print(f"🔧 Configurando SL/TP LIMIT para SHORT...")
                self.place_sl_tp('short', self.entry_price)
                print(f"✅ SHORT concluído (entrada + SL/TP em limit).")
            except Exception as e:
                print(f"❌ Erro ao abrir SHORT: {e}")
                import traceback
                traceback.print_exc()
                return

        elif signal == 'sell':
            if self.position == 'long':
                position_qty = self._get_position_quantity()
                if position_qty is None:
                    return
                # Fecha a posição; só cancela SL/TP e actualiza buyed se fechar com sucesso
                if self._place_limit_close_and_wait('SELL', position_qty):
                    self.cancel_sl_tp()
                    self.position = None
                    self.buyed = False
            elif self.position == 'short':
                position_qty = self._get_position_quantity()
                if position_qty is None:
                    return
                # Fecha a posição; só cancela SL/TP e actualiza buyed se fechar com sucesso
                if self._place_limit_close_and_wait('BUY', position_qty):
                    self.cancel_sl_tp()
                    self.position = None
                    self.buyed = False
            else:
                print("No position to close.")

    def run(self):
        print(f"🚀 Starting trading bot for {self.symbol} on {self.timeframe} timeframe.")
        
        # Primeira execução imediata
        first_run = True
        
        while True:
            try:
                if not first_run:
                    self.wait_for_next_candle()
                    # Esperar para a Binance finalizar o OHLC (evita CLOSE incorreto vs TradingView)
                    time.sleep(5)

                    now_sec = time.time()
                    need_full_refresh = (
                        self.last_ohlcv_full_refresh is None or
                        (now_sec - self.last_ohlcv_full_refresh) >= self.ohlcv_refresh_interval_sec
                    )

                    if need_full_refresh:
                        # De 1h em 1h ou 2h em 2h: apagar todo o OHLC e buscar tudo de novo
                        self._sync_time_with_binance()
                        self.df_cache = None
                        df_fresh = self.fetch_ohlcv(limit=self.cache_size)
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
                        df_fresh = self.fetch_ohlcv(limit=self.cache_size)
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
                    df = self.fetch_ohlcv(limit=self.cache_size)
                    self.df_cache = df.copy()
                    self.last_ohlcv_full_refresh = time.time()
                    if len(df) < self.cache_size:
                        self.cache_size = len(df)
                if df is None or len(df) == 0:
                    print(f"⚠️ Nenhum dado disponível. Aguardando...")
                    continue
                last_candle_open = df['timestamp'].iloc[-1]
                tf_sec = self.get_timeframe_seconds()
                last_candle_close = last_candle_open + pd.Timedelta(seconds=tf_sec)
                now_utc = pd.Timestamp.now(tz='UTC')
                # Se estamos muito além do fecho da última vela, forçar refresh completo (evitar ficar preso)
                if (now_utc - last_candle_close).total_seconds() > tf_sec + 30 and self.df_cache is not None:
                    df_refresh = self.fetch_ohlcv(limit=self.cache_size)
                    if df_refresh is not None and len(df_refresh) > 0:
                        self.df_cache = df_refresh.copy()
                        df = self.df_cache.copy()
                        last_candle_open = df['timestamp'].iloc[-1]
                        last_candle_close = last_candle_open + pd.Timedelta(seconds=tf_sec)
                        print(f"🔄 Cache atualizado por refresh (último candle já fechado há mais de 1 ciclo).")
                last_close_str = last_candle_close.strftime('%Y-%m-%d %H:%M:%S') if hasattr(last_candle_close, 'strftime') else str(last_candle_close)
                print(f"📊 Último candle: abertura {last_candle_open} → fechou às {last_close_str} (Total: {len(df)} candles)")
                print(f"⏰ Hora atual: {now_utc.strftime('%Y-%m-%d %H:%M:%S')} UTC")
                
                signal = self.strategy(df)
                if signal:
                    # Log adicional quando trade é executado
                    self.execute_trade(signal)
                    
            except Exception as e:
                print(f"❌ Error: {e}")
                # Em caso de erro, espera o timeframe antes de tentar novamente
                time.sleep(self.get_timeframe_seconds())

# Usage example
if __name__ == "__main__":
    # Replace with your actual API keys and parameters
    bot = TradingBot(
        # api_key='oBCUcH7rlF4HIB0XMmN3UFYUUPjrxEBwbF3rJMbMQ552iqN1RSLVd0fz9HAr95Cd', # meu
        # api_secret='DoS1h2VUbqKK0OpqnZYyD71bunbUNUybR040c0WH2mkEhc5NwCAMa5V7jEDB3vZz',
        api_key='jIFrSBMR8rgFTp2zeIadPvMHXeuL9o6z075OhuGkIYr8lGg1tNCix36pSOC3rfDL',
        api_secret='JcG8eT9n9knHSsUKDkxsoRh3mfXIuFhjXkDsjmntnop6cktHOIBjE6HN3yalqQc6', # pai
        symbol='WLD/USDC:USDC',  # USDT-margined BTC perpetual
        timeframe='1m',  # 1-minute candles
        leverage=10,  # Example leverage
        sl_percent=0.01,  # 1% stop-loss (Pine Market Lateral RSI 1min)
        tp_percent=0.02   # 2% take-profit (Pine)
    )
    bot.run()