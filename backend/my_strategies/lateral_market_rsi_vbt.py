"""
lateral_market_rsi_vbt.py
─────────────────────────
Estratégia lateral_market_rsi para vectorbt: EMAs com **Pandas** ``ewm`` (mais rápido
que ``vbt.MA.run`` numa única série); WMA e contagens consecutivas via **Numba**;
True Range e OBV em **NumPy** (menos alocações Pandas); VWAP diário em **Numba**
(um passe, sem ``groupby``); RSI Wilder e ATR=WMA(TR) mantêm a lógica original.

API pública:
    get_strategy_parameters()           → dict de specs (igual ao original)
    get_chart_strategy_for_ui()         → dict para o chart Next.js (defaults dos tuplos)
    compute_indicators(df, params)      → dict de arrays 1D
    compute_signals(ind, params)        → 4 arrays 1D booleanos
    compute_signals_vectorized(ind, thr_params_list)
                                        → 4 arrays 2D (n_bars × n_combos) + sl/tp
"""

import numpy as np
import pandas as pd
import vectorbt as vbt
from numba import njit

try:
    vbt.settings.caching["enabled"] = True
except Exception:
    pass


# ═══════════════════════════════════════════════════════════════════════════════
#  PARÂMETROS (cópia do ficheiro original — não importa para não criar dependência)
# ═══════════════════════════════════════════════════════════════════════════════

# Metadata para o orquestrador (timeframe/símbolos/risco definidos na estratégia)
STRATEGY_META = {
    "id": "lateral_rsi_scalp",
    "chart_label": "Lateral Market RSI",
    "kind": "scalp",
    "timeframe": "3m",
    "symbols": ["WLD/USDC:USDC"],
    "leverage": 5,
    "margin_wallet_share": 0.80,
}

def get_strategy_parameters():
    return {
        'atr_wma_length':       (100,  50,   200,  25,    False, True),
        'ema_fast_span':        (100,  50,   200,  25,    False, True),
        'ema_span':             (10,   5,    30,   5,     False, True),
        'ema_slow_span':        (1000, 500,  2000, 500,   False, False),
        'dif_ema_shift':        (10,   5,    20,   5,     False, False),
        'rsi_close_length':     (9,    5,    21,   2,     False, True),
        'adx_length':           (10,   5,    20,   5,     False, False),
        'envelope_length':      (300,  100,  500,  100,   False, False),
        'envelope_mult':        (1,  0.8,  1.5,  0.1,  True,  False),
        'vol_sma_length':       (4000, 1000, 8000, 1000,  False, True),
        'atr_pct_max':          (1.0,  0.3,  2.5,  0.2,  True,  True),
        'dif_pct_abs_max':      (0.18, 0.05, 0.5,  0.05, True,  True),
        'dif_obv_norm_max':     (8.5,  1.0,  20.0, 1.0,  True,  True),
        'flat_ema2_pct_max':    (0.55, 0.1,  1.5,  0.1,  True,  False),
        'flat_ema2_exit_bars':  (15,   5,    30,   5,    False, False),
        'get_out_exit_bars':    (5,    2,    15,   1,    False, False),
        'rsi_over_sold':        (25,   15,   40,   2,    False, True),
        'rsi_over_bought':      (75,   60,   85,   2,    False, True),
        'rsi_vwap_over_sold':   (15,   5,    30,   5,    False, False),
        'rsi_vwap_over_bought': (85,   70,   95,   5,    False, False),
        'tp_pct':               (0.03, 0.01, 0.07, 0.01, True,  False),
        'sl_pct':               (0.03, 0.01, 0.07, 0.01, True,  True),
    }


def _param_default(params: dict, key: str) -> int | float:
    """Primeiro valor do tuplo (default) de get_strategy_parameters()."""
    t = params[key]
    if not isinstance(t, tuple) or len(t) < 1:
        raise KeyError(key)
    v = t[0]
    if isinstance(v, bool):
        return int(v)
    return v


