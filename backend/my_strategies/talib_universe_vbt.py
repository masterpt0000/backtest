"""
Universo TA-Lib para vectorbt: ``compute_indicators`` devolve **todas** as séries
TA-Lib disponíveis (parâmetros por defeito da biblioteca).

**Instalação:** ``pip install TA-Lib`` (requer biblioteca C TA-Lib).

Sinais: neutros (sem entradas) — serve como base para features / gráfico; adapta
``compute_signals_vectorized`` se quiseres optimizar com base num indicador.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

try:
    from talib_indicators import compute_all_talib_features, talib_available
except ImportError:  # pragma: no cover
    compute_all_talib_features = None  # type: ignore[assignment]

    def talib_available() -> bool:
        return False


INDICATOR_PARAM_NAMES: frozenset[str] = frozenset()

STRATEGY_META = {
    "id": "talib_universe",
    "chart_label": "TA-Lib (todas as funções)",
    "kind": "research",
    "timeframe": "3m",
    "symbols": [],
    "leverage": 1,
    "margin_wallet_share": 1.0,
}


def get_strategy_parameters() -> dict:
    return {}


def get_chart_strategy_for_ui() -> dict:
    meta = STRATEGY_META
    return {
        "id": str(meta["id"]),
        "label": str(meta.get("chart_label") or "TA-Lib universe"),
        "indicators": [],
        "vbt_strategy": "talib_universe",
    }


def compute_indicators(df: pd.DataFrame, params: dict) -> dict | None:
    if not talib_available() or compute_all_talib_features is None:
        print("  ⚠️ talib_universe: instale TA-Lib (pip install TA-Lib + lib C).")
        return None
    try:
        return compute_all_talib_features(df)
    except Exception as e:
        print(f"  ⚠️ talib_universe compute_indicators: {e}")
        return None


def compute_signals_vectorized(
    ind: dict,
    thr_params_list: list[dict],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Sem trades — apenas para satisfazer o pipeline vectorbt."""
    c = np.asarray(ind["close"], dtype=np.float64)
    n = int(c.shape[0])
    nc = max(1, len(thr_params_list))
    z2 = np.zeros((n, nc), dtype=bool)
    z1 = np.zeros(nc, dtype=np.float64)
    return z2, z2, z2, z2, z1, z1
