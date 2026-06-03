# Estrategia autocontida: **todos os cálculos de indicadores** estão neste ficheiro.
# Copias só este `.py` para outra pasta quando:
#   • quiseres testar `indicators(DataFrame)` — basta `pandas`, `numpy`, `talib`;
#   • quiseres bot completo — mantém os `import configs.*` (ou estrutura equivalente)
#     e define `BOT_API_KEY` / `BOT_API_SECRET` no ambiente.

from __future__ import annotations

import os
from typing import Any

import numpy as np
import pandas as pd
import talib

# ── Motor do teu bot (opcional nesta pasta só para estratégias importadas assim) ──
from configs.get_info_account import *
from configs.get_candles import *
from configs.Actions_trading import *
from configs.Sync_time import *
from configs.loop import *
from configs.Custom_indicators import *
from configs.bot_main import TradingBot


# ═══════════════════════════════════════════════════════════════════════════════
# Trend composite — cópia local (equivale ao backend ``trend_composite.py``)
# ═══════════════════════════════════════════════════════════════════════════════


def _tc_ema(x: np.ndarray, span: int) -> np.ndarray:
    if x.size == 0:
        return x
    s = pd.Series(np.asarray(x, dtype=np.float64), dtype=np.float64)
    return s.ewm(span=int(span), adjust=False).mean().to_numpy(dtype=np.float64)


def _tc_wilder_rma(x: np.ndarray, length: int) -> np.ndarray:
    n = x.size
    out = np.full(n, np.nan, dtype=np.float64)
    if n == 0 or length < 1:
        return out
    if n < length:
        return out
    window = x[:length]
    out[length - 1] = float(np.nanmean(window))
    alpha = 1.0 / float(length)
    for i in range(length, n):
        out[i] = out[i - 1] + alpha * (x[i] - out[i - 1])
    return out


def _tc_true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    n = int(high.size)
    tr = np.full(n, np.nan, dtype=np.float64)
    if n == 0:
        return tr
    tr[0] = high[0] - low[0]
    for i in range(1, n):
        a = high[i] - low[i]
        b = abs(high[i] - close[i - 1])
        c = abs(low[i] - close[i - 1])
        tr[i] = max(a, b, c)
    return tr


def _tc_sma(x: np.ndarray, length: int) -> np.ndarray:
    if x.size == 0 or length < 1:
        return np.full_like(x, np.nan, dtype=np.float64)
    s = pd.Series(np.asarray(x, dtype=np.float64), dtype=np.float64)
    return s.rolling(window=length, min_periods=length).mean().to_numpy(dtype=np.float64)


def _tc_rsi(close: np.ndarray, length: int) -> np.ndarray:
    if close.size == 0 or length < 2:
        return np.full_like(close, np.nan, dtype=np.float64)
    diff = np.diff(close, prepend=np.nan)
    gains = np.where(diff > 0, diff, 0.0)
    losses = np.where(diff < 0, -diff, 0.0)
    avg_gain = _tc_wilder_rma(gains[1:], length)
    avg_loss = _tc_wilder_rma(losses[1:], length)
    out = np.full(close.size, np.nan, dtype=np.float64)
    for i in range(1, close.size):
        gi = avg_gain[i - 1] if i - 1 < avg_gain.size else np.nan
        li = avg_loss[i - 1] if i - 1 < avg_loss.size else np.nan
        if not np.isfinite(gi) or not np.isfinite(li):
            continue
        if li <= 1e-14:
            out[i] = 100.0 if gi > 1e-14 else 50.0
        else:
            rs = gi / li
            out[i] = 100.0 - (100.0 / (1.0 + rs))
    return out


def _tc_rolling_zscore_then_tanh(x: np.ndarray, window: int, clip: float) -> np.ndarray:
    w = max(5, int(window))
    c = max(0.25, float(clip))
    s = pd.Series(np.asarray(x, dtype=np.float64), dtype=np.float64)
    m = s.rolling(window=w, min_periods=w).mean()
    sd = s.rolling(window=w, min_periods=w).std(ddof=0)
    z = ((s - m) / sd.replace(0.0, np.nan)).to_numpy(dtype=np.float64)
    return np.tanh(z / c)


