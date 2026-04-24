"""
Backtests vectorbt via monthly_scanner_vbt.py + QuestDB.

Optimizações de performance (env):
  BACKTEST_MAX_SYMBOL_WORKERS   — threads para processar pares em paralelo (default 3)
  BACKTEST_QUESTDB_CONCURRENCY  — pedidos HTTP paralelos ao carregar velas (default 4)
  BACKTEST_PREFILTER            — 1 = contagem rápida em candles_1m antes do SQL pesado (default 1)
  BACKTEST_PREFILTER_MULT       — multiplicador do mínimo de velas 1m vs bar_limit*minutos (default 0.85)
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import threading
import time
import types
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

import httpx
import numpy as np
import pandas as pd

from pg_jobs import persist_job_upsert

from questdb_client import (
    MAX_POINTS_CAP,
    TIMEFRAME_TO_SAMPLE,
    build_candles_backward_query,
    candles_ts_column,
    is_valid_timeframe,
    questdb_http_base,
    rows_as_objects,
    rows_to_bars,
)

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent
SCANNER_PATH = REPO_ROOT / "monthly_scanner_vbt.py"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

_scanner: Any = None

# Minutos por barra (para limite de velas e pré-filtro 1m)
_TF_MINUTES: dict[str, float] = {
    "1m": 1,
    "2m": 2,
    "3m": 3,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "45m": 45,
    "1h": 60,
    "2h": 120,
    "3h": 180,
    "4h": 240,
    "6h": 360,
    "12h": 720,
    "1d": 1440,
    "7d": 10080,
    "1w": 10080,
}

_LEGACY_BAR_FLOOR: dict[str, int] = {
    "7d": 1500,
    "30d": 4000,
    "90d": 8000,
    "1y": 9000,
}


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def timeframe_to_pandas_freq(timeframe: str) -> str:
    """Frequência para vectorbt / pandas (alinhada ao TF das velas)."""
    m = {
        "1m": "1min",
        "2m": "2min",
        "3m": "3min",
        "5m": "5min",
        "15m": "15min",
        "30m": "30min",
        "45m": "45min",
        "1h": "1h",
        "2h": "2h",
        "3h": "3h",
        "4h": "4h",
        "6h": "6h",
        "12h": "12h",
        "1d": "1d",
        "7d": "7d",
        "1w": "1w",
    }
    return m.get(timeframe, "5min")


def bars_per_day_approx(timeframe: str) -> float:
    m = _TF_MINUTES.get(timeframe, 5)
    return 1440.0 / m


def preset_bar_limit(timeframe: str, preset: str) -> int:
    """
    Limite de barras puxadas da QuestDB: combina dias do preset com densidade do TF,
    com piso legado para TFs altos não ficarem com poucas velas.
    """
    if preset == "max":
        return MAX_POINTS_CAP
    days_map = {"7d": 7, "30d": 30, "90d": 90, "1y": 365}
    days = days_map.get(preset, 30)
    bpd = bars_per_day_approx(timeframe)
    target = int(bpd * days)
    floor = _LEGACY_BAR_FLOOR.get(preset, 3000)
    return min(MAX_POINTS_CAP, max(300, max(target, floor)))


def dedupe_symbol_ids(symbol_ids: list[int]) -> list[int]:
    seen: set[int] = set()
    out: list[int] = []
    for x in symbol_ids:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _load_scanner():
    global _scanner
    if _scanner is not None:
        return _scanner
    if not SCANNER_PATH.is_file():
        raise FileNotFoundError(f"monthly_scanner_vbt.py não encontrado em {SCANNER_PATH}")

    cfg = types.ModuleType("config")
    cfg.TOTAL_CASH_TEST = 10_000.0
    sys.modules.setdefault("config", cfg)

    spec = importlib.util.spec_from_file_location("monthly_scanner_vbt", str(SCANNER_PATH))
    if spec is None or spec.loader is None:
        raise ImportError("spec inválido para monthly_scanner_vbt")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["monthly_scanner_vbt"] = mod
    spec.loader.exec_module(mod)
    _scanner = mod
    return mod


def list_vbt_strategy_stems() -> list[dict[str, str]]:
    d = BACKEND_DIR / "my_strategies"
    if not d.is_dir():
        return []
    out: list[dict[str, str]] = []
    for p in sorted(d.glob("*_vbt.py"), key=lambda x: x.name.lower()):
        if p.name.startswith("_"):
            continue
        stem = p.stem
        short = stem[:-4] if stem.endswith("_vbt") else stem
        out.append({"id": short, "module": stem, "label": short.replace("_", " ").title()})
    return out


def bars_to_ohlcv_df(bars: list[dict[str, Any]], min_rows: int) -> pd.DataFrame | None:
    if len(bars) < min_rows:
        return None
    df = pd.DataFrame(bars)
    df["timestamp"] = pd.to_datetime(df["t"], unit="s", utc=True)
    df = df.set_index("timestamp")
    out = pd.DataFrame(
        {
            "Open": df["o"].astype(float),
            "High": df["h"].astype(float),
            "Low": df["l"].astype(float),
            "Close": df["c"].astype(float),
            "Volume": df["v"].astype(float),
        }
    )
    return out.dropna()


async def questdb_count_1m_rows(client: httpx.AsyncClient, symbol_id: int) -> int:
    """Contagem leve para pré-filtrar símbolos sem dados 1m suficientes."""
    base = questdb_http_base()
    sql = f"SELECT count() FROM candles_1m WHERE symbol_id = {int(symbol_id)}"
    r = await client.get(f"{base}/exec", params={"query": sql})
    r.raise_for_status()
    data = r.json()
    rows = rows_as_objects(data)
    if not rows:
        return 0
    v = rows[0].get("count")
    if v is None:
        for k in rows[0]:
            if "count" in k.lower():
                v = rows[0][k]
                break
    try:
        return int(v) if v is not None else 0
    except (TypeError, ValueError):
        return 0


async def questdb_fetch_bars(
    client: httpx.AsyncClient,
    symbol_id: int,
    timeframe: str,
    bar_limit: int,
) -> list[dict[str, Any]]:
    if not is_valid_timeframe(timeframe):
        raise ValueError(f"timeframe inválido: {timeframe}")
    ts_col = candles_ts_column()
    before_ms = time.time() * 1000
    _res, sql = build_candles_backward_query(symbol_id, timeframe, before_ms, bar_limit, ts_col)
    base = questdb_http_base()
    r = await client.get(f"{base}/exec", params={"query": sql})
    r.raise_for_status()
    data = r.json()
    rows = rows_as_objects(data)
    return rows_to_bars(rows, ts_col)


def _freeze_indicator_optimization(
    param_specs: dict[str, Any],
    ind_param_names: frozenset,
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, tup in param_specs.items():
        if not isinstance(tup, tuple) or len(tup) < 6:
            out[name] = tup
            continue
        d, mn, mx, st, dec, do_opt = tup[0], tup[1], tup[2], tup[3], tup[4], tup[5]
        if name in ind_param_names:
            out[name] = (d, mn, mx, st, dec, False)
        else:
            out[name] = tup
    return out


def _json_safe(x: Any) -> Any:
    if isinstance(x, dict):
        return {str(k): _json_safe(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_json_safe(v) for v in x]
    if isinstance(x, (np.integer, np.int64, np.int32)):
        return int(x)
    if isinstance(x, (np.floating, np.float64, np.float32)):
        return float(x)
    if isinstance(x, (float, int, str, bool)) or x is None:
        return x
    return str(x)


JOBS: dict[str, dict[str, Any]] = {}
CANCEL_REQUESTED: set[str] = set()


def job_get(job_id: str) -> dict[str, Any] | None:
    return JOBS.get(job_id)


def job_request_cancel(job_id: str) -> bool:
    if job_id not in JOBS:
        return False
    CANCEL_REQUESTED.add(job_id)
    return True


def run_backtest_job(
    job_id: str,
    payload: dict[str, Any],
    progress_cb: Callable[[int, str], None],
) -> None:
    mode = payload.get("mode") or "single"
    vbt_strategy = str(payload.get("vbt_strategy") or "").strip()
    symbol_ids = dedupe_symbol_ids([int(x) for x in payload.get("symbol_ids") or []])
    timeframe = str(payload.get("timeframe") or "5m")
    range_preset = str(payload.get("range_preset") or "30d")
    initial_cash = float(payload.get("initial_cash") or 10_000)
    best_by = str(payload.get("best_by") or "return_pct")
    num_tests = int(payload.get("num_tests") or 50)
    max_tries = int(payload.get("max_tries") or 500)

    raw_seed = payload.get("optimize_seed")
    if raw_seed is None or raw_seed == "":
        optimize_seed = int(time.time_ns() % (2**31))
    else:
        optimize_seed = int(raw_seed)

    grid_sample = str(payload.get("optimize_grid_sample") or "lhs").strip().lower()
    if grid_sample not in ("lhs", "random"):
        grid_sample = "lhs"

    if mode == "optimize":
        optimize_top_k = int(payload.get("optimize_top_k") or 5)
    else:
        optimize_top_k = 1
    optimize_top_k = max(1, min(optimize_top_k, 20))

    holdout = float(payload.get("optimize_holdout_ratio") or 0)
    if holdout <= 0 or holdout >= 0.5:
        holdout = 0.0

    max_workers = _env_int("BACKTEST_MAX_SYMBOL_WORKERS", 3)
    qdb_conc = _env_int("BACKTEST_QUESTDB_CONCURRENCY", 4)
    do_prefilter = _env_bool("BACKTEST_PREFILTER", True)
    prefilter_mult = _env_float("BACKTEST_PREFILTER_MULT", 0.85)

    JOBS[job_id].update(
        {
            "status": "running",
            "progress": 0,
            "phase": "A iniciar…",
            "results": None,
            "error": None,
            "started_at": time.time(),
            "finished_at": None,
            "payload_summary": {
                "mode": mode,
                "vbt_strategy": vbt_strategy,
                "symbols": len(symbol_ids),
                "timeframe": timeframe,
                "workers": max_workers,
                "questdb_concurrency": qdb_conc,
                "optimize_seed": optimize_seed,
                "optimize_grid_sample": grid_sample,
                "optimize_top_k": optimize_top_k,
                "optimize_holdout_ratio": holdout,
            },
        }
    )
    persist_job_upsert(job_id, JOBS[job_id])

    try:
        sc = _load_scanner()
        min_trades = int(payload.get("min_trades") or sc.MIN_TRADES)

        if not vbt_strategy or not symbol_ids:
            raise ValueError("vbt_strategy e symbol_ids são obrigatórios")

        if timeframe not in TIMEFRAME_TO_SAMPLE:
            raise ValueError(f"timeframe inválido: {timeframe}")

        sc.TOTAL_CASH_TEST = initial_cash
        sc.MIN_TRADES = max(1, min_trades)

        vbt_mod = sc.load_strategy_vbt_module(vbt_strategy)
        if not hasattr(vbt_mod, "compute_signals_vectorized") or not hasattr(vbt_mod, "compute_indicators"):
            raise ValueError("Módulo *_vbt precisa de compute_indicators e compute_signals_vectorized")

        signal_fn = vbt_mod.compute_signals_vectorized
        param_specs = sc.get_strategy_param_specs(vbt_mod)
        ind_param_names = sc.resolve_indicator_param_names(vbt_mod, param_specs)

        if not param_specs:
            ind_list = [{}]
            thr_list = [{}]
        elif mode == "optimize":
            ind_list, thr_list = sc.build_param_grids(
                param_specs,
                max_tries,
                ind_param_names,
                seed=optimize_seed,
                grid_sample=grid_sample,
            )
        else:
            frozen = _freeze_indicator_optimization(param_specs, ind_param_names)
            mt = max(1, min(num_tests, 5_000))
            ind_list, thr_list = sc.build_param_grids(
                frozen,
                mt,
                ind_param_names,
                seed=optimize_seed,
                grid_sample=grid_sample,
            )

        bar_limit = preset_bar_limit(timeframe, range_preset)
        freq_str = timeframe_to_pandas_freq(timeframe)
        symbol_labels: dict[int, str] = {
            int(k): str(v) for k, v in (payload.get("symbol_labels") or {}).items()
        }

        tf_min = _TF_MINUTES.get(timeframe, 5)
        min_1m_for_prefilter = int(bar_limit * tf_min * prefilter_mult) if do_prefilter else 0

        progress_cb(2, f"A carregar velas (até {bar_limit} barras, {qdb_conc} paralelo)…")

        async def _prefetch_all() -> dict[int, list[dict[str, Any]] | None]:
            sem = asyncio.Semaphore(qdb_conc)
            out_map: dict[int, list[dict[str, Any]] | None] = {}

            async def _one(sym_id: int) -> None:
                async with sem:
                    if job_id in CANCEL_REQUESTED:
                        out_map[sym_id] = None
                        return
                    try:
                        if do_prefilter and min_1m_for_prefilter > 0:
                            cnt = await questdb_count_1m_rows(client, sym_id)
                            if cnt < min_1m_for_prefilter:
                                out_map[sym_id] = None
                                return
                        bars = await questdb_fetch_bars(client, sym_id, timeframe, bar_limit)
                        out_map[sym_id] = bars
                    except Exception:
                        out_map[sym_id] = None

            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
                await asyncio.gather(*(_one(sid) for sid in symbol_ids))

            return out_map

        bars_by_symbol = asyncio.run(_prefetch_all())

        if job_id in CANCEL_REQUESTED:
            raise RuntimeError("Cancelado pelo utilizador")

        total_steps = max(1, len(symbol_ids) * max(1, len(ind_list)))
        progress_lock = threading.Lock()
        progress_done = [0]

        def _bump_progress(label_s: str) -> None:
            with progress_lock:
                progress_done[0] += 1
                d = progress_done[0]
                progress_cb(
                    min(99, 5 + int(90 * d / total_steps)),
                    f"{label_s}: {d}/{total_steps}",
                )

        results_lock = threading.Lock()
        per_batch_k = min(len(thr_list), optimize_top_k, 12)

        def _process_one_symbol(sym_id: int) -> list[dict[str, Any]]:
            if job_id in CANCEL_REQUESTED:
                return []
            label = symbol_labels.get(sym_id, str(sym_id))
            bars = bars_by_symbol.get(sym_id)
            if not bars:
                with progress_lock:
                    progress_done[0] += len(ind_list)
                    progress_cb(
                        min(99, 5 + int(90 * progress_done[0] / total_steps)),
                        f"{label}: sem dados",
                    )
                return []

            df = bars_to_ohlcv_df(bars, min_rows=max(50, min_trades))
            if df is None:
                with progress_lock:
                    progress_done[0] += len(ind_list)
                    progress_cb(
                        min(99, 5 + int(90 * progress_done[0] / total_steps)),
                        f"{label}: poucas velas",
                    )
                return []

            min_w = max(50, min_trades)
            if holdout > 0 and len(df) >= 2 * min_w + 2:
                split_i = int(len(df) * (1 - holdout))
                split_i = max(min_w, min(split_i, len(df) - min_w))
                df_fit = df.iloc[:split_i]
                df_oos = df.iloc[split_i:]
            else:
                df_fit = df
                df_oos = None

            candidates: list[dict[str, Any]] = []
            for ind_params in ind_list:
                if job_id in CANCEL_REQUESTED:
                    return []
                batch = sc.run_vbt_backtest_topk(
                    df_fit,
                    label,
                    ind_params,
                    thr_list,
                    signal_fn,
                    vbt_mod.compute_indicators,
                    best_by=best_by,
                    freq=freq_str,
                    top_k=per_batch_k,
                )
                candidates.extend(batch)
                _bump_progress(label)

            seen_fp: set[tuple] = set()
            uniq: list[dict[str, Any]] = []
            for r in candidates:
                fp = sc._param_fingerprint(r["best_params"])
                if fp in seen_fp:
                    continue
                seen_fp.add(fp)
                uniq.append(r)

            uniq.sort(key=lambda row: sc._result_score(row, best_by), reverse=True)
            top = uniq[:optimize_top_k]

            if df_oos is not None and top:
                for r in top:
                    ind_p, thr_p = sc.split_best_params_ind_thr(r["best_params"], ind_param_names)
                    thr_combo = [thr_p] if thr_p else [{}]
                    oos = sc.run_vbt_backtest(
                        df_oos,
                        label,
                        ind_p,
                        thr_combo,
                        signal_fn,
                        vbt_mod.compute_indicators,
                        best_by=best_by,
                        freq=freq_str,
                    )
                    if oos:
                        r["oos_return_pct"] = oos["return_pct"]
                        r["oos_trades"] = oos["trades"]
                        r["oos_sharpe"] = oos["sharpe"]
                        r["oos_max_dd"] = oos["max_dd"]
                        r["oos_profit_fct"] = oos["profit_fct"]
                    else:
                        r["oos_return_pct"] = None
                        r["oos_trades"] = None
                        r["oos_sharpe"] = None
                        r["oos_max_dd"] = None
                        r["oos_profit_fct"] = None

            for rank, r in enumerate(top, 1):
                r["optimize_rank"] = rank

            return [_json_safe(x) for x in top]

        by_sid: dict[int, list[dict[str, Any]]] = {}

        if max_workers <= 1:
            for sid in symbol_ids:
                if job_id in CANCEL_REQUESTED:
                    raise RuntimeError("Cancelado pelo utilizador")
                by_sid[sid] = _process_one_symbol(sid)
        else:
            with ThreadPoolExecutor(max_workers=max_workers) as ex:
                futs = {ex.submit(_process_one_symbol, sid): sid for sid in symbol_ids}
                for fut in as_completed(futs):
                    if job_id in CANCEL_REQUESTED:
                        ex.shutdown(wait=False, cancel_futures=True)
                        raise RuntimeError("Cancelado pelo utilizador")
                    sid = futs[fut]
                    try:
                        rows = fut.result()
                        with results_lock:
                            by_sid[sid] = rows
                    except Exception:
                        with results_lock:
                            by_sid[sid] = []

        if job_id in CANCEL_REQUESTED:
            raise RuntimeError("Cancelado pelo utilizador")

        results: list[dict[str, Any]] = []
        for sid in symbol_ids:
            rows = by_sid.get(sid) or []
            rows.sort(key=lambda row: sc._result_score(row, best_by), reverse=True)
            results.extend(rows)

        JOBS[job_id].update(
            {
                "status": "completed",
                "progress": 100,
                "phase": "Concluído",
                "results": results,
                "finished_at": time.time(),
            }
        )
        persist_job_upsert(job_id, JOBS[job_id])
        progress_cb(100, "Concluído")
        CANCEL_REQUESTED.discard(job_id)
    except Exception as e:
        CANCEL_REQUESTED.discard(job_id)
        JOBS[job_id].update(
            {
                "status": "error",
                "progress": JOBS[job_id].get("progress", 0),
                "phase": "Erro",
                "error": str(e),
                "finished_at": time.time(),
            }
        )
        persist_job_upsert(job_id, JOBS[job_id])


def spawn_backtest_job(payload: dict[str, Any]) -> str:
    job_id = str(uuid.uuid4())
    JOBS[job_id] = {
        "status": "queued",
        "progress": 0,
        "phase": "Na fila…",
        "results": None,
        "error": None,
        "started_at": time.time(),
        "finished_at": None,
        "payload_summary": {},
        "request_payload": dict(payload),
    }
    persist_job_upsert(job_id, JOBS[job_id])

    def cb(p: int, ph: str) -> None:
        if job_id in JOBS:
            JOBS[job_id]["progress"] = p
            JOBS[job_id]["phase"] = ph

    def _thread_target() -> None:
        run_backtest_job(job_id, payload, cb)

    threading.Thread(target=_thread_target, daemon=True).start()
    return job_id
