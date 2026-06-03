"""
monthly_scanner_vbt.py
──────────────────────
Scanner mensal usando vectorbt — muito mais rápido na optimização.

Como funciona a vectorização:
  • Os indicadores são calculados UMA vez por (símbolo × conjunto de ind_params).
  • Os sinais são gerados para TODAS as combinações de threshold em simultâneo
    via numpy broadcasting → arrays 2D (n_barras × n_combos).
  • O vectorbt corre 1 Portfolio com N colunas, equivalente a N backtests paralelos.

Vantagem vs backtesting.py:
  backtesting.py → 1 backtest de cada vez (loop Python, bar-a-bar)
  vectorbt       → N backtests simultâneos (arrays numpy + JIT numba)
  Para 300 combinações de parâmetros: ~10-30× mais rápido.

Uso:
    python monthly_scanner_vbt.py
    python monthly_scanner_vbt.py --optimize --max-tries 500
    python monthly_scanner_vbt.py --tf 15m --days 60 --top 15

Estratégia (--strategy): qualquer módulo *_vbt sem editar este ficheiro.
    python monthly_scanner_vbt.py --strategy lateral_market_rsi
    python monthly_scanner_vbt.py --strategy fast_15min_v3_vbt
    python monthly_scanner_vbt.py --strategy my_strategies.fast_15min_v3_vbt
    python monthly_scanner_vbt.py --strategy my_strategies/fast_15min_v3_vbt.py

Auto-geração de trader files (filtro + top N):
    # Gera os 5 melhores com WR>=75% E expectancy>=0.2%
    python monthly_scanner_vbt.py --auto-top 5 --min-win-rate 75 --min-expectancy 0.2

    # Critérios mais estritos: também PF>=1.5 e DD<=20%
    python monthly_scanner_vbt.py --auto-top 5 --min-win-rate 75 --min-expectancy 0.2 --min-pf 1.5 --max-dd 20

    # Apenas 3 melhores, sem filtro (top 3 de sempre)
    python monthly_scanner_vbt.py --auto-top 3

    Ficheiros gerados: traders_py/auto_SYMBOL_QUOTE_TF.py
    Se o ficheiro já existir, apenas o bloco de parâmetros é actualizado.
"""

import sys
import os
import re
import argparse
import time
import random
import math
import importlib
import importlib.util
import inspect
from datetime import datetime, timedelta, timezone
from itertools import product as iterproduct

# Forçar UTF-8 no stdout para evitar erros de encoding no Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
elif sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import ccxt
import numpy as np
import pandas as pd
import requests

try:
    import vectorbt as vbt
except ImportError:
    print("❌ vectorbt não instalado. Execute:  pip install vectorbt")
    sys.exit(1)

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'traders_py'))
_BACKEND_DIR = os.path.join(ROOT, 'backend')
if os.path.isdir(_BACKEND_DIR):
    sys.path.insert(0, _BACKEND_DIR)

from config import TOTAL_CASH_TEST

DEFAULT_STRATEGY  = 'lateral_market_rsi_vbt'
DEFAULT_TIMEFRAME = '3m'
DEFAULT_DAYS      = 90
DEFAULT_TOP       = 10
MIN_TRADES        = 50
MIN_CANDLES       = 1000

# Sem lista fixa de nomes: cada *_vbt deve definir INDICATOR_PARAM_NAMES ou ser
# inferível a partir de compute_indicators + get_strategy_parameters.
FALLBACK_IND_PARAM_NAMES: frozenset = frozenset()


# ═══════════════════════════════════════════════════════════════════════════════
#  CARREGAMENTO DINÂMICO DE ESTRATÉGIAS *_vbt
# ═══════════════════════════════════════════════════════════════════════════════

def _resolve_strategy_path(spec: str) -> str | None:
    """Se spec for um caminho para .py existente, devolve path absoluto; senão None."""
    s = spec.strip().strip('"').strip("'")
    if not s.lower().endswith('.py'):
        return None
    if os.path.isfile(s):
        return os.path.abspath(s)
    rel = os.path.join(ROOT, os.path.normpath(s))
    if os.path.isfile(rel):
        return os.path.abspath(rel)
    return None


def load_strategy_vbt_module(spec: str):
    """
    Carrega o módulo Python da estratégia vectorbt.

    Aceita:
      • Nome curto (sem _vbt):  lateral_market_rsi  →  my_strategies.lateral_market_rsi_vbt
      • Nome já com sufixo:    fast_15min_v3_vbt    →  my_strategies.fast_15min_v3_vbt
      • Módulo completo:       my_strategies.fast_15min_v3_vbt
      • Caminho para ficheiro: my_strategies/foo_vbt.py (relativo ao ROOT ou absoluto)
    """
    s = spec.strip().strip('"').strip("'")
    if not s:
        raise ValueError('Estratégia vazia.')

    path = _resolve_strategy_path(s)
    if path is not None:
        stem = os.path.splitext(os.path.basename(path))[0]
        mod_name = f'_vbt_loaded_{stem}'
        if mod_name in sys.modules:
            del sys.modules[mod_name]
        loader_spec = importlib.util.spec_from_file_location(mod_name, path)
        if loader_spec is None or loader_spec.loader is None:
            raise ImportError(f'Não foi possível carregar: {path}')
        mod = importlib.util.module_from_spec(loader_spec)
        sys.modules[mod_name] = mod
        loader_spec.loader.exec_module(mod)
        mod.__file__ = path
        return mod

    if '.' in s and not s.startswith('.'):
        return importlib.import_module(s)

    base = s
    if base.endswith('_vbt'):
        mod_name = f'my_strategies.{base}'
    else:
        mod_name = f'my_strategies.{base}_vbt'
    return importlib.import_module(mod_name)


def _companion_backtesting_module_name(vbt_mod_name: str) -> str | None:
    """my_strategies.foo_vbt → my_strategies.foo"""
    parts = vbt_mod_name.split('.')
    last = parts[-1]
    if not last.endswith('_vbt'):
        return None
    parts[-1] = last[:-4]
    return '.'.join(parts)


def get_strategy_param_specs(vbt_mod) -> dict:
    """
    Obtém o dict de specs do scanner: primeiro do módulo *_vbt, depois do
    ficheiro backtesting companheiro (my_strategies.foo), se existir.
    """
    if hasattr(vbt_mod, 'get_strategy_parameters'):
        fn = vbt_mod.get_strategy_parameters
        if callable(fn):
            out = fn()
            if out:
                return dict(out)
    ori = _companion_backtesting_module_name(getattr(vbt_mod, '__name__', ''))
    if ori:
        try:
            m = importlib.import_module(ori)
            if hasattr(m, 'get_strategy_parameters'):
                out = m.get_strategy_parameters()
                if out:
                    return dict(out)
        except Exception:
            pass
    return {}


def _infer_indicator_keys_from_compute_indicators(vbt_mod) -> set[str]:
    """Descobre chaves params['...'] usadas em compute_indicators (heurística)."""
    if not hasattr(vbt_mod, 'compute_indicators'):
        return set()
    try:
        src = inspect.getsource(vbt_mod.compute_indicators)
    except (OSError, TypeError):
        return set()
    keys = set(re.findall(r"params\[\s*['\"]([^'\"]+)['\"]\s*\]", src))
    keys |= set(re.findall(r"params\.get\(\s*['\"]([^'\"]+)['\"]", src))
    return keys


def resolve_indicator_param_names(vbt_mod, param_specs: dict) -> frozenset:
    """
    Conjunto de nomes de parâmetros que afectam só os indicadores (grid ind_list).

    Ordem:
      1. Atributo INDICATOR_PARAM_NAMES ou IND_PARAM_NAMES no módulo *_vbt
      2. Chaves usadas em compute_indicators (regex)
      3. Intersecção FALLBACK_IND_PARAM_NAMES ∩ keys(param_specs)
      4. FALLBACK_IND_PARAM_NAMES completo
    """
    for attr in ('INDICATOR_PARAM_NAMES', 'IND_PARAM_NAMES'):
        if hasattr(vbt_mod, attr):
            raw = getattr(vbt_mod, attr)
            if raw is not None:
                return frozenset(raw)

    spec_keys = set(param_specs.keys()) if param_specs else set()
    inferred = _infer_indicator_keys_from_compute_indicators(vbt_mod) & spec_keys
    if inferred:
        return frozenset(inferred)

    fb = FALLBACK_IND_PARAM_NAMES & spec_keys
    if fb:
        return frozenset(fb)

    return frozenset()


# ═══════════════════════════════════════════════════════════════════════════════
#  GRIDS DE PARÂMETROS
# ═══════════════════════════════════════════════════════════════════════════════

def _param_range(min_v, max_v, step, is_decimal):
    if is_decimal:
        dec  = max(len(str(step).rstrip('0').split('.')[-1]), 4)
        vals = [round(v, dec) for v in np.arange(float(min_v), float(max_v) + float(step) / 2, float(step))]
    else:
        vals = list(range(int(min_v), int(max_v) + int(step), int(step)))
    return vals