def get_chart_strategy_for_ui() -> dict:
    """
    Estratégia para o chart Next.js: indicadores alinhados com ``get_strategy_parameters()``.
    Só tipos suportados pelo frontend (ema, bollinger, rsi). Os períodos/multiplicadores
    vêm sempre do **default** (1.º elemento) de cada tuplo.
    """
    p = get_strategy_parameters()
    meta = STRATEGY_META
    sid = str(meta["id"])
    label = str(meta.get("chart_label") or meta.get("name") or "Estratégia")

    ema_fast = int(_param_default(p, "ema_fast_span"))
    ema_mid = int(_param_default(p, "ema_span"))
    ema_slow = int(_param_default(p, "ema_slow_span"))
    env_len = int(_param_default(p, "envelope_length"))
    env_mult = float(_param_default(p, "envelope_mult"))
    rsi_len = int(_param_default(p, "rsi_close_length"))

    indicators: list[dict] = [
        {
            "id": "ema_fast",
            "label": f"EMA rápida ({ema_fast})",
            "group": "overlays",
            "kind": "ema",
            "params": {"period": ema_fast},
        },
        {
            "id": "ema_core",
            "label": f"EMA ({ema_mid})",
            "group": "overlays",
            "kind": "ema",
            "params": {"period": ema_mid},
        },
        {
            "id": "ema_slow",
            "label": f"EMA lenta ({ema_slow})",
            "group": "overlays",
            "kind": "ema",
            "params": {"period": ema_slow},
        },
        {
            "id": "envelope_bb",
            "label": f"Envelope → BB ({env_len}, ×{env_mult})",
            "group": "overlays",
            "kind": "bollinger",
            "params": {"period": env_len, "mult": env_mult},
        },
        {
            "id": "rsi_close",
            "label": f"RSI close ({rsi_len})",
            "group": "studies",
            "kind": "rsi",
            "params": {"period": rsi_len},
        },
    ]

    return {"id": sid, "label": label, "indicators": indicators}


# ═══════════════════════════════════════════════════════════════════════════════
#  FUNÇÕES AUXILIARES
# ═══════════════════════════════════════════════════════════════════════════════

@njit(cache=True)
def _wma_nb(series: np.ndarray, length: int) -> np.ndarray:
    """WMA do True Range (mesma fórmula que antes; compilado com Numba)."""
    n = len(series)
    result = np.empty(n, dtype=np.float64)
    for i in range(n):
        result[i] = np.nan
    w = np.empty(length, dtype=np.float64)
    for j in range(length):
        w[j] = j + 1
    w_sum = 0.0
    for j in range(length):
        w_sum += w[j]
    for i in range(length - 1, n):
        s = 0.0
        base = i - length + 1
        for j in range(length):
            s += series[base + j] * w[j]
        result[i] = s / w_sum
    return result


def _wma(series: np.ndarray, length: int) -> np.ndarray:
    x = np.asarray(series, dtype=np.float64)
    return _wma_nb(x, int(length))


def _day_bucket_ns(index, n: int) -> np.ndarray:
    """Dia em UTC (meia-noite) como int64 ns — mesmo critério que ``normalize()`` para agrupar VWAP."""
    try:
        idx = pd.DatetimeIndex(pd.to_datetime(index, utc=True))
        if len(idx) != n:
            return np.zeros(n, dtype=np.int64)
        return idx.normalize().asi8.astype(np.int64)
    except Exception:
        return np.zeros(n, dtype=np.int64)


@njit(cache=True)
def _vwap_daily_nb(close: np.ndarray, volume: np.ndarray, day_ns: np.ndarray) -> np.ndarray:
    """VWAP com reset quando ``day_ns`` muda (equivalente ao ``groupby`` diário em Pandas)."""
    n = len(close)
    out = np.empty(n, dtype=np.float64)
    cum_pv = 0.0
    cum_v = 0.0
    for i in range(n):
        if i == 0 or day_ns[i] != day_ns[i - 1]:
            cum_pv = 0.0
            cum_v = 0.0
        cum_pv += close[i] * volume[i]
        cum_v += volume[i]
        if cum_v == 0.0:
            out[i] = np.nan
        else:
            out[i] = cum_pv / cum_v
    return out


def _ema(close: pd.Series, span: int) -> pd.Series:
    """EMA; Pandas ``ewm`` é mais leve que ``vbt.MA.run`` por chamada numa só série."""
    return close.ewm(span=int(span), min_periods=int(span), adjust=False).mean()


def _rsi(series: pd.Series, length: int) -> np.ndarray:
    """RSI com smoothing de Wilder (alpha = 1/length)."""
    delta    = series.diff()
    gain     = delta.where(delta > 0, 0.0)
    loss     = (-delta).where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / length, min_periods=length, adjust=False).mean()
    rs       = avg_gain / avg_loss.replace(0, np.nan)
    rsi_val  = 100 - (100 / (1 + rs))
    rsi_val  = np.where(avg_loss == 0, 100, rsi_val)
    rsi_val  = np.where(avg_gain == 0,   0, rsi_val)
    return rsi_val


