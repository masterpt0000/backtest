"""
Indicadores técnicos no servidor — SMA, ATR, MACD (pandas) e TA-Lib (opcional).

TA-Lib: ``kind: talib`` em ``/api/chart/ta-series``; catálogo em ``GET /api/chart/talib-catalog``;
metadados de parâmetros em ``GET /api/chart/talib-function-meta``.
"""

from __future__ import annotations

import hashlib
import ast
import json
import math
import os
import time
from collections import OrderedDict
from typing import Any, Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from talib_indicators import run_talib_for_chart, talib_available
from trend_composite import components_from_pydantic, compute_trend_composite_score

router = APIRouter(tags=["chart"])

# Incluir em ``_ta_cache_key`` para invalidar cache quando mudar semântica de fórmulas (ex.: max rolling).
TA_EVAL_REVISION = 5

_VALID_SOURCES = frozenset({"open", "high", "low", "close", "hl2", "hlc3", "ohlc4"})
_TF_SECONDS = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
}
_TA_CACHE_MAX = max(8, int(os.environ.get("CHART_TA_CACHE_MAX", "96") or "96"))
# Limite base (~equivalente 1m): também usado por simulate-bars e mensagens de erro.
# Sobrepõe com CHART_TA_1M_BAR_LIMIT no ambiente se precisares de mais/menos CPU/RAM por pedido.
_TA_BASE_BAR_LIMIT = max(1_000, int(os.environ.get("CHART_TA_1M_BAR_LIMIT", "50000") or "50000"))
_TA_ABSOLUTE_BAR_LIMIT = max(
    _TA_BASE_BAR_LIMIT,
    int(os.environ.get("CHART_TA_MAX_BAR_LIMIT", "600000") or "600000"),
)
_TA_CACHE: OrderedDict[str, dict[str, Any]] = OrderedDict()


class TaBar(BaseModel):
    t: float
    o: float
    h: float
    l: float
    c: float
    v: float = 0.0


class TaIndSma(BaseModel):
    model_config = {"extra": "forbid"}
    id: str = Field(..., min_length=1, max_length=64)
    kind: Literal["sma"] = "sma"
    period: int = Field(20, ge=1, le=500)
    source: str = Field("close")
    timeframe: str | None = Field(None, max_length=16)
    """Δ do indicador (modo histograma no gráfico): expõe também ``{id}_delta`` nas fórmulas derivadas."""
    deltaLookbackBars: int | None = Field(None, ge=0, le=500)
    deltaNormalizeByPrice: bool | None = Field(None)


class TaIndAtr(BaseModel):
    model_config = {"extra": "forbid"}
    id: str = Field(..., min_length=1, max_length=64)
    kind: Literal["atr"] = "atr"
    period: int = Field(14, ge=1, le=500)
    timeframe: str | None = Field(None, max_length=16)
    deltaLookbackBars: int | None = Field(None, ge=0, le=500)
    deltaNormalizeByPrice: bool | None = Field(None)


class TaIndMacd(BaseModel):
    model_config = {"extra": "forbid"}
    id: str = Field(..., min_length=1, max_length=64)
    kind: Literal["macd"] = "macd"
    fast: int = Field(12, ge=1, le=200)
    slow: int = Field(26, ge=1, le=500)
    signal: int = Field(9, ge=1, le=200)
    source: str = Field("close")
    timeframe: str | None = Field(None, max_length=16)
    deltaLookbackBars: int | None = Field(None, ge=0, le=500)
    deltaNormalizeByPrice: bool | None = Field(None)


class TaIndTalib(BaseModel):
    model_config = {"extra": "forbid"}
    id: str = Field(..., min_length=1, max_length=64)
    kind: Literal["talib"] = "talib"
    function: str = Field(..., min_length=1, max_length=64)
    params: dict[str, int | float] = Field(default_factory=dict)
    # Fonte OHLC/composto (alinhada a _VALID_SOURCES) — EMA/RSI ligam o input real ao ``close`` sintético.
    source: str = Field("close")
    timeframe: str | None = Field(None, max_length=16)
    deltaLookbackBars: int | None = Field(None, ge=0, le=500)
    deltaNormalizeByPrice: bool | None = Field(None)


class TaIndDerived(BaseModel):
    model_config = {"extra": "forbid"}
    id: str = Field(..., min_length=1, max_length=64)
    kind: Literal["derived"] = "derived"
    mode: Literal["chain", "formula"] = "chain"
    inputRef: str | None = Field(None, max_length=128)
    transform: str | None = Field(None, max_length=32)
    params: dict[str, int | float] = Field(default_factory=dict)
    formula: str | None = Field(None, max_length=2048)
    timeframe: str | None = Field(None, max_length=16)
    deltaLookbackBars: int | None = Field(None, ge=0, le=500)
    deltaNormalizeByPrice: bool | None = Field(None)


class TaTrendComponent(BaseModel):
    model_config = {"extra": "forbid"}
    cid: str = Field("c1", max_length=32)
    weight: float = Field(..., ge=0, le=100)
    preset: Literal["price_vs_sma_atr", "rsi_zscore", "macd_hist_zscore", "plus_di_minus_di"]
    params: dict[str, int | float] = Field(default_factory=dict)


