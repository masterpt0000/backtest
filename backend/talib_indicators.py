"""
Execução genérica de todas as funções TA-Lib (Abstract API).

Requer o pacote ``TA-Lib`` **e** a biblioteca C TA-Lib instalada no sistema.
Windows: muitas vezes ``pip install TA-Lib`` falha sem wheel adequado; vê
https://github.com/TA-Lib/ta-lib-python

Uso típico: ``compute_all_talib_features(df)`` para popular ``compute_indicators``
num módulo ``*_vbt.py``.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

try:
    import talib
    from talib.abstract import Function
except ImportError:  # pragma: no cover
    talib = None  # type: ignore[assignment]
    Function = None  # type: ignore[assignment]


def talib_available() -> bool:
    return talib is not None and Function is not None


def list_talib_functions() -> list[str]:
    """Nomes devolvidos por ``talib.get_functions()`` (ordenados)."""
    if not talib_available():
        return []
    return sorted(talib.get_functions())


def _ohlcv_inputs(df: pd.DataFrame) -> dict[str, np.ndarray]:
    """Constrói o dict ``open/high/low/close/volume`` esperado pela Abstract API."""

    def col(*candidates: str) -> np.ndarray | None:
        for n in candidates:
            if n in df.columns:
                return df[n].to_numpy(dtype=np.float64, copy=False)
        return None

    c = col("Close", "close")
    if c is None:
        raise ValueError("DataFrame precisa de coluna Close ou close")
    o = col("Open", "open")
    h = col("High", "high")
    l = col("Low", "low")
    v = col("Volume", "volume")
    n = int(c.shape[0])
    if o is None:
        o = np.copy(c)
    if h is None:
        h = np.copy(c)
    if l is None:
        l = np.copy(c)
    if v is None:
        v = np.zeros(n, dtype=np.float64)
    return {"open": o, "high": h, "low": l, "close": c, "volume": v}


def run_talib_for_chart(
    function: str,
    df: pd.DataFrame,
    param_overrides: dict[str, object] | None = None,
) -> dict[str, np.ndarray]:
    """
    Executa uma função TA-Lib sobre um DataFrame com colunas
    ``open``, ``high``, ``low``, ``close``, ``volume`` (minúsculas).

    Devolve ``{ nome_output: ndarray }`` (nomes como devolvidos por ``output_names``).
    """
    if not talib_available():
        raise RuntimeError("TA-Lib não está instalado (pip install TA-Lib + lib C).")
    key = function.strip().upper()
    registry = {n.upper(): n for n in talib.get_functions()}
    if key not in registry:
        raise ValueError(f"função TA-Lib desconhecida: {function!r}")
    canon = registry[key]
    fn = Function(canon)
    lower = {str(c).lower(): c for c in df.columns}

    def col(name: str) -> np.ndarray:
        c = lower.get(name)
        if c is None:
            raise ValueError(f"DataFrame sem coluna {name!r}")
        return df[c].to_numpy(dtype=np.float64, copy=False)

    inputs = {
        "open": col("open"),
        "high": col("high"),
        "low": col("low"),
        "close": col("close"),
        "volume": col("volume"),
    }
    if param_overrides:
        pdef = dict(fn.parameters)
        for k, raw_v in param_overrides.items():
            if k not in pdef:
                continue
            cur = pdef[k]
            if isinstance(cur, bool):
                pdef[k] = bool(raw_v)
            elif isinstance(cur, int) and not isinstance(cur, bool):
                pdef[k] = int(raw_v)
            else:
                pdef[k] = float(raw_v)
        fn.parameters = pdef
    res = fn.run(inputs)
    onames = [str(x) for x in (fn.output_names or [])]
    out: dict[str, np.ndarray] = {}
    # TA-Lib pode devolver tuple *ou* lista de ndarrays por saída (ex. BBANDS = 3 séries).
    if isinstance(res, (tuple, list)) and len(res) > 1:
        for i, arr in enumerate(res):
            label = onames[i] if i < len(onames) else str(i)
            out[label] = np.asarray(arr, dtype=np.float64)
    elif isinstance(res, (tuple, list)) and len(res) == 1:
        label = onames[0] if onames else canon.lower()
        out[label] = np.asarray(res[0], dtype=np.float64)
    else:
        label = onames[0] if len(onames) == 1 else canon.lower()
        out[label] = np.asarray(res, dtype=np.float64)
    return out


def compute_all_talib_features(df: pd.DataFrame) -> dict[str, np.ndarray] | None:
    """
    Corre **todas** as funções registadas em TA-Lib com parâmetros por defeito.

    Chaves de saída: ``rsi``, ``macd_macd``, ``macd_signal``, … (prefixo = função
    em minúsculas; multi-output: ``{fun}_{nome_output}``).

    Inclui também ``open``, ``high``, ``low``, ``close``, ``volume`` para
    alinhar comprimentos com o resto do pipeline.
    """
    if not talib_available():
        return None
    inputs = _ohlcv_inputs(df)
    out: dict[str, np.ndarray] = {
        "open": np.asarray(inputs["open"], dtype=np.float64),
        "high": np.asarray(inputs["high"], dtype=np.float64),
        "low": np.asarray(inputs["low"], dtype=np.float64),
        "close": np.asarray(inputs["close"], dtype=np.float64),
        "volume": np.asarray(inputs["volume"], dtype=np.float64),
    }
    for raw in talib.get_functions():
        try:
            fn = Function(raw)
            res = fn.run(inputs)
        except Exception:
            continue
        base = raw.lower()
        onames = list(fn.output_names or [])
        if isinstance(res, (tuple, list)) and len(res) > 1:
            for i, arr in enumerate(res):
                label = onames[i] if i < len(onames) else str(i)
                key = f"{base}_{str(label).lower()}"
                out[key] = np.asarray(arr, dtype=np.float64)
        elif isinstance(res, (tuple, list)) and len(res) == 1:
            arr0 = np.asarray(res[0], dtype=np.float64)
            if len(onames) == 1:
                key = f"{base}_{onames[0].lower()}"
            else:
                key = base
            out[key] = arr0
        else:
            if len(onames) == 1:
                key = f"{base}_{onames[0].lower()}"
            else:
                key = base
            out[key] = np.asarray(res, dtype=np.float64)
    return out
