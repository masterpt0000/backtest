import time
import pandas as pd

def fetch_ohlcv(self, limit=None):
    """
    Busca OHLCV até `limit` candles. Binance Futures limita a 1500 klines por pedido;
    faz vários pedidos com endTime para ir buscar histórico mais antigo.
    """
    if limit is None:
        limit = getattr(self, 'cache_size', 1000)
    # Binance GET /fapi/v1/klines: max 1500 por request
    klines_max = 1500

    timeframe_map = {
        '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
        '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h', '1d': '1d'
    }
    binance_timeframe = timeframe_map.get(self.timeframe, '1m')

    all_klines = []
    remaining = int(limit)
    end_time_ms = None  # None = candles mais recentes

    while remaining > 0:
        batch_limit = min(klines_max, remaining)
        params = {
            'symbol': self.symbol_internal,
            'interval': binance_timeframe,
            'limit': batch_limit,
        }
        if end_time_ms is not None:
            params['endTime'] = int(end_time_ms)

        klines = self.client.futures_klines(**params)
        if not klines:
            break

        # Resposta vem do mais antigo ao mais recente; bloco seguinte é antes do open do primeiro candle
        all_klines = klines + all_klines
        remaining -= len(klines)

        oldest_open_ms = klines[0][0]
        end_time_ms = oldest_open_ms - 1

        if len(klines) < batch_limit:
            break
        if remaining > 0:
            time.sleep(0.05)

    if not all_klines:
        return pd.DataFrame(columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])

    df = pd.DataFrame(all_klines, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume',
                                            'close_time', 'quote_volume', 'trades', 'taker_buy_base',
                                            'taker_buy_quote', 'ignore'])
    df = df[['timestamp', 'open', 'high', 'low', 'close', 'volume']].copy()
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
    df[['open', 'high', 'low', 'close', 'volume']] = df[['open', 'high', 'low', 'close', 'volume']].astype(float)
    df = df.sort_values('timestamp').drop_duplicates(subset=['timestamp'], keep='first').reset_index(drop=True)
    # Cortar ao máximo pedido (pode haver overlap mínimo em teorias edge)
    if len(df) > limit:
        df = df.iloc[-limit:].reset_index(drop=True)

    # Verificar se o último candle já fechou e está finalizado na API (Binance demora alguns segundos)
    if len(df) > 0:
        last_candle_timestamp = df['timestamp'].iloc[-1]
        timeframe_seconds = get_timeframe_seconds(self)
        safety_margin = pd.Timedelta(seconds=5)

        candle_close_time = last_candle_timestamp + pd.Timedelta(seconds=timeframe_seconds)
        current_time = pd.Timestamp.now(tz='UTC')

        if current_time < (candle_close_time + safety_margin):
            df = df.iloc[:-1].copy()
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
    timeframe_seconds = get_timeframe_seconds(self)
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
            time.sleep(get_timeframe_seconds(self))
            return
        
        last_candle_timestamp = klines[-1][0]  # Timestamp do último candle em ms
        timeframe_seconds = get_timeframe_seconds(self)
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
        time.sleep(get_timeframe_seconds(self))