class TaIndTrendComposite(BaseModel):
    model_config = {"extra": "forbid"}
    id: str = Field(..., min_length=1, max_length=64)
    kind: Literal["trend_composite"] = "trend_composite"
    normWindow: int = Field(60, ge=5, le=500)
    clip: float = Field(2.0, ge=0.25, le=12.0)
    outputScale: float = Field(100.0, ge=1.0, le=500.0)
    components: list[TaTrendComponent] = Field(..., min_length=1, max_length=12)
    timeframe: str | None = Field(None, max_length=16)
    deltaLookbackBars: int | None = Field(None, ge=0, le=500)
    deltaNormalizeByPrice: bool | None = Field(None)

    @field_validator("components")
    @classmethod
    def _weights_sum_positive(cls, v: list[TaTrendComponent]) -> list[TaTrendComponent]:
        if sum(float(x.weight) for x in v) <= 0:
            raise ValueError("trend_composite: a soma dos pesos tem de ser > 0")
        return v


TaIndicatorSpec = TaIndSma | TaIndAtr | TaIndMacd | TaIndTalib | TaIndDerived | TaIndTrendComposite


class TaSeriesBody(BaseModel):
    bars: list[TaBar] = Field(..., min_length=1)
    indicators: list[TaIndicatorSpec] = Field(..., min_length=1, max_length=40)
    input_series: dict[str, list[float | None]] = Field(default_factory=dict)

    @field_validator("bars")
    @classmethod
    def sort_bars(cls, v: list[TaBar]) -> list[TaBar]:
        return sorted(v, key=lambda b: float(b.t))


def _ta_cache_key(body: TaSeriesBody) -> str:
    payload = {
        "_eval_rev": TA_EVAL_REVISION,
        "bars": [
            [
                round(float(b.t), 6),
                round(float(b.o), 12),
                round(float(b.h), 12),
                round(float(b.l), 12),
                round(float(b.c), 12),
                round(float(b.v), 12),
            ]
            for b in body.bars
        ],
        "indicators": [i.model_dump(mode="json") for i in body.indicators],
        "input_series": {
            k: [None if v is None else round(float(v), 12) for v in vals]
            for k, vals in sorted((body.input_series or {}).items())
        },
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.blake2b(raw, digest_size=20).hexdigest()


def _ta_cache_get(key: str) -> dict[str, Any] | None:
    hit = _TA_CACHE.get(key)
    if hit is None:
        return None
    _TA_CACHE.move_to_end(key)
    return {"compute_ms": 0.0, "series": hit["series"], "cache_hit": True}


def _ta_cache_set(key: str, series: dict[str, Any], compute_ms: float) -> None:
    _TA_CACHE[key] = {"series": series, "compute_ms": compute_ms}
    _TA_CACHE.move_to_end(key)
    while len(_TA_CACHE) > _TA_CACHE_MAX:
        _TA_CACHE.popitem(last=False)


def _price_series(df: pd.DataFrame, source: str) -> np.ndarray:
    s = (source or "close").strip().lower()
    if s not in _VALID_SOURCES:
        s = "close"
    o = df["open"].to_numpy(dtype=np.float64)
    h = df["high"].to_numpy(dtype=np.float64)
    l = df["low"].to_numpy(dtype=np.float64)
    c = df["close"].to_numpy(dtype=np.float64)
    if s == "open":
        return o
    if s == "high":
        return h
    if s == "low":
        return l
    if s == "close":
        return c
    if s == "hl2":
        return (h + l) / 2.0
    if s == "hlc3":
        return (h + l + c) / 3.0
    return (o + h + l + c) / 4.0


def _median_step_seconds(t_col: np.ndarray) -> float:
    if t_col.size < 2:
        return 0.0
    diffs = np.diff(np.sort(t_col))
    diffs = diffs[np.isfinite(diffs) & (diffs > 0)]
    if diffs.size == 0:
        return 0.0
    return float(np.median(diffs))


def _adaptive_ta_bar_limit(bars: list[TaBar]) -> int:
    """
    Mantém um limite base (por defeito ~50k velas ≈ ~1m de histórico em 1m) e escala com o
    timeframe real do gráfico, para uma janela temporal semelhante entre TFs.
    """
    if len(bars) < 2:
        return _TA_BASE_BAR_LIMIT
    t_col = np.asarray([float(b.t) for b in bars], dtype=np.float64)
    step_sec = _median_step_seconds(t_col)
    if not np.isfinite(step_sec) or step_sec <= 60.0:
        return _TA_BASE_BAR_LIMIT
    multiplier = max(1, int(round(step_sec / 60.0)))
    return min(_TA_ABSOLUTE_BAR_LIMIT, _TA_BASE_BAR_LIMIT * multiplier)


def _timeframe_seconds(raw: str | None) -> int | None:
    tf = (raw or "").strip().lower()
    if not tf or tf == "chart":
        return None
    return _TF_SECONDS.get(tf)


def _aggregate_ohlcv_to_timeframe(
    df: pd.DataFrame,
    t_col: np.ndarray,
    tf_sec: int,
) -> tuple[pd.DataFrame, np.ndarray]:
    bucket = np.floor(t_col / float(tf_sec)).astype(np.int64) * int(tf_sec)
    work = df.copy()
    work["_bucket"] = bucket
    grouped = work.groupby("_bucket", sort=True, as_index=True).agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
    )
    close_t = grouped.index.to_numpy(dtype=np.float64) + float(tf_sec)
    return grouped.reset_index(drop=True), close_t


