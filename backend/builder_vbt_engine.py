"""
Executor Python para estratégias do chart builder.

Mantém a semântica do motor live do frontend: regras ifLine, zonas com janela,
filtro opcional nas zonas/entradas, MTF sem repaint e TP/SL/trailing conservador.
"""

from __future__ import annotations

import copy
import math
import re
from dataclasses import dataclass
from numbers import Real
from typing import Any

import numpy as np
import pandas as pd

from chart_ta_routes import (
    _derived_transform,
    _eval_formula,
    _indicator_frame,
    _maybe_align_indicator,
    _price_series,
    _register_named_output_aliases,
    _sma,
    _ema,
    _timeframe_seconds,
    _true_range,
    _wilder_rma,
)
from talib_indicators import run_talib_for_chart, talib_available
from trend_composite import compute_trend_composite_score


OPS = {">": "gt", "<": "lt", ">=": "ge", "<=": "le", "==": "eq", "=": "eq"}
_INDICATOR_DELTA_DISPLAY_SCALE = 1000.0
_ENTRY_OPERAND_RE = re.compile(
    r"(?is)^entry\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:,\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*)?\)$"
)
VALID_SOURCES = {"open", "high", "low", "close", "hl2", "hlc3", "ohlc4"}


@dataclass
class Bundle:
    scalar: np.ndarray
    upper: np.ndarray | None = None
    mid: np.ndarray | None = None
    lower: np.ndarray | None = None
    is_mtf: bool = False
    shifted: dict[int, "Bundle"] | None = None