def _vwap_daily(close: pd.Series, volume: pd.Series, index) -> np.ndarray:
    """VWAP com reset diário (Numba; fallback de dia único se o índice não for temporal)."""
    c = close.to_numpy(dtype=np.float64, copy=False)
    v = volume.to_numpy(dtype=np.float64, copy=False)
    day_ns = _day_bucket_ns(index, len(c))
    return _vwap_daily_nb(c, v, day_ns)


def _vwma(source: pd.Series, volume: pd.Series, length: int) -> pd.Series:
    pv  = (source * volume).rolling(length, min_periods=1).sum()
    vol = volume.rolling(length, min_periods=1).sum().replace(0, np.nan)
    return pv / vol


@njit(cache=True)
def _consecutive_count_nb(arr: np.ndarray) -> np.ndarray:
    """Conta barras consecutivas True (reset a 0 quando False)."""
    n = len(arr)
    result = np.zeros(n, dtype=np.int32)
    count = 0
    for i in range(n):
        if arr[i]:
            count += 1
        else:
            count = 0
        result[i] = count
    return result


def _consecutive_count(arr: np.ndarray) -> np.ndarray:
    a = np.asarray(arr, dtype=np.bool_)
    return _consecutive_count_nb(a)


# ═══════════════════════════════════════════════════════════════════════════════
#  INDICADORES
# ═══════════════════════════════════════════════════════════════════════════════

def compute_indicators(df: pd.DataFrame, params: dict) -> dict | None:
    """
    Calcula todos os indicadores a partir de OHLCV.
    Parâmetros afectados: atr_wma_length, ema_fast_span, ema_span,
                          dif_ema_shift, rsi_close_length, envelope_length,
                          envelope_mult, vol_sma_length.
    Devolve dict de arrays numpy 1D ou None se falhar.
    """
    try:
        close  = df['Close'].astype(np.float64)
        high   = df['High'].astype(np.float64)
        low    = df['Low'].astype(np.float64)
        volume = df['Volume'].astype(np.float64)
        c      = close.to_numpy()
        h      = high.to_numpy()
        l      = low.to_numpy()
        vol_a  = volume.to_numpy()

        # ── ATR (WMA do True Range) — TR em NumPy (evita shift/abs em Series) ─
        hl = h - l
        prev_c = np.empty_like(c)
        prev_c[0] = np.nan
        prev_c[1:] = c[:-1]
        hc = np.abs(h - prev_c)
        lc = np.abs(l - prev_c)
        tr = np.nanmax(np.stack((hl, hc, lc), axis=0), axis=0)
        atr = _wma(tr, params['atr_wma_length'])
        with np.errstate(divide='ignore', invalid='ignore'):
            atr_pct = np.where(c != 0, atr / c * 100, np.nan)

        # ── EMA rápida + média + dif percentual ──────────────────────────
        shift    = params['dif_ema_shift']
        ema_fast = _ema(close, params['ema_fast_span'])
        ema_med  = _ema(close, params['ema_span'])
        dif_ema  = ema_fast - ema_fast.shift(shift)
        dif_ema2 = ema_med  - ema_med.shift(shift)
        with np.errstate(divide='ignore', invalid='ignore'):
            dif_pct  = np.where(ema_fast != 0, (dif_ema  / ema_fast) * 100, np.nan)
            dif_pct2 = np.where(ema_med  != 0, (dif_ema2 / ema_med)  * 100, np.nan)

        # ── RSI VWAP (reset diário, length=1 igual ao Pine) ──────────────
        vwap     = pd.Series(_vwap_daily(close, volume, df.index), index=df.index)
        rsi_vwap = _rsi(vwap, 1)

        # ── RSI close ────────────────────────────────────────────────────
        rsi_close = _rsi(close, params['rsi_close_length'])

        # ── Envelope Fibonacci (VWMA ± stdev) ────────────────────────────
        hlc3   = (high + low + close) / 3
        basis  = _vwma(hlc3, volume, params['envelope_length'])
        dev    = params['envelope_mult'] * hlc3.rolling(params['envelope_length'], min_periods=1).std()
        upper6 = (basis + dev).values
        lower6 = (basis - dev).values

        # ── OBV normalizado (equivalente a sign(diff)*V cumsum + diff; vol SMA Pandas)
        sign_obv = np.zeros(len(c), dtype=np.float64)
        sign_obv[1:] = np.sign(np.diff(c))
        obv = np.cumsum(sign_obv * vol_a)
        dif_obv = np.empty_like(obv)
        dif_obv[0] = 0.0
        dif_obv[1:] = np.diff(obv)
        vol_sma = (
            volume.rolling(params['vol_sma_length'], min_periods=1)
            .mean()
            .replace(0, np.nan)
            .to_numpy()
        )
        with np.errstate(divide='ignore', invalid='ignore'):
            dif_obv_n = dif_obv / vol_sma

        # ── get_out: preço fora do envelope (N barras consecutivas → saída) ──
        c_vals        = c
        get_out       = (lower6 > c_vals) | (upper6 < c_vals)
        get_out_consec = _consecutive_count(get_out)

        return {
            'close':          c_vals,
            'atr_pct':        np.asarray(atr_pct,        dtype=np.float64),
            'dif_pct':        np.asarray(dif_pct,        dtype=np.float64),
            'dif_pct2':       np.asarray(dif_pct2,       dtype=np.float64),
            'rsi':            np.asarray(rsi_close,       dtype=np.float64),
            'rsi_vwap':       np.asarray(rsi_vwap,        dtype=np.float64),
            'upper6':         np.asarray(upper6,          dtype=np.float64),
            'lower6':         np.asarray(lower6,          dtype=np.float64),
            'dif_obv_norm':   np.asarray(dif_obv_n,       dtype=np.float64),
            'get_out_consec': np.asarray(get_out_consec,  dtype=np.int32),
        }
    except Exception as e:
        print(f"  ⚠️ compute_indicators falhou: {e}")
        return None