def _align_closed_htf_to_base(
    base_t: np.ndarray,
    htf_close_t: np.ndarray,
    htf_values: np.ndarray,
) -> np.ndarray:
    out = np.full(base_t.size, np.nan, dtype=np.float64)
    j = 0
    last = np.nan
    for i, tv in enumerate(base_t):
        while j < htf_close_t.size and htf_close_t[j] <= tv:
            v = htf_values[j] if j < htf_values.size else np.nan
            last = float(v) if np.isfinite(v) else np.nan
            j += 1
        out[i] = last
    return out


def _indicator_frame(
    df: pd.DataFrame,
    t_col: np.ndarray,
    timeframe: str | None,
) -> tuple[pd.DataFrame, np.ndarray | None]:
    tf_sec = _timeframe_seconds(timeframe)
    if tf_sec is None:
        return df, None
    base_step = _median_step_seconds(t_col)
    if base_step <= 0 or tf_sec <= base_step * 1.5:
        return df, None
    htf_df, close_t = _aggregate_ohlcv_to_timeframe(df, t_col, tf_sec)
    return htf_df, close_t


def _maybe_align_indicator(
    base_t: np.ndarray,
    close_t: np.ndarray | None,
    values: np.ndarray,
) -> np.ndarray:
    if close_t is None:
        return values
    return _align_closed_htf_to_base(base_t, close_t, values)


def _ema(x: np.ndarray, span: int) -> np.ndarray:
    """EMA clássica (adjust=False), alinhada ao pandas ``ewm``."""
    if x.size == 0:
        return x
    s = pd.Series(x, dtype=np.float64)
    return s.ewm(span=span, adjust=False).mean().to_numpy(dtype=np.float64)


def _wilder_rma(x: np.ndarray, length: int) -> np.ndarray:
    """Wilder / RMA: primeira média simples, depois RMA."""
    n = x.size
    out = np.full(n, np.nan, dtype=np.float64)
    if n == 0 or length < 1:
        return out
    if n < length:
        return out
    window = x[:length]
    out[length - 1] = np.nanmean(window)
    alpha = 1.0 / float(length)
    for i in range(length, n):
        out[i] = out[i - 1] + alpha * (x[i] - out[i - 1])
    return out


def _true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    n = high.size
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


def _sma(x: np.ndarray, length: int) -> np.ndarray:
    if x.size == 0 or length < 1:
        return np.full_like(x, np.nan, dtype=np.float64)
    s = pd.Series(x, dtype=np.float64)
    return s.rolling(window=length, min_periods=length).mean().to_numpy(dtype=np.float64)


def _rsi(x: np.ndarray, length: int) -> np.ndarray:
    if x.size == 0 or length < 2:
        return np.full_like(x, np.nan, dtype=np.float64)
    diff = np.diff(x, prepend=np.nan)
    gains = np.where(diff > 0, diff, 0.0)
    losses = np.where(diff < 0, -diff, 0.0)
    avg_gain = _wilder_rma(gains[1:], length)
    avg_loss = _wilder_rma(losses[1:], length)
    out = np.full(x.size, np.nan, dtype=np.float64)
    for i in range(1, x.size):
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


def _shift_back(x: np.ndarray, lookback: int) -> np.ndarray:
    n = max(0, int(lookback))
    out = np.full_like(x, np.nan, dtype=np.float64)
    if n == 0:
        return x.astype(np.float64, copy=True)
    if n < x.size:
        out[n:] = x[:-n]
    return out


def _delta(x: np.ndarray, lookback: int) -> np.ndarray:
    return x - _shift_back(x, lookback)


def _roc(x: np.ndarray, lookback: int) -> np.ndarray:
    prev = _shift_back(x, lookback)
    out = np.full_like(x, np.nan, dtype=np.float64)
    mask = np.isfinite(prev) & (np.abs(prev) > 1e-14)
    out[mask] = (x[mask] - prev[mask]) / prev[mask]
    return out


def _normalize(x: np.ndarray, length: int) -> np.ndarray:
    n = max(2, int(length))
    s = pd.Series(x, dtype=np.float64)
    mean = s.rolling(window=n, min_periods=n).mean()
    std = s.rolling(window=n, min_periods=n).std(ddof=0)
    out = ((s - mean) / std.replace(0.0, np.nan)).to_numpy(dtype=np.float64)
    return out


