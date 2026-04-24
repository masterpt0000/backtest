"""
Live: arranque do ``store.py`` (ingest CCXT → QuestDB), snapshot em QuestDB **ou** feed directo.

Com query ``code=`` (par CCXT, ex. ``BTC/USDT:USDT``), snapshot e ``/candles`` usam **memória + CCXT Pro**
sem ler QuestDB. O ``store.py`` pode continuar a gravar em paralelo.
Desliga o arranque remoto do store via ``LIVE_STORE_DISABLED=1``.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Query, Request

from live_signal_engine import evaluate_demo_signal
from live_scalp_engine import evaluate_scalp_signal
from questdb_client import (
    async_questdb_exec_raw,
    is_valid_timeframe,
    parse_ts_to_unix_sec,
    rows_as_objects,
)

_REPO_ROOT = Path(__file__).resolve().parent.parent
_STORE_SCRIPT = _REPO_ROOT / "store.py"

_lock = threading.Lock()
_store_proc: subprocess.Popen | None = None

router = APIRouter(prefix="/api/live", tags=["live"])


def live_store_api_enabled() -> bool:
    return os.environ.get("LIVE_STORE_DISABLED", "").strip().lower() not in (
        "1",
        "true",
        "yes",
        "on",
    )


def _json_ts(v: Any) -> int | None:
    return parse_ts_to_unix_sec(v)


async def _safe_rows(
    client: httpx.AsyncClient, query: str
) -> tuple[list[dict[str, Any]], str | None]:
    try:
        data = await async_questdb_exec_raw(client, query)
        return rows_as_objects(data), None
    except httpx.HTTPStatusError as e:
        body = (e.response.text or "")[:400]
        return [], f"HTTP {e.response.status_code}: {body or str(e)}"
    except (httpx.ConnectError, httpx.TimeoutException, OSError) as e:
        return [], f"{type(e).__name__}: {e}"
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"


@router.post("/store/start")
async def store_start() -> dict[str, Any]:
    if not live_store_api_enabled():
        raise HTTPException(
            403,
            detail="Arranque remoto do store desligado. Remove LIVE_STORE_DISABLED ou corre store.py manualmente.",
        )
    global _store_proc
    if not _STORE_SCRIPT.is_file():
        raise HTTPException(
            500,
            detail=f"Ficheiro store.py não encontrado em {_STORE_SCRIPT}. Ajusta a estrutura do repo.",
        )
    creationflags = 0
    if sys.platform == "win32":
        creationflags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
    with _lock:
        if _store_proc is not None and _store_proc.poll() is None:
            return {"running": True, "pid": _store_proc.pid, "started": False}
        try:
            _store_proc = subprocess.Popen(
                [sys.executable, str(_STORE_SCRIPT)],
                cwd=str(_REPO_ROOT),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creationflags,
            )
        except OSError as e:
            raise HTTPException(500, detail=f"Não foi possível arrancar store.py: {e}") from e
        return {"running": True, "pid": _store_proc.pid, "started": True}


@router.post("/store/stop")
async def store_stop() -> dict[str, Any]:
    global _store_proc
    with _lock:
        if _store_proc is None or _store_proc.poll() is not None:
            _store_proc = None
            return {"running": False, "pid": None}
        _store_proc.terminate()
        try:
            _store_proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            _store_proc.kill()
            try:
                _store_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        _store_proc = None
        return {"running": False, "pid": None}


@router.get("/store/status")
async def store_status() -> dict[str, Any]:
    with _lock:
        if _store_proc is None or _store_proc.poll() is not None:
            return {"running": False, "pid": None}
        return {"running": True, "pid": _store_proc.pid}


@router.get("/candles")
async def live_candles(
    request: Request,
    symbol_id: int = Query(..., ge=1),
    code: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
    limit: int = Query(2000, ge=10, le=5000),
) -> dict[str, Any]:
    if not is_valid_timeframe(timeframe):
        raise HTTPException(status_code=400, detail=f"timeframe inválido: {timeframe}")
    hub = getattr(request.app.state, "live_feed", None)
    if hub is None:
        raise HTTPException(
            status_code=503, detail="Feed live em memória não inicializado no servidor."
        )
    try:
        feed = await hub.ensure(int(symbol_id), code)
        bars = await feed.fetch_ohlcv(timeframe, limit)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"bars": bars, "has_more_older": False, "live_source": "memory"}


@router.get("/signal")
async def live_signal(
    request: Request,
    symbol_id: int = Query(..., ge=1),
    code: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
    strategy: Literal["scalp", "demo"] = Query(
        "scalp",
        description="scalp = multistream (tape+livro+velas+funding+OI+liqs); demo = RSI+ATR+livro",
    ),
    limit: int = Query(220, ge=80, le=2000),
    rsi_period: int = Query(14, ge=2, le=50),
    atr_period: int = Query(14, ge=2, le=50),
    rsi_oversold: float = Query(35.0, ge=1.0, le=50.0),
    rsi_overbought: float = Query(65.0, ge=50.0, le=99.0),
    book_thresh: float = Query(0.05, ge=0.0, le=0.5),
    sl_atr: float = Query(1.5, ge=0.25, le=10.0),
    tp_atr: float = Query(2.5, ge=0.25, le=20.0),
    use_book_filter: bool = Query(True),
    scalp_atr_period: int = Query(7, ge=2, le=30),
    scalp_min_score: float = Query(2.35, ge=0.5, le=6.0),
    scalp_sl_atr: float = Query(0.68, ge=0.2, le=5.0),
    scalp_tp_atr: float = Query(1.05, ge=0.2, le=8.0),
    scalp_tape_window_sec: int = Query(72, ge=15, le=300),
    scalp_liq_window_sec: int = Query(160, ge=30, le=600),
) -> dict[str, Any]:
    """
    Sinal live em memória: **scalp** (multistream) ou **demo** (RSI+ATR+livro).
    """
    if not is_valid_timeframe(timeframe):
        raise HTTPException(status_code=400, detail=f"timeframe inválido: {timeframe}")
    hub = getattr(request.app.state, "live_feed", None)
    if hub is None:
        raise HTTPException(
            status_code=503, detail="Feed live em memória não inicializado no servidor."
        )
    try:
        feed = await hub.ensure(int(symbol_id), code)
        bars = await feed.fetch_ohlcv(timeframe, limit)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if strategy == "scalp":
        now_sec = int(time.time())
        ticks = list(feed.ticks)
        oi_s = list(feed.open_interest_series)
        ob_all = list(feed.order_book_series)
        liqs = list(feed.liquidations)
        fund = feed.funding
        ev = evaluate_scalp_signal(
            bars,
            ticks,
            fund,
            oi_s,
            ob_all,
            liqs,
            now_sec,
            atr_period=scalp_atr_period,
            min_abs_score=scalp_min_score,
            sl_atr=scalp_sl_atr,
            tp_atr=scalp_tp_atr,
            tape_window_sec=scalp_tape_window_sec,
            liq_window_sec=scalp_liq_window_sec,
        )
        disclaimer = (
            "Scalping multistream (exemplo): agrega microestrutura e velas; não é "
            "aconselhamento financeiro. Latência, slippage e snapshots incompletos alteram resultados reais."
        )
        strat_id = "scalp_multistream"
    else:
        book_imb: float | None = None
        ob_all = list(feed.order_book_series)
        if ob_all:
            raw_im = ob_all[-1].get("imbalance")
            if raw_im is not None:
                try:
                    book_imb = float(raw_im)
                except (TypeError, ValueError):
                    book_imb = None

        ev = evaluate_demo_signal(
            bars,
            book_imb,
            rsi_period=rsi_period,
            atr_period=atr_period,
            rsi_oversold=rsi_oversold,
            rsi_overbought=rsi_overbought,
            book_thresh=book_thresh,
            sl_atr=sl_atr,
            tp_atr=tp_atr,
            use_book_filter=use_book_filter,
        )
        disclaimer = (
            "Exemplo técnico apenas (RSI+ATR+livro). Não é aconselhamento financeiro. "
            "Métricas do livro são snapshots agregados, não execução garantida."
        )
        strat_id = "demo_rsi_atr_book"

    return {
        "symbol_id": int(symbol_id),
        "code": str(code).strip(),
        "timeframe": timeframe.strip(),
        "strategy": strat_id,
        "disclaimer": disclaimer,
        "live_source": "memory",
        **ev,
    }


@router.get("/snapshot")
async def live_snapshot(
    request: Request,
    symbol_id: int = Query(..., ge=1),
    code: str | None = Query(None),
    ticks_limit: int = Query(120, ge=1, le=500),
    series_limit: int = Query(90, ge=10, le=500),
    liq_limit: int = Query(50, ge=1, le=600),
) -> dict[str, Any]:
    sid = int(symbol_id)
    if code is not None and str(code).strip():
        hub = getattr(request.app.state, "live_feed", None)
        if hub is None:
            raise HTTPException(
                status_code=503, detail="Feed live em memória não inicializado no servidor."
            )
        try:
            feed = await hub.ensure(sid, str(code))
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        return feed.build_snapshot(
            ticks_limit=ticks_limit, series_limit=series_limit, liq_limit=liq_limit
        )

    client: httpx.AsyncClient = request.app.state.qdb_client
    errors: list[str] = []

    ticks: list[dict[str, Any]] = []
    q_ticks = (
        f"SELECT local_ts, price, amount, trade_id, side "
        f"FROM tick_trades WHERE symbol_id = {sid} "
        f"ORDER BY local_ts DESC LIMIT {ticks_limit}"
    )
    rows, err = await _safe_rows(client, q_ticks)
    if err:
        q2 = (
            f"SELECT local_ts, price, amount, trade_id "
            f"FROM tick_trades WHERE symbol_id = {sid} "
            f"ORDER BY local_ts DESC LIMIT {ticks_limit}"
        )
        rows, err2 = await _safe_rows(client, q2)
        if err2:
            errors.append(f"tick_trades: {err}")
        else:
            err = None
    if not err:
        for r in rows:
            t = _json_ts(r.get("local_ts"))
            if t is None:
                continue
            try:
                tick: dict[str, Any] = {
                    "t": t,
                    "price": float(r["price"]),
                    "amount": float(r["amount"]),
                    "trade_id": str(r.get("trade_id") or ""),
                }
            except (KeyError, TypeError, ValueError):
                continue
            s = r.get("side")
            if s is not None:
                tick["side"] = str(s)
            ticks.append(tick)

    funding: dict[str, Any] | None = None
    q_f = (
        f"SELECT mark_price, funding_rate, index_price, next_funding_time, "
        f"exchange_ts, local_ts "
        f"FROM mark_price_funding WHERE symbol_id = {sid} "
        f"ORDER BY local_ts DESC LIMIT 1"
    )
    fr, fe = await _safe_rows(client, q_f)
    if fe:
        errors.append(f"mark_price_funding: {fe}")
    elif fr:
        r0 = fr[0]
        lt = _json_ts(r0.get("local_ts"))
        if lt is not None:
            funding = {
                "t": lt,
                "mark_price": r0.get("mark_price"),
                "funding_rate": r0.get("funding_rate"),
                "index_price": r0.get("index_price"),
                "next_funding_time": _json_ts(r0.get("next_funding_time")),
                "exchange_ts": _json_ts(r0.get("exchange_ts")),
            }

    oi_series: list[dict[str, Any]] = []
    q_oi = (
        f"SELECT local_ts, oi_amount FROM open_interest WHERE symbol_id = {sid} "
        f"ORDER BY local_ts DESC LIMIT {series_limit}"
    )
    oir, oie = await _safe_rows(client, q_oi)
    if oie:
        errors.append(f"open_interest: {oie}")
    else:
        for r in reversed(oir):
            t = _json_ts(r.get("local_ts"))
            if t is None:
                continue
            try:
                oi_series.append({"t": t, "oi": float(r["oi_amount"])})
            except (KeyError, TypeError, ValueError):
                continue

    book_series: list[dict[str, Any]] = []
    q_ob = (
        f"SELECT local_ts, best_bid, best_ask, spread, bid_depth_1pct, ask_depth_1pct "
        f"FROM order_book WHERE symbol_id = {sid} "
        f"ORDER BY local_ts DESC LIMIT {series_limit}"
    )
    obr, obe = await _safe_rows(client, q_ob)
    if obe:
        errors.append(f"order_book: {obe}")
    else:
        for r in reversed(obr):
            t = _json_ts(r.get("local_ts"))
            if t is None:
                continue
            try:
                bb = float(r["best_bid"])
                ba = float(r["best_ask"])
                bd = float(r.get("bid_depth_1pct") or 0)
                ad = float(r.get("ask_depth_1pct") or 0)
                tot = bd + ad
                imb = (bd - ad) / tot if tot > 0 else None
                book_series.append(
                    {
                        "t": t,
                        "best_bid": bb,
                        "best_ask": ba,
                        "spread": float(r.get("spread") or (ba - bb)),
                        "bid_depth_1pct": bd,
                        "ask_depth_1pct": ad,
                        "imbalance": imb,
                    }
                )
            except (KeyError, TypeError, ValueError):
                continue

    liquidations: list[dict[str, Any]] = []
    q_l = (
        f"SELECT local_ts, price, contracts, side "
        f"FROM liquidations WHERE symbol_id = {sid} "
        f"ORDER BY local_ts DESC LIMIT {liq_limit}"
    )
    lr, le = await _safe_rows(client, q_l)
    if le:
        q_l2 = (
            f"SELECT local_ts, price, contracts "
            f"FROM liquidations WHERE symbol_id = {sid} "
            f"ORDER BY local_ts DESC LIMIT {liq_limit}"
        )
        lr, le2 = await _safe_rows(client, q_l2)
        if le2:
            errors.append(f"liquidations: {le}")
        else:
            le = None
    if not le:
        for r in lr:
            t = _json_ts(r.get("local_ts"))
            if t is None:
                continue
            try:
                item: dict[str, Any] = {
                    "t": t,
                    "price": float(r["price"]) if r.get("price") is not None else None,
                    "contracts": float(r["contracts"]) if r.get("contracts") is not None else None,
                }
            except (TypeError, ValueError):
                continue
            s = r.get("side")
            if s is not None:
                item["side"] = str(s)
            liquidations.append(item)

    now_sec = int(__import__("time").time())
    last_tick_sec = ticks[0]["t"] if ticks else None
    stale_sec = (now_sec - last_tick_sec) if last_tick_sec is not None else None

    return {
        "symbol_id": sid,
        "server_now_sec": now_sec,
        "last_tick_stale_sec": stale_sec,
        "ticks": ticks,
        "funding": funding,
        "open_interest_series": oi_series,
        "order_book_series": book_series,
        "liquidations": liquidations,
        "errors": errors,
        "live_source": "questdb",
    }