def _tc_preset_raw_series(
    o: np.ndarray,
    h: np.ndarray,
    l: np.ndarray,
    c: np.ndarray,
    preset: str,
    params: dict[str, float | int],
) -> np.ndarray:
    p = params or {}
    n = c.size
    out = np.full(n, np.nan, dtype=np.float64)

    if preset == "price_vs_sma_atr":
        sma_p = int(float(p.get("sma_period", p.get("smaPeriod", 50))))
        sma_p = max(2, min(500, sma_p))
        atr_p = int(float(p.get("atr_period", p.get("atrPeriod", 14))))
        atr_p = max(1, min(500, atr_p))
        sma = _tc_sma(c, sma_p)
        tr = _tc_true_range(h, l, c)
        atr = _tc_wilder_rma(tr, atr_p)
        denom = np.where(np.isfinite(atr) & (atr > 1e-15), atr, np.nan)
        return (c - sma) / denom

    if preset == "rsi_zscore":
        rlen = int(float(p.get("rsi_period", p.get("rsiPeriod", 14))))
        rlen = max(2, min(500, rlen))
        return _tc_rsi(c, rlen)

    if preset == "macd_hist_zscore":
        fast = max(1, min(200, int(float(p.get("fast", 12)))))
        slow = max(1, min(500, int(float(p.get("slow", 26)))))
        sig = max(1, min(200, int(float(p.get("signal", 9)))))
        fe = _tc_ema(c, fast)
        se = _tc_ema(c, slow)
        macd = fe - se
        sigl = _tc_ema(macd, sig)
        return macd - sigl

    if preset == "plus_di_minus_di":
        period = int(float(p.get("period", p.get("adx_period", 14))))
        period = max(2, min(500, period))
        try:
            pdi = talib.PLUS_DI(h.astype(float), l.astype(float), c.astype(float), timeperiod=period)
            mdi = talib.MINUS_DI(h.astype(float), l.astype(float), c.astype(float), timeperiod=period)
            return (np.asarray(pdi, dtype=np.float64) - np.asarray(mdi, dtype=np.float64)) / 100.0
        except Exception:
            pass
        plus_dm = np.zeros(n, dtype=np.float64)
        minus_dm = np.zeros(n, dtype=np.float64)
        for i in range(1, n):
            up_move = h[i] - h[i - 1]
            down_move = l[i - 1] - l[i]
            if up_move > down_move and up_move > 0:
                plus_dm[i] = up_move
            if down_move > up_move and down_move > 0:
                minus_dm[i] = down_move
        tr = _tc_true_range(h, l, c)
        tr_s = _tc_wilder_rma(tr, period)
        pdm_s = _tc_wilder_rma(plus_dm, period)
        mdm_s = _tc_wilder_rma(minus_dm, period)
        with np.errstate(divide="ignore", invalid="ignore"):
            pdi = np.where(tr_s > 1e-15, 100.0 * pdm_s / tr_s, np.nan)
            mdi = np.where(tr_s > 1e-15, 100.0 * mdm_s / tr_s, np.nan)
        return (pdi - mdi) / 100.0

    return out


def compute_trend_composite_score_local(
    df: pd.DataFrame,
    *,
    components: list[dict[str, Any]],
    norm_window: int,
    clip: float,
    output_scale: float,
) -> np.ndarray:
    """``df`` com colunas open/high/low/close (maiúsculas ou minúsculas)."""
    cols = {c.lower(): c for c in df.columns}

    def col(name: str) -> pd.Series:
        k = cols.get(name)
        if k is None:
            raise ValueError(f"trend_composite: falta coluna {name}")
        return df[k]

    o_arr = col("open").to_numpy(dtype=np.float64)
    h_arr = col("high").to_numpy(dtype=np.float64)
    l_arr = col("low").to_numpy(dtype=np.float64)
    c_arr = col("close").to_numpy(dtype=np.float64)
    n = c_arr.size
    if n == 0:
        return np.array([], dtype=np.float64)

    weights = [float(x.get("weight") or 0) for x in components]
    wsum = float(np.sum(weights))
    if wsum <= 0:
        raise ValueError("trend_composite: soma de pesos deve ser > 0")
    wnorm = np.asarray([w / wsum for w in weights], dtype=np.float64)

    acc = np.zeros(n, dtype=np.float64)
    any_ok = np.zeros(n, dtype=bool)

    for i, comp in enumerate(components):
        preset = comp.get("preset")
        if preset not in (
            "price_vs_sma_atr",
            "rsi_zscore",
            "macd_hist_zscore",
            "plus_di_minus_di",
        ):
            raise ValueError(f"trend_composite: preset inválido: {preset!r}")
        praw = _tc_preset_raw_series(o_arr, h_arr, l_arr, c_arr, str(preset), dict(comp.get("params") or {}))
        sub = _tc_rolling_zscore_then_tanh(praw, int(norm_window), float(clip))
        m = np.isfinite(sub)
        acc[m] += wnorm[i] * sub[m]
        any_ok |= m

    scale = float(output_scale)
    out = np.full(n, np.nan, dtype=np.float64)
    out[any_ok] = acc[any_ok] * scale
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# Estrategia
# ═══════════════════════════════════════════════════════════════════════════════

# Saídas usam entry_snap em cada entrada (ver _capture_entry_snap).

TAKE_PROFIT_PCT = 1
STOP_LOSS_PCT = 0.3
TRAILING_STOP_PCT = 0