def _derived_transform(name: str, x: np.ndarray, params: dict[str, int | float]) -> np.ndarray:
    key = (name or "").strip().lower()
    period = int(params.get("period") or params.get("timeperiod") or params.get("length") or 14)
    lookback = int(params.get("lookback") or params.get("bars") or params.get("period") or 1)
    if key == "ema":
        return _ema(x, max(1, min(1000, period)))
    if key == "sma":
        return _sma(x, max(1, min(1000, period)))
    if key == "rsi":
        return _rsi(x, max(2, min(1000, period)))
    if key == "delta":
        return _delta(x, max(1, min(5000, lookback)))
    if key == "roc":
        return _roc(x, max(1, min(5000, lookback)))
    if key == "abs":
        return np.abs(x)
    if key in {"normalize", "normalise"}:
        return _normalize(x, max(2, min(1000, period)))
    raise ValueError(f"transformação derivada desconhecida: {name!r}")


def _series_to_points(t_arr: np.ndarray, val_arr: np.ndarray) -> list[dict[str, float]]:
    out: list[dict[str, float]] = []
    n = min(len(t_arr), len(val_arr))
    for i in range(n):
        v = val_arr[i]
        if v is None or (isinstance(v, float) and np.isnan(v)):
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        if not np.isfinite(fv):
            continue
        out.append({"t": float(t_arr[i]), "v": fv})
    return out


def _sparse_htf_points_for_chart(
    base_t: np.ndarray,
    htf_close_t: np.ndarray,
    htf_vals: np.ndarray,
) -> list[dict[str, float]]:
    """
    Ligações rectas entre fechos HTF (sem um ponto por vela do gráfico).

    Evita o aspecto em «degraus» quando o indicador usa timeframe superior ao gráfico.
    Para derivadas/cruzamentos mantemos séries densas alinhadas em ``arrays_by_id``.
    """
    out: list[dict[str, float]] = []
    n = min(int(htf_close_t.size), int(htf_vals.size))
    if base_t.size == 0 or n == 0:
        return out
    for j in range(n):
        v = htf_vals[j]
        if v is None or (isinstance(v, float) and np.isnan(v)):
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        if not np.isfinite(fv):
            continue
        tc = float(htf_close_t[j])
        idx = int(np.searchsorted(base_t, tc, side="right") - 1)
        if idx < 0:
            continue
        out.append({"t": float(base_t[idx]), "v": fv})
    return out


def _chart_points_htf_or_dense(
    base_t: np.ndarray,
    close_t: np.ndarray | None,
    aligned_vals: np.ndarray,
    htf_vals: np.ndarray,
) -> list[dict[str, float]]:
    if close_t is None or close_t.size == 0:
        return _series_to_points(base_t, aligned_vals)
    return _sparse_htf_points_for_chart(base_t, close_t, htf_vals)


def _input_series_map(body: TaSeriesBody, n: int) -> dict[str, np.ndarray]:
    out: dict[str, np.ndarray] = {}
    for k, vals in (body.input_series or {}).items():
        key = str(k).strip()
        if not key:
            continue
        arr = np.full(n, np.nan, dtype=np.float64)
        for i, v in enumerate(vals[:n]):
            try:
                fv = float(v) if v is not None else np.nan
            except (TypeError, ValueError):
                fv = np.nan
            arr[i] = fv if np.isfinite(fv) else np.nan
        out[key] = arr
    return out


_INDICATOR_DELTA_DISPLAY_SCALE = 1000.0


def _indicator_delta_series_chart(
    scalar: np.ndarray,
    close_px: np.ndarray,
    lookback: int,
    normalize_by_price: bool,
) -> np.ndarray:
    """Δ em N barras, opcionalmente ÷ fecho; ×1000 como no HUD / builder JS."""
    n = int(scalar.shape[0])
    out = np.full(n, np.nan, dtype=np.float64)
    lb = max(1, int(lookback))
    c = np.asarray(close_px, dtype=np.float64)
    s = np.asarray(scalar, dtype=np.float64)
    for i in range(lb, n):
        v = s[i]
        v0 = s[i - lb]
        if not (np.isfinite(v) and np.isfinite(v0)):
            continue
        d = float(v - v0)
        if normalize_by_price:
            ci = c[i]
            if not np.isfinite(ci) or abs(ci) < 1e-15:
                continue
            d /= float(ci)
        out[i] = d * _INDICATOR_DELTA_DISPLAY_SCALE
    return out


def _register_delta_alias_if_requested(
    arrays_by_id: dict[str, np.ndarray],
    indicator_id: str,
    scalar: np.ndarray,
    close_px: np.ndarray,
    *,
    delta_lookback_bars: int | None,
    delta_normalize_by_price: bool | None,
) -> None:
    iid = (indicator_id or "").strip()
    if not iid or scalar.size == 0:
        return
    lb_raw = delta_lookback_bars
    try:
        lb = int(lb_raw) if lb_raw is not None else 0
    except (TypeError, ValueError):
        lb = 0
    if lb < 1:
        return
    norm = delta_normalize_by_price is not False
    delta_s = _indicator_delta_series_chart(scalar, close_px, lb, norm)
    key = f"{iid}_delta"
    arrays_by_id[key] = delta_s
    lk = key.lower()
    if lk != key:
        arrays_by_id[lk] = delta_s


