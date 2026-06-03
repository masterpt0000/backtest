import numpy as np
import pandas as pd


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

def vwap_close_daily(df, close: pd.Series, volume: pd.Series) -> pd.Series:
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


def pine_wilder_smooth(values, period):
    """
    Pine manual (não é ta.rma): S := nz(S[1]) - nz(S[1])/period + source.
    Equivale a prev*(period-1)/period + source (soma o valor inteiro).
    O indicador embutido ta.adx usa ta.rma — ver pine_rma.
    """
    values = np.asarray(values, dtype=np.float64)
    n = len(values)
    if n == 0:
        return np.array([], dtype=np.float64)
    result = np.empty(n, dtype=np.float64)
    result[0] = values[0]
    p = float(period)
    for i in range(1, n):
        result[i] = result[i - 1] * (p - 1.0) / p + values[i]
    return result


def pine_rma(values, period):
    """
    Igual ao TradingView ta.rma: na(s[1]) ? source : (s[1]*(len-1)+source)/len.
    Usado em ta.adx para TR, +DM, -DM e para suavizar DX no ADX (não é SMA).
    """
    values = np.asarray(values, dtype=np.float64)
    n = len(values)
    result = np.full(n, np.nan, dtype=np.float64)
    if n == 0:
        return result
    p = float(period)
    for i in range(n):
        x = values[i]
        if not np.isfinite(x):
            result[i] = np.nan
            continue
        if i == 0 or not np.isfinite(result[i - 1]):
            result[i] = x
        else:
            result[i] = (result[i - 1] * (p - 1.0) + x) / p
    return result

def wilders_smoothing(series: pd.Series, length: int) -> pd.Series:
    result = np.zeros(len(series))
    for i in range(len(series)):
        if i == 0:
            result[i] = series.iloc[i]
        else:
            result[i] = result[i - 1] - result[i - 1] / length + series.iloc[i]
    return pd.Series(result, index=series.index)

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

    # ta.adx: ta.rma em TR, +DM e -DM (não é o script manual com TR inteiro)
    SmoothedTrueRange = pine_rma(TrueRange, length) * 100
    SmoothedDirectionalMovementPlus = pine_rma(DirectionalMovementPlus, length) * 100
    SmoothedDirectionalMovementMinus = pine_rma(DirectionalMovementMinus, length) * 100

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

def vfi_vfima(df, length_vol, coef_vol, vcoef_vol, signal_length, smooth_vfi):
    """Pine VFI block → vfima * 100."""
    hlc3 = (df['high'] + df['low'] + df['close']) / 3
    typical_vol = hlc3
    inter_vol = np.log(typical_vol.clip(lower=1e-12)) - np.log(typical_vol.shift(1).clip(lower=1e-12))
    vinter_vol = inter_vol.rolling(30, min_periods=1).std()
    cutoff_vol = coef_vol * vinter_vol * df['close']
    vave_vol = df['volume'].rolling(length_vol, min_periods=1).mean().shift(1)
    vmax_vol = vave_vol * vcoef_vol
    vc_vol = np.minimum(df['volume'], vmax_vol)
    mf_vol = typical_vol - typical_vol.shift(1)
    vcp_vol = np.where(
        mf_vol > cutoff_vol,
        vc_vol,
        np.where(mf_vol < -cutoff_vol, -vc_vol, 0.0),
    )
    vfi_raw_vol = pd.Series(vcp_vol, index=df.index).rolling(length_vol, min_periods=1).mean()
    vfi_base = vfi_raw_vol / vave_vol.replace(0, np.nan)
    if smooth_vfi:
        vfi_vol = vfi_base.rolling(3, min_periods=1).mean()
    else:
        vfi_vol = vfi_base
    vfima = vfi_vol.ewm(span=int(signal_length), min_periods=int(signal_length), adjust=False).mean() * 100.0
    return vfima