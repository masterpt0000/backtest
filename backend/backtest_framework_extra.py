"""
Walk-forward (folds contíguos) e Monte Carlo (bootstrap i.i.d. de retornos por trade ou fallback equity).
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np


def strip_row_ui_heavy(row: dict[str, Any]) -> dict[str, Any]:
    """Remove payloads grandes quando ``include_ui_charts`` é falso."""
    out = dict(row)
    out.pop("chart_overlay", None)
    out.pop("trade_log", None)
    return out


def contiguous_folds(n_bars: int, n_splits: int, min_seg: int) -> list[tuple[int, int]]:
    """Divide [0, n_bars) em até ``n_splits`` intervalos contíguos com comprimento ≥ ``min_seg``."""
    n_splits = max(2, min(int(n_splits), 24))
    min_seg = max(30, int(min_seg))
    if n_bars < min_seg * 2:
        return []
    if n_bars < min_seg * n_splits:
        n_splits = max(2, n_bars // min_seg)
    if n_splits < 2:
        return []
    seg = n_bars // n_splits
    folds: list[tuple[int, int]] = []
    for i in range(n_splits):
        a = i * seg
        b = (i + 1) * seg if i < n_splits - 1 else n_bars
        if b - a >= min_seg:
            folds.append((int(a), int(b)))
    return folds


def equity_points_to_returns_decimal(equity: list[dict[str, Any]]) -> list[float]:
    """Fallback: retornos por passo na série de equity reportada."""
    if len(equity) < 3:
        return []
    vs = [float(p["v"]) for p in equity if isinstance(p, dict) and "v" in p]
    out: list[float] = []
    for i in range(1, len(vs)):
        prev = vs[i - 1]
        if prev > 1e-12:
            out.append((vs[i] - prev) / prev)
    return out


def trade_log_to_returns_decimal(trade_log: list[dict[str, Any]]) -> list[float]:
    out: list[float] = []
    for t in trade_log:
        if not isinstance(t, dict):
            continue
        try:
            p = float(t.get("pnl_pct", 0.0)) / 100.0
        except (TypeError, ValueError):
            continue
        if math.isfinite(p):
            out.append(p)
    return out


def monte_carlo_bootstrap_returns(
    returns_decimal: list[float],
    *,
    initial: float,
    n_runs: int,
    seed: int,
    min_trades_fallback_note: str | None = None,
) -> dict[str, Any]:
    """
    Bootstrap com reposição: em cada run, amostra ``len(returns_decimal)`` retornos e compõe equity.
    """
    arr = np.asarray([x for x in returns_decimal if math.isfinite(x)], dtype=np.float64)
    if arr.size < 2:
        return {
            "error": "poucos retornos para bootstrap",
            "n_samples": int(arr.size),
            "note": min_trades_fallback_note,
        }
    rng = np.random.default_rng(int(seed) & 0xFFFFFFFF)
    n_runs = max(50, min(int(n_runs), 10_000))
    n_t = int(arr.size)
    finals: list[float] = []
    max_dds: list[float] = []
    for _ in range(n_runs):
        idx = rng.integers(0, n_t, size=n_t)
        sample = arr[idx]
        v = float(initial)
        peak = v
        worst = 0.0
        for r in sample:
            v *= 1.0 + float(r)
            peak = max(peak, v)
            if peak > 1e-12:
                worst = min(worst, (v / peak - 1.0) * 100.0)
        finals.append((v / float(initial) - 1.0) * 100.0)
        max_dds.append(worst)
    finals_a = np.asarray(finals, dtype=np.float64)
    dds_a = np.asarray(max_dds, dtype=np.float64)

    def pct(p: float) -> float:
        return float(np.percentile(finals_a, p))

    return {
        "n_runs": n_runs,
        "n_source_returns": n_t,
        "return_pct_mean": float(np.mean(finals_a)),
        "return_pct_std": float(np.std(finals_a)),
        "return_pct_p5": pct(5),
        "return_pct_p25": pct(25),
        "return_pct_p50": pct(50),
        "return_pct_p75": pct(75),
        "return_pct_p95": pct(95),
        "max_dd_pct_mean": float(np.mean(dds_a)),
        "max_dd_pct_p50": float(np.percentile(dds_a, 50)),
        "source": "trade_bootstrap" if not min_trades_fallback_note else "equity_step_bootstrap",
        "note": min_trades_fallback_note,
    }