def _ref_series(
    ref: str,
    df: pd.DataFrame,
    arrays_by_id: dict[str, np.ndarray],
    extra: dict[str, np.ndarray],
) -> np.ndarray:
    raw = (ref or "").strip()
    if not raw:
        raise ValueError("referência vazia")
    shift = 0
    if raw.endswith("]") and "[" in raw:
        base, ix = raw.rsplit("[", 1)
        raw = base
        try:
            shift = int(ix[:-1])
        except ValueError as e:
            raise ValueError(f"shift inválido: {ref!r}") from e
    key = raw.strip()
    lower = key.lower()
    if lower in _VALID_SOURCES:
        arr = _price_series(df, lower)
    elif key in arrays_by_id:
        arr = arrays_by_id[key]
    elif lower in arrays_by_id:
        arr = arrays_by_id[lower]
    elif lower in extra:
        arr = extra[lower]
    elif key in extra:
        arr = extra[key]
    else:
        low_key = key.lower()
        if low_key.endswith("_delta"):
            base_id = key[: -len("_delta")].strip()
            hint = (
                f" — activa o modo Δ (histograma) no indicador «{base_id}» com lookback ≥ 1 "
                "para expor esta série nas fórmulas."
            )
            raise ValueError(f"referência desconhecida no indicador derivado: {ref!r}{hint}")
        raise ValueError(f"referência desconhecida no indicador derivado: {ref!r}")
    return _shift_back(arr, shift) if shift > 0 else arr


_ROLLING_EXTREME_WINDOW_MAX = 5000


def _scalar_window_period(x: Any) -> int | None:
    """Inteiro 1…5000 adequado a comprimento de janela rolling; caso contrário None."""
    if isinstance(x, bool):
        return None
    if isinstance(x, (int, np.integer)):
        v = int(x)
        return v if 1 <= v <= _ROLLING_EXTREME_WINDOW_MAX else None
    if isinstance(x, (float, np.floating)):
        v = float(x)
        if not math.isfinite(v):
            return None
        w = int(round(v))
        if abs(v - w) > 1e-9:
            return None
        return w if 1 <= w <= _ROLLING_EXTREME_WINDOW_MAX else None
    if isinstance(x, np.ndarray) and x.ndim == 0:
        return _scalar_window_period(x.item())
    return None


def _rolling_nan_extreme(arr: np.ndarray, window: int, *, is_max: bool) -> np.ndarray:
    """Máximo/mínimo móvel (últimos ``window`` candles, min_periods=1)."""
    s = pd.Series(np.asarray(arr, dtype=np.float64), dtype=np.float64)
    w = int(window)
    if is_max:
        out = s.rolling(window=w, min_periods=1).max()
    else:
        out = s.rolling(window=w, min_periods=1).min()
    return out.to_numpy(dtype=np.float64)


def _try_rolling_minmax(args: list[Any], *, is_max: bool) -> np.ndarray | None:
    """
    ``max(series, n)`` / ``min(series, n)`` → extremo móvel nos últimos ``n`` valores.
    ``max(a, b)`` com duas séries → None (tratado como elemento-a-elemento).
    Aceita ``max(n, series)``.
    """
    if len(args) != 2:
        return None
    for series_raw, window_raw in ((args[0], args[1]), (args[1], args[0])):
        win = _scalar_window_period(window_raw)
        if win is None:
            continue
        arr = np.asarray(series_raw, dtype=np.float64).reshape(-1)
        if arr.size < 1:
            continue
        return _rolling_nan_extreme(arr, win, is_max=is_max)
    return None


def _formula_ref_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _formula_ref_name(node.value)
        return f"{parent}.{node.attr}" if parent else None
    return None


