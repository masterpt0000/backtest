"""
Características derivadas das tabelas fact (QuestDB), alinhadas às barras OHLC —
uso nas regras do construtor sob ``feat_*`` (mesmo papel que série de indicador).

Agregação por intervalo ``[t_i, t_{i+1})`` com ``bisect_right`` sobre timestamps de abertura das velas.
"""

from __future__ import annotations

import asyncio
import bisect
import math
import os
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from chart_feature_aggregates import (
    backfill_chart_features_1m_range,
    chart_features_from_1m_cache,
    infer_chart_features_1m_range,
)
from job_queue import chart_job_status, enqueue_chart_job
from live_routes import _safe_rows
from questdb_client import parse_ts_to_unix_sec, ts_iso


router = APIRouter(tags=["chart"])
_BAR_FEATURES_MAX_BARS = max(
    50_000,
    int(os.environ.get("CHART_BAR_FEATURES_MAX_BARS", "600000") or "600000"),
)


class ChartBarFeatBar(BaseModel):
    t: float
    o: float = 0.0
    h: float = 0.0
    l: float = 0.0
    c: float = 0.0
    v: float = 0.0


class ChartBarFeaturesBody(BaseModel):
    symbol_id: int = Field(ge=1)
    bars: list[ChartBarFeatBar] = Field(..., min_length=1)
    raw_fallback: bool = True

    model_config = {"extra": "forbid"}


class ChartFeaturesBackfillBody(BaseModel):
    symbol_ids: list[int] = Field(..., min_length=1)
    start_sec: int | None = None
    end_sec: int | None = None
    chunk_minutes: int = Field(7 * 24 * 60, ge=60, le=80_000)

    model_config = {"extra": "forbid"}


class ChartFootprintBody(BaseModel):
    symbol_id: int = Field(ge=1)
    bars: list[ChartBarFeatBar] = Field(..., min_length=1, max_length=5_000)
    price_step: float | None = Field(None, gt=0)
    max_levels_per_bar: int = Field(18, ge=4, le=80)
    tick_limit: int = Field(250_000, ge=1_000, le=1_000_000)

    model_config = {"extra": "forbid"}


def _bar_idx(barriers_sec: list[float], n: int, tv: float) -> int:
    idx = bisect.bisect_right(barriers_sec, float(tv)) - 1
    if idx < 0 or idx >= n:
        return -1
    return idx


def _json_safe_float_list(values: list[float]) -> list[float]:
    """Evita NaN/inf na JSON (``JSON.parse`` no browser não aceita literal ``NaN``)."""
    out: list[float] = []
    for x in values:
        try:
            xf = float(x)
        except (TypeError, ValueError):
            out.append(0.0)
            continue
        if math.isnan(xf) or math.isinf(xf):
            out.append(0.0)
        else:
            out.append(xf)
    return out


def _nice_price_step(raw: float) -> float:
    if not math.isfinite(raw) or raw <= 0:
        return 1.0
    exp = math.floor(math.log10(raw))
    base = raw / (10**exp)
    if base <= 1:
        nice = 1
    elif base <= 2:
        nice = 2
    elif base <= 5:
        nice = 5
    else:
        nice = 10
    return float(nice * (10**exp))