# ═══════════════════════════════════════════════════════════════════════════════
#  SINAIS — 1 conjunto de parâmetros
# ═══════════════════════════════════════════════════════════════════════════════

def compute_signals(ind: dict, params: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Gera sinais de entrada/saída para UM conjunto de parâmetros.
    Devolve: (long_entries, long_exits, short_entries, short_exits) — arrays 1D bool.
    """
    # Substituir NaN por valores neutros para não gerar sinais espúrios
    atr = np.nan_to_num(ind['atr_pct'],      nan=1e9)
    dp  = np.nan_to_num(ind['dif_pct'],      nan=1e9)
    dp2 = np.nan_to_num(ind['dif_pct2'],     nan=1e9)
    obv = np.nan_to_num(ind['dif_obv_norm'], nan=1e9)
    ri  = np.nan_to_num(ind['rsi'],          nan=50.0)
    rv  = np.nan_to_num(ind['rsi_vwap'],     nan=50.0)
    c   = ind['close']
    up  = np.nan_to_num(ind['upper6'],       nan=1e9)
    lo  = np.nan_to_num(ind['lower6'],       nan=-1e9)

    filter_trend = (
        (up > c) & (lo < c)
        & (atr < params['atr_pct_max'])
        & (np.abs(dp) <= params['dif_pct_abs_max'])
        & (np.abs(obv) <= params['dif_obv_norm_max'])
    )

    long_entries  = filter_trend & (ri < params['rsi_over_sold'])  & (rv < params['rsi_vwap_over_sold'])
    short_entries = filter_trend & (ri > params['rsi_over_bought']) & (rv > params['rsi_vwap_over_bought'])

    # Saída RSI
    exit_long  = ri > 50
    exit_short = ri < 50

    # Saída por EMA2 plana (N barras consecutivas)
    ema2_flat = np.abs(dp2) <= params['flat_ema2_pct_max']
    consec    = _consecutive_count(ema2_flat)
    flat_exit = consec >= params['flat_ema2_exit_bars']

    # Saída por preço fora do envelope (N barras consecutivas)
    get_out_exit = ind['get_out_consec'] >= params['get_out_exit_bars']

    long_exits  = exit_long  | flat_exit | get_out_exit
    short_exits = exit_short | flat_exit | get_out_exit

    return long_entries, long_exits, short_entries, short_exits


# ═══════════════════════════════════════════════════════════════════════════════
#  SINAIS — múltiplos conjuntos de threshold (vectorizado)
# ═══════════════════════════════════════════════════════════════════════════════

def compute_signals_vectorized(
        ind: dict,
        thr_params_list: list[dict],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Gera sinais para MÚLTIPLOS conjuntos de threshold usando numpy broadcasting.
    A lógica dos indicadores não muda entre combinações — só os thresholds variam.

    Devolve: (long_entries, long_exits, short_entries, short_exits, sl_arr, tp_arr)
        - long_entries / ... : arrays 2D bool (n_bars × n_combos)
        - sl_arr / tp_arr    : arrays 1D float (n_combos,)
    """
    nc = len(thr_params_list)

    # ── Extrair thresholds em arrays (n_combos,) ─────────────────────────
    atr_max      = np.array([t['atr_pct_max']         for t in thr_params_list])
    dif_max      = np.array([t['dif_pct_abs_max']      for t in thr_params_list])
    obv_max      = np.array([t['dif_obv_norm_max']     for t in thr_params_list])
    flat_max     = np.array([t['flat_ema2_pct_max']    for t in thr_params_list])
    flat_bars    = np.array([t['flat_ema2_exit_bars']  for t in thr_params_list], dtype=int)
    get_out_bars = np.array([t['get_out_exit_bars']    for t in thr_params_list], dtype=int)
    rsi_os       = np.array([t['rsi_over_sold']        for t in thr_params_list])
    rsi_ob       = np.array([t['rsi_over_bought']      for t in thr_params_list])
    vwap_os      = np.array([t['rsi_vwap_over_sold']   for t in thr_params_list])
    vwap_ob      = np.array([t['rsi_vwap_over_bought'] for t in thr_params_list])
    sl_arr       = np.array([t['sl_pct']               for t in thr_params_list])
    tp_arr       = np.array([t['tp_pct']               for t in thr_params_list])

    # ── Indicadores como coluna (n_bars, 1) para broadcast ───────────────
    atr = np.nan_to_num(ind['atr_pct'],      nan=1e9)[:, None]
    dp  = np.nan_to_num(ind['dif_pct'],      nan=1e9)[:, None]
    dp2 = np.nan_to_num(ind['dif_pct2'],     nan=1e9)
    obv = np.nan_to_num(ind['dif_obv_norm'], nan=1e9)[:, None]
    ri  = np.nan_to_num(ind['rsi'],          nan=50.0)
    rv  = np.nan_to_num(ind['rsi_vwap'],     nan=50.0)[:, None]
    c   = ind['close'][:, None]
    up  = np.nan_to_num(ind['upper6'],       nan=1e9)[:, None]
    lo  = np.nan_to_num(ind['lower6'],       nan=-1e9)[:, None]
    goc = ind['get_out_consec']  # 1D int32

    # ── filter_trend: (n_bars, n_combos) — broadcast automático ──────────
    filter_trend = (
        (up > c) & (lo < c)
        & (atr < atr_max)
        & (np.abs(dp) <= dif_max)
        & (np.abs(obv) <= obv_max)
    )

    # ── Entradas ──────────────────────────────────────────────────────────
    long_entries  = filter_trend & (ri[:, None] < rsi_os) & (rv < vwap_os)
    short_entries = filter_trend & (ri[:, None] > rsi_ob) & (rv > vwap_ob)

    # ── Saídas RSI (independente de threshold → broadcast simples) ────────
    exit_long  = np.broadcast_to((ri > 50)[:, None], (len(ri), nc)).copy()
    exit_short = np.broadcast_to((ri < 50)[:, None], (len(ri), nc)).copy()

    # ── Saída EMA2 plana — por combinação única de (flat_max, flat_bars) ──
    flat_exit = np.zeros((len(ri), nc), dtype=bool)
    u_flat_max = np.unique(flat_max)
    consec_by_flat_max: dict[float, np.ndarray] = {}
    for u_max in u_flat_max:
        ema2_flat = np.abs(dp2) <= u_max
        consec_by_flat_max[float(u_max)] = _consecutive_count(ema2_flat)
    for u_max in u_flat_max:
        consec = consec_by_flat_max[float(u_max)]
        for u_bars in np.unique(flat_bars):
            mask = (flat_max == u_max) & (flat_bars == u_bars)
            if not mask.any():
                continue
            fe = (consec >= u_bars)[:, None]
            flat_exit[:, mask] = np.broadcast_to(fe, (len(ri), int(mask.sum())))

    # ── Saída get_out (preço fora do envelope N barras consecutivas) ──────
    get_out_exit = np.zeros((len(ri), nc), dtype=bool)
    for u_bars in np.unique(get_out_bars):
        mask = get_out_bars == u_bars
        if not mask.any():
            continue
        ge = (goc >= u_bars)[:, None]
        get_out_exit[:, mask] = np.broadcast_to(ge, (len(ri), int(mask.sum())))

    long_exits  = exit_long  | flat_exit | get_out_exit
    short_exits = exit_short | flat_exit | get_out_exit

    return long_entries, long_exits, short_entries, short_exits, sl_arr, tp_arr