def _eval_formula(
    formula: str,
    df: pd.DataFrame,
    arrays_by_id: dict[str, np.ndarray],
    extra: dict[str, np.ndarray],
) -> np.ndarray:
    tree = ast.parse(formula, mode="eval")

    def ev(node: ast.AST) -> np.ndarray | float:
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.Name):
            return _ref_series(node.id, df, arrays_by_id, extra)
        if isinstance(node, ast.Attribute):
            ref_name = _formula_ref_name(node)
            if not ref_name:
                raise ValueError("referência inválida na fórmula")
            return _ref_series(ref_name, df, arrays_by_id, extra)
        if isinstance(node, ast.Subscript):
            ref_name = _formula_ref_name(node.value)
            if not ref_name:
                raise ValueError("shift em fórmula tem de usar referência, ex. rsi1[1]")
            sl = node.slice
            if isinstance(sl, ast.Constant) and isinstance(sl.value, int):
                return _ref_series(f"{ref_name}[{sl.value}]", df, arrays_by_id, extra)
            raise ValueError("shift em fórmula tem de ser inteiro, ex. rsi1[1]")
        if isinstance(node, ast.UnaryOp):
            val = ev(node.operand)
            if isinstance(node.op, ast.USub):
                return -val
            if isinstance(node.op, ast.UAdd):
                return val
            raise ValueError("operador unário não permitido")
        if isinstance(node, ast.BinOp):
            left = ev(node.left)
            right = ev(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                return left / right
            raise ValueError("operador não permitido na fórmula")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            fn = node.func.id.lower()
            args = [ev(a) for a in node.args]
            if fn in {"min", "max"}:
                if len(args) < 2:
                    raise ValueError(f"{fn} exige pelo menos 2 argumentos")
                rolled = _try_rolling_minmax(args, is_max=(fn == "max"))
                if rolled is not None:
                    return rolled
                arrs = [np.asarray(a, dtype=np.float64) for a in args]
                try:
                    broadcasted = np.broadcast_arrays(*arrs)
                except ValueError as e:
                    shapes = ", ".join(str(np.asarray(a).shape) for a in args)
                    raise ValueError(f"{fn}: formas incompatíveis ({shapes})") from e
                stacked = np.stack(broadcasted, axis=0)
                return np.nanmin(stacked, axis=0) if fn == "min" else np.nanmax(stacked, axis=0)
            if fn == "abs":
                if len(args) != 1:
                    raise ValueError("abs exige 1 argumento")
                return np.abs(np.asarray(args[0], dtype=np.float64))
            if fn in {"ema", "sma", "rsi", "delta", "roc", "normalize", "normalise"}:
                if not args:
                    raise ValueError(f"{fn} exige uma série")
                x = np.asarray(args[0], dtype=np.float64)
                p: dict[str, int | float] = {}
                if len(args) >= 2:
                    p["period" if fn not in {"delta", "roc"} else "lookback"] = float(args[1])  # type: ignore[arg-type]
                return _derived_transform(fn, x, p)
            raise ValueError(f"função não permitida na fórmula: {node.func.id!r}")
        raise ValueError("expressão não permitida na fórmula")

    res = ev(tree)
    arr = np.asarray(res, dtype=np.float64)
    if arr.ndim == 0:
        arr = np.full(len(df), float(arr), dtype=np.float64)
    if arr.size != len(df):
        raise ValueError("fórmula devolveu série com comprimento inválido")
    return arr


def _register_named_output_aliases(
    arrays_by_id: dict[str, np.ndarray],
    indicator_id: str,
    output_name: str,
    values: np.ndarray,
) -> None:
    base = indicator_id.strip()
    out = output_name.strip()
    if not base or not out:
        return
    lower_out = out.lower()
    keys = {f"{base}.{out}", f"{base}.{lower_out}", f"{base.lower()}.{lower_out}"}
    if lower_out.startswith("upper"):
        keys.update({f"{base}.upper", f"{base.lower()}.upper", f"{base}.high", f"{base}.higher"})
    elif lower_out.startswith("lower"):
        keys.update({f"{base}.lower", f"{base.lower()}.lower", f"{base}.low", f"{base}.lower"})
    elif lower_out.startswith("middle") or lower_out.startswith("mid"):
        keys.update({f"{base}.mid", f"{base.lower()}.mid", f"{base}.middle", f"{base}.basis"})
    for key in keys:
        arrays_by_id[key] = values


@router.get("/api/chart/talib-catalog")
async def api_chart_talib_catalog() -> dict[str, Any]:
    """Lista funções expostas pelo TA-Lib (agrupadas), para a biblioteca do gráfico."""
    if not talib_available():
        return {"available": False, "functions": [], "groups": {}}
    import talib

    groups = talib.get_function_groups()
    flat: list[dict[str, str]] = []
    for g in sorted(groups.keys()):
        for n in sorted(groups[g]):
            flat.append({"name": n, "group": g})
    return {"available": True, "functions": flat, "groups": groups}


@router.get("/api/chart/talib-function-meta")
async def api_chart_talib_function_meta(
    function: str = Query(..., min_length=1, max_length=64, description="Nome TA-Lib, ex. RSI"),
) -> dict[str, Any]:
    """Nomes e valores por defeito dos parâmetros editáveis (Abstract API), para o builder."""
    if not talib_available():
        return {
            "available": False,
            "function": function.strip(),
            "parameters": [],
            "error": "TA-Lib não disponível no servidor",
        }
    import talib
    from talib.abstract import Function

    key = function.strip().upper()
    registry = {n.upper(): n for n in talib.get_functions()}
    if key not in registry:
        raise HTTPException(400, detail=f"função TA-Lib desconhecida: {function!r}")
    canon = registry[key]
    fn = Function(canon)
    parameters: list[dict[str, Any]] = []
    for pname, default in fn.parameters.items():
        if isinstance(default, bool):
            ptype = "boolean"
        elif isinstance(default, int) and not isinstance(default, bool):
            ptype = "integer"
        else:
            ptype = "real"
        parameters.append({"name": pname, "default": default, "type": ptype})
    return {"available": True, "function": canon, "parameters": parameters}


@router.post("/api/chart/ta-series")
async def api_chart_ta_series(body: TaSeriesBody) -> dict[str, Any]:
    bar_limit = _adaptive_ta_bar_limit(body.bars)
    if len(body.bars) > bar_limit:
        raise HTTPException(
            400,
            detail=f"máximo {bar_limit} velas por pedido para este timeframe",
        )
    ids = [x.id for x in body.indicators]
    if len(ids) != len(set(ids)):
        raise HTTPException(400, detail="ids de indicadores duplicados")

    cache_key = _ta_cache_key(body)
    cache_hit = _ta_cache_get(cache_key)
    if cache_hit is not None:
        return cache_hit

    t0 = time.perf_counter()
    df = pd.DataFrame(
        {
            "open": [float(b.o) for b in body.bars],
            "high": [float(b.h) for b in body.bars],
            "low": [float(b.l) for b in body.bars],
            "close": [float(b.c) for b in body.bars],
            "volume": [float(b.v) for b in body.bars],
        }
    )
    high = df["high"].to_numpy(dtype=np.float64)
    low = df["low"].to_numpy(dtype=np.float64)
    close = df["close"].to_numpy(dtype=np.float64)
    t_col = np.array([float(b.t) for b in body.bars], dtype=np.float64)
    series: dict[str, Any] = {}
    arrays_by_id: dict[str, np.ndarray] = {}
    extra_input = _input_series_map(body, len(body.bars))

    for ind in body.indicators:
        if isinstance(ind, TaIndSma):
            calc_df, close_t = _indicator_frame(df, t_col, ind.timeframe)
            px = _price_series(calc_df, ind.source)
            htf_s = _sma(px, int(ind.period))
            s = _maybe_align_indicator(t_col, close_t, htf_s)
            arrays_by_id[ind.id] = s
            series[ind.id] = _chart_points_htf_or_dense(t_col, close_t, s, htf_s)
            _register_delta_alias_if_requested(
                arrays_by_id,
                ind.id,
                s,
                close,
                delta_lookback_bars=ind.deltaLookbackBars,
                delta_normalize_by_price=ind.deltaNormalizeByPrice,
            )
        elif isinstance(ind, TaIndAtr):
            calc_df, close_t = _indicator_frame(df, t_col, ind.timeframe)
            ch = calc_df["high"].to_numpy(dtype=np.float64)
            cl = calc_df["low"].to_numpy(dtype=np.float64)
            cc = calc_df["close"].to_numpy(dtype=np.float64)
            tr = _true_range(ch, cl, cc)
            htf_a = _wilder_rma(tr, int(ind.period))
            s = _maybe_align_indicator(t_col, close_t, htf_a)
            arrays_by_id[ind.id] = s
            series[ind.id] = _chart_points_htf_or_dense(t_col, close_t, s, htf_a)
            _register_delta_alias_if_requested(
                arrays_by_id,
                ind.id,
                s,
                close,
                delta_lookback_bars=ind.deltaLookbackBars,
                delta_normalize_by_price=ind.deltaNormalizeByPrice,
            )
        elif isinstance(ind, TaIndMacd):
            calc_df, close_t = _indicator_frame(df, t_col, ind.timeframe)
            px = _price_series(calc_df, ind.source)
            fast_e = _ema(px, int(ind.fast))
            slow_e = _ema(px, int(ind.slow))
            macd_line = fast_e - slow_e
            sig = _ema(macd_line, int(ind.signal))
            hist = macd_line - sig
            macd_line_a = _maybe_align_indicator(t_col, close_t, macd_line)
            sig_a = _maybe_align_indicator(t_col, close_t, sig)
            hist_a = _maybe_align_indicator(t_col, close_t, hist)
            arrays_by_id[ind.id] = macd_line_a
            series[ind.id] = {
                "macd": _chart_points_htf_or_dense(t_col, close_t, macd_line_a, macd_line),
                "signal": _chart_points_htf_or_dense(t_col, close_t, sig_a, sig),
                "histogram": _chart_points_htf_or_dense(t_col, close_t, hist_a, hist),
            }
            _register_delta_alias_if_requested(
                arrays_by_id,
                ind.id,
                macd_line_a,
                close,
                delta_lookback_bars=ind.deltaLookbackBars,
                delta_normalize_by_price=ind.deltaNormalizeByPrice,
            )
        elif isinstance(ind, TaIndTalib):
            if not talib_available():
                raise HTTPException(503, detail="TA-Lib não disponível no servidor")
            try:
                calc_df, close_t = _indicator_frame(df, t_col, ind.timeframe)
                px = _price_series(calc_df, ind.source)
                df_work = calc_df.copy()
                df_work["close"] = px
                raw = run_talib_for_chart(ind.function, df_work, ind.params or None)
            except ValueError as e:
                raise HTTPException(400, detail=str(e)) from e
            except Exception as e:  # noqa: BLE001
                raise HTTPException(500, detail=f"TA-Lib {ind.function!r}: {e!s}") from e
            if len(raw) == 1:
                _k, arr = next(iter(raw.items()))
                arr_np = np.asarray(arr, dtype=np.float64)
                aligned = _maybe_align_indicator(t_col, close_t, arr_np)
                arrays_by_id[ind.id] = aligned
                series[ind.id] = _chart_points_htf_or_dense(t_col, close_t, aligned, arr_np)
                _register_delta_alias_if_requested(
                    arrays_by_id,
                    ind.id,
                    aligned,
                    close,
                    delta_lookback_bars=ind.deltaLookbackBars,
                    delta_normalize_by_price=ind.deltaNormalizeByPrice,
                )
            else:
                first_key = "middleband" if "middleband" in raw else sorted(raw.keys())[0]
                fk_np = np.asarray(raw[first_key], dtype=np.float64)
                arrays_by_id[ind.id] = _maybe_align_indicator(t_col, close_t, fk_np)
                arrays_by_id[ind.id.lower()] = arrays_by_id[ind.id]
                aligned_outputs: dict[str, np.ndarray] = {}
                for k, v in raw.items():
                    v_np = np.asarray(v, dtype=np.float64)
                    aligned_output = _maybe_align_indicator(t_col, close_t, v_np)
                    aligned_outputs[str(k)] = aligned_output
                    _register_named_output_aliases(arrays_by_id, ind.id, k, aligned_output)
                series[ind.id] = {
                    k: _chart_points_htf_or_dense(
                        t_col,
                        close_t,
                        aligned_outputs[k],
                        np.asarray(raw[k], dtype=np.float64),
                    )
                    for k in sorted(raw.keys())
                }
                _register_delta_alias_if_requested(
                    arrays_by_id,
                    ind.id,
                    arrays_by_id[ind.id],
                    close,
                    delta_lookback_bars=ind.deltaLookbackBars,
                    delta_normalize_by_price=ind.deltaNormalizeByPrice,
                )
        elif isinstance(ind, TaIndDerived):
            try:
                calc_df, close_t = _indicator_frame(df, t_col, ind.timeframe)
                if ind.mode == "formula":
                    formula = (ind.formula or "").strip()
                    if not formula:
                        raise ValueError("indicador derivado formula exige fórmula")
                    if close_t is not None:
                        s_raw = _eval_formula(formula, calc_df, {}, {})
                        s = _maybe_align_indicator(t_col, close_t, s_raw)
                        series_pts = _chart_points_htf_or_dense(t_col, close_t, s, s_raw)
                    else:
                        s = _eval_formula(formula, df, arrays_by_id, extra_input)
                        series_pts = _series_to_points(t_col, s)
                else:
                    input_ref = (ind.inputRef or "close").strip()
                    transform = (ind.transform or "").strip()
                    if not transform:
                        raise ValueError("indicador derivado chain exige transform")
                    if close_t is not None and input_ref.lower() in _VALID_SOURCES:
                        base = _ref_series(input_ref, calc_df, {}, {})
                        htf_raw = _derived_transform(transform, base, ind.params or {})
                        s = _maybe_align_indicator(t_col, close_t, htf_raw)
                        series_pts = _chart_points_htf_or_dense(t_col, close_t, s, htf_raw)
                    else:
                        base = _ref_series(input_ref, df, arrays_by_id, extra_input)
                        s = _derived_transform(transform, base, ind.params or {})
                        series_pts = _series_to_points(t_col, s)
            except ValueError as e:
                raise HTTPException(400, detail=f"derived {ind.id!r}: {e!s}") from e
            except Exception as e:  # noqa: BLE001
                raise HTTPException(500, detail=f"derived {ind.id!r}: {e!s}") from e
            arrays_by_id[ind.id] = s
            series[ind.id] = series_pts
            _register_delta_alias_if_requested(
                arrays_by_id,
                ind.id,
                s,
                close,
                delta_lookback_bars=ind.deltaLookbackBars,
                delta_normalize_by_price=ind.deltaNormalizeByPrice,
            )
        elif isinstance(ind, TaIndTrendComposite):
            try:
                calc_df, close_t = _indicator_frame(df, t_col, ind.timeframe)
                comp_spec = components_from_pydantic(list(ind.components))
                raw_htf = compute_trend_composite_score(
                    calc_df,
                    components=comp_spec,
                    norm_window=int(ind.normWindow),
                    clip=float(ind.clip),
                    output_scale=float(ind.outputScale),
                )
                s = _maybe_align_indicator(t_col, close_t, raw_htf)
            except ValueError as e:
                raise HTTPException(400, detail=f"trend_composite {ind.id!r}: {e!s}") from e
            except Exception as e:  # noqa: BLE001
                raise HTTPException(500, detail=f"trend_composite {ind.id!r}: {e!s}") from e
            arrays_by_id[ind.id] = s
            series[ind.id] = _chart_points_htf_or_dense(t_col, close_t, s, raw_htf)
            _register_delta_alias_if_requested(
                arrays_by_id,
                ind.id,
                s,
                close,
                delta_lookback_bars=ind.deltaLookbackBars,
                delta_normalize_by_price=ind.deltaNormalizeByPrice,
            )
        else:
            raise HTTPException(400, detail="indicador inválido")

    compute_ms = round((time.perf_counter() - t0) * 1000.0, 3)
    _ta_cache_set(cache_key, series, compute_ms)
    return {"compute_ms": compute_ms, "series": series}


def chart_ta_base_bar_limit() -> int:
    """Teto na escala ~1m de barras (env ``CHART_TA_1M_BAR_LIMIT``); usado por outros endpoints."""
    return _TA_BASE_BAR_LIMIT