def _infer_price_step(bars: list[ChartBarFeatBar]) -> float:
    ranges: list[float] = []
    closes: list[float] = []
    for b in bars:
        h = float(b.h)
        l = float(b.l)
        c = float(b.c)
        if math.isfinite(h) and math.isfinite(l) and h > l:
            ranges.append(h - l)
        if math.isfinite(c) and c > 0:
            closes.append(c)
    ranges.sort()
    closes.sort()
    if ranges:
        raw = ranges[len(ranges) // 2] / 18.0
    elif closes:
        raw = closes[len(closes) // 2] * 0.0002
    else:
        raw = 1.0
    return _nice_price_step(raw)


def _ffill_nan_leading_zeros(series: list[float]) -> list[float]:
    """Preenche NaNs com o último valor válido; início sem valor → 0."""
    last: float | None = None
    out: list[float] = []
    for x in series:
        if isinstance(x, (int, float)) and math.isfinite(x):
            last = float(x)
            out.append(last)
        elif last is not None:
            out.append(last)
        else:
            out.append(0.0)
    return out


def _is_long_liquidation(side_raw: object) -> bool:
    s = str(side_raw or "").lower()
    if "short" in s or s == "buy":
        return False
    if "long" in s or s == "sell":
        return True
    return True


def _feat_liquidations_per_bar(
    barriers_sec: list[float],
    *,
    rows: list[dict[str, Any]],
) -> tuple[list[float], list[float]]:
    n = len(barriers_sec)
    liq_long = [0.0] * n
    liq_short = [0.0] * n
    if n == 0 or not rows:
        return liq_long, liq_short

    for row in rows:
        ts_any = row.get("local_ts")
        if ts_any is None:
            continue
        tv = parse_ts_to_unix_sec(ts_any)
        if tv is None:
            continue
        idx = _bar_idx(barriers_sec, n, tv)
        if idx < 0:
            continue
        try:
            amt = abs(float(row.get("contracts") or 0.0))
        except (TypeError, ValueError):
            amt = 0.0
        if amt <= 0:
            continue
        side = row.get("side")
        target = liq_long if _is_long_liquidation(side) else liq_short
        target[idx] += amt
    return liq_long, liq_short


def _feat_tick_buy_sell(barriers_sec: list[float], *, rows: list[dict[str, Any]]) -> tuple[list[float], list[float]]:
    """Volume de amount agregado por lado (tape)."""
    n = len(barriers_sec)
    buy_vol = [0.0] * n
    sell_vol = [0.0] * n
    if n == 0 or not rows:
        return buy_vol, sell_vol
    for row in rows:
        ts_any = row.get("local_ts")
        if ts_any is None:
            continue
        tv = parse_ts_to_unix_sec(ts_any)
        if tv is None:
            continue
        idx = _bar_idx(barriers_sec, n, tv)
        if idx < 0:
            continue
        try:
            amt = abs(float(row.get("amount") or 0.0))
        except (TypeError, ValueError):
            amt = 0.0
        if amt <= 0:
            continue
        sraw = str(row.get("side") or "").strip().lower()
        if "buy" in sraw:
            buy_vol[idx] += amt
        elif "sell" in sraw:
            sell_vol[idx] += amt
    return buy_vol, sell_vol


def _feat_tick_derived_buy_sell(
    feat_buy: list[float],
    feat_sell: list[float],
    *,
    ratio_cap: float = 1_000_000.0,
) -> tuple[list[float], list[float]]:
    """Volume tape: razão compra/venda e imbalanço (−1..1).

    ``feat_tick_buy_sell_ratio`` ≈ compra / venda (teto quando venda≈0).
    ``feat_tick_imbalance`` = (compra − venda) / (compra + venda).
    """
    n = len(feat_buy)
    ratio = [0.0] * n
    imb = [0.0] * n
    if n != len(feat_sell):
        return ratio, imb
    for i in range(n):
        try:
            b = float(feat_buy[i])
        except (TypeError, ValueError):
            b = 0.0
        try:
            s = float(feat_sell[i])
        except (TypeError, ValueError):
            s = 0.0
        if not math.isfinite(b):
            b = 0.0
        if not math.isfinite(s):
            s = 0.0
        b = max(b, 0.0)
        s = max(s, 0.0)
        if s <= 1e-14:
            ratio[i] = ratio_cap if b > 1e-14 else 0.0
        else:
            ratio[i] = min(b / s, ratio_cap)
        tot = b + s
        if tot > 1e-14:
            imb[i] = (b - s) / tot
        else:
            imb[i] = 0.0
    return ratio, imb


def _take_last_numeric_per_bucket(
    barriers_sec: list[float],
    n: int,
    rows: list[dict[str, Any]],
    col: str,
) -> tuple[list[float | None], list[int | None]]:
    """Por vela: valor da linha com ``local_ts`` mais recente nesse intervalo."""
    last_val: list[float | None] = [None] * n
    last_ts: list[int | None] = [None] * n
    for row in rows:
        ts_any = row.get("local_ts")
        if ts_any is None:
            continue
        tv = parse_ts_to_unix_sec(ts_any)
        if tv is None:
            continue
        idx = _bar_idx(barriers_sec, n, tv)
        if idx < 0:
            continue
        raw = row.get(col)
        if raw is None:
            continue
        try:
            v = float(raw)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(v):
            continue
        prev_t = last_ts[idx]
        if prev_t is None or tv >= prev_t:
            last_ts[idx] = int(tv)
            last_val[idx] = v
    return last_val, last_ts


def _series_optional_to_ffill(series_opt: list[float | None]) -> list[float]:
    base = [float("nan") if x is None else float(x) for x in series_opt]
    return _ffill_nan_leading_zeros(base)


def _feat_order_book_per_bar(barriers_sec: list[float], *, rows: list[dict[str, Any]]) -> tuple[list[float], list[float]]:
    """spread médio no intervalo + último imbalance (bid/ask depth ±1pct) por vela."""
    n = len(barriers_sec)
    spread_sum = [0.0] * n
    spread_cnt = [0] * n
    imb_val: list[float | None] = [None] * n
    imb_ts: list[int | None] = [None] * n
    if n == 0 or not rows:
        return [0.0] * n, [0.0] * n

    for row in rows:
        ts_any = row.get("local_ts")
        if ts_any is None:
            continue
        tv = parse_ts_to_unix_sec(ts_any)
        if tv is None:
            continue
        idx = _bar_idx(barriers_sec, n, tv)
        if idx < 0:
            continue
        try:
            bd = float(row.get("bid_depth_1pct") or 0.0)
            ad = float(row.get("ask_depth_1pct") or 0.0)
            sp = float(row.get("spread") or 0.0)
        except (TypeError, ValueError):
            continue
        if math.isfinite(sp) and sp >= 0:
            spread_sum[idx] += sp
            spread_cnt[idx] += 1
        tot = bd + ad
        imb = (bd - ad) / tot if tot > 0 else None
        if imb is None or not math.isfinite(imb):
            continue
        pt = imb_ts[idx]
        if pt is None or tv >= pt:
            imb_ts[idx] = int(tv)
            imb_val[idx] = imb

    spread_avg = [
        spread_sum[i] / spread_cnt[i] if spread_cnt[i] else 0.0 for i in range(n)
    ]
    imb_ff = _series_optional_to_ffill(imb_val)
    return spread_avg, imb_ff


async def compute_chart_footprint(
    client: httpx.AsyncClient,
    body: ChartFootprintBody,
) -> dict[str, Any]:
    t0 = time.perf_counter()
    bars = sorted(body.bars, key=lambda x: float(x.t))
    if not bars:
        return {"compute_ms": 0.0, "price_step": body.price_step or 1.0, "bars": []}
    barriers = [float(b.t) for b in bars]
    n = len(bars)
    step_est = max(30.0, barriers[1] - barriers[0]) if n >= 2 else 300.0
    price_step = float(body.price_step or _infer_price_step(bars))
    price_step = max(price_step, 1e-12)

    lo = ts_iso(int(barriers[0] * 1000))
    hi = ts_iso(int((barriers[-1] + step_est) * 1000))
    sid = int(body.symbol_id)
    q_tick = (
        "SELECT local_ts, price, amount, side FROM tick_trades "
        f"WHERE symbol_id = {sid} AND local_ts >= '{lo}' AND local_ts < '{hi}' "
        f"ORDER BY local_ts ASC LIMIT {int(body.tick_limit)}"
    )
    rows, err = await _safe_rows(client, q_tick)
    errors: list[str] = []
    if err:
        raise HTTPException(502, detail=f"tick_trades: {err}")

    buckets: list[dict[float, dict[str, float]]] = [{} for _ in range(n)]
    for row in rows:
        tv = parse_ts_to_unix_sec(row.get("local_ts"))
        if tv is None:
            continue
        idx = _bar_idx(barriers, n, tv)
        if idx < 0:
            continue
        price = row.get("price")
        amount = row.get("amount")
        try:
            px = float(price)
            amt = abs(float(amount or 0.0))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(px) or not math.isfinite(amt) or amt <= 0:
            continue
        level = round(px / price_step) * price_step
        side = str(row.get("side") or "").strip().lower()
        cell = buckets[idx].setdefault(level, {"buy": 0.0, "sell": 0.0})
        if "buy" in side:
            cell["buy"] += amt
        elif "sell" in side:
            cell["sell"] += amt

    out_bars: list[dict[str, Any]] = []
    max_levels = int(body.max_levels_per_bar)
    for i, by_price in enumerate(buckets):
        if not by_price:
            continue
        levels = []
        for px, v in by_price.items():
            buy = float(v.get("buy") or 0.0)
            sell = float(v.get("sell") or 0.0)
            total = buy + sell
            if total <= 0:
                continue
            levels.append(
                {
                    "price": float(px),
                    "buy": buy,
                    "sell": sell,
                    "delta": buy - sell,
                    "total": total,
                }
            )
        levels.sort(key=lambda x: float(x["total"]), reverse=True)
        levels = levels[:max_levels]
        levels.sort(key=lambda x: float(x["price"]), reverse=True)
        out_bars.append({"t": int(barriers[i]), "levels": levels})

    compute_ms = round((time.perf_counter() - t0) * 1000.0, 3)
    resp: dict[str, Any] = {
        "compute_ms": compute_ms,
        "price_step": price_step,
        "bars": out_bars,
        "ticks_used": len(rows),
        "truncated": len(rows) >= int(body.tick_limit),
    }
    if errors:
        resp["errors"] = errors
    return resp


@router.post("/api/chart/footprint")
async def api_chart_footprint(request: Request, body: ChartFootprintBody) -> dict[str, Any]:
    client: httpx.AsyncClient = getattr(request.app.state, "qdb_client", None)
    if client is None:
        raise HTTPException(status_code=503, detail="QuestDB cliente não inicializado.")
    return await compute_chart_footprint(client, body)


@router.post("/api/chart/footprint/jobs")
async def api_chart_footprint_job_start(body: ChartFootprintBody) -> dict[str, Any]:
    from chart_jobs import run_footprint_job

    try:
        return enqueue_chart_job(
            kind="footprint",
            payload=body.model_dump(mode="json"),
            func=run_footprint_job,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, detail=f"Redis/RQ indisponível: {e!s}") from e


@router.get("/api/chart/footprint/jobs/{job_id}")
async def api_chart_footprint_job_status(job_id: str) -> dict[str, Any]:
    return chart_job_status(job_id)


async def compute_chart_bar_features(
    client: httpx.AsyncClient,
    body: ChartBarFeaturesBody,
) -> dict[str, Any]:
    t0 = time.perf_counter()
    sorted_bars = sorted(body.bars, key=lambda x: float(x.t))
    n = len(sorted_bars)
    if n > _BAR_FEATURES_MAX_BARS:
        raise HTTPException(400, detail=f"máximo {_BAR_FEATURES_MAX_BARS} velas por pedido.")

    barriers = [float(b.t) for b in sorted_bars]
    sid = body.symbol_id
    errors: list[str] = []

    if n >= 2:
        step_est = max(30.0, barriers[1] - barriers[0])
    else:
        step_est = 3600.0
    ts_start_ms = int(barriers[0] * 1000)
    ts_end_ms = int((barriers[-1] + step_est * 4.0) * 1000)
    lo = ts_iso(ts_start_ms)
    hi = ts_iso(ts_end_ms)

    try:
        cached_raw, meta = await chart_features_from_1m_cache(
            client,
            sid,
            barriers,
            step_est,
            warm_missing=True,
        )
        coverage = float(meta.get("coverage") or 1.0)
        if body.raw_fallback and meta.get("warming") and coverage < 0.98:
            raise RuntimeError(
                f"chart_features_1m incompleto ({meta.get('coverage', 0):.0%}); usar raw fallback"
            )
        cached_features: dict[str, list[float]] = {
            k: _json_safe_float_list(v) for k, v in cached_raw.items()
        }
        compute_ms = round((time.perf_counter() - t0) * 1000.0, 3)
        out: dict[str, Any] = {
            "compute_ms": compute_ms,
            "features": cached_features,
            "errors": list(meta.get("errors") or []),
            "source": "chart_features_1m",
            "aggregate_inserted": int(meta.get("inserted") or 0),
            "aggregate_coverage": coverage,
        }
        if out["errors"] or (meta.get("warming") and coverage < 1.0):
            out["partial"] = True
        return out
    except Exception as e:  # noqa: BLE001 - mantém compatibilidade enquanto o agregado aquece
        errors.append(f"chart_features_1m fallback: {e!s}")

    q_liq = (
        f"SELECT local_ts, contracts, side FROM liquidations "
        f"WHERE symbol_id = {sid} AND local_ts >= '{lo}' AND local_ts <= '{hi}'"
    )
    q_tick = (
        f"SELECT local_ts, amount, side FROM tick_trades "
        f"WHERE symbol_id = {sid} AND local_ts >= '{lo}' AND local_ts <= '{hi}'"
    )
    q_oi = (
        f"SELECT local_ts, oi_amount FROM open_interest "
        f"WHERE symbol_id = {sid} AND local_ts >= '{lo}' AND local_ts <= '{hi}' "
        "ORDER BY local_ts ASC"
    )
    q_mf = (
        f"SELECT local_ts, mark_price, funding_rate, index_price FROM mark_price_funding "
        f"WHERE symbol_id = {sid} AND local_ts >= '{lo}' AND local_ts <= '{hi}' "
        "ORDER BY local_ts ASC"
    )
    q_ob = (
        f"SELECT local_ts, best_bid, best_ask, spread, bid_depth_1pct, ask_depth_1pct FROM order_book "
        f"WHERE symbol_id = {sid} AND local_ts >= '{lo}' AND local_ts <= '{hi}' "
        "ORDER BY local_ts ASC"
    )

    # Cinco tabelas independentes — correr em paralelo (antes: 5 round-trips sequenciais).
    (rows_liq, err_liq), (rows_tick, err_tick), (rows_oi, err_oi), (rows_mf, err_mf), (rows_ob, err_ob) = (
        await asyncio.gather(
            _safe_rows(client, q_liq),
            _safe_rows(client, q_tick),
            _safe_rows(client, q_oi),
            _safe_rows(client, q_mf),
            _safe_rows(client, q_ob),
        )
    )
    if err_liq:
        errors.append(f"liquidations: {err_liq}")
        rows_liq = []
    if err_tick:
        errors.append(f"tick_trades: {err_tick}")
        rows_tick = []
    if err_oi:
        errors.append(f"open_interest: {err_oi}")
        rows_oi = []
    if err_mf:
        errors.append(f"mark_price_funding: {err_mf}")
        rows_mf = []
    if err_ob:
        errors.append(f"order_book: {err_ob}")
        rows_ob = []

    feat_ll, feat_ls = _feat_liquidations_per_bar(barriers, rows=rows_liq)
    feat_tb, feat_ts = _feat_tick_buy_sell(barriers, rows=rows_tick)
    feat_tick_buy_sell_ratio, feat_tick_imbalance = _feat_tick_derived_buy_sell(feat_tb, feat_ts)

    oi_opt, _ = _take_last_numeric_per_bucket(barriers, n, rows_oi, "oi_amount")
    feat_oi_snap = _series_optional_to_ffill(oi_opt)

    mk_opt, _ = _take_last_numeric_per_bucket(barriers, n, rows_mf, "mark_price")
    fr_opt, _ = _take_last_numeric_per_bucket(barriers, n, rows_mf, "funding_rate")
    ix_opt, _ = _take_last_numeric_per_bucket(barriers, n, rows_mf, "index_price")
    feat_mark_px = _series_optional_to_ffill(mk_opt)
    feat_funding_rate = _series_optional_to_ffill(fr_opt)
    feat_index_px = _series_optional_to_ffill(ix_opt)

    feat_ob_spread_avg, feat_ob_imb_snap = _feat_order_book_per_bar(barriers, rows=rows_ob)

    compute_ms = round((time.perf_counter() - t0) * 1000.0, 3)

    raw_feats: dict[str, list[float]] = {
        "feat_liq_long": feat_ll,
        "feat_liq_short": feat_ls,
        "feat_tick_buy_vol": feat_tb,
        "feat_tick_sell_vol": feat_ts,
        "feat_tick_buy_sell_ratio": feat_tick_buy_sell_ratio,
        "feat_tick_imbalance": feat_tick_imbalance,
        "feat_oi_snap": feat_oi_snap,
        "feat_mark_px": feat_mark_px,
        "feat_funding_rate": feat_funding_rate,
        "feat_index_px": feat_index_px,
        "feat_ob_spread_avg": feat_ob_spread_avg,
        "feat_ob_imb_snap": feat_ob_imb_snap,
    }
    features: dict[str, list[float]] = {k: _json_safe_float_list(v) for k, v in raw_feats.items()}

    out: dict[str, Any] = {
        "compute_ms": compute_ms,
        "features": features,
        "errors": errors,
    }
    if errors:
        out["partial"] = True
    return out


@router.post("/api/chart/bar-features")
async def api_chart_bar_features(request: Request, body: ChartBarFeaturesBody) -> dict[str, Any]:
    client: httpx.AsyncClient = getattr(request.app.state, "qdb_client", None)
    if client is None:
        raise HTTPException(status_code=503, detail="QuestDB cliente não inicializado.")
    return await compute_chart_bar_features(client, body)


@router.post("/api/chart/bar-features/backfill-1m")
async def api_chart_bar_features_backfill_1m(
    request: Request,
    body: ChartFeaturesBackfillBody,
) -> dict[str, Any]:
    client: httpx.AsyncClient = getattr(request.app.state, "qdb_client", None)
    if client is None:
        raise HTTPException(status_code=503, detail="QuestDB cliente não inicializado.")
    results: list[dict[str, Any]] = []
    for sid in body.symbol_ids:
        if body.start_sec is None or body.end_sec is None:
            start_sec, end_sec = await infer_chart_features_1m_range(client, sid)
        else:
            start_sec, end_sec = int(body.start_sec), int(body.end_sec)
        results.append(
            await backfill_chart_features_1m_range(
                client,
                sid,
                start_sec,
                end_sec,
                chunk_minutes=int(body.chunk_minutes),
            )
        )
    return {
        "ok": True,
        "results": results,
        "inserted": sum(int(r.get("inserted") or 0) for r in results),
    }


@router.post("/api/chart/bar-features/jobs")
async def api_chart_bar_features_job_start(body: ChartBarFeaturesBody) -> dict[str, Any]:
    from chart_jobs import run_bar_features_job

    try:
        return enqueue_chart_job(
            kind="bar-features-v2",
            payload=body.model_dump(mode="json"),
            func=run_bar_features_job,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, detail=f"Redis/RQ indisponível: {e!s}") from e


@router.get("/api/chart/bar-features/jobs/{job_id}")
async def api_chart_bar_features_job_status(job_id: str) -> dict[str, Any]:
    return chart_job_status(job_id)
