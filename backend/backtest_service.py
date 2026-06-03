"""
Backtests vectorbt via monthly_scanner_vbt.py + QuestDB.

Optimizações de performance (env):
  BACKTEST_MAX_SYMBOL_WORKERS   — threads para processar pares em paralelo (default 3)
  BACKTEST_QUESTDB_CONCURRENCY  — pedidos HTTP paralelos ao carregar velas (default 4)
  BACKTEST_PREFILTER            — 1 = contagem rápida em candles_1m antes do SQL pesado (default 1);
                                o limiar efectivo não exige mais linhas que chart_ta_base_bar_limit().
  BACKTEST_PREFILTER_MULT       — multiplicador do mínimo de velas 1m vs bar_limit*minutos (default 0.85)
  BACKTEST_UI_TRIALS_MAX        — máximo de testes com curva de equity devolvidos por par (default 120, max 500)
  BACKTEST_MC_RUNS_CAP          — teto para mc_runs no payload (default 4000)

Velas QuestDB nos jobs usam o mesmo teto base que o motor TA do chart
(``CHART_TA_1M_BAR_LIMIT`` / ``chart_ta_base_bar_limit``), para 1m não ficar
cortado a 10k barras (~7d) enquanto o chart simula até ~50k.
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
from sqlalchemy.orm import Session

from backtest_framework_extra import (
    contiguous_folds,
    equity_points_to_returns_decimal,
    monte_carlo_bootstrap_returns,
    strip_row_ui_heavy,
    trade_log_to_returns_decimal,
)
from builder_vbt_engine import builder_param_grid, run_builder_backtest
from chart_ta_routes import chart_ta_base_bar_limit
from pg_db import get_engine
from pg_jobs import persist_job_upsert
from pg_models import ChartBuilderStrategy

from questdb_client import (
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

    O teto efectivo alinha-se ao chart TA (``chart_ta_base_bar_limit``), não ao
    ``MAX_POINTS_CAP`` genérico da API — assim 1m não fica truncado a ~7 dias
    quando o utilizador escolhe ex.: 90d.
    """
    cap = chart_ta_base_bar_limit()
    if preset == "max":
        return cap
    days_map = {"7d": 7, "30d": 30, "90d": 90, "1y": 365}
    days = days_map.get(preset, 30)
    bpd = bars_per_day_approx(timeframe)
    target = int(bpd * days)
    floor = _LEGACY_BAR_FLOOR.get(preset, 3000)
    return min(cap, max(300, max(target, floor)))


def dedupe_symbol_ids(symbol_ids: list[int]) -> list[int]:
    seen: set[int] = set()
    out: list[int] = []
    for x in symbol_ids:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _clamp_exec_pct(raw: Any, cap: float = 2.0) -> float:
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(v, cap))


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


def load_builder_strategy_spec(strategy_id: str | None, snapshot: dict[str, Any] | None = None) -> tuple[str, dict[str, Any]]:
    if isinstance(snapshot, dict) and snapshot.get("version") == 1:
        return str(snapshot.get("name") or "Builder strategy"), dict(snapshot)
    sid = str(strategy_id or "").strip()
    if not sid:
        raise ValueError("builder_strategy_id ou builder_spec é obrigatório")
    eng = get_engine()
    if eng is None:
        raise ValueError("PostgreSQL não configurado para carregar estratégias builder")
    with Session(eng) as session:
        row = session.get(ChartBuilderStrategy, uuid.UUID(sid))
        if row is None:
            raise ValueError("estratégia builder não encontrada")
        spec = row.spec if isinstance(row.spec, dict) else {}
        if spec.get("version") != 1:
            raise ValueError("spec builder inválido")
        return row.name or str(spec.get("name") or sid), dict(spec)


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
    bar_cap = chart_ta_base_bar_limit()
    _res, sql = build_candles_backward_query(
        symbol_id, timeframe, before_ms, bar_limit, ts_col, bar_cap=bar_cap
    )
    base = questdb_http_base()
    r = await client.get(f"{base}/exec", params={"query": sql})
    r.raise_for_status()
    data = r.json()
    rows = rows_as_objects(data)
    return rows_to_bars(rows, ts_col)


def _defaults_from_param_specs(param_specs: dict[str, Any]) -> dict[str, Any]:
    """Primeiro elemento de cada tupla ``get_strategy_parameters`` (valor por defeito)."""
    out: dict[str, Any] = {}
    for name, tup in param_specs.items():
        if isinstance(tup, tuple) and len(tup) >= 1:
            out[name] = tup[0]
    return out