ZONE_LONG_WAIT_CANDLES = 5
ZONE_SHORT_WAIT_CANDLES = 5

# Defaults iguais ao Trend composite do site (ajusta aqui se mudares o spec no builder).
_TC1_COMPONENTS: list[dict] = [
    {"weight": 35.0, "preset": "price_vs_sma_atr", "params": {"sma_period": 50, "atr_period": 14}},
    {"weight": 35.0, "preset": "macd_hist_zscore", "params": {"fast": 12, "slow": 26, "signal": 9}},
    {"weight": 15.0, "preset": "rsi_zscore", "params": {"rsi_period": 14}},
    {"weight": 15.0, "preset": "plus_di_minus_di", "params": {"period": 14}},
]
_TC1_NORM_WINDOW = 60
_TC1_CLIP = 2.0
_TC1_OUTPUT_SCALE = 100.0


def _fv(ser, ji):
    n = len(ser)
    if ji < 0 or ji >= n:
        return float("nan")
    v = ser.iloc[int(ji)]
    return float(v) if pd.notna(v) else float("nan")


def _entry_snap_get(self, key):
    snap = getattr(self, "entry_snap", None)
    if not isinstance(snap, dict) or key not in snap:
        return float("nan")
    v = snap[key]
    return float(v) if pd.notna(v) else float("nan")


def _capture_entry_snap(df, cur_i):
    return {
        "tc1": _fv(df["tc1"], cur_i),
    }


def indicators(df):
    df = df.copy()
    # --- OHLCV esperado: open, high, low, close, volume ---
    # t1: talib · RSI
    _t1_rsi = talib.RSI(df["close"].astype(float).values, timeperiod=50)
    df["t1"] = pd.Series(_t1_rsi, index=df.index).astype(float)
    # tc1: score composto (−scale…+scale); cálculo 100 % local neste ficheiro
    try:
        raw = compute_trend_composite_score_local(
            df,
            components=_TC1_COMPONENTS,
            norm_window=_TC1_NORM_WINDOW,
            clip=_TC1_CLIP,
            output_scale=_TC1_OUTPUT_SCALE,
        )
        df["tc1"] = pd.Series(np.asarray(raw, dtype=np.float64), index=df.index).astype(float)
    except Exception as e:
        print(f"  ⚠️ tc1 (trend composite local): {e}")
        df["tc1"] = np.nan
    return df


def strategy(self, df):
    get_current_position(self)
    print(f"POSITION: {self.position}")
    last_idx = -1
    df = indicators(df)

    n = len(df)
    cur_i = n + last_idx

    def _filter_ok_at(j):
        return ((((_fv(df["t1"], j)) > (40)) and ((_fv(df["t1"], j)) < (60))))

    market_ok = _filter_ok_at(cur_i)
    zone_long_ok = True
    zone_short_ok = True

    long_signal = bool(((_fv(df["tc1"], cur_i)) < (-60))) and market_ok
    short_signal = bool(((_fv(df["tc1"], cur_i)) > (60))) and market_ok

    exit_long = bool(((_fv(df["tc1"], cur_i)) > (((_entry_snap_get(self, "tc1")) + 60) if pd.notna(_entry_snap_get(self, "tc1")) else np.nan)))
    exit_short = bool(((_fv(df["tc1"], cur_i)) < (((_entry_snap_get(self, "tc1")) + 60) if pd.notna(_entry_snap_get(self, "tc1")) else np.nan)))

    signal_result = None

    # Saídas por regra, depois entradas (motor Chart Builder; sem TP/SL intrabar aqui).

    if self.position == "long" and exit_long:
        signal_result = "sell"
        return signal_result

    if self.position == "short" and exit_short:
        signal_result = "sell"
        return signal_result

    if long_signal and zone_long_ok and (self.position in (None, "short")):
        signal_result = "long"
        self.entry_snap = _capture_entry_snap(df, cur_i)
        return signal_result

    if short_signal and zone_short_ok and (self.position in (None, "long")):
        signal_result = "short"
        self.entry_snap = _capture_entry_snap(df, cur_i)
        return signal_result

    return signal_result


if __name__ == "__main__":
    # Preferir variáveis de ambiente em vez de chaves no código.
    _key = os.environ.get("BOT_API_KEY", "")
    _sec = os.environ.get("BOT_API_SECRET", "")
    bot = TradingBot(
        api_key=_key,
        api_secret=_sec,
        symbol="WLD/USDC:USDC",
        timeframe="1m",
        leverage=10,
        sl_percent=STOP_LOSS_PCT / 100.0,
        tp_percent=TAKE_PROFIT_PCT / 100.0,
        buyed=False,
        strategy_name="teste_com_trend",
        type_strategy="trend",
        one_trade_per_account=False,
    )
    if not hasattr(bot, "entry_snap"):
        bot.entry_snap = {}
    run(bot)