def _finite(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _unix_times(df: pd.DataFrame) -> np.ndarray:
    return (df.index.astype("int64") // 10**9).to_numpy(dtype=np.float64)


def _indicator_delta_series(
    scalar: np.ndarray,
    close_px: np.ndarray,
    lookback: int,
    normalize_by_price: bool,
) -> np.ndarray:
    """Δ nas últimas ``lookback`` barras; opcionalmente ÷ fecho; ×1000 como no chart."""
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


def _maybe_register_delta_bundle(
    bundles: dict[str, Bundle],
    ind: dict[str, Any],
    scalar: np.ndarray,
    close_px: np.ndarray,
    *,
    is_mtf: bool,
) -> None:
    iid = str(ind.get("id") or "").strip()
    if not iid or iid not in bundles:
        return
    params = ind.get("params") if isinstance(ind.get("params"), dict) else {}
    lb_raw = params.get("deltaLookbackBars")
    try:
        lb = int(lb_raw) if lb_raw is not None else 0
    except (TypeError, ValueError):
        lb = 0
    if lb < 1:
        return
    norm = params.get("deltaNormalizeByPrice") is not False
    delta_s = _indicator_delta_series(scalar, close_px, lb, norm)
    bundles[f"{iid}_delta"] = Bundle(delta_s, is_mtf=is_mtf)


def _lower_df(df: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "open": df["Open"].astype(float).to_numpy(),
            "high": df["High"].astype(float).to_numpy(),
            "low": df["Low"].astype(float).to_numpy(),
            "close": df["Close"].astype(float).to_numpy(),
            "volume": df["Volume"].astype(float).to_numpy(),
        },
        index=df.index,
    )


def _shift_back(arr: np.ndarray, n: int) -> np.ndarray:
    n = max(0, int(n or 0))
    if n <= 0:
        return arr
    out = np.full(arr.shape[0], np.nan, dtype=np.float64)
    out[n:] = arr[:-n]
    return out


def _previous_distinct_values(arr: np.ndarray, shift: int) -> np.ndarray:
    out = np.full(arr.shape[0], np.nan, dtype=np.float64)
    distinct: list[float] = []
    prev = np.nan
    for i, raw in enumerate(arr):
        v = float(raw) if np.isfinite(raw) else np.nan
        if np.isfinite(v) and (not np.isfinite(prev) or abs(v - prev) > 1e-12):
            distinct.append(v)
            prev = v
        if len(distinct) > shift:
            out[i] = distinct[-(shift + 1)]
    return out


def _with_mtf_shifted(bundle: Bundle, shifts: set[int]) -> Bundle:
    if not shifts:
        return bundle
    shifted: dict[int, Bundle] = {}
    for s in shifts:
        if s < 1:
            continue
        shifted[s] = Bundle(
            scalar=_previous_distinct_values(bundle.scalar, s),
            upper=_previous_distinct_values(bundle.upper, s) if bundle.upper is not None else None,
            mid=_previous_distinct_values(bundle.mid, s) if bundle.mid is not None else None,
            lower=_previous_distinct_values(bundle.lower, s) if bundle.lower is not None else None,
            is_mtf=bundle.is_mtf,
        )
    bundle.shifted = shifted or None
    return bundle


def _indicator_alias(name: str, indicators: list[dict[str, Any]]) -> tuple[str, str | None] | None:
    raw = name.strip()
    low = raw.lower()
    if low.endswith("_delta") and len(low) > len("_delta"):
        base_l = low[: -len("_delta")].strip()
        by_delta = next((i for i in indicators if str(i.get("id", "")).lower() == base_l), None)
        if by_delta:
            p = by_delta.get("params") if isinstance(by_delta.get("params"), dict) else {}
            lb_raw = p.get("deltaLookbackBars")
            try:
                lb_i = int(lb_raw) if lb_raw is not None else 0
            except (TypeError, ValueError):
                lb_i = 0
            if lb_i >= 1:
                return f"{by_delta['id']}_delta", None
        return None
    by_id = next((i for i in indicators if str(i.get("id", "")).lower() == low), None)
    if by_id:
        return str(by_id["id"]), None
    if low in ("close", "c"):
        return "close", None
    if low.startswith("feat_"):
        return low, None
    if "." in raw:
        base, band = raw.split(".", 1)
        band_l = band.lower()
        if band_l not in ("upper", "mid", "lower"):
            return None
        if base.lower() in ("bb", "bollinger", "bbands"):
            c = [
                i
                for i in indicators
                if i.get("kind") == "talib"
                and str((i.get("params") or {}).get("talibFunction", "")).upper() == "BBANDS"
            ]
            return (str(c[0]["id"]), band_l) if len(c) == 1 else None
        ind = next((i for i in indicators if str(i.get("id", "")).lower() == base.lower()), None)
        if ind:
            return str(ind["id"]), band_l
        return None
    aliases = {"rsi": "RSI", "ema": "EMA", "bb": "BBANDS", "bollinger": "BBANDS", "bbands": "BBANDS"}
    fn = aliases.get(low)
    if fn:
        c = [
            i
            for i in indicators
            if i.get("kind") == "talib"
            and str((i.get("params") or {}).get("talibFunction", "")).upper() == fn
        ]
        if len(c) == 1:
            return str(c[0]["id"]), "mid" if fn == "BBANDS" else None
    return None


def _operand_from_token(tok: str, indicators: list[dict[str, Any]]) -> dict[str, Any]:
    ts = tok.strip()
    em = _ENTRY_OPERAND_RE.match(ts)
    if em:
        inner = em.group(1).strip()
        add_raw = em.group(2)
        resolved = _indicator_alias(inner, indicators)
        if not resolved:
            raise ValueError(f"entry: indicador desconhecido {inner!r}")
        ref, band = resolved
        snap: dict[str, Any] = {"type": "entry_snap", "ref": ref}
        if band:
            snap["bollingerBand"] = band
        if add_raw is None:
            return snap
        return {"type": "adjusted", "inner": snap, "add": float(add_raw)}
    try:
        return {"type": "constant", "value": float(tok)}
    except ValueError:
        pass
    shift = 0
    m = re.match(r"^([A-Za-z_][A-Za-z0-9_.]*)(?:\[(\d+)\])?$", tok.strip())
    if not m:
        raise ValueError(f"operando inválido: {tok!r}")
    name = m.group(1)
    if m.group(2):
        shift = int(m.group(2))
    resolved = _indicator_alias(name, indicators)
    if not resolved:
        raise ValueError(f"indicador desconhecido: {name!r}")
    ref, band = resolved
    out: dict[str, Any] = {"type": "indicator", "ref": ref}
    if band:
        out["bollingerBand"] = band
    if shift:
        out["shift"] = shift
    return out


def parse_if_line(line: str | None, indicators: list[dict[str, Any]]) -> dict[str, Any] | None:
    text = (line or "").strip()
    if not text:
        return None
    parts = re.split(r"\s+(and|or)\s+", text, flags=re.I)
    expr: dict[str, Any] | None = None
    pending = "and"
    for part in parts:
        p = part.strip()
        if not p:
            continue
        if p.lower() in ("and", "or"):
            pending = p.lower()
            continue
        while p.startswith("(") and p.endswith(")"):
            p = p[1:-1].strip()
        m = re.match(r"^(.+?)\s*(>=|<=|==|=|>|<)\s*(.+)$", p)
        if not m:
            raise ValueError(f"condição inválida: {p!r}")
        atom = {
            "kind": "atom",
            "condition": {
                "left": _operand_from_token(m.group(1).strip(), indicators),
                "op": OPS[m.group(2)],
                "right": _operand_from_token(m.group(3).strip(), indicators),
            },
        }
        if expr is None:
            expr = atom
        else:
            expr = {"kind": "all" if pending == "and" else "any", "children": [expr, atom]}
    return expr


def _expr_from_line_or_json(line: str | None, fallback: Any, indicators: list[dict[str, Any]]) -> dict[str, Any] | None:
    if line and line.strip():
        try:
            return parse_if_line(line, indicators)
        except ValueError:
            if isinstance(fallback, dict):
                return fallback
            raise
    return fallback if isinstance(fallback, dict) else None


def _compute_indicators(df_src: pd.DataFrame, spec: dict[str, Any]) -> dict[str, Bundle]:
    df = _lower_df(df_src)
    t_col = _unix_times(df_src)
    arrays_by_id: dict[str, np.ndarray] = {}
    extra: dict[str, np.ndarray] = {}
    bundles: dict[str, Bundle] = {"close": Bundle(df["close"].to_numpy(dtype=np.float64))}
    for ind in spec.get("indicators") or []:
        iid = str(ind.get("id") or "").strip()
        kind = str(ind.get("kind") or "").strip()
        params = ind.get("params") if isinstance(ind.get("params"), dict) else {}
        tf = params.get("timeframe")
        is_mtf = bool(tf and tf != "chart" and _timeframe_seconds(str(tf)) is not None)
        calc_df, close_t = _indicator_frame(df, t_col, str(tf) if tf else None)
        if not iid:
            continue
        if kind == "sma":
            s = _maybe_align_indicator(t_col, close_t, _sma(_price_series(calc_df, str(params.get("source") or "close")), int(params.get("period") or 20)))
            bundles[iid] = Bundle(s, is_mtf=is_mtf)
        elif kind == "atr":
            tr = _true_range(
                calc_df["high"].to_numpy(dtype=np.float64),
                calc_df["low"].to_numpy(dtype=np.float64),
                calc_df["close"].to_numpy(dtype=np.float64),
            )
            s = _maybe_align_indicator(t_col, close_t, _wilder_rma(tr, int(params.get("period") or 14)))
            bundles[iid] = Bundle(s, is_mtf=is_mtf)
        elif kind == "macd":
            px = _price_series(calc_df, str(params.get("source") or "close"))
            macd = _ema(px, int(params.get("fast") or 12)) - _ema(px, int(params.get("slow") or 26))
            s = _maybe_align_indicator(t_col, close_t, macd)
            bundles[iid] = Bundle(s, is_mtf=is_mtf)
        elif kind == "talib":
            if not talib_available():
                raise ValueError("TA-Lib não disponível")
            fn = str(params.get("talibFunction") or "").strip()
            if not fn:
                continue
            df_work = calc_df.copy()
            df_work["close"] = _price_series(calc_df, str(params.get("source") or "close"))
            raw = run_talib_for_chart(fn, df_work, params.get("talibParams") or None)
            aligned: dict[str, np.ndarray] = {
                k: _maybe_align_indicator(t_col, close_t, np.asarray(v, dtype=np.float64))
                for k, v in raw.items()
            }
            if len(aligned) == 1:
                s = next(iter(aligned.values()))
                bundles[iid] = Bundle(s, is_mtf=is_mtf)
            else:
                keys = {k.lower(): k for k in aligned}
                up_key = keys.get("upperband")
                mid_key = keys.get("middleband") or keys.get("mid")
                lo_key = keys.get("lowerband")
                up = aligned[up_key] if up_key else None
                mid = aligned[mid_key] if mid_key else None
                lo = aligned[lo_key] if lo_key else None
                scalar = mid if mid is not None else next(iter(aligned.values()))
                bundles[iid] = Bundle(scalar, upper=up, mid=mid, lower=lo, is_mtf=is_mtf)
                for k, arr in aligned.items():
                    _register_named_output_aliases(arrays_by_id, iid, k, arr)
            arrays_by_id[iid] = bundles[iid].scalar
            arrays_by_id[iid.lower()] = bundles[iid].scalar
            _maybe_register_delta_bundle(
                bundles,
                ind,
                bundles[iid].scalar,
                df["close"].to_numpy(dtype=np.float64),
                is_mtf=is_mtf,
            )
            continue
        elif kind == "trend_composite":
            tc = params.get("trendComposite") or params.get("trend_composite")
            if not isinstance(tc, dict):
                raise ValueError(f"indicador {iid!r}: params.trendComposite obrigatório")
            comp_raw = tc.get("components")
            comp_list: list[dict[str, Any]] = []
            if isinstance(comp_raw, list):
                for c in comp_raw:
                    if not isinstance(c, dict):
                        continue
                    pr = c.get("params") if isinstance(c.get("params"), dict) else {}
                    num_params: dict[str, float | int] = {}
                    for pk, pv in pr.items():
                        if isinstance(pv, (int, float)) and isinstance(pk, str):
                            num_params[pk] = pv
                    comp_list.append(
                        {
                            "cid": str(c.get("cid") or ""),
                            "weight": float(c.get("weight") or 0),
                            "preset": c.get("preset"),
                            "params": num_params,
                        }
                    )
            nw = int(tc.get("normWindow") or tc.get("norm_window") or 60)
            clip_v = float(tc.get("clip") or 2.0)
            scale_v = float(tc.get("outputScale") or tc.get("output_scale") or 100.0)
            raw_tc = compute_trend_composite_score(
                calc_df,
                components=comp_list,
                norm_window=nw,
                clip=clip_v,
                output_scale=scale_v,
            )
            s = _maybe_align_indicator(t_col, close_t, raw_tc)
            bundles[iid] = Bundle(s, is_mtf=is_mtf)
        elif kind == "derived":
            d = params.get("derived") if isinstance(params.get("derived"), dict) else {}
            if d.get("mode") == "formula":
                formula = str(d.get("formula") or "")
                if close_t is not None:
                    s = _maybe_align_indicator(t_col, close_t, _eval_formula(formula, calc_df, {}, {}))
                else:
                    s = _eval_formula(formula, df, arrays_by_id, extra)
            else:
                base_ref = str(d.get("inputRef") or "close")
                transform = str(d.get("transform") or "")
                if close_t is not None and base_ref.lower() in VALID_SOURCES:
                    base = _price_series(calc_df, base_ref)
                    s = _maybe_align_indicator(t_col, close_t, _derived_transform(transform, base, d.get("params") or {}))
                else:
                    base_bundle = bundles.get(base_ref)
                    base = base_bundle.scalar if base_bundle else df["close"].to_numpy(dtype=np.float64)
                    s = _derived_transform(transform, base, d.get("params") or {})
            bundles[iid] = Bundle(s, is_mtf=is_mtf)
        if iid in bundles:
            _maybe_register_delta_bundle(
                bundles,
                ind,
                bundles[iid].scalar,
                df["close"].to_numpy(dtype=np.float64),
                is_mtf=is_mtf,
            )
            arrays_by_id[iid] = bundles[iid].scalar
            arrays_by_id[iid.lower()] = bundles[iid].scalar
    return bundles


def _snap_key(op: dict[str, Any]) -> str:
    ref = str(op.get("ref") or "")
    band = op.get("bollingerBand")
    return f"{ref}|{band}" if band else ref


def _operand_collect_shift(op: dict[str, Any], out: dict[str, set[int]]) -> None:
    t = op.get("type")
    if t == "indicator" and int(op.get("shift") or 0) > 0:
        out.setdefault(str(op.get("ref")), set()).add(int(op.get("shift") or 0))
    elif t == "adjusted":
        _operand_collect_shift(op.get("inner") or {}, out)


def _collect_shifts(expr: dict[str, Any] | None, out: dict[str, set[int]]) -> None:
    if not expr:
        return
    if expr.get("kind") == "atom":
        cond = expr.get("condition") or {}
        for side in ("left", "right"):
            _operand_collect_shift(cond.get(side) or {}, out)
    else:
        for ch in expr.get("children") or []:
            _collect_shifts(ch, out)


def _prepare_bundles(df: pd.DataFrame, spec: dict[str, Any], exprs: list[dict[str, Any] | None]) -> dict[str, Bundle]:
    bundles = _compute_indicators(df, spec)
    shifts: dict[str, set[int]] = {}
    for ex in exprs:
        _collect_shifts(ex, shifts)
    for ref, ss in shifts.items():
        b = bundles.get(ref)
        if b and b.is_mtf:
            bundles[ref] = _with_mtf_shifted(b, ss)
    return bundles


def _op_value(op: dict[str, Any], i: int, bundles: dict[str, Bundle], snap: dict[str, float] | None = None) -> float | None:
    t = op.get("type")
    if t == "constant":
        return _finite(op.get("value"))
    if t == "adjusted":
        inner = op.get("inner") or {}
        base = _op_value(inner, i, bundles, snap)
        add = op.get("add")
        if base is None or not isinstance(add, (int, float)) or not math.isfinite(float(add)):
            return None
        return float(base) + float(add)
    if t == "entry_snap":
        if snap is None:
            return None
        return _finite(snap.get(_snap_key(op)))
    ref = str(op.get("ref") or "")
    b = bundles.get(ref)
    if not b:
        return None
    shift = int(op.get("shift") or 0)
    if shift > 0:
        if b.is_mtf and b.shifted and shift in b.shifted:
            b = b.shifted[shift]
            j = i
        else:
            j = i - shift
    else:
        j = i
    if j < 0 or j >= b.scalar.shape[0]:
        return None
    band = op.get("bollingerBand")
    arr = b.scalar
    if band == "upper" and b.upper is not None:
        arr = b.upper
    elif band == "mid" and b.mid is not None:
        arr = b.mid
    elif band == "lower" and b.lower is not None:
        arr = b.lower
    return _finite(arr[j])


def _eval_cond(cond: dict[str, Any], i: int, bundles: dict[str, Bundle], snap: dict[str, float] | None = None) -> bool:
    lv = _op_value(cond.get("left") or {}, i, bundles, snap)
    rv = _op_value(cond.get("right") or {}, i, bundles, snap)
    if lv is None or rv is None:
        return False
    op = cond.get("op")
    if op == "gt":
        return lv > rv
    if op == "lt":
        return lv < rv
    if op == "ge":
        return lv >= rv
    if op == "le":
        return lv <= rv
    if op == "eq":
        return abs(lv - rv) <= 1e-12
    if op == "cross_up":
        if i == 0:
            return False
        lp = _op_value(cond.get("left") or {}, i - 1, bundles, snap)
        rp = _op_value(cond.get("right") or {}, i - 1, bundles, snap)
        return lp is not None and rp is not None and lp <= rp and lv > rv
    if op == "cross_down":
        if i == 0:
            return False
        lp = _op_value(cond.get("left") or {}, i - 1, bundles, snap)
        rp = _op_value(cond.get("right") or {}, i - 1, bundles, snap)
        return lp is not None and rp is not None and lp >= rp and lv < rv
    return False


def _eval_expr(expr: dict[str, Any] | None, i: int, bundles: dict[str, Bundle], snap: dict[str, float] | None = None) -> bool:
    if not expr:
        return False
    if expr.get("kind") == "atom":
        return _eval_cond(expr.get("condition") or {}, i, bundles, snap)
    children = expr.get("children") or []
    if expr.get("kind") == "all":
        return all(_eval_expr(ch, i, bundles, snap) for ch in children)
    return any(_eval_expr(ch, i, bundles, snap) for ch in children)


def _operand_has_entry_snap(op: dict[str, Any] | None) -> bool:
    if not op:
        return False
    t = op.get("type")
    if t == "entry_snap":
        return True
    if t == "adjusted":
        return _operand_has_entry_snap(op.get("inner"))
    return False


def _expr_has_entry_snap(expr: dict[str, Any] | None) -> bool:
    if not expr:
        return False
    if expr.get("kind") == "atom":
        cond = expr.get("condition") or {}
        return _operand_has_entry_snap(cond.get("left")) or _operand_has_entry_snap(cond.get("right"))
    return any(_expr_has_entry_snap(ch) for ch in (expr.get("children") or []))


def _operand_collect_entry_snap(op: dict[str, Any] | None, acc: list[dict[str, Any]]) -> None:
    if not op:
        return
    t = op.get("type")
    if t == "entry_snap":
        acc.append(op)
    elif t == "adjusted":
        _operand_collect_entry_snap(op.get("inner"), acc)


def _collect_entry_snap_ops(expr: dict[str, Any] | None, acc: list[dict[str, Any]]) -> None:
    if not expr:
        return
    if expr.get("kind") == "atom":
        cond = expr.get("condition") or {}
        _operand_collect_entry_snap(cond.get("left"), acc)
        _operand_collect_entry_snap(cond.get("right"), acc)
        return
    for ch in expr.get("children") or []:
        _collect_entry_snap_ops(ch, acc)


def _uniq_entry_snaps(ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for op in ops:
        k = _snap_key(op)
        if k in seen:
            continue
        seen.add(k)
        out.append(op)
    return out


def _capture_snap_bar(ops: list[dict[str, Any]], i: int, bundles: dict[str, Bundle]) -> dict[str, float]:
    snap: dict[str, float] = {}
    for op in ops:
        pseudo = {"type": "indicator", "ref": op.get("ref")}
        if op.get("bollingerBand"):
            pseudo["bollingerBand"] = op.get("bollingerBand")
        v = _op_value(pseudo, i, bundles, None)
        if v is not None:
            snap[_snap_key(op)] = float(v)
    return snap


def _zone_window(n: int, zone: dict[str, Any] | None, flt: dict[str, Any] | None, apply_filter: bool, wait: int, bundles: dict[str, Bundle]) -> np.ndarray:
    out = np.ones(n, dtype=bool)
    if not zone:
        return out
    out[:] = False
    last = -1
    w = max(0, min(500, int(wait or 0)))
    for i in range(n):
        f_ok = (not apply_filter) or (not flt) or _eval_expr(flt, i, bundles)
        if f_ok and _eval_expr(zone, i, bundles):
            last = i
        out[i] = last >= 0 and i - last <= w
    return out


def _entry_rule_lines(rule_obj: Any) -> tuple[Any, Any]:
    """Se ``enabled`` é ``False``, ignorar entrada (mas pode haver ``ifLine`` guardado como rascunho)."""
    if not isinstance(rule_obj, dict):
        return None, None
    if rule_obj.get("enabled") is False:
        return None, None
    return rule_obj.get("ifLine"), rule_obj.get("expr")


def _signals(df: pd.DataFrame, spec: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, dict[str, Bundle]]:
    rules = spec.get("rules") or {}
    ind = spec.get("indicators") or []
    flt = _expr_from_line_or_json(rules.get("filterIf"), rules.get("filter"), ind)
    zl = _expr_from_line_or_json(rules.get("zoneLongIf"), rules.get("zoneLong"), ind)
    zs = _expr_from_line_or_json(rules.get("zoneShortIf"), rules.get("zoneShort"), ind)
    long_parts = _entry_rule_lines(rules.get("long"))
    short_parts = _entry_rule_lines(rules.get("short"))
    le = _expr_from_line_or_json(
        long_parts[0] if isinstance(long_parts[0], str) else None,
        long_parts[1] if isinstance(long_parts[1], dict) else None,
        ind,
    )
    se = _expr_from_line_or_json(
        short_parts[0] if isinstance(short_parts[0], str) else None,
        short_parts[1] if isinstance(short_parts[1], dict) else None,
        ind,
    )
    lx = _expr_from_line_or_json(rules.get("exitLongIf"), rules.get("exitLong"), ind)
    sx = _expr_from_line_or_json(rules.get("exitShortIf"), rules.get("exitShort"), ind)
    exprs = [flt, zl, zs, le, se, lx, sx]
    bundles = _prepare_bundles(df, spec, exprs)
    n = len(df)
    zlo = _zone_window(n, zl, flt, rules.get("zoneLongApplyFilter") is not False, int(rules.get("zoneLongWaitCandles") or 10), bundles)
    zso = _zone_window(n, zs, flt, rules.get("zoneShortApplyFilter") is not False, int(rules.get("zoneShortWaitCandles") or 10), bundles)
    long_rule = rules.get("long") or {}
    short_rule = rules.get("short") or {}
    long_entry = np.zeros(n, dtype=bool)
    short_entry = np.zeros(n, dtype=bool)
    long_exit = np.zeros(n, dtype=bool)
    short_exit = np.zeros(n, dtype=bool)

    snap_enabled = rules.get("entrySnapEnabled") is True and (_expr_has_entry_snap(lx) or _expr_has_entry_snap(sx))
    # Com TP/SL/trailing activos ainda precisamos do modo stateful: caso contrário
    # ``entry()`` avalia sem ``snap`` e nunca dispara (paridade com ``dynamicExit`` no builderEngine TS).
    stateful = snap_enabled

    keys_l: list[dict[str, Any]] = []
    keys_s: list[dict[str, Any]] = []
    if stateful:
        acc_l: list[dict[str, Any]] = []
        acc_s: list[dict[str, Any]] = []
        _collect_entry_snap_ops(lx, acc_l)
        _collect_entry_snap_ops(sx, acc_s)
        keys_l = _uniq_entry_snaps(acc_l)
        keys_s = _uniq_entry_snaps(acc_s)

    for i in range(n):
        market_ok = True if not flt else _eval_expr(flt, i, bundles)
        if le and zlo[i] and (long_rule.get("applyFilter") is not True or market_ok) and _eval_expr(le, i, bundles):
            long_entry[i] = True
        if se and zso[i] and (short_rule.get("applyFilter") is not True or market_ok) and _eval_expr(se, i, bundles):
            short_entry[i] = True
        if not stateful:
            if lx and _eval_expr(lx, i, bundles):
                long_exit[i] = True
            if sx and _eval_expr(sx, i, bundles):
                short_exit[i] = True

    if stateful:
        pos = "flat"
        snap_l: dict[str, float] = {}
        snap_s: dict[str, float] = {}
        for i in range(n):
            le_i = bool(long_entry[i])
            se_i = bool(short_entry[i])
            long_exit[i] = bool(pos == "L" and lx and _eval_expr(lx, i, bundles, snap_l))
            short_exit[i] = bool(pos == "S" and sx and _eval_expr(sx, i, bundles, snap_s))
            if pos == "flat":
                if le_i:
                    pos = "L"
                    snap_l = _capture_snap_bar(keys_l, i, bundles)
                elif se_i:
                    pos = "S"
                    snap_s = _capture_snap_bar(keys_s, i, bundles)
            elif pos == "L":
                if long_exit[i]:
                    pos = "flat"
                    snap_l = {}
                elif se_i:
                    pos = "S"
                    snap_l = {}
                    snap_s = _capture_snap_bar(keys_s, i, bundles)
            else:
                if short_exit[i]:
                    pos = "flat"
                    snap_s = {}
                elif le_i:
                    pos = "L"
                    snap_s = {}
                    snap_l = _capture_snap_bar(keys_l, i, bundles)

    return long_entry, long_exit, short_entry, short_exit, bundles


def _max_dd(values: list[float]) -> float:
    peak = -np.inf
    worst = 0.0
    for v in values:
        peak = max(peak, v)
        if peak > 0:
            worst = min(worst, (v / peak - 1.0) * 100.0)
    return worst


def parse_builder_ind_override_key(key: str) -> tuple[str, list[str]] | None:
    """``ind/<indicator_id>/<dot.path>`` → indicador + segmentos do caminho nos ``params``."""
    if not key.startswith("ind/"):
        return None
    rest = key[4:]
    slash = rest.find("/")
    if slash <= 0:
        return None
    ind_id = rest[:slash]
    path_s = rest[slash + 1 :].strip()
    if not path_s:
        return None
    return ind_id, path_s.split(".")


def read_builder_grid_base_value(spec: dict[str, Any], key: str) -> tuple[float | int, bool] | None:
    """
    Valor base na spec para uma chave da grelha builder.
    Segundo valor: ``True`` se variantes devem ser inteiras (períodos, velas).
    """
    if key in {"takeProfitPct", "stopLossPct", "trailingStopPct"}:
        risk = spec.get("risk") or {}
        try:
            return float(risk.get(key) or 0.0), False
        except (TypeError, ValueError):
            return 0.0, False
    if key == "zoneLongWaitCandles":
        rules = spec.get("rules") or {}
        try:
            return int(rules.get("zoneLongWaitCandles") or 10), True
        except (TypeError, ValueError):
            return 10, True
    if key == "zoneShortWaitCandles":
        rules = spec.get("rules") or {}
        try:
            return int(rules.get("zoneShortWaitCandles") or 10), True
        except (TypeError, ValueError):
            return 10, True

    parsed = parse_builder_ind_override_key(key)
    if not parsed:
        return None
    ind_id, path_parts = parsed
    if not path_parts:
        return None
    for ind in spec.get("indicators") or []:
        if str(ind.get("id")) != ind_id:
            continue
        params = ind.get("params")
        if not isinstance(params, dict):
            return None
        cur: Any = params
        for seg in path_parts[:-1]:
            nxt = cur.get(seg)
            if not isinstance(nxt, dict):
                return None
            cur = nxt
        leaf = path_parts[-1]
        val = cur.get(leaf)
        if isinstance(val, bool):
            return None
        if isinstance(val, int):
            return val, True
        if isinstance(val, float):
            return val, False
        return None
    return None


def drift_variant_values(base: float | int, pct: float, *, as_int: bool) -> list[float | int]:
    """Três níveis típicos: min (−pct%), base, max (+pct%)."""
    p = float(pct)
    if p <= 0:
        return [base]
    bf = float(base)
    lo = bf * (1.0 - p / 100.0)
    hi = bf * (1.0 + p / 100.0)
    if as_int:
        bi = int(round(bf))
        lo_i = max(1, int(math.floor(lo + 1e-9)))
        hi_i = max(1, int(math.ceil(hi - 1e-9)))
        out = sorted({lo_i, bi, hi_i})
        return out if out else [bi]
    lo_f = round(lo, 8)
    mid_f = round(bf, 8)
    hi_f = round(hi, 8)
    out_f = sorted({lo_f, mid_f, hi_f})
    return out_f if out_f else [mid_f]


def merge_builder_best_params_into_spec(spec: dict[str, Any], best_params: dict[str, Any] | None) -> None:
    """Aplica ``best_params`` à cópia ``spec`` (risco, zonas, indicadores ``ind/…``)."""
    if not best_params:
        return
    risk = spec.setdefault("risk", dict(spec.get("risk") or {}))
    rules = spec.setdefault("rules", dict(spec.get("rules") or {}))
    risk.update({k: v for k, v in best_params.items() if k in {"takeProfitPct", "stopLossPct", "trailingStopPct"}})
    if "zoneLongWaitCandles" in best_params:
        rules["zoneLongWaitCandles"] = best_params["zoneLongWaitCandles"]
    if "zoneShortWaitCandles" in best_params:
        rules["zoneShortWaitCandles"] = best_params["zoneShortWaitCandles"]

    indicators = spec.get("indicators")
    if not isinstance(indicators, list):
        return

    for raw_k, val in best_params.items():
        k = str(raw_k)
        parsed = parse_builder_ind_override_key(k)
        if not parsed:
            continue
        ind_id, path_parts = parsed
        if not path_parts:
            continue
        for ind in indicators:
            if str(ind.get("id")) != ind_id:
                continue
            params = ind.setdefault("params", {})
            if not isinstance(params, dict):
                break
            cur: dict[str, Any] = params
            for seg in path_parts[:-1]:
                nxt = cur.get(seg)
                if not isinstance(nxt, dict):
                    cur[seg] = {}
                    nxt = cur[seg]
                cur = nxt
            cur[path_parts[-1]] = val
            # Evitar períodos TA-Lib vs raiz divergentes quando ambos existem na spec.
            if path_parts == ["period"]:
                tp = params.get("talibParams")
                if isinstance(tp, dict):
                    tp["timeperiod"] = val
            elif len(path_parts) == 2 and path_parts[0] == "talibParams" and path_parts[1] == "timeperiod":
                if "period" in params:
                    params["period"] = val
            break


def builder_effective_params_snapshot(spec: dict[str, Any]) -> dict[str, Any]:
    """
    Parâmetros efectivos após merge (risco, zonas, todos os números em ``indicators[].params``).
    Chaves de indicador no formato ``ind/<id>/<dot.path>`` (igual ao stress/drift no frontend).
    """
    out: dict[str, Any] = {}
    risk = spec.get("risk") if isinstance(spec.get("risk"), dict) else {}
    for k in ("takeProfitPct", "stopLossPct", "trailingStopPct"):
        if k not in risk:
            continue
        try:
            x = float(risk[k])
            out[k] = round(x, 8) if math.isfinite(x) else x
        except (TypeError, ValueError):
            pass
    rules = spec.get("rules") if isinstance(spec.get("rules"), dict) else {}
    for k in ("zoneLongWaitCandles", "zoneShortWaitCandles"):
        if k not in rules:
            continue
        try:
            out[k] = int(rules[k])
        except (TypeError, ValueError):
            pass

    for ind in spec.get("indicators") or []:
        iid = str(ind.get("id") or "").strip()
        params = ind.get("params")
        if not iid or not isinstance(params, dict):
            continue

        def walk(obj: dict[str, Any], prefix: str) -> None:
            for key, val in obj.items():
                path = f"{prefix}.{key}" if prefix else key
                if isinstance(val, dict):
                    walk(val, path)
                    continue
                if isinstance(val, bool):
                    continue
                if isinstance(val, np.generic):
                    try:
                        val = val.item()
                    except Exception:
                        continue
                if isinstance(val, Real) and not isinstance(val, bool):
                    try:
                        x = float(val)
                    except (TypeError, ValueError):
                        continue
                    if not math.isfinite(x):
                        continue
                    rx = round(x, 8)
                    ir = int(round(rx))
                    out[f"ind/{iid}/{path}"] = ir if abs(rx - ir) < 1e-9 else rx

        walk(params, "")
    return out


def _exec_adverse_frac(slippage_pct: float, half_spread_pct: float) -> float:
    """Slippage + half-spread as fractions of price (inputs are percentages)."""
    return max(0.0, float(slippage_pct)) / 100.0 + max(0.0, float(half_spread_pct)) / 100.0


def exec_buy_px(ref_px: float, adverse_frac: float) -> float:
    """Executable buy price vs reference (long entry / short cover)."""
    return float(ref_px) * (1.0 + adverse_frac)


def exec_sell_px(ref_px: float, adverse_frac: float) -> float:
    """Executable sell price vs reference (long exit / short entry)."""
    return float(ref_px) * (1.0 - adverse_frac)


def _fee_fraction(fee_pct_per_fill: float) -> float:
    return max(0.0, float(fee_pct_per_fill)) / 100.0


def run_builder_backtest(
    df: pd.DataFrame,
    symbol: str,
    spec: dict[str, Any],
    *,
    initial_cash: float,
    best_params: dict[str, Any] | None = None,
    exec_fee_pct_per_fill: float = 0.0,
    exec_slippage_pct: float = 0.0,
    exec_half_spread_pct: float = 0.0,
) -> dict[str, Any]:
    spec_work = copy.deepcopy(spec)
    spec_work.setdefault("risk", dict(spec_work.get("risk") or {}))
    spec_work.setdefault("rules", dict(spec_work.get("rules") or {}))
    merge_builder_best_params_into_spec(spec_work, best_params)
    risk = spec_work["risk"]
    le, lx, se, sx, _bundles = _signals(df, spec_work)
    tp = max(0.0, float(risk.get("takeProfitPct") or 0.0)) / 100.0
    sl = max(0.0, float(risk.get("stopLossPct") or 0.0)) / 100.0
    tr = max(0.0, float(risk.get("trailingStopPct") or 0.0)) / 100.0
    times = (df.index.astype("int64") // 10**9).to_numpy(dtype=np.int64)
    h = df["High"].to_numpy(dtype=np.float64)
    l = df["Low"].to_numpy(dtype=np.float64)
    c = df["Close"].to_numpy(dtype=np.float64)
    value = float(initial_cash)
    pos: dict[str, Any] | None = None
    equity: list[dict[str, Any]] = []
    markers: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    returns: list[float] = []

    adverse_frac = _exec_adverse_frac(exec_slippage_pct, exec_half_spread_pct)
    fee_r = _fee_fraction(exec_fee_pct_per_fill)

    def mark(i: int, short: bool, close: bool, text: str) -> None:
        markers.append({
            "time": int(times[i]),
            "position": "aboveBar" if (short != close) else "belowBar",
            "color": "#f59e0b" if close else ("#f87171" if short else "#4ade80"),
            "shape": "arrowDown" if (short != close) else "arrowUp",
            "text": text,
        })

    def close_pos(i: int, px: float, label: str) -> None:
        nonlocal value, pos
        if not pos:
            return
        old = float(pos["n"])
        if pos["k"] == "L":
            px_eff = exec_sell_px(px, adverse_frac)
            cash = old * px_eff / float(pos["e"])
            side = "long"
            mark(i, False, True, label)
        else:
            px_eff = exec_buy_px(px, adverse_frac)
            cash = old * (2.0 - px_eff / float(pos["e"]))
            side = "short"
            mark(i, True, True, label)
        cash *= 1.0 - fee_r
        r = cash / old - 1.0
        returns.append(r)
        trades.append({"entryTime": int(pos["entryT"]), "exitTime": int(times[i]), "side": side, "pnl_pct": r * 100.0})
        value = cash
        pos = None

    for i in range(len(df)):
        if pos is None:
            if le[i]:
                pos = {
                    "k": "L",
                    "n": value * (1.0 - fee_r),
                    "e": exec_buy_px(c[i], adverse_frac),
                    "entryT": int(times[i]),
                    "best": c[i],
                }
                mark(i, False, False, "B")
            elif se[i]:
                pos = {
                    "k": "S",
                    "n": value * (1.0 - fee_r),
                    "e": exec_sell_px(c[i], adverse_frac),
                    "entryT": int(times[i]),
                    "best": c[i],
                }
                mark(i, True, False, "S")
        elif pos["k"] == "L":
            value = float(pos["n"]) * c[i] / float(pos["e"])
            done = False
            if sl > 0 and l[i] <= float(pos["e"]) * (1 - sl):
                close_pos(i, float(pos["e"]) * (1 - sl), "SL"); done = True
            if not done and tp > 0 and h[i] >= float(pos["e"]) * (1 + tp):
                close_pos(i, float(pos["e"]) * (1 + tp), "TP"); done = True
            if not done and tr > 0 and l[i] <= float(pos["best"]) * (1 - tr):
                close_pos(i, float(pos["best"]) * (1 - tr), "TR"); done = True
            if not done and lx[i]:
                close_pos(i, c[i], "C"); done = True
            if not done and se[i]:
                close_pos(i, c[i], "C")
                pos = {
                    "k": "S",
                    "n": value * (1.0 - fee_r),
                    "e": exec_sell_px(c[i], adverse_frac),
                    "entryT": int(times[i]),
                    "best": c[i],
                }
                mark(i, True, False, "S")
            elif pos is not None and pos["k"] == "L":
                pos["best"] = max(float(pos["best"]), h[i])
        else:
            value = float(pos["n"]) * (2.0 - c[i] / float(pos["e"]))
            done = False
            if sl > 0 and h[i] >= float(pos["e"]) * (1 + sl):
                close_pos(i, float(pos["e"]) * (1 + sl), "SL"); done = True
            if not done and tp > 0 and l[i] <= float(pos["e"]) * (1 - tp):
                close_pos(i, float(pos["e"]) * (1 - tp), "TP"); done = True
            if not done and tr > 0 and h[i] >= float(pos["best"]) * (1 + tr):
                close_pos(i, float(pos["best"]) * (1 + tr), "TR"); done = True
            if not done and sx[i]:
                close_pos(i, c[i], "C"); done = True
            if not done and le[i]:
                close_pos(i, c[i], "C")
                pos = {
                    "k": "L",
                    "n": value * (1.0 - fee_r),
                    "e": exec_buy_px(c[i], adverse_frac),
                    "entryT": int(times[i]),
                    "best": c[i],
                }
                mark(i, False, False, "B")
            elif pos is not None and pos["k"] == "S":
                pos["best"] = min(float(pos["best"]), l[i])
        equity.append({"t": int(times[i]), "v": float(value)})

    total_ret = ((equity[-1]["v"] if equity else initial_cash) / initial_cash - 1.0) * 100.0
    wins = [x for x in returns if x > 0]
    losses = [x for x in returns if x < 0]
    gross_p = sum(wins)
    gross_l = -sum(losses)
    pf = gross_p / gross_l if gross_l > 1e-12 else (9.99 if gross_p > 0 else 0.0)
    ret_arr = np.asarray(returns, dtype=np.float64)
    sharpe = float(np.sqrt(max(1, len(ret_arr))) * ret_arr.mean() / ret_arr.std()) if ret_arr.size > 1 and ret_arr.std() > 1e-12 else 0.0
    resolved = builder_effective_params_snapshot(spec_work)
    return {
        "symbol": symbol,
        "base": symbol.split("/")[0],
        "return_pct": round(float(total_ret), 2),
        "win_rate": round(100.0 * len(wins) / len(returns), 1) if returns else 0.0,
        "trades": len(returns),
        "long_trades": sum(1 for t in trades if t["side"] == "long"),
        "short_trades": sum(1 for t in trades if t["side"] == "short"),
        "max_dd": round(_max_dd([x["v"] for x in equity]), 2),
        "sharpe": round(sharpe, 2),
        "profit_fct": round(float(pf), 2),
        "avg_win_pct": round(float(np.mean(wins) * 100.0), 2) if wins else 0.0,
        "avg_loss_pct": round(float(np.mean(losses) * 100.0), 2) if losses else 0.0,
        "expectancy": round(float(np.mean(returns) * 100.0), 2) if returns else 0.0,
        "best_params": best_params or {},
        "resolved_params": resolved,
        "exec_fee_pct_per_fill": round(float(exec_fee_pct_per_fill), 6),
        "exec_slippage_pct": round(float(exec_slippage_pct), 6),
        "exec_half_spread_pct": round(float(exec_half_spread_pct), 6),
        "n_valid": 1,
        "vbt_col": 0,
        "chart_overlay": {"markers": markers[-800:], "equity": equity[:: max(1, len(equity) // 2500)], "initial_cash": initial_cash},
        "trade_log": trades[:500],
    }


def builder_param_grid(
    spec: dict[str, Any],
    mode: str,
    max_tries: int,
    *,
    drift_enabled: bool = False,
    drift_pct_by_key: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    """
    Grelha de parâmetros de risco / janelas de zona / indicadores para backtests builder.
    Com ``drift_enabled`` e ``drift_pct_by_key``, varia cada chave entre ~min/base/max (+/-pct%).
    Sem drift: expansão clássica 0.5× / 1× / 1.5× sobre risco e zonas.
    """
    cap = max(1, min(int(max_tries), 500))
    if mode != "optimize":
        cap = max(1, min(cap, 120))

    drift_map = drift_pct_by_key or {}
    active_drift = drift_enabled and bool(
        drift_map and any(float(v) > 0 for v in drift_map.values()),
    )

    if active_drift:
        keys_sorted = sorted([str(k) for k in drift_map.keys()])
        baselines: dict[str, Any] = {}
        entries: list[tuple[str, float, Any, bool]] = []
        for ck in keys_sorted:
            pct = float(drift_map.get(ck, 0.0))
            if pct <= 0:
                continue
            got = read_builder_grid_base_value(spec, ck)
            if got is None:
                continue
            base_v, as_int = got
            baselines[ck] = base_v
            entries.append((ck, pct, base_v, as_int))

        vals = [{}]
        for ck, pct, base_v, as_int in entries:
            variants = drift_variant_values(base_v, pct, as_int=as_int)
            if as_int:
                # TA-Lib rejeita timeperiod/study period < 2 (TA_BAD_PARAM).
                if "/period" in ck or "timeperiod" in ck:
                    variants = sorted({max(2, int(v)) for v in variants})
                elif "deltaLookbackBars" in ck:
                    variants = sorted({max(1, int(v)) for v in variants})
            vals = [dict(p, **{ck: x}) for p in vals for x in variants]
            if len(vals) >= cap:
                vals = vals[:cap]
                break

        out = vals[:cap] if vals else [{}]
        for d in out:
            for ck, bv in baselines.items():
                if ck not in d:
                    d[ck] = bv

        return out if out else [{}]

    risk = spec.get("risk") or {}
    base = {
        "takeProfitPct": float(risk.get("takeProfitPct") or 0.0),
        "stopLossPct": float(risk.get("stopLossPct") or 0.0),
        "trailingStopPct": float(risk.get("trailingStopPct") or 0.0),
        "zoneLongWaitCandles": int((spec.get("rules") or {}).get("zoneLongWaitCandles") or 10),
        "zoneShortWaitCandles": int((spec.get("rules") or {}).get("zoneShortWaitCandles") or 10),
    }
    vals_legacy: list[dict[str, Any]] = [{}]
    for k, v in base.items():
        if isinstance(v, float):
            around = sorted({max(0.0, v * 0.5), v, v * 1.5 if v > 0 else 1.0})
        else:
            around = sorted({max(0, int(v * 0.5)), int(v), max(0, int(v * 1.5))})
        vals_legacy = [dict(p, **{k: x}) for p in vals_legacy for x in around]
        if len(vals_legacy) >= cap:
            break
    out = vals_legacy[:cap]
    return out if out else [{}]