def _param_fingerprint(d: dict) -> tuple:
    """Chave estável para dedupe de combinações de parâmetros."""

    def _atom(x):
        # Evita TypeError em sorted() quando vêm np.float64/np.int64 (ex.: builder → job em thread).
        if isinstance(x, (np.generic,)):
            try:
                x = x.item()
            except Exception:
                pass
        if isinstance(x, (np.integer, np.int64, np.int32)):
            return int(x)
        if isinstance(x, (np.floating, np.float64, np.float32)):
            return round(float(x), 8)
        if isinstance(x, float):
            return round(x, 8)
        if isinstance(x, bool):
            return x
        if isinstance(x, int):
            return x
        return x

    return tuple(sorted((str(k), _atom(d[k])) for k in sorted(d.keys())))


def _grid_product_size(ranges: dict[str, list]) -> int:
    if not ranges:
        return 1
    n = 1
    for v in ranges.values():
        n *= max(1, len(v))
        if n > 10**15:
            return n
    return n


def _enumerate_full_grid(keys: list[str], ranges: dict[str, list], defaults: dict) -> list[dict]:
    if not keys:
        return [dict(defaults)]
    return [{**defaults, **dict(zip(keys, c))} for c in iterproduct(*[ranges[k] for k in keys])]


def _sample_param_combos_random(
    keys: list[str],
    ranges: dict[str, list],
    defaults: dict,
    n_target: int,
    rng: random.Random,
) -> list[dict]:
    if not keys:
        return [dict(defaults)]
    seen: set[tuple] = set()
    out: list[dict] = []
    cap = min(n_target, _grid_product_size(ranges))
    guard = 0
    while len(out) < cap and guard < cap * 50 + 100:
        guard += 1
        combo = {k: rng.choice(ranges[k]) for k in keys}
        full = {**defaults, **combo}
        fp = _param_fingerprint(full)
        if fp in seen:
            continue
        seen.add(fp)
        out.append(full)
    return out


def _sample_param_combos_lhs(
    keys: list[str],
    ranges: dict[str, list],
    defaults: dict,
    n_target: int,
    rng: random.Random,
) -> list[dict]:
    """Amostragem tipo Latin Hypercube em grelhas discretas (melhor cobertura que i.i.d.)."""
    if not keys:
        return [dict(defaults)]
    lengths = [len(ranges[k]) for k in keys]
    prod_sz = math.prod(lengths)
    n = max(1, min(n_target, prod_sz))
    d = len(keys)
    perms = []
    for _ in range(d):
        p = list(range(n))
        rng.shuffle(p)
        perms.append(p)
    seen: set[tuple] = set()
    out: list[dict] = []
    for i in range(n):
        combo = {}
        for j, k in enumerate(keys):
            L = lengths[j]
            u = (perms[j][i] + rng.random()) / n
            idx = min(L - 1, int(u * L))
            combo[k] = ranges[k][idx]
        full = {**defaults, **combo}
        fp = _param_fingerprint(full)
        if fp in seen:
            continue
        seen.add(fp)
        out.append(full)
    guard = 0
    while len(out) < n and guard < n * 80 + 200:
        guard += 1
        combo = {k: rng.choice(ranges[k]) for k in keys}
        full = {**defaults, **combo}
        fp = _param_fingerprint(full)
        if fp in seen:
            continue
        seen.add(fp)
        out.append(full)
    return out


def build_param_grids(
    param_specs: dict,
    max_tries: int,
    ind_param_names: frozenset,
    seed: int = 42,
    grid_sample: str = "lhs",
):
    """
    Divide os parâmetros em:
      ind_list   → combinações de parâmetros de indicadores (loop)
      thr_list   → combinações de threshold (vectorbt, todos testados em paralelo)

    Parâmetros com optimize=False usam sempre o valor default.
    Limite de ``ind_list``: até ``sqrt(max_tries)`` (evita explodir o tempo).
    ``thr_list``: até ``max_tries`` combinações.

    ``grid_sample``: ``lhs`` (recomendado) ou ``random`` — sem materializar o produto
    completo quando a grelha é enorme (poupa RAM e mantém diversidade).

    ``seed`` / ``seed+100_003`` separam RNG de indicadores vs thresholds.
    """
    sample = (grid_sample or "lhs").strip().lower()
    if sample not in ("lhs", "random"):
        sample = "lhs"
    rng_ind = random.Random(int(seed) & 0x7FFFFFFF)
    rng_thr = random.Random((int(seed) + 100_003) & 0x7FFFFFFF)

    ind_ranges: dict[str, list] = {}
    thr_ranges: dict[str, list] = {}
    ind_defaults: dict = {}
    thr_defaults: dict = {}

    for name, (default, min_v, max_v, step, is_dec, do_opt) in param_specs.items():
        if name in ind_param_names:
            if do_opt:
                ind_ranges[name] = _param_range(min_v, max_v, step, is_dec)
            else:
                ind_defaults[name] = default
        else:
            if do_opt:
                thr_ranges[name] = _param_range(min_v, max_v, step, is_dec)
            else:
                thr_defaults[name] = default

    max_ind = max(1, int(max_tries ** 0.5))
    max_thr = max(1, int(max_tries))

    sampler = _sample_param_combos_lhs if sample == "lhs" else _sample_param_combos_random

    keys_i = sorted(ind_ranges.keys())
    if ind_ranges:
        sz_i = _grid_product_size(ind_ranges)
        if sz_i <= max_ind:
            ind_list = _enumerate_full_grid(keys_i, ind_ranges, ind_defaults)
        else:
            ind_list = sampler(keys_i, ind_ranges, ind_defaults, max_ind, rng_ind)
    else:
        ind_list = [dict(ind_defaults)]

    keys_t = sorted(thr_ranges.keys())
    if thr_ranges:
        sz_t = _grid_product_size(thr_ranges)
        if sz_t <= max_thr:
            thr_list = _enumerate_full_grid(keys_t, thr_ranges, thr_defaults)
        else:
            thr_list = sampler(keys_t, thr_ranges, thr_defaults, max_thr, rng_thr)
    else:
        thr_list = [dict(thr_defaults)]

    return ind_list, thr_list


def split_best_params_ind_thr(best_params: dict, ind_param_names: frozenset) -> tuple[dict, dict]:
    """Separa parâmetros fundidos (ind + threshold) para um segundo backtest (ex.: OOS)."""
    ind = {k: best_params[k] for k in ind_param_names if k in best_params}
    thr = {k: v for k, v in best_params.items() if k not in ind_param_names}
    return ind, thr


# ═══════════════════════════════════════════════════════════════════════════════
#  BACKTEST COM VECTORBT
# ═══════════════════════════════════════════════════════════════════════════════