def _split_merged_into_ind_thr(
    merged: dict[str, Any],
    param_specs: dict[str, Any],
    ind_param_names: frozenset,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Separa o mapa plano para ``compute_indicators`` vs uma linha de ``thr_list``.

    Chaves em ``merged`` que não existem em ``param_specs`` assumem-se thresholds
    (compatível com extensões).
    """
    ind: dict[str, Any] = {}
    thr: dict[str, Any] = {}
    spec_keys = set(param_specs.keys())
    for name in spec_keys:
        if name not in merged:
            continue
        if name in ind_param_names:
            ind[name] = merged[name]
        else:
            thr[name] = merged[name]
    for name, val in merged.items():
        if name in spec_keys:
            continue
        thr[name] = val
    return ind, thr


def _merge_indicator_params_client(
    base: dict[str, Any],
    client: dict[str, Any] | None,
    param_specs: dict[str, Any],
) -> dict[str, Any]:
    """Sobrepõe parâmetros enviados pelo gráfico (sliders) sobre a grelha default."""
    out = dict(base)
    if not client:
        return out
    for k, raw in client.items():
        ks = str(k).strip()
        if not ks:
            continue
        spec = param_specs.get(ks)
        if isinstance(spec, tuple) and len(spec) >= 6:
            is_dec = bool(spec[4])
            try:
                out[ks] = float(raw) if is_dec else int(round(float(raw)))
            except (TypeError, ValueError):
                continue
        else:
            try:
                if isinstance(raw, bool):
                    out[ks] = raw
                elif isinstance(raw, int):
                    out[ks] = raw
                elif isinstance(raw, float):
                    out[ks] = raw
                else:
                    out[ks] = float(raw)
            except (TypeError, ValueError):
                continue
    return out


def _indicators_dict_for_chart(ind: dict[str, Any], n_bars: int) -> dict[str, list[Any]]:
    """Serializa saída de ``compute_indicators`` para JSON (alinhado a ``n_bars``)."""
    serial: dict[str, list[Any]] = {}
    for key, val in ind.items():
        if val is None:
            continue
        arr = np.asarray(val, dtype=np.float64).reshape(-1)
        m = min(int(arr.shape[0]), int(n_bars))
        lst: list[Any] = []
        for i in range(m):
            x = float(arr[i])
            if np.isnan(x) or np.isinf(x):
                lst.append(None)
            else:
                lst.append(x)
        if m < n_bars:
            lst.extend([None] * (int(n_bars) - m))
        serial[str(key)] = lst
    return serial


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


def _optimize_row_metric_signature(row: dict[str, Any]) -> tuple:
    """
    Chave estável para esconder linhas repetidas na tabela quando várias combos de
    parâmetros rendem o mesmo resultado vectorbt (métricas idênticas na UI).
    Mantém-se a primeira linha após ordenação por ``best_by`` (melhor rank).
    """
    try:
        return (
            round(float(row.get("return_pct") or 0), 6),
            round(float(row.get("win_rate") or 0), 6),
            int(row.get("trades") or 0),
            round(float(row.get("max_dd") or 0), 6),
            round(float(row.get("sharpe") or 0), 6),
            round(float(row.get("profit_fct") or 0), 6),
            round(float(row.get("expectancy") or 0), 6),
        )
    except (TypeError, ValueError):
        return (0.0, 0.0, 0, 0.0, 0.0, 0.0, 0.0)


def _dedupe_sorted_rows_same_metrics(sorted_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple] = set()
    out: list[dict[str, Any]] = []
    for r in sorted_rows:
        sig = _optimize_row_metric_signature(r)
        if sig in seen:
            continue
        seen.add(sig)
        out.append(r)
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


def _builder_trial_for_ui(row: dict[str, Any], trial_index: int, max_equity_points: int, sc_mod: Any) -> dict[str, Any]:
    """Extrai série de equity compacta + métricas para gráficos multi-teste."""
    co = row.get("chart_overlay") if isinstance(row.get("chart_overlay"), dict) else {}
    eq = co.get("equity") if isinstance(co.get("equity"), list) else []
    times: list[int] = []
    vals: list[float] = []
    for p in eq:
        if not isinstance(p, dict):
            continue
        try:
            times.append(int(p["t"]))
            vals.append(float(p["v"]))
        except (KeyError, TypeError, ValueError):
            continue
    cap = max(32, int(max_equity_points))
    if len(times) >= 2:
        t2, v2 = sc_mod._downsample_equity(times, vals, cap)
        eq_out = [{"t": int(t), "v": float(v)} for t, v in zip(t2, v2)]
    else:
        eq_out = [{"t": times[i], "v": vals[i]} for i in range(len(times))]

    return {
        "trial_index": int(trial_index),
        "return_pct": row.get("return_pct"),
        "win_rate": row.get("win_rate"),
        "trades": row.get("trades"),
        "max_dd": row.get("max_dd"),
        "sharpe": row.get("sharpe"),
        "profit_fct": row.get("profit_fct"),
        "expectancy": row.get("expectancy"),
        "best_params": row.get("best_params") if isinstance(row.get("best_params"), dict) else {},
        "resolved_params": row.get("resolved_params") if isinstance(row.get("resolved_params"), dict) else {},
        "equity": eq_out,
    }


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
    strategy_source = str(payload.get("strategy_source") or "vbt").strip().lower()
    vbt_strategy = str(payload.get("vbt_strategy") or "").strip()
    builder_strategy_id = str(payload.get("builder_strategy_id") or "").strip()
    builder_spec_payload = payload.get("builder_spec") if isinstance(payload.get("builder_spec"), dict) else None
    symbol_ids = dedupe_symbol_ids([int(x) for x in payload.get("symbol_ids") or []])
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

    include_ui_charts = bool(payload.get("include_ui_charts"))

    validation_framework = str(payload.get("validation_framework") or "standard").strip().lower()
    if validation_framework not in ("standard", "walk_forward", "monte_carlo"):
        validation_framework = "standard"

    raw_vfs = payload.get("validation_frameworks")
    vfs_list: list[str]
    if isinstance(raw_vfs, list) and raw_vfs:
        vfs_list = []
        seen_v: set[str] = set()
        for x in raw_vfs:
            s = str(x).strip().lower()
            if s in ("standard", "walk_forward", "monte_carlo") and s not in seen_v:
                seen_v.add(s)
                vfs_list.append(s)
        if not vfs_list:
            vfs_list = [validation_framework]
    else:
        vfs_list = [validation_framework]

    do_walk_forward = "walk_forward" in vfs_list
    do_monte_carlo = "monte_carlo" in vfs_list

    raw_tfs = payload.get("timeframes")
    tf_list: list[str] = []
    if isinstance(raw_tfs, list) and raw_tfs:
        seen_tf: set[str] = set()
        for x in raw_tfs:
            s = str(x).strip()
            if s in TIMEFRAME_TO_SAMPLE and s not in seen_tf:
                seen_tf.add(s)
                tf_list.append(s)
    if not tf_list:
        single_tf = str(payload.get("timeframe") or "5m").strip()
        if single_tf in TIMEFRAME_TO_SAMPLE:
            tf_list = [single_tf]

    if not tf_list:
        raise ValueError("timeframe(s) inválido(s)")

    param_drift_enabled = bool(payload.get("param_drift_enabled"))
    drift_pct_by_key: dict[str, float] = {}
    raw_drift = payload.get("param_drift_pct_by_key")
    if isinstance(raw_drift, dict):
        for dk, dv in raw_drift.items():
            try:
                drift_pct_by_key[str(dk)] = float(dv)
            except (TypeError, ValueError):
                pass

    wf_n_splits = max(2, min(int(payload.get("wf_n_splits") or 5), 24))
    wf_min_seg = max(30, min(int(payload.get("wf_min_segment_bars") or 80), 50_000))

    mc_runs_req = int(payload.get("mc_runs") or 800)
    mc_cap = _env_int("BACKTEST_MC_RUNS_CAP", 4000)
    mc_runs_eff = max(50, min(mc_runs_req, mc_cap))

    raw_mc_seed = payload.get("mc_seed")
    if raw_mc_seed is None or raw_mc_seed == "":
        mc_seed_eff = int(time.time_ns() % (2**31))
    else:
        mc_seed_eff = int(raw_mc_seed)

    exec_fee_pct_fill = _clamp_exec_pct(payload.get("exec_fee_pct_per_fill"))
    exec_slippage_pct_eff = _clamp_exec_pct(payload.get("exec_slippage_pct"))
    exec_half_spread_pct_eff = _clamp_exec_pct(payload.get("exec_half_spread_pct"))

    max_workers = _env_int("BACKTEST_MAX_SYMBOL_WORKERS", 3)
    qdb_conc = _env_int("BACKTEST_QUESTDB_CONCURRENCY", 4)
    do_prefilter = _env_bool("BACKTEST_PREFILTER", True)
    prefilter_mult = _env_float("BACKTEST_PREFILTER_MULT", 0.85)

    trials_ui_max = max(1, min(_env_int("BACKTEST_UI_TRIALS_MAX", 120), 500))
    trial_equity_pts = max(32, min(_env_int("BACKTEST_UI_TRIAL_EQUITY_POINTS", 400), 2500))

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
                "strategy_source": strategy_source,
                "vbt_strategy": vbt_strategy,
                "builder_strategy_id": builder_strategy_id,
                "symbols": len(symbol_ids),
                "timeframe": tf_list[0] if tf_list else "",
                "timeframes": tf_list,
                "workers": max_workers,
                "questdb_concurrency": qdb_conc,
                "optimize_seed": optimize_seed,
                "optimize_grid_sample": grid_sample,
                "optimize_top_k": optimize_top_k,
                "optimize_holdout_ratio": holdout,
                "ui_trials_max": trials_ui_max,
                "ui_trial_equity_points": trial_equity_pts,
                "include_ui_charts": include_ui_charts,
                "validation_framework": validation_framework,
                "validation_frameworks": vfs_list,
                "param_drift_enabled": param_drift_enabled,
                "wf_n_splits": wf_n_splits,
                "wf_min_segment_bars": wf_min_seg,
                "mc_runs": mc_runs_eff,
                "exec_fee_pct_per_fill": exec_fee_pct_fill,
                "exec_slippage_pct": exec_slippage_pct_eff,
                "exec_half_spread_pct": exec_half_spread_pct_eff,
            },
        }
    )
    persist_job_upsert(job_id, JOBS[job_id])

    try:
        sc = _load_scanner()
        min_trades = int(payload.get("min_trades") or sc.MIN_TRADES)

        is_builder = strategy_source == "builder"
        if not symbol_ids:
            raise ValueError("symbol_ids são obrigatórios")
        if not is_builder and not vbt_strategy:
            raise ValueError("vbt_strategy é obrigatório")

        sc.TOTAL_CASH_TEST = initial_cash
        sc.MIN_TRADES = max(1, min_trades)

        builder_label = ""
        builder_spec: dict[str, Any] | None = None
        builder_grid: list[dict[str, Any]] = [{}]
        vbt_mod = None
        signal_fn = None
        ind_param_names = frozenset()
        ind_list: list[dict[str, Any]]
        thr_list: list[dict[str, Any]]
        if is_builder:
            builder_label, builder_spec = load_builder_strategy_spec(builder_strategy_id, builder_spec_payload)
            builder_grid = builder_param_grid(
                builder_spec,
                mode,
                max_tries if mode == "optimize" else num_tests,
                drift_enabled=param_drift_enabled,
                drift_pct_by_key=drift_pct_by_key if param_drift_enabled else None,
            )
            ind_list = builder_grid
            thr_list = [{}]
        else:
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

        symbol_labels: dict[int, str] = {
            int(k): str(v) for k, v in (payload.get("symbol_labels") or {}).items()
        }

        max_bar_hint = max(preset_bar_limit(t, range_preset) for t in tf_list)

        progress_cb(
            2,
            f"A carregar velas (até ~{max_bar_hint} barras/tf, {len(tf_list)} TF, {qdb_conc} paralelo)…",
        )

        async def _prefetch_all() -> dict[tuple[int, str], list[dict[str, Any]] | None]:
            sem = asyncio.Semaphore(qdb_conc)
            out_map: dict[tuple[int, str], list[dict[str, Any]] | None] = {}

            async def _one(sym_id: int, tf: str, client: httpx.AsyncClient) -> None:
                pair_k = (sym_id, tf)
                async with sem:
                    if job_id in CANCEL_REQUESTED:
                        out_map[pair_k] = None
                        return
                    try:
                        bar_limit_tf = preset_bar_limit(tf, range_preset)
                        tf_min = _TF_MINUTES.get(tf, 5)
                        # Estimativa: `bar_limit_tf` barras agregadas ≈ precisar de bar_limit × tf_min
                        # linhas 1m. Com preset "max" isso explode (ex.: 5m → 212k+) e o pré-filtro
                        # recusa o fetch mesmo com dados suficientes para um backtest útil.
                        est_raw_1m = int(bar_limit_tf * tf_min * prefilter_mult)
                        prefilter_cap = chart_ta_base_bar_limit()
                        min_1m_local = min(est_raw_1m, prefilter_cap) if do_prefilter else 0
                        if do_prefilter and min_1m_local > 0:
                            cnt = await questdb_count_1m_rows(client, sym_id)
                            if cnt < min_1m_local:
                                out_map[pair_k] = None
                                return
                        bars = await questdb_fetch_bars(client, sym_id, tf, bar_limit_tf)
                        out_map[pair_k] = bars
                    except Exception:
                        out_map[pair_k] = None

            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
                await asyncio.gather(*(_one(sid, tf, client) for tf in tf_list for sid in symbol_ids))

            return out_map

        bars_by_symbol = asyncio.run(_prefetch_all())

        if job_id in CANCEL_REQUESTED:
            raise RuntimeError("Cancelado pelo utilizador")

        total_steps = max(1, len(tf_list) * len(symbol_ids) * max(1, len(ind_list)))
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
        diagnostics: dict[str, Any] = {
            "min_trades_filter": max(1, min_trades),
            "skip_no_data": 0,
            "skip_short_series": 0,
            "trials_executed": 0,
            "trials_below_min_trades": 0,
        }

        def _diag_inc(key: str, n: int = 1) -> None:
            with results_lock:
                diagnostics[key] = int(diagnostics.get(key, 0)) + n

        per_batch_k = min(len(thr_list), optimize_top_k, 12)

        def _process_pair(sym_id: int, tf: str) -> dict[str, Any]:
            freq_str = timeframe_to_pandas_freq(tf)
            tf_mc_seed = mc_seed_eff + sym_id + sum(ord(c) for c in tf)
            if job_id in CANCEL_REQUESTED:
                return {"rows": [], "trials": [], "walk_forward": None, "monte_carlo": None}
            label = symbol_labels.get(sym_id, str(sym_id))
            bars = bars_by_symbol.get((sym_id, tf))
            if not bars:
                _diag_inc("skip_no_data")
                with progress_lock:
                    progress_done[0] += len(ind_list)
                    progress_cb(
                        min(99, 5 + int(90 * progress_done[0] / total_steps)),
                        f"{label} [{tf}]: sem dados",
                    )
                return {"rows": [], "trials": [], "walk_forward": None, "monte_carlo": None}

            df = bars_to_ohlcv_df(bars, min_rows=max(50, min_trades))
            if df is None:
                _diag_inc("skip_short_series")
                with progress_lock:
                    progress_done[0] += len(ind_list)
                    progress_cb(
                        min(99, 5 + int(90 * progress_done[0] / total_steps)),
                        f"{label} [{tf}]: poucas velas",
                    )
                return {"rows": [], "trials": [], "walk_forward": None, "monte_carlo": None}

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
            trials_acc: list[dict[str, Any]] = []
            for ind_params in ind_list:
                if job_id in CANCEL_REQUESTED:
                    return {"rows": [], "trials": [], "walk_forward": None, "monte_carlo": None}
                if is_builder:
                    assert builder_spec is not None
                    _diag_inc("trials_executed")
                    row = run_builder_backtest(
                        df_fit,
                        label,
                        builder_spec,
                        initial_cash=initial_cash,
                        best_params=ind_params,
                        exec_fee_pct_per_fill=exec_fee_pct_fill,
                        exec_slippage_pct=exec_slippage_pct_eff,
                        exec_half_spread_pct=exec_half_spread_pct_eff,
                    )
                    if int(row.get("trades") or 0) >= max(1, min_trades):
                        row["strategy_source"] = "builder"
                        row["builder_strategy_id"] = builder_strategy_id
                        row["builder_strategy_name"] = builder_label
                        candidates.append(row)
                        if include_ui_charts and len(trials_acc) < trials_ui_max:
                            trials_acc.append(_builder_trial_for_ui(row, len(trials_acc), trial_equity_pts, sc))
                    else:
                        _diag_inc("trials_below_min_trades")
                else:
                    assert vbt_mod is not None and signal_fn is not None
                    _diag_inc("trials_executed")
                    pf_sink: list[Any] | None = [] if include_ui_charts else None
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
                        pf_sink=pf_sink,
                        include_chart_overlay=include_ui_charts,
                        exec_fee_pct_per_fill=exec_fee_pct_fill,
                        exec_slippage_pct=exec_slippage_pct_eff,
                        exec_half_spread_pct=exec_half_spread_pct_eff,
                    )
                    if not batch:
                        _diag_inc("trials_below_min_trades")
                    candidates.extend(batch)
                    if (
                        include_ui_charts
                        and pf_sink
                        and len(trials_acc) < trials_ui_max
                        and len(thr_list) > 0
                    ):
                        remain = trials_ui_max - len(trials_acc)
                        curves = sc.export_pf_trial_curves(
                            pf_sink[0],
                            df_fit,
                            thr_list,
                            ind_params,
                            label,
                            best_by=best_by,
                            max_trials=remain,
                            max_equity_points=trial_equity_pts,
                            trial_index_offset=len(trials_acc),
                        )
                        trials_acc.extend(curves)
                _bump_progress(f"{label} [{tf}]")

            seen_fp: set[tuple] = set()
            uniq: list[dict[str, Any]] = []
            for r in candidates:
                fp = sc._param_fingerprint(r["best_params"])
                if fp in seen_fp:
                    continue
                seen_fp.add(fp)
                uniq.append(r)

            uniq.sort(key=lambda row: sc._result_score(row, best_by), reverse=True)
            uniq = _dedupe_sorted_rows_same_metrics(uniq)
            top = uniq[:optimize_top_k]

            if df_oos is not None and top:
                for r in top:
                    if is_builder:
                        assert builder_spec is not None
                        oos = run_builder_backtest(
                            df_oos,
                            label,
                            builder_spec,
                            initial_cash=initial_cash,
                            best_params=r.get("best_params") if isinstance(r.get("best_params"), dict) else {},
                            exec_fee_pct_per_fill=exec_fee_pct_fill,
                            exec_slippage_pct=exec_slippage_pct_eff,
                            exec_half_spread_pct=exec_half_spread_pct_eff,
                        )
                    else:
                        assert vbt_mod is not None and signal_fn is not None
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
                            exec_fee_pct_per_fill=exec_fee_pct_fill,
                            exec_slippage_pct=exec_slippage_pct_eff,
                            exec_half_spread_pct=exec_half_spread_pct_eff,
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
                r["timeframe"] = tf

            wf_payload: dict[str, Any] | None = None
            mc_payload: dict[str, Any] | None = None

            MC_RET_MIN = 30

            if do_walk_forward and top:
                folds_ix = contiguous_folds(len(df_fit), wf_n_splits, wf_min_seg)
                best_params_wf = top[0].get("best_params") if isinstance(top[0].get("best_params"), dict) else {}
                fold_rows: list[dict[str, Any]] = []
                if not folds_ix:
                    wf_payload = {
                        "symbol_id": sym_id,
                        "symbol": label,
                        "timeframe": tf,
                        "error": "série curta para walk-forward",
                        "folds": [],
                        "summary": {},
                    }
                else:
                    for fi, (a, b) in enumerate(folds_ix):
                        sl = df_fit.iloc[a:b]
                        if len(sl) < max(50, min_trades):
                            continue
                        if is_builder:
                            assert builder_spec is not None
                            rr = run_builder_backtest(
                                sl,
                                label,
                                builder_spec,
                                initial_cash=initial_cash,
                                best_params=best_params_wf,
                                exec_fee_pct_per_fill=exec_fee_pct_fill,
                                exec_slippage_pct=exec_slippage_pct_eff,
                                exec_half_spread_pct=exec_half_spread_pct_eff,
                            )
                        else:
                            assert vbt_mod is not None and signal_fn is not None
                            ind_p, thr_p = sc.split_best_params_ind_thr(best_params_wf, ind_param_names)
                            thr_combo = [thr_p] if thr_p else [{}]
                            rr_o = sc.run_vbt_backtest(
                                sl,
                                label,
                                ind_p,
                                thr_combo,
                                signal_fn,
                                vbt_mod.compute_indicators,
                                best_by=best_by,
                                freq=freq_str,
                                exec_fee_pct_per_fill=exec_fee_pct_fill,
                                exec_slippage_pct=exec_slippage_pct_eff,
                                exec_half_spread_pct=exec_half_spread_pct_eff,
                            )
                            rr = rr_o if rr_o else {}
                        fold_rows.append(
                            {
                                "fold": fi,
                                "bar_from": a,
                                "bar_to": b,
                                "return_pct": rr.get("return_pct"),
                                "win_rate": rr.get("win_rate"),
                                "trades": rr.get("trades"),
                                "max_dd": rr.get("max_dd"),
                                "profit_fct": rr.get("profit_fct"),
                                "sharpe": rr.get("sharpe"),
                            }
                        )
                    if fold_rows:
                        rp = [
                            float(x["return_pct"])
                            for x in fold_rows
                            if x.get("return_pct") is not None
                        ]
                        wf_payload = {
                            "symbol_id": sym_id,
                            "symbol": label,
                            "timeframe": tf,
                            "folds": fold_rows,
                            "summary": {
                                "n_folds": len(fold_rows),
                                "return_pct_mean": float(np.mean(rp)) if rp else None,
                                "return_pct_std": float(np.std(rp)) if len(rp) > 1 else 0.0,
                            },
                            "policy": "contiguous_slices_fixed_params",
                        }
                    elif wf_payload is None:
                        wf_payload = {
                            "symbol_id": sym_id,
                            "symbol": label,
                            "timeframe": tf,
                            "error": "nenhum fold passou o mínimo de barras/trades",
                            "folds": [],
                            "summary": {},
                        }

            if do_monte_carlo and top:
                ref = top[0]
                rets_dec: list[float] = []
                note_fb: str | None = None
                if is_builder:
                    tl0 = ref.get("trade_log") if isinstance(ref.get("trade_log"), list) else []
                    rets_dec = trade_log_to_returns_decimal(tl0)
                    if len(rets_dec) < MC_RET_MIN:
                        co = ref.get("chart_overlay") if isinstance(ref.get("chart_overlay"), dict) else {}
                        eq = co.get("equity") if isinstance(co.get("equity"), list) else []
                        rets_dec = equity_points_to_returns_decimal(eq)
                        note_fb = "fallback_equity_steps"
                else:
                    assert vbt_mod is not None and signal_fn is not None
                    bp = ref.get("best_params") if isinstance(ref.get("best_params"), dict) else {}
                    ind_p, thr_p = sc.split_best_params_ind_thr(bp, ind_param_names)
                    thr_combo = [thr_p] if thr_p else [{}]
                    pf_mc: list[Any] = []
                    sc.run_vbt_backtest_topk(
                        df_fit,
                        label,
                        ind_p,
                        thr_combo,
                        signal_fn,
                        vbt_mod.compute_indicators,
                        best_by=best_by,
                        freq=freq_str,
                        top_k=1,
                        pf_sink=pf_mc,
                        include_chart_overlay=False,
                        exec_fee_pct_per_fill=exec_fee_pct_fill,
                        exec_slippage_pct=exec_slippage_pct_eff,
                        exec_half_spread_pct=exec_half_spread_pct_eff,
                    )
                    if pf_mc:
                        tl_v = sc.trade_log_rows_from_pf(pf_mc[0], df_fit, 0)
                        rets_dec = [float(x["pnl_pct"]) / 100.0 for x in tl_v]
                        if len(rets_dec) < MC_RET_MIN:
                            try:
                                val = pf_mc[0].value()
                                arr = np.asarray(val, dtype=np.float64)
                                eq_s = arr[:, 0] if arr.ndim == 2 else np.asarray(arr, dtype=np.float64).ravel()
                                n = len(df_fit.index)
                                if len(eq_s) > n:
                                    eq_s = eq_s[:n]
                                elif len(eq_s) < n:
                                    eq_s = np.pad(eq_s, (0, n - len(eq_s)), mode="edge")[:n]
                                if len(eq_s) >= 3:
                                    rets_dec = [
                                        float((eq_s[i] - eq_s[i - 1]) / eq_s[i - 1])
                                        for i in range(1, len(eq_s))
                                        if eq_s[i - 1] > 1e-12
                                    ]
                                    note_fb = "fallback_equity_steps"
                            except Exception:
                                rets_dec = []
                                note_fb = None

                mc_merge = monte_carlo_bootstrap_returns(
                    rets_dec,
                    initial=initial_cash,
                    n_runs=mc_runs_eff,
                    seed=tf_mc_seed,
                    min_trades_fallback_note=note_fb,
                )
                mc_payload = {"symbol_id": sym_id, "symbol": label, "timeframe": tf, **mc_merge}

            def _finalize_row(rw: dict[str, Any]) -> dict[str, Any]:
                out = strip_row_ui_heavy(rw) if not include_ui_charts else dict(rw)
                return _json_safe(out)

            return {
                "rows": [_finalize_row(x) for x in top],
                "trials": [_json_safe(x) for x in trials_acc],
                "walk_forward": wf_payload,
                "monte_carlo": mc_payload,
            }

        by_pair: dict[tuple[int, str], Any] = {}

        if max_workers <= 1:
            for tf in tf_list:
                for sid in symbol_ids:
                    if job_id in CANCEL_REQUESTED:
                        raise RuntimeError("Cancelado pelo utilizador")
                    by_pair[(sid, tf)] = _process_pair(sid, tf)
        else:
            pair_tasks = [(sid, tf) for tf in tf_list for sid in symbol_ids]
            with ThreadPoolExecutor(max_workers=max_workers) as ex:
                futs = {ex.submit(_process_pair, sid, tf): (sid, tf) for sid, tf in pair_tasks}
                for fut in as_completed(futs):
                    if job_id in CANCEL_REQUESTED:
                        ex.shutdown(wait=False, cancel_futures=True)
                        raise RuntimeError("Cancelado pelo utilizador")
                    sid_tf = futs[fut]
                    try:
                        pack = fut.result()
                        with results_lock:
                            by_pair[sid_tf] = pack
                    except Exception:
                        with results_lock:
                            by_pair[sid_tf] = {
                                "rows": [],
                                "trials": [],
                                "walk_forward": None,
                                "monte_carlo": None,
                            }

        if job_id in CANCEL_REQUESTED:
            raise RuntimeError("Cancelado pelo utilizador")

        results: list[dict[str, Any]] = []
        trial_batches: list[dict[str, Any]] = []
        walk_forward_batches: list[dict[str, Any]] = []
        monte_carlo_batches: list[dict[str, Any]] = []
        for tf in tf_list:
            for sid in symbol_ids:
                pack = by_pair.get((sid, tf))
                if isinstance(pack, dict) and "rows" in pack:
                    rows = pack.get("rows") or []
                    tr = pack.get("trials") or []
                    wf_e = pack.get("walk_forward")
                    mc_e = pack.get("monte_carlo")
                    if isinstance(wf_e, dict):
                        walk_forward_batches.append(wf_e)
                    if isinstance(mc_e, dict):
                        monte_carlo_batches.append(mc_e)
                else:
                    rows = pack if isinstance(pack, list) else []
                    tr = []
                rows = list(rows)
                rows.sort(key=lambda row: sc._result_score(row, best_by), reverse=True)
                results.extend(rows)
                trial_batches.append(
                    {
                        "symbol_id": sid,
                        "symbol": symbol_labels.get(sid, str(sid)),
                        "timeframe": tf,
                        "trials": tr if include_ui_charts else [],
                    }
                )

        for r in results:
            r["strategy_source"] = "builder" if is_builder else "vbt"
            r["vbt_strategy"] = vbt_strategy if not is_builder else ""
            r["exec_fee_pct_per_fill"] = exec_fee_pct_fill
            r["exec_slippage_pct"] = exec_slippage_pct_eff
            r["exec_half_spread_pct"] = exec_half_spread_pct_eff
            if is_builder:
                r["builder_strategy_id"] = builder_strategy_id
                r["builder_strategy_name"] = builder_label
                if builder_spec is not None:
                    r["builder_spec"] = builder_spec

        diagnostics["result_rows"] = len(results)

        JOBS[job_id].update(
            {
                "status": "completed",
                "progress": 100,
                "phase": "Concluído",
                "results": results,
                "trial_batches": trial_batches,
                "walk_forward": walk_forward_batches,
                "monte_carlo": monte_carlo_batches,
                "diagnostics": diagnostics,
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


def simulate_strategy_on_chart_bars(
    vbt_strategy: str,
    timeframe: str,
    bars: list[dict[str, Any]],
    *,
    initial_cash: float = 10_000.0,
    min_trades: int = 1,
    best_by: str = "return_pct",
    indicator_params: dict[str, Any] | None = None,
    exec_fee_pct_per_fill: float = 0.0,
    exec_slippage_pct: float = 0.0,
    exec_half_spread_pct: float = 0.0,
) -> dict[str, Any] | None:
    """
    Simulação nas velas do gráfico (POST): mesma pipeline vectorbt que os jobs QuestDB,
    sem gravar job. Resposta no formato ``BacktestChartLayer`` do frontend.
    """
    sc = _load_scanner()
    if timeframe not in TIMEFRAME_TO_SAMPLE:
        raise ValueError(f"timeframe inválido: {timeframe}")
    vs = str(vbt_strategy).strip()
    if not vs:
        raise ValueError("vbt_strategy é obrigatório")

    cap = chart_ta_base_bar_limit()
    if len(bars) > cap:
        bars = bars[-cap:]

    prev_min = int(sc.MIN_TRADES)
    prev_cash = float(sc.TOTAL_CASH_TEST)
    pf_sink: list[Any] = []
    try:
        sc.MIN_TRADES = max(1, min(int(min_trades), 5000))
        sc.TOTAL_CASH_TEST = float(initial_cash)

        exec_fee_eff = _clamp_exec_pct(exec_fee_pct_per_fill)
        exec_slip_eff = _clamp_exec_pct(exec_slippage_pct)
        exec_half_eff = _clamp_exec_pct(exec_half_spread_pct)

        vbt_mod = sc.load_strategy_vbt_module(vs)
        if not hasattr(vbt_mod, "compute_signals_vectorized") or not hasattr(
            vbt_mod, "compute_indicators"
        ):
            raise ValueError(
                "Módulo *_vbt precisa de compute_indicators e compute_signals_vectorized"
            )

        signal_fn = vbt_mod.compute_signals_vectorized
        param_specs = sc.get_strategy_param_specs(vbt_mod)
        ind_param_names = sc.resolve_indicator_param_names(vbt_mod, param_specs)

        df = bars_to_ohlcv_df(bars, min_rows=15)
        if df is None:
            return None

        freq_str = timeframe_to_pandas_freq(timeframe)

        if not param_specs:
            ind_params = dict(indicator_params or {})
            thr_list: list[dict[str, Any]] = [{}]
        else:
            defaults = _defaults_from_param_specs(param_specs)
            merged = _merge_indicator_params_client(defaults, indicator_params, param_specs)
            ind_params, thr_row = _split_merged_into_ind_thr(merged, param_specs, ind_param_names)
            thr_list = [thr_row]

        batch = sc.run_vbt_backtest_topk(
            df,
            "chart",
            ind_params,
            thr_list,
            signal_fn,
            vbt_mod.compute_indicators,
            best_by=best_by,
            freq=freq_str,
            top_k=1,
            pf_sink=pf_sink,
            ignore_overlay_env=True,
            exec_fee_pct_per_fill=exec_fee_eff,
            exec_slippage_pct=exec_slip_eff,
            exec_half_spread_pct=exec_half_eff,
        )
        if not batch:
            return None

        row = batch[0]
        col_i = int(row.get("vbt_col", 0))
        trade_log: list[dict[str, Any]] = []
        if pf_sink:
            trade_log = sc.trade_log_rows_from_pf(pf_sink[0], df, col_i)

        ov = row.get("chart_overlay")
        if ov is None and pf_sink:
            try:
                ov = sc.chart_overlay_from_pf(
                    pf_sink[0], df, col_i, ignore_overlay_env=True
                )
            except Exception:
                ov = None
        if ov is None:
            return None

        try:
            ind_raw = vbt_mod.compute_indicators(df, ind_params)
            ind_serial = _indicators_dict_for_chart(ind_raw, len(df))
        except Exception:
            ind_serial = {}

        layer: dict[str, Any] = {
            "overlay": ov,
            "stats": {
                "return_pct": float(row.get("return_pct", 0.0)),
                "win_rate": float(row.get("win_rate", 0.0)),
                "trades": int(row.get("trades", 0)),
                "max_dd": float(row.get("max_dd", 0.0)),
                "sharpe": float(row.get("sharpe", 0.0)),
                "profit_fct": float(row.get("profit_fct", 0.0)),
            },
            "trade_log": trade_log,
            "indicators": ind_serial,
        }
        return _json_safe(layer)
    finally:
        sc.MIN_TRADES = prev_min
        sc.TOTAL_CASH_TEST = prev_cash


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