def _extract_vbt_metrics(pf, nc: int) -> dict:
    """
    Extrai métricas do portfolio vectorbt de forma robusta.
    Devolve dict de arrays numpy (nc,).
    """
    def _scalar_or_series(val) -> np.ndarray:
        if np.isscalar(val):
            return np.array([float(val)])
        a = np.asarray(val, dtype=np.float64).flatten()
        return a

    # total_return() devolve fracção
    try:
        total_ret = _scalar_or_series(pf.total_return())
    except Exception:
        total_ret = np.full(nc, np.nan)

    # max_drawdown() devolve fracção
    try:
        max_dd = _scalar_or_series(pf.max_drawdown())
    except Exception:
        max_dd = np.full(nc, np.nan)

    # sharpe_ratio()
    try:
        sharpe = _scalar_or_series(pf.sharpe_ratio())
    except Exception:
        sharpe = np.full(nc, np.nan)

    # ── Todas as estatísticas via trade records ───────────────────────────
    n_trades     = np.zeros(nc, dtype=int)
    wins         = np.zeros(nc, dtype=int)
    win_pnl      = np.zeros(nc)
    loss_pnl     = np.zeros(nc)
    win_ret_sum  = np.zeros(nc)
    loss_ret_sum = np.zeros(nc)
    long_tr      = np.zeros(nc, dtype=int)
    short_tr     = np.zeros(nc, dtype=int)

    try:
        rec = pf.trades.records
        if len(rec) > 0:
            # Converter colunas para numpy arrays para np.add.at funcionar corretamente
            cols = np.asarray(rec['col'],    dtype=int)
            pnls = np.asarray(rec['pnl'],    dtype=float)
            rets = np.asarray(rec['return'], dtype=float)
            win_m  = pnls > 0
            loss_m = pnls < 0
            np.add.at(n_trades,    cols, 1)
            np.add.at(wins,        cols[win_m],  1)
            np.add.at(win_pnl,     cols[win_m],  pnls[win_m])
            np.add.at(loss_pnl,    cols[loss_m], pnls[loss_m])
            np.add.at(win_ret_sum, cols[win_m],  rets[win_m])
            np.add.at(loss_ret_sum,cols[loss_m], rets[loss_m])
            # long vs short — direction: 0=Long, 1=Short
            dir_col = 'direction'
            if dir_col in (rec.columns if hasattr(rec, 'columns') else rec.dtype.names):
                dirs = np.asarray(rec[dir_col], dtype=int)
                np.add.at(long_tr,  cols[dirs == 0], 1)
                np.add.at(short_tr, cols[dirs == 1], 1)
    except Exception:
        pass

    losses = n_trades - wins
    with np.errstate(divide='ignore', invalid='ignore'):
        win_rate     = np.where(n_trades > 0, wins  / n_trades  * 100.0, 0.0)
        profit_fct   = np.where(loss_pnl < 0, win_pnl / np.abs(loss_pnl), 0.0)
        avg_win_pct  = np.where(wins   > 0, win_ret_sum  / wins   * 100.0, 0.0)
        avg_loss_pct = np.where(losses > 0, loss_ret_sum / losses * 100.0, 0.0)
        expectancy   = (win_rate / 100.0) * avg_win_pct + (1 - win_rate / 100.0) * avg_loss_pct

    # Substituir NaN/Inf por 0.0 para garantir JSON válido no Discord
    def _clean(a): return np.nan_to_num(np.asarray(a, dtype=np.float64).flatten(),
                                         nan=0.0, posinf=0.0, neginf=0.0)

    def _pad(arr):
        a = _clean(arr)
        return np.full(nc, a[0]) if len(a) == 1 and nc > 1 else a

    return {
        'total_ret':   _pad(total_ret) * 100.0,
        'max_dd':      _pad(max_dd)    * 100.0,
        'sharpe':      _pad(sharpe),
        'n_trades':    n_trades   if len(n_trades)   == nc else np.zeros(nc, dtype=int),
        'win_rate':    win_rate   if len(win_rate)   == nc else np.zeros(nc),
        'profit_fct':  _clean(profit_fct)   if len(profit_fct)   == nc else np.zeros(nc),
        'avg_win_pct': _clean(avg_win_pct)  if len(avg_win_pct)  == nc else np.zeros(nc),
        'avg_loss_pct':_clean(avg_loss_pct) if len(avg_loss_pct) == nc else np.zeros(nc),
        'expectancy':  _clean(expectancy)   if len(expectancy)   == nc else np.zeros(nc),
        'long_trades': long_tr  if len(long_tr)  == nc else np.zeros(nc, dtype=int),
        'short_trades':short_tr if len(short_tr) == nc else np.zeros(nc, dtype=int),
    }


def _score_metric(metrics: dict, best_by: str) -> np.ndarray:
    """
    Converte uma métrica para score (maior = melhor) para escolher a melhor
    combinação dentro de uma moeda.
    """
    if best_by in ('return_pct', 'total_ret'):
        return np.asarray(metrics.get('total_ret', []), dtype=np.float64)
    if best_by == 'profit_fct':
        return np.asarray(metrics.get('profit_fct', []), dtype=np.float64)
    if best_by == 'win_rate':
        return np.asarray(metrics.get('win_rate', []), dtype=np.float64)
    if best_by == 'sharpe':
        return np.asarray(metrics.get('sharpe', []), dtype=np.float64)
    if best_by == 'expectancy':
        return np.asarray(metrics.get('expectancy', []), dtype=np.float64)
    if best_by == 'trades':
        return np.asarray(metrics.get('n_trades', []), dtype=np.float64)
    if best_by == 'max_dd':
        # melhor = menor drawdown absoluto
        return -np.abs(np.asarray(metrics.get('max_dd', []), dtype=np.float64))
    return np.asarray(metrics.get('total_ret', []), dtype=np.float64)


def _result_score(result: dict, best_by: str) -> float:
    """Score (maior=melhor) para comparar resultados entre ind_params na mesma moeda."""
    if best_by == 'max_dd':
        return -abs(float(result.get('max_dd', 0.0)))
    if best_by == 'trades':
        return float(result.get('trades', 0))
    if best_by == 'return_pct':
        return float(result.get('return_pct', -np.inf))
    return float(result.get(best_by, -np.inf))


def ccxt_timeframe_to_vbt_freq(timeframe: str) -> str:
    """Frequência vectorbt alinhada ao timeframe CCXT (fetch_ohlcv)."""
    m = {
        '1m': '1min', '3m': '3min', '5m': '5min', '15m': '15min', '30m': '30min',
        '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h',
        '1d': '1d', '1w': '1w',
    }
    return m.get(timeframe, '5min')


def _vbt_result_row(
    metrics: dict,
    col_i: int,
    symbol: str,
    ind_params: dict,
    thr_list: list[dict],
    n_valid: int,
) -> dict:
    def _f(key):
        return round(float(metrics[key][col_i]), 2)

    return {
        'symbol':       symbol,
        'base':         symbol.split('/')[0],
        'return_pct':   _f('total_ret'),
        'win_rate':     round(float(metrics['win_rate'][col_i]), 1),
        'trades':       int(metrics['n_trades'][col_i]),
        'long_trades':  int(metrics['long_trades'][col_i]),
        'short_trades': int(metrics['short_trades'][col_i]),
        'max_dd':       _f('max_dd'),
        'sharpe':       _f('sharpe'),
        'profit_fct':   _f('profit_fct'),
        'avg_win_pct':  _f('avg_win_pct'),
        'avg_loss_pct': _f('avg_loss_pct'),
        'expectancy':   _f('expectancy'),
        'best_params':  {**ind_params, **thr_list[col_i]},
        'n_valid':      int(n_valid),
        'vbt_col':      int(col_i),
    }


def _include_chart_overlay() -> bool:
    v = os.environ.get('BACKTEST_INCLUDE_CHART_OVERLAY', '1').strip().lower()
    return v not in ('0', 'false', 'no', 'off')


def _downsample_equity(times: list[int], values: list[float], max_points: int) -> tuple[list[int], list[float]]:
    n = len(times)
    if n <= max_points or n < 2:
        return times, values
    step = max(1, n // max_points)
    t2 = [times[i] for i in range(0, n, step)]
    v2 = [values[i] for i in range(0, n, step)]
    if t2[-1] != times[-1]:
        t2.append(times[-1])
        v2.append(values[-1])
    return t2, v2


def _bar_unix_t(df: pd.DataFrame, i: int) -> int:
    ts = df.index[i]
    if hasattr(ts, 'timestamp'):
        return int(ts.timestamp())
    return int(pd.Timestamp(ts).timestamp())


def trade_log_rows_from_pf(pf, df, col: int, max_pairs: int = 500) -> list[dict]:
    """
    Lista alinhada ao tipo ``BacktestTradeRow`` no frontend (tempos UNIX s, lado, P&L %).
    """
    out: list[dict] = []
    n = len(df.index)
    try:
        rec = pf.trades.records
        if rec is None or len(rec) == 0:
            return out
        tr = pd.DataFrame(rec)
        if "col" in tr.columns:
            tr = tr[tr["col"].astype(int) == int(col)]
        for _, trw in tr.iterrows():
            if len(out) >= max_pairs:
                break
            ei = xi = None
            for k in ("entry_idx", "Entry Index", "entry_index"):
                if k in trw.index and trw[k] is not None and not (
                    isinstance(trw[k], float) and np.isnan(trw[k])
                ):
                    try:
                        ei = int(trw[k])
                        break
                    except Exception:
                        pass
            for k in ("exit_idx", "Exit Index", "exit_index"):
                if k in trw.index and trw[k] is not None and not (
                    isinstance(trw[k], float) and np.isnan(trw[k])
                ):
                    try:
                        xi = int(trw[k])
                        break
                    except Exception:
                        pass
            if ei is None or xi is None:
                continue
            if not (0 <= ei < n and 0 <= xi < n):
                continue
            direction = 0
            for k in ("direction", "Direction"):
                if k in trw.index:
                    try:
                        direction = int(trw[k])
                        break
                    except Exception:
                        pass
            ret = 0.0
            for k in ("return", "Return"):
                if k in trw.index:
                    try:
                        ret = float(trw[k])
                        break
                    except Exception:
                        pass
            out.append(
                {
                    "entryTime": _bar_unix_t(df, ei),
                    "exitTime": _bar_unix_t(df, xi),
                    "side": "short" if direction == 1 else "long",
                    "pnl_pct": ret * 100.0,
                }
            )
    except Exception:
        pass
    return out


def chart_overlay_from_pf(
    pf,
    df,
    col: int,
    *,
    ignore_overlay_env: bool = False,
    max_equity_points: int = 2500,
) -> dict | None:
    """
    Dados para o gráfico (Lightweight Charts): marcadores de entrada/saída + curva de equity.
    """
    if not ignore_overlay_env and not _include_chart_overlay():
        return None
    try:
        val = pf.value()
    except Exception:
        return None
    if val is None:
        return None
    arr = np.asarray(val, dtype=np.float64)
    if arr.ndim == 2:
        eq_s = arr[:, int(col)]
    else:
        eq_s = np.asarray(arr, dtype=np.float64).ravel()
    n = len(df.index)
    if len(eq_s) < n:
        eq_s = np.pad(eq_s, (0, n - len(eq_s)), mode='edge')[:n]
    elif len(eq_s) > n:
        eq_s = eq_s[:n]
    ts_sec = (df.index.astype(np.int64) // 10**9).to_numpy(dtype=np.int64)
    t_list = [int(x) for x in ts_sec]
    v_list = [float(x) for x in eq_s]
    cap = max(32, int(max_equity_points))
    t_list, v_list = _downsample_equity(t_list, v_list, cap)
    equity = [{'t': t, 'v': v} for t, v in zip(t_list, v_list)]

    markers: list[dict] = []
    try:
        rec = pf.trades.records
        if rec is not None and len(rec) > 0:
            tr = pd.DataFrame(rec)
            if 'col' in tr.columns:
                tr = tr[tr['col'].astype(int) == int(col)]
            max_pairs = 400
            for _, trw in tr.iterrows():
                if len(markers) >= max_pairs * 2:
                    break
                try:
                    ei = int(trw['entry_idx'])
                    xi = int(trw['exit_idx'])
                except Exception:
                    continue
                if 'direction' in trw.index:
                    is_short = int(trw['direction']) == 1
                else:
                    is_short = False
                if 0 <= ei < n:
                    te = _bar_unix_t(df, ei)
                    if is_short:
                        markers.append(
                            {
                                'time': te,
                                'position': 'aboveBar',
                                'color': '#f87171',
                                'shape': 'arrowDown',
                                'text': 'S',
                            }
                        )
                    else:
                        markers.append(
                            {
                                'time': te,
                                'position': 'belowBar',
                                'color': '#4ade80',
                                'shape': 'arrowUp',
                                'text': 'B',
                            }
                        )
                if 0 <= xi < n:
                    tx = _bar_unix_t(df, xi)
                    # Sair: âmbar — distingue de entradas (verde/vermelho) no gráfico
                    if is_short:
                        markers.append(
                            {
                                'time': tx,
                                'position': 'belowBar',
                                'color': '#f59e0b',
                                'shape': 'arrowUp',
                                'text': 'C',
                            }
                        )
                    else:
                        markers.append(
                            {
                                'time': tx,
                                'position': 'aboveBar',
                                'color': '#f59e0b',
                                'shape': 'arrowDown',
                                'text': 'S',
                            }
                        )
    except Exception:
        pass

    ic = None
    try:
        ic = float(getattr(pf, 'init_cash', TOTAL_CASH_TEST))
    except Exception:
        ic = float(TOTAL_CASH_TEST)

    return {
        'markers': markers,
        'equity': equity,
        'initial_cash': ic,
    }


def export_pf_trial_curves(
    pf,
    df,
    thr_list: list[dict],
    ind_params: dict,
    symbol: str,
    *,
    best_by: str,
    max_trials: int,
    max_equity_points: int = 400,
    ignore_overlay_env: bool = True,
    trial_index_offset: int = 0,
) -> list[dict]:
    """
    Exporta curvas de equity e métricas por coluna do portfolio (cada threshold / teste).
    Só inclui colunas com ``n_trades >= MIN_TRADES``, ordenadas por ``best_by``.
    """
    nc = len(thr_list)
    if nc < 1:
        return []
    metrics = _extract_vbt_metrics(pf, nc)
    valid_mask = metrics['n_trades'] >= MIN_TRADES
    if not valid_mask.any():
        return []

    scores = _score_metric(metrics, best_by)
    if len(scores) != nc:
        scores = np.full(nc, -np.inf)
    scores_masked = np.where(valid_mask, scores, -np.inf)
    order = np.argsort(-scores_masked)
    n_valid = int(valid_mask.sum())
    out: list[dict] = []
    cap = max(1, int(max_trials))

    for j in order:
        if len(out) >= cap:
            break
        i = int(j)
        if not np.isfinite(scores_masked[i]) or scores_masked[i] <= -np.inf:
            continue

        row = _vbt_result_row(metrics, i, symbol, ind_params, thr_list, n_valid)
        ov = chart_overlay_from_pf(
            pf,
            df,
            i,
            ignore_overlay_env=ignore_overlay_env,
            max_equity_points=max_equity_points,
        )
        equity = ov.get('equity') if isinstance(ov, dict) else None
        out.append({
            'trial_index': trial_index_offset + len(out),
            'return_pct': row['return_pct'],
            'win_rate': row['win_rate'],
            'trades': row['trades'],
            'max_dd': row['max_dd'],
            'sharpe': row['sharpe'],
            'profit_fct': row['profit_fct'],
            'expectancy': row['expectancy'],
            'best_params': row['best_params'],
            'equity': equity if isinstance(equity, list) else [],
        })
    return out


def _vbt_exec_portfolio_kwargs(
    exec_fee_pct_per_fill: float = 0.0,
    exec_slippage_pct: float = 0.0,
    exec_half_spread_pct: float = 0.0,
) -> dict:
    """
    Map UI/job percentages to vectorbt ``Portfolio.from_signals`` kwargs.
    Effective slippage fraction = (slippage_pct + half_spread_pct) / 100 (merged for vectorbt).
    """
    fee_frac = max(0.0, float(exec_fee_pct_per_fill)) / 100.0
    slip_frac = max(0.0, float(exec_slippage_pct) + float(exec_half_spread_pct)) / 100.0
    kw: dict = {}
    if fee_frac > 0:
        kw['fees'] = fee_frac
    if slip_frac > 0:
        kw['slippage'] = slip_frac
    return kw


def run_vbt_backtest_topk(
    df: pd.DataFrame,
    symbol: str,
    ind_params: dict,
    thr_list: list[dict],
    signal_fn,
    compute_indicators_fn,
    best_by: str = 'return_pct',
    freq: str | None = None,
    top_k: int = 3,
    *,
    pf_sink: list | None = None,
    ignore_overlay_env: bool = False,
    include_chart_overlay: bool = True,
    exec_fee_pct_per_fill: float = 0.0,
    exec_slippage_pct: float = 0.0,
    exec_half_spread_pct: float = 0.0,
) -> list[dict]:
    """
    Igual a ``run_vbt_backtest`` mas devolve até ``top_k`` combinações válidas
    (por ``best_by``), sem repetir o custo de um Portfolio por candidato.
    """
    ind = compute_indicators_fn(df, ind_params)
    if ind is None:
        return []

    nc = len(thr_list)

    if nc == 1:
        le, lx, se, sx, sl_arr, tp_arr = signal_fn(ind, thr_list)
        le = le[:, 0]
        lx = lx[:, 0]
        se = se[:, 0]
        sx = sx[:, 0]
        sl_stop = float(sl_arr[0])
        tp_stop = float(tp_arr[0])
    else:
        le, lx, se, sx, sl_arr, tp_arr = signal_fn(ind, thr_list)
        le = pd.DataFrame(le, index=df.index, columns=range(nc))
        lx = pd.DataFrame(lx, index=df.index, columns=range(nc))
        se = pd.DataFrame(se, index=df.index, columns=range(nc))
        sx = pd.DataFrame(sx, index=df.index, columns=range(nc))
        sl_stop = sl_arr if len(np.unique(sl_arr)) > 1 else float(sl_arr[0])
        tp_stop = tp_arr if len(np.unique(tp_arr)) > 1 else float(tp_arr[0])

    _freq = freq if freq is not None else '1min'
    exec_kw = _vbt_exec_portfolio_kwargs(
        exec_fee_pct_per_fill,
        exec_slippage_pct,
        exec_half_spread_pct,
    )
    try:
        pf = vbt.Portfolio.from_signals(
            close               = df['Close'],
            entries             = le,
            exits               = lx,
            short_entries       = se,
            short_exits         = sx,
            sl_stop             = sl_stop,
            tp_stop             = tp_stop,
            init_cash           = float(TOTAL_CASH_TEST),
            freq                = _freq,
            upon_opposite_entry = 'close',
            **exec_kw,
        )
    except Exception as e:
        print(f"  ⚠️ vbt.Portfolio falhou: {e}")
        return []

    if pf_sink is not None:
        pf_sink.append(pf)

    metrics = _extract_vbt_metrics(pf, nc)

    valid_mask = metrics['n_trades'] >= MIN_TRADES
    if not valid_mask.any():
        return []

    scores = _score_metric(metrics, best_by)
    if len(scores) != nc:
        scores = np.full(nc, -np.inf)
    scores_masked = np.where(valid_mask, scores, -np.inf)
    order = np.argsort(-scores_masked)
    k = max(1, int(top_k))
    n_valid = int(valid_mask.sum())
    rows: list[dict] = []
    for j in order:
        i = int(j)
        if len(rows) >= k:
            break
        s = scores_masked[i]
        if not np.isfinite(s) or s <= -np.inf:
            continue
        row = _vbt_result_row(metrics, i, symbol, ind_params, thr_list, n_valid)
        if include_chart_overlay:
            try:
                ov = chart_overlay_from_pf(pf, df, i, ignore_overlay_env=ignore_overlay_env)
            except Exception:
                ov = None
            if ov is not None:
                row['chart_overlay'] = ov
        row['exec_fee_pct_per_fill'] = round(float(exec_fee_pct_per_fill), 6)
        row['exec_slippage_pct'] = round(float(exec_slippage_pct), 6)
        row['exec_half_spread_pct'] = round(float(exec_half_spread_pct), 6)
        rows.append(row)
    return rows


def run_vbt_backtest(
    df: pd.DataFrame,
    symbol: str,
    ind_params: dict,
    thr_list: list[dict],
    signal_fn,
    compute_indicators_fn,
    best_by: str = 'return_pct',
    freq: str | None = None,
    *,
    exec_fee_pct_per_fill: float = 0.0,
    exec_slippage_pct: float = 0.0,
    exec_half_spread_pct: float = 0.0,
) -> dict | None:
    """
    Para um único conjunto de ind_params e todos os thr_list (vectorizado):
      1. Calcula indicadores
      2. Gera matriz de sinais 2D
      3. Corre vbt.Portfolio com N colunas
      4. Devolve o melhor resultado

    ``freq``: frequência pandas/vectorbt (ex. ``5min``, ``1h``). None = ``1min`` (legado).
    """
    rows = run_vbt_backtest_topk(
        df,
        symbol,
        ind_params,
        thr_list,
        signal_fn,
        compute_indicators_fn,
        best_by=best_by,
        freq=freq,
        top_k=1,
        exec_fee_pct_per_fill=exec_fee_pct_per_fill,
        exec_slippage_pct=exec_slippage_pct,
        exec_half_spread_pct=exec_half_spread_pct,
    )
    return rows[0] if rows else None


# ═══════════════════════════════════════════════════════════════════════════════
#  BINANCE — fetch symbols e OHLCV
# ═══════════════════════════════════════════════════════════════════════════════

def get_exchange():
    return ccxt.binance({
        'enableRateLimit': True,
        'rateLimit': 150,
        'options': {'defaultType': 'future'},
    })


def fetch_usdc_futures_symbols(exchange) -> list[str]:
    markets = exchange.load_markets()
    return sorted(
        s for s, m in markets.items()
        if m.get('quote') == 'USDC'
        and m.get('type') in ('swap', 'future')
        and m.get('active', True)
    )


def download_ohlcv(exchange, symbol: str, timeframe: str, days: int) -> pd.DataFrame | None:
    since_ms = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp() * 1000)
    rows, limit = [], 1000
    while True:
        try:
            candles = exchange.fetch_ohlcv(symbol, timeframe, since=since_ms, limit=limit)
        except Exception as e:
            print(f"  ⚠️ {e}")
            return None
        if not candles:
            break
        rows.extend(candles)
        since_ms = candles[-1][0] + 1
        if len(candles) < limit:
            break
        time.sleep(0.15)

    if len(rows) < MIN_CANDLES:
        return None

    df = pd.DataFrame(rows, columns=['timestamp', 'Open', 'High', 'Low', 'Close', 'Volume'])
    df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
    df.set_index('timestamp', inplace=True)
    return df.astype(float).dropna()


# ═══════════════════════════════════════════════════════════════════════════════
#  DISCORD
# ═══════════════════════════════════════════════════════════════════════════════

def _get_webhook() -> str:
    try:
        from traders_py.configs.discords_alerts import get_discord_webhook
        return get_discord_webhook('monthly_scanner')
    except Exception:
        return ''


def send_discord(results: list[dict], strategy_name: str, timeframe: str,
                 days: int, total_tested: int, optimized: bool = False,
                 opt_param_names: list[str] | None = None):
    webhook = _get_webhook()
    if not webhook:
        print("⚠️ Webhook não encontrado — a saltar Discord.")
        return

    # Mostrar apenas os parâmetros marcados com optimize=True na estratégia
    DISCORD_PARAMS = opt_param_names or []

    medals = ['🥇', '🥈', '🥉'] + ['🏅'] * 7
    lines  = []
    for i, r in enumerate(results):
        sign  = '+' if r['return_pct'] >= 0 else ''
        color = '🟢' if r['return_pct'] >= 0 else '🔴'
        aw    = f"+{r['avg_win_pct']:.2f}" if r.get('avg_win_pct', 0) >= 0 else f"{r['avg_win_pct']:.2f}"
        al    = f"{r.get('avg_loss_pct', 0.0):.2f}"
        ex    = r.get('expectancy', 0.0)
        ex_s  = f"+{ex:.2f}" if ex >= 0 else f"{ex:.2f}"

        # Linha 1 — métricas principais
        line = (
            f"{medals[i]} **{r['base']}**  "
            f"{color} `{sign}{r['return_pct']}%`  "
            f"WR `{r['win_rate']}%`  T `{r['trades']}`  "
            f"DD `{r['max_dd']}%`  PF `{r['profit_fct']:.2f}`"
        )
        # Linha 2 — métricas secundárias
        line += (
            f"\n　　↳ Sharpe `{r['sharpe']}`  "
            f"L `{r.get('long_trades',0)}`  S `{r.get('short_trades',0)}`  "
            f"AvgW `{aw}%`  AvgL `{al}%`  Exp `{ex_s}%`"
        )
        # Linha 3 — parâmetros usados
        bp = r.get('best_params') or {}
        if bp:
            p_str = '  '.join(f"{k}=`{bp[k]}`" for k in DISCORD_PARAMS if k in bp)
            if p_str:
                line += f"\n　　↳ {p_str}"
        lines.append(line)

    opt_label = "  |  ⚡ **vectorbt** 🔬 **Optimizado**" if optimized else "  |  ⚡ **vectorbt**"
    desc = (
        f"**Estratégia:** `{strategy_name}`  |  **TF:** `{timeframe}`  |  "
        f"**Período:** últimos {days} dias{opt_label}\n"
        f"**Pares testados:** {total_tested}  |  **Com trades:** {len(results)}\n\n"
        + "\n".join(lines)
    )
    message = {
        "embeds": [{
            "title":       f"⚡ Scanner vbt — Top {len(results)} USDC Futures",
            "description": desc,
            "color":       10181046,
            "footer":      {"text": f"vectorbt • {datetime.now().strftime('%Y-%m-%d %H:%M')} UTC"},
        }]
    }
    try:
        resp = requests.post(webhook, json=message, timeout=10)
        if resp.status_code == 204:
            print("✅ Discord enviado.")
        else:
            print(f"⚠️ Discord HTTP {resp.status_code}: {resp.text[:500]}")
    except Exception as e:
        print(f"⚠️ Erro ao enviar Discord: {e}")


# ═══════════════════════════════════════════════════════════════════════════════
#  FILTRO DE RESULTADOS
# ═══════════════════════════════════════════════════════════════════════════════

def filter_results(results: list[dict],
                   min_win_rate:   float = 0.0,
                   min_expectancy: float = 0.0,
                   min_pf:         float = 0.0,
                   min_sharpe:     float = 0.0,
                   max_dd:         float = 100.0) -> list[dict]:
    """
    Filtra resultados pelos critérios definidos (todos os critérios devem ser cumpridos).
    max_dd é o drawdown máximo permitido em valor absoluto (ex: 10 = máximo -10%).
    """
    filtered = []
    for r in results:
        if r['win_rate']   < min_win_rate:   continue
        if r['expectancy'] < min_expectancy: continue
        if r['profit_fct'] < min_pf:         continue
        if r['sharpe']     < min_sharpe:     continue
        if abs(r['max_dd']) > max_dd:        continue
        filtered.append(r)
    return filtered


# ═══════════════════════════════════════════════════════════════════════════════
#  GERAÇÃO AUTOMÁTICA DE FICHEIROS DE TRADER
# ═══════════════════════════════════════════════════════════════════════════════

# Marcadores que delimitam o bloco de parâmetros nos ficheiros gerados
_PARAMS_START = '# ── PARAMS_START ──'
_PARAMS_END   = '# ── PARAMS_END ──'

# Template completo para um trader file auto-gerado
_TRADER_TEMPLATE = '''\
# ═══════════════════════════════════════════════════════════════════
# AUTO-GENERATED by monthly_scanner_vbt.py — NÃO EDITAR MANUALMENTE
# Symbol     : {symbol}
# Gerado em  : {date}
# Scanner    : Retorno {return_pct:+.2f}%  WR {win_rate:.1f}%  Sharpe {sharpe:.2f}  PF {profit_fct:.2f}
#              DD {max_dd:.2f}%  Expectancy {expectancy:+.3f}%/trade
#              Trades {trades} (L:{long_trades} S:{short_trades})
# ═══════════════════════════════════════════════════════════════════
import pandas as pd
import numpy as np
from configs.get_info_account import *
from configs.get_candles import *
from configs.Actions_trading import *
from configs.Sync_time import *
from configs.loop import *
from configs.Custom_indicators import *
from configs.bot_main import TradingBot

{params_block}


def indicators(df):
    df[\'atr\']     = ma_function(true_range(df[\'high\'], df[\'low\'], df[\'close\']), ATR_WMA_LENGTH, "WMA").round(4)
    df[\'atr_pct\'] = (df[\'atr\'] / df[\'close\'] * 100).round(6)

    df[\'ema_fast\'] = df[\'close\'].ewm(span=EMA_FAST_SPAN, min_periods=EMA_FAST_SPAN, adjust=False).mean()
    df[\'ema\']      = df[\'close\'].ewm(span=EMA_SPAN,      min_periods=EMA_SPAN,      adjust=False).mean()
    df[\'ema_slow\'] = df[\'close\'].ewm(span=EMA_SLOW_SPAN, min_periods=EMA_SLOW_SPAN, adjust=False).mean()

    df[\'vwap_close\'] = vwap_close_daily(df, df[\'close\'], df[\'volume\'])
    df[\'RSI_VWAP\']   = rsi(df[\'vwap_close\'], 1)
    df[\'rsi\']        = pd.Series(rsi(df[\'close\'], RSI_LENGTH), index=df.index).round(4)

    df[\'cumVol\']  = df[\'volume\'].fillna(0).cumsum()
    obv_raw        = np.sign(df[\'close\'].diff().fillna(0)) * df[\'volume\'].fillna(0)
    df[\'obv\']     = obv_raw.cumsum()
    df[\'dif_obv\'] = df[\'obv\'] - df[\'obv\'].shift(1)
    df[\'vol_sma\'] = df[\'volume\'].rolling(window=VOL_SMA_LEN, min_periods=1).mean()
    df[\'dif_obv_norm\'] = (df[\'dif_obv\'] / df[\'vol_sma\'].replace(0, np.nan)).round(6)

    df[\'dif_ema\']  = (df[\'ema_fast\'] - df[\'ema_fast\'].shift(DIF_EMA_SHIFT)).round(4)
    df[\'dif_ema2\'] = (df[\'ema\']      - df[\'ema\'].shift(DIF_EMA_SHIFT)).round(4)
    df[\'dif_ema3\'] = (df[\'ema_slow\'] - df[\'ema_slow\'].shift(DIF_EMA_SHIFT)).round(4)
    df[\'dif_pct\']  = (df[\'dif_ema\']  / df[\'ema_fast\'].replace(0, np.nan) * 100).round(6)
    df[\'dif_pct2\'] = (df[\'dif_ema2\'] / df[\'ema\'].replace(0, np.nan)      * 100).round(6)

    di_plus, di_minus, adx = adx_indicator(df, ADX_LENGTH)
    df[\'DIPlus\']  = di_plus.round(4)
    df[\'DIMinus\'] = di_minus.round(4)
    df[\'ADX\']     = adx.round(4)
    df[\'dif_ADX\'] = (df[\'ADX\'] - df[\'ADX\'].shift(5)).round(4)

    upper_6, lower_6 = calc_envelope_fibonacci(df, ENVELOPE_LEN, ENVELOPE_MULT)
    df[\'upper_6\'] = upper_6.round(4)
    df[\'lower_6\'] = lower_6.round(4)
    return df


def strategy(self, df):
    get_current_position(self)
    print(f"POSITION: {{self.position}}")
    df = indicators(df)

    current_atr_pct      = df[\'atr_pct\'].iloc[-1]
    current_dif_pct      = df[\'dif_pct\'].iloc[-1]
    current_dif_pct2     = df[\'dif_pct2\'].iloc[-1]
    current_dif_obv_norm = df[\'dif_obv_norm\'].iloc[-1]
    current_rsi_vwap     = df[\'RSI_VWAP\'].iloc[-1]
    current_rsi          = df[\'rsi\'].iloc[-1]
    current_upper_6      = df[\'upper_6\'].iloc[-1]
    current_lower_6      = df[\'lower_6\'].iloc[-1]
    current_close        = df[\'close\'].iloc[-1]

    if self.wait_candle > 0:
        self.wait_candle -= 1

    ema2_is_flat = abs(float(current_dif_pct2)) <= FLAT_EMA2_PCT
    if self.position is not None:
        self.flat_ema2_count = self.flat_ema2_count + 1 if ema2_is_flat else 0
    else:
        self.flat_ema2_count = 0

    filter_trend = (
        current_upper_6      > current_close
        and current_lower_6  < current_close
        and current_atr_pct  < ATR_PCT_MAX
        and current_dif_pct  <=  DIF_PCT_ABS_MAX
        and current_dif_pct  >= -DIF_PCT_ABS_MAX
        and pd.notna(current_dif_obv_norm)
        and float(current_dif_obv_norm) <  DIF_OBV_NORM_MAX
        and float(current_dif_obv_norm) > -DIF_OBV_NORM_MAX
    )

    get_out = (current_lower_6 > current_close or current_upper_6 < current_close) and (not filter_trend)
    if self.position is not None:
        self.get_out_count = self.get_out_count + 1 if get_out else 0
    else:
        self.get_out_count = 0

    print(f"ATR_PCT: {{current_atr_pct:.4f}}  DIF_PCT: {{current_dif_pct:.4f}}  OBV_NORM: {{current_dif_obv_norm:.4f}}")
    print(f"FILTER: {{filter_trend}}  RSI: {{current_rsi:.2f}}  RSI_VWAP: {{current_rsi_vwap:.2f}}")

    longCondition  = filter_trend and current_rsi < RSI_OVER_SOLD  and current_rsi_vwap < RSI_VWAP_OS
    shortCondition = filter_trend and current_rsi > RSI_OVER_BOUGHT and current_rsi_vwap > RSI_VWAP_OB

    print(f"LONG: {{longCondition}}  SHORT: {{shortCondition}}  buyed: {{self.buyed}}")

    signal_result = None
    exit_long  = current_rsi > 50
    exit_short = current_rsi < 50

    if longCondition and (self.position == \'short\' or self.position is None):
        return \'long\'
    if shortCondition and (self.position == \'long\' or self.position is None):
        return \'short\'
    if self.position is not None and self.flat_ema2_count >= FLAT_EMA2_BARS and self.buyed:
        self.wait_candle = 5
        print(f"Saida EMA2 flat (>={{FLAT_EMA2_BARS}} candles)")
        return \'sell\'
    if self.position is not None and self.get_out_count >= GET_OUT_BARS and self.buyed:
        self.wait_candle = 10
        print(f"Saida get_out (>={{GET_OUT_BARS}} candles)")
        return \'sell\'
    if self.position == \'long\'  and exit_long  and self.buyed: return \'sell\'
    if self.position == \'short\' and exit_short and self.buyed: return \'sell\'
    return signal_result


if __name__ == "__main__":
    bot = TradingBot(
        api_key    = \'{api_key}\',
        api_secret = \'{api_secret}\',
        symbol     = \'{symbol}\',
        timeframe  = \'{timeframe}\',
        leverage   = {leverage},
        sl_percent = SL_PCT,
        tp_percent = TP_PCT,
        buyed      = False,
        strategy_name = \'{strategy_name}\',
        type_strategy = \'trend\',
    )
    bot.wait_candle     = 0
    bot.flat_ema2_count = 0
    bot.get_out_count   = 0
    run(bot)
'''

# Mapeamento: nome do parâmetro do scanner → nome da constante no trader file
_PARAM_CONST = {
    'atr_wma_length':       'ATR_WMA_LENGTH',
    'ema_fast_span':        'EMA_FAST_SPAN',
    'ema_span':             'EMA_SPAN',
    'ema_slow_span':        'EMA_SLOW_SPAN',
    'dif_ema_shift':        'DIF_EMA_SHIFT',
    'rsi_close_length':     'RSI_LENGTH',
    'adx_length':           'ADX_LENGTH',
    'envelope_length':      'ENVELOPE_LEN',
    'envelope_mult':        'ENVELOPE_MULT',
    'vol_sma_length':       'VOL_SMA_LEN',
    'atr_pct_max':          'ATR_PCT_MAX',
    'dif_pct_abs_max':      'DIF_PCT_ABS_MAX',
    'dif_obv_norm_max':     'DIF_OBV_NORM_MAX',
    'flat_ema2_pct_max':    'FLAT_EMA2_PCT',
    'flat_ema2_exit_bars':  'FLAT_EMA2_BARS',
    'get_out_exit_bars':    'GET_OUT_BARS',
    'rsi_over_sold':        'RSI_OVER_SOLD',
    'rsi_over_bought':      'RSI_OVER_BOUGHT',
    'rsi_vwap_over_sold':   'RSI_VWAP_OS',
    'rsi_vwap_over_bought': 'RSI_VWAP_OB',
    'tp_pct':               'TP_PCT',
    'sl_pct':               'SL_PCT',
}


def _read_api_credentials() -> tuple[str, str]:
    """Tenta ler as credenciais de um trader file existente."""
    # import re
    # trader_dir = os.path.join(ROOT, 'traders_py')
    # for fname in sorted(os.listdir(trader_dir)):
    #     if fname.startswith('trader_') and fname.endswith('.py'):
    #         try:
    #             content = open(os.path.join(trader_dir, fname), encoding='utf-8').read()
    #             km = re.search(r"api_key\s*=\s*'([^']{10,})'", content)
    #             sm = re.search(r"api_secret\s*=\s*'([^']{10,})'", content)
    #             if km and sm:
    #                 return km.group(1), sm.group(1)
    #         except Exception:
    #             pass
    return 'jIFrSBMR8rgFTp2zeIadPvMHXeuL9o6z075OhuGkIYr8lGg1tNCix36pSOC3rfDL', 'JcG8eT9n9knHSsUKDkxsoRh3mfXIuFhjXkDsjmntnop6cktHOIBjE6HN3yalqQc6'


def _build_params_block(bp: dict, param_specs: dict, opt_names: list[str]) -> str:
    """Gera o bloco de constantes de parâmetros para o trader file."""
    lines = [_PARAMS_START,
             '# Parâmetros da estratégia — gerados pelo scanner (optimize=True = optimizado)']
    for pname, const in _PARAM_CONST.items():
        if pname not in bp:
            continue
        val    = bp[pname]
        tag    = '← optimizado' if pname in opt_names else 'default'
        lines.append(f'{const:<20} = {val!r:<10}  # {tag}')
    lines.append(_PARAMS_END)
    return '\n'.join(lines)


def generate_trader_file(result: dict, param_specs: dict, opt_names: list[str],
                         output_dir: str, timeframe: str, leverage: int = 5) -> str:
    """
    Cria ou actualiza o ficheiro de trader para um resultado do scanner.
    Se o ficheiro já existe, apenas actualiza o bloco de parâmetros.
    Devolve o caminho do ficheiro criado/actualizado.
    """
    # Nome do ficheiro: auto_TRUMP_USDC_3m.py
    base  = result['symbol'].split('/')[0]
    quote = result['symbol'].split('/')[1].split(':')[0]
    tf    = timeframe.replace('m', 'min').replace('h', 'h')
    fname = f"auto_{base}_{quote}_{tf}.py"
    fpath = os.path.join(output_dir, fname)

    bp         = result.get('best_params', {})
    params_blk = _build_params_block(bp, param_specs, opt_names)

    if os.path.exists(fpath):
        # Actualizar apenas o bloco de parâmetros
        content = open(fpath, encoding='utf-8').read()
        import re
        pattern = re.compile(
            re.escape(_PARAMS_START) + r'.*?' + re.escape(_PARAMS_END),
            re.DOTALL,
        )
        if pattern.search(content):
            new_content = pattern.sub(params_blk, content)
            # Actualizar também o cabeçalho de estatísticas
            header_pattern = re.compile(r'# Scanner    :.*?(?=\n# ═)', re.DOTALL)
            new_header = (
                f"# Scanner    : Retorno {result['return_pct']:+.2f}%  "
                f"WR {result['win_rate']:.1f}%  Sharpe {result['sharpe']:.2f}  "
                f"PF {result['profit_fct']:.2f}\n"
                f"#              DD {result['max_dd']:.2f}%  "
                f"Expectancy {result['expectancy']:+.3f}%/trade\n"
                f"#              Trades {result['trades']} "
                f"(L:{result['long_trades']} S:{result['short_trades']})"
            )
            new_content = header_pattern.sub(new_header, new_content)
            open(fpath, 'w', encoding='utf-8').write(new_content)
            return fpath + '  [ACTUALIZADO]'

    # Criar ficheiro novo a partir do template
    api_key, api_secret = _read_api_credentials()
    strategy_name       = fname.replace('.py', '')
    content = _TRADER_TEMPLATE.format(
        symbol       = result['symbol'],
        date         = datetime.now().strftime('%Y-%m-%d %H:%M'),
        return_pct   = result['return_pct'],
        win_rate     = result['win_rate'],
        sharpe       = result['sharpe'],
        profit_fct   = result['profit_fct'],
        max_dd       = result['max_dd'],
        expectancy   = result['expectancy'],
        trades       = result['trades'],
        long_trades  = result['long_trades'],
        short_trades = result['short_trades'],
        params_block = params_blk,
        api_key      = api_key,
        api_secret   = api_secret,
        timeframe    = timeframe,
        leverage     = leverage,
        strategy_name= strategy_name,
    )
    open(fpath, 'w', encoding='utf-8').write(content)
    return fpath + '  [CRIADO]'


def auto_generate_traders(filtered: list[dict], param_specs: dict, opt_names: list[str],
                           output_dir: str, timeframe: str, top_n: int = 5,
                           leverage: int = 5) -> list[str]:
    """Gera/actualiza trader files para os top_n resultados filtrados."""
    selected = filtered[:top_n]
    generated = []
    for r in selected:
        try:
            path = generate_trader_file(r, param_specs, opt_names, output_dir, timeframe, leverage)
            generated.append((r['symbol'], path))
        except Exception as e:
            print(f"  ⚠️  Erro ao gerar ficheiro para {r['symbol']}: {e}")
    return generated


# ═══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        '--strategy', default=DEFAULT_STRATEGY,
        help='Módulo *_vbt: nome curto (lateral_market_rsi), nome com _vbt, '
             'pacote completo (my_strategies.foo_vbt) ou caminho .py',
    )
    parser.add_argument('--tf',        default=DEFAULT_TIMEFRAME)
    parser.add_argument('--days',      type=int, default=DEFAULT_DAYS)
    parser.add_argument('--top',       type=int, default=DEFAULT_TOP)
    parser.add_argument('--sort-by',   default='profit_fct',
                        choices=['return_pct', 'profit_fct', 'win_rate', 'sharpe',
                                 'expectancy', 'max_dd', 'trades'],
                        help='Critério de ordenação do top (default: profit_fct)')
    parser.add_argument('--best-by',   default='return_pct',
                        choices=['return_pct', 'profit_fct', 'win_rate', 'sharpe',
                                 'expectancy', 'max_dd', 'trades'],
                        help='Critério para escolher o melhor resultado dentro de cada moeda (default: return_pct)')
    parser.add_argument('--optimize',  action='store_true', default=True,
                        help='Optimizar parâmetros (vectorbt testa todos os combos de threshold em paralelo)')
    parser.add_argument('--max-tries', type=int, default=1000,
                        help='Combinações máximas de threshold por conjunto de indicadores (default: 1000)')
    parser.add_argument('--optimize-seed', type=int, default=42,
                        help='Seed RNG para amostragem da grelha (reprodutibilidade)')
    parser.add_argument('--grid-sample', choices=('lhs', 'random'), default='lhs',
                        help='lhs = Latin Hypercube discreto (melhor cobertura); random = aleatório')
    # ── Filtros para geração automática
    parser.add_argument('--auto-top',       type=int,  default=0,
                        help='Nº de traders a gerar/actualizar automaticamente (0 = desactivado)')
    parser.add_argument('--min-win-rate',   type=float, default=0.0,
                        help='Win rate mínima %% para passar o filtro (ex: 75)')
    parser.add_argument('--min-expectancy', type=float, default=0.0,
                        help='Expectancy mínima %%/trade para passar o filtro (ex: 0.2)')
    parser.add_argument('--min-pf',         type=float, default=0.0,
                        help='Profit Factor mínimo (ex: 1.5)')
    parser.add_argument('--min-sharpe',     type=float, default=0.0,
                        help='Sharpe ratio mínimo (ex: 1.0)')
    parser.add_argument('--max-dd',         type=float, default=100.0,
                        help='Drawdown máximo permitido em %% absoluto (ex: 20)')
    parser.add_argument('--leverage',       type=int,   default=5,
                        help='Leverage para os traders gerados (default: 1)')
    args = parser.parse_args()

    print(f"\n{'═'*60}")
    print(f"⚡ Scanner vbt — {datetime.now().strftime('%Y-%m-%d %H:%M')} UTC")
    print(f"   Estratégia : {args.strategy}")
    print(f"   Timeframe  : {args.tf}")
    print(f"   Lookback   : {args.days} dias")
    print(f"   Top        : {args.top}  (ordenado por {args.sort_by})")
    print(f"   Melhor/moeda: {args.best_by}")
    opt_txt = f"Sim (max {args.max_tries} combos threshold)" if args.optimize else "Não (parâmetros default)"
    print(f"   Optimizar  : {opt_txt}")
    if args.auto_top > 0:
        print(f"   Auto-gerar : top {args.auto_top}  "
              f"(WR≥{args.min_win_rate}%  Exp≥{args.min_expectancy}%  "
              f"PF≥{args.min_pf}  Sharpe≥{args.min_sharpe}  DD≤{args.max_dd}%)")
    print(f"{'═'*60}\n")

    # 1. Carregar módulo de estratégia VBT (qualquer ficheiro / nome de módulo)
    print("📦 A carregar estratégia...")
    try:
        vbt_mod = load_strategy_vbt_module(args.strategy)
    except Exception as e:
        print(f"❌ Não foi possível carregar a estratégia '{args.strategy}': {e}")
        sys.exit(1)

    vbt_label = getattr(vbt_mod, '__name__', args.strategy)
    vbt_file  = getattr(vbt_mod, '__file__', '?')
    print(f"   → módulo: {vbt_label}")
    print(f"   → ficheiro: {vbt_file}")

    if not hasattr(vbt_mod, 'compute_signals_vectorized'):
        print("❌ O módulo deve expor compute_signals_vectorized().")
        sys.exit(1)
    if not hasattr(vbt_mod, 'compute_indicators'):
        print("❌ O módulo deve expor compute_indicators(df, params).")
        sys.exit(1)

    signal_fn = vbt_mod.compute_signals_vectorized

    param_specs = get_strategy_param_specs(vbt_mod)
    ind_param_names = resolve_indicator_param_names(vbt_mod, param_specs)

    if not param_specs:
        print("   ⚠️  Sem get_strategy_parameters() — a usar parâmetros vazios.")
        if args.optimize:
            args.optimize = False

    # 2. Construir grids
    if args.optimize and param_specs:
        ind_list, thr_list = build_param_grids(
            param_specs,
            args.max_tries,
            ind_param_names,
            seed=args.optimize_seed,
            grid_sample=args.grid_sample,
        )
        opt_p = [n for n, (*_, do) in param_specs.items() if do]
        print(f"   → {len(opt_p)} parâmetros optimizáveis")
        print(f"   → {len(ind_list)} conjuntos indicadores × {len(thr_list)} combos threshold")
        print(f"   → {len(ind_list) * len(thr_list):,} backtests totais (threshold em paralelo)")
        print(f"   → seed={args.optimize_seed}  amostragem={args.grid_sample}\n")
    else:
        defaults = {n: v[0] for n, v in param_specs.items()} if param_specs else {}
        ind_list = [defaults]
        thr_list = [defaults]
        print(f"   → parâmetros default (sem optimização)\n")

    # 3. Buscar pares    futures
    print("📡 A buscar pares USDC futures na Binance...")
    exchange = get_exchange()
    try:
        symbols = fetch_usdc_futures_symbols(exchange)
    except Exception as e:
        print(f"❌ Erro ao listar símbolos: {e}")
        sys.exit(1)
    print(f"   → {len(symbols)} pares encontrados\n")

    # 4. Download + backtest
    results = []
    skipped = 0
    t0      = time.time()

    for i, symbol in enumerate(symbols, 1):
        prefix = f"[{i:>3}/{len(symbols)}] {symbol:<25}"
        print(prefix, end=' ', flush=True)

        df = download_ohlcv(exchange, symbol, args.tf, args.days)
        if df is None:
            print("⏭️  skip (dados insuficientes)")
            skipped += 1
            continue

        best_result = None
        for ind_params in ind_list:
            r = run_vbt_backtest(
                df,
                symbol,
                ind_params,
                thr_list,
                signal_fn,
                vbt_mod.compute_indicators,
                best_by=args.best_by,
                freq=ccxt_timeframe_to_vbt_freq(args.tf),
            )
            if r is None:
                continue
            if best_result is None or _result_score(r, args.best_by) > _result_score(best_result, args.best_by):
                best_result = r

        if best_result is None:
            print(f"⏭️  skip (trades < {MIN_TRADES})")
            skipped += 1
            continue

        results.append(best_result)
        r          = best_result
        sign       = '+' if r['return_pct'] >= 0 else ''
        valid_hint = f"  [{r['n_valid']} válidos]" if args.optimize else ''
        print(f"✓  {sign}{r['return_pct']:>7.2f}%  WR {r['win_rate']:>5.1f}%  "
              f"T={r['trades']}  DD={r['max_dd']}%  PF={r['profit_fct']:.2f}{valid_hint}")

    elapsed = time.time() - t0

    # 5. Ranking e top N
    sort_key = args.sort_by
    # Para max_dd: menor drawdown (valor negativo) é melhor → ordenar ascendente pelo valor
    if sort_key == 'max_dd':
        results.sort(key=lambda r: abs(r['max_dd']))
    else:
        results.sort(key=lambda r: r[sort_key], reverse=True)
    top = results[:args.top]

    # Parâmetros a mostrar — apenas os que têm optimize=True na estratégia
    SHOW_PARAMS = [n for n, (*_, do_opt) in param_specs.items() if do_opt] if param_specs else []

    sep = '═' * 72
    print(f"\n{sep}")
    print(f"🏆 Top {args.top} por {args.sort_by}  "
          f"(de {len(results)} com trades / {len(symbols)} testados)  [{elapsed:.0f}s]")
    print(sep)
    for j, r in enumerate(top, 1):
        sign = '+' if r['return_pct'] >= 0 else ''
        aw   = f"+{r['avg_win_pct']:.2f}" if r['avg_win_pct'] >= 0 else f"{r['avg_win_pct']:.2f}"
        al   = f"{r['avg_loss_pct']:.2f}"
        ex   = f"+{r['expectancy']:.2f}" if r['expectancy'] >= 0 else f"{r['expectancy']:.2f}"
        print(f"  {j:>2}. {r['symbol']}")
        print(f"       Retorno {sign}{r['return_pct']}%  |  WR {r['win_rate']}%  |  "
              f"Trades {r['trades']} (L:{r['long_trades']} S:{r['short_trades']})")
        print(f"       DD {r['max_dd']}%  |  Sharpe {r['sharpe']}  |  "
              f"PF {r['profit_fct']:.2f}  |  Expectancy {ex}%/trade")
        print(f"       AvgWin {aw}%  |  AvgLoss {al}%")
        # Mostrar parâmetros
        bp = r.get('best_params', {})
        if bp:
            p_str = '  '.join(f"{k}={bp[k]}" for k in SHOW_PARAMS if k in bp)
            print(f"       Params: {p_str}")
        if j < len(top):
            print()
    print(sep + '\n')

    # 6. Discord
    if top:
        send_discord(top, args.strategy, args.tf, args.days, len(symbols),
                     optimized=args.optimize, opt_param_names=SHOW_PARAMS)
    else:
        print("⚠️ Nenhum resultado com trades suficientes.")

    # 7. Filtro + geração automática de trader files
    if args.auto_top > 0 and results:
        sep2 = '─' * 72
        print(f"\n{sep2}")
        print(f"🤖 Auto-geração de traders  (top {args.auto_top})")
        print(f"   Filtros: WR≥{args.min_win_rate}%  Exp≥{args.min_expectancy}%  "
              f"PF≥{args.min_pf}  Sharpe≥{args.min_sharpe}  DD≤{args.max_dd}%")
        print(sep2)

        filtered = filter_results(
            results,
            min_win_rate   = args.min_win_rate,
            min_expectancy = args.min_expectancy,
            min_pf         = args.min_pf,
            min_sharpe     = args.min_sharpe,
            max_dd         = args.max_dd,
        )

        print(f"   {len(filtered)} moedas passaram o filtro  "
              f"(de {len(results)} com trades suficientes)")

        if not filtered:
            print("   ⚠️  Nenhuma moeda passou os critérios — "
                  "considera relaxar os limites (--min-win-rate, --min-expectancy, ...)")
        else:
            output_dir = os.path.join(ROOT, 'traders_py')

            # Apagar ficheiros auto_* existentes antes de gerar os novos
            removed = [f for f in os.listdir(output_dir)
                       if f.startswith('auto_') and f.endswith('.py')]
            for f in removed:
                os.remove(os.path.join(output_dir, f))
            if removed:
                print(f"   🗑️  Removidos {len(removed)} ficheiro(s) antigo(s): "
                      f"{', '.join(removed)}")

            generated  = auto_generate_traders(
                filtered, param_specs, SHOW_PARAMS,
                output_dir, args.tf, args.auto_top, args.leverage,
            )
            for sym, path in generated:
                rel = os.path.relpath(path.split('  [')[0], ROOT)
                tag = '[ACTUALIZADO]' if '[ACTUALIZADO]' in path else '[CRIADO]'
                print(f"   {tag:<14}  {sym:<25}  traders_py/{os.path.basename(rel)}")

            if len(filtered) < args.auto_top:
                print(f"\n   ℹ️  Apenas {len(filtered)} moeda(s) passaram o filtro "
                      f"(pediste {args.auto_top}) — considera ajustar os limites.")

        print(sep2)


if __name__ == '__main__':
    main()
