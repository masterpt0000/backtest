"""
API HTTP para o dashboard Next.js: símbolos e velas (QuestDB /exec).

    python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload

Variáveis: QUESTDB_HTTP_URL, QUESTDB_CANDLES_TS_COL, BACKEND_CORS_ORIGINS (vírgulas)
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from dotenv import load_dotenv

_BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(_BACKEND_DIR / ".env")
from contextlib import asynccontextmanager
from typing import Any, Literal

import httpx
import orjson
from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, Field

from backtest_service import (
    job_get,
    job_request_cancel,
    list_vbt_strategy_stems,
    spawn_backtest_job,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

from strategy_loader import load_strategies_from_disk

from pg_db import database_url, init_db_schema, pg_healthcheck
from live_feed import LiveFeedHub
from live_routes import router as live_router
from preset_routes import router as presets_router

from questdb_client import (
    MAX_POINTS_CAP,
    SYMBOL_QUERIES,
    TIMEFRAME_TO_SAMPLE,
    async_questdb_exec_raw,
    build_candles_backward_query,
    candles_ts_column,
    is_valid_timeframe,
    questdb_http_base,
    rows_as_objects,
    rows_to_bars,
)

DEFAULT_INITIAL_LIMIT = 5000
EXEC_TIMEOUT = httpx.Timeout(120.0, connect=10.0)


class BacktestJobStartBody(BaseModel):
    mode: Literal["single", "optimize"] = "single"
    vbt_strategy: str = Field(..., min_length=1)
    symbol_ids: list[int] = Field(..., min_length=1)
    symbol_labels: dict[str, str] = Field(default_factory=dict)
    timeframe: str = "5m"
    range_preset: str = "30d"
    initial_cash: float = 10_000.0
    num_tests: int = Field(50, ge=1, le=5_000)
    max_tries: int = Field(500, ge=1, le=10_000)
    best_by: str = "return_pct"
    min_trades: int = Field(50, ge=1, le=5_000)
    optimize_seed: int | None = None
    optimize_grid_sample: Literal["lhs", "random"] = "lhs"
    optimize_top_k: int = Field(5, ge=1, le=20)
    optimize_holdout_ratio: float = Field(0.0, ge=0.0, lt=0.5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.qdb_client = httpx.AsyncClient(
        timeout=EXEC_TIMEOUT,
        limits=httpx.Limits(max_keepalive_connections=20, max_connections=100),
    )
    app.state.live_feed = LiveFeedHub()
    app.state.pg_error = None
    if database_url():
        err = init_db_schema()
        app.state.pg_error = err
    yield
    await app.state.live_feed.shutdown()
    await app.state.qdb_client.aclose()


app = FastAPI(title="Backtest API", default_response_class=ORJSONResponse, lifespan=lifespan)
app.include_router(presets_router)
app.include_router(live_router)

_origins = os.environ.get(
    "BACKEND_CORS_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def _http_error(_request: Request, exc: HTTPException) -> ORJSONResponse:
    d = exc.detail
    msg = d if isinstance(d, str) else orjson.dumps(d).decode()
    return ORJSONResponse(status_code=exc.status_code, content={"error": msg})


async def questdb_exec(client: httpx.AsyncClient, query: str) -> dict[str, Any]:
    try:
        return await async_questdb_exec_raw(client, query)
    except httpx.ConnectError as e:
        raise HTTPException(
            503,
            detail=(
                "Ligação à QuestDB falhou. Inicia o QuestDB (REST, por defeito "
                f"http://127.0.0.1:9000) ou ajusta QUESTDB_HTTP_URL no .env do backend. "
                f"Alvo: {base}"
            ),
        ) from e
    except httpx.TimeoutException as e:
        raise HTTPException(
            504,
            detail=f"QuestDB não respondeu a tempo. Alvo: {base}. ({e})",
        ) from e


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/postgres")
async def health_postgres() -> dict[str, Any]:
    """PostgreSQL: ``ok`` | ``disabled`` | ``error`` (schema na arranque em ``pg_error``)."""
    if not database_url():
        return {"postgres": "disabled", "detail": "DATABASE_URL não definido"}
    ok, msg = pg_healthcheck()
    out: dict[str, Any] = {"postgres": "ok" if ok else "error", "detail": msg}
    ge = getattr(app.state, "pg_error", None)
    if ge:
        out["schema_error"] = ge
    return out


@app.get("/health/questdb")
async def health_questdb() -> dict[str, str]:
    """Confirma ligação HTTP à QuestDB (útil quando o chart mostra erro de ligação)."""
    client: httpx.AsyncClient = app.state.qdb_client
    await questdb_exec(client, "SELECT 1")
    return {"questdb": "ok", "url": questdb_http_base()}


@app.get("/api/backtest/vbt-strategies")
async def api_backtest_vbt_strategies() -> dict[str, Any]:
    """Estratégias vectorbt (ficheiros ``*_vbt.py`` em ``my_strategies/``)."""
    return {"strategies": list_vbt_strategy_stems()}


@app.post("/api/backtest/jobs")
async def api_backtest_jobs_start(body: BacktestJobStartBody) -> dict[str, str]:
    """Inicia job em thread em background; usa lógica de ``monthly_scanner_vbt`` + QuestDB."""
    job_id = spawn_backtest_job(body.model_dump())
    return {"job_id": job_id}


@app.get("/api/backtest/jobs/{job_id}")
async def api_backtest_job_status(job_id: str) -> dict[str, Any]:
    row = job_get(job_id)
    if row is None:
        raise HTTPException(404, detail="job não encontrado")
    return row


@app.post("/api/backtest/jobs/{job_id}/cancel")
async def api_backtest_job_cancel(job_id: str) -> dict[str, bool]:
    if not job_request_cancel(job_id):
        raise HTTPException(404, detail="job não encontrado")
    return {"cancelled": True}


@app.get("/api/strategies")
async def list_strategies() -> dict[str, Any]:
    """Estratégias do chart (JSON em ``backend/my_strategies/``)."""
    strategies, errors = load_strategies_from_disk()
    return {"strategies": strategies, "load_errors": errors}


@app.get("/api/symbols")
async def list_symbols() -> dict[str, Any]:
    client: httpx.AsyncClient = app.state.qdb_client
    last_err: str | None = None
    for q in SYMBOL_QUERIES:
        try:
            data = await questdb_exec(client, q)
            rows = rows_as_objects(data)
            symbols: list[dict[str, Any]] = []
            for r in rows:
                sid = r.get("symbol_id")
                code = r.get("code")
                if sid is not None and code is not None:
                    try:
                        symbols.append({"symbol_id": int(sid), "code": str(code)})
                    except (TypeError, ValueError):
                        continue
            if symbols:
                return {"symbols": symbols}
        except HTTPException:
            raise
        except Exception as e:
            last_err = str(e)
            continue
    raise HTTPException(502, detail=last_err or "sem dados")


@app.get("/api/candles")
async def get_candles(
    symbol_id: int = Query(..., ge=1),
    timeframe: str = Query(...),
    before_ms: float = Query(0),
    limit: float = Query(0),
) -> dict[str, Any]:
    tf = timeframe.strip()
    if not tf or not is_valid_timeframe(tf):
        valid = ", ".join(TIMEFRAME_TO_SAMPLE.keys())
        raise HTTPException(400, detail=f"timeframe inválido. Usa: {valid}")
    end_ms = before_ms if before_ms and before_ms > 0 else time.time() * 1000
    lim = int(limit) if limit and limit > 0 else DEFAULT_INITIAL_LIMIT
    lim = min(MAX_POINTS_CAP, max(1, lim))

    try:
        ts_col = candles_ts_column()
    except ValueError as e:
        raise HTTPException(500, detail=str(e)) from e

    resolution, sql = build_candles_backward_query(
        symbol_id, tf, end_ms, lim, ts_col
    )
    client: httpx.AsyncClient = app.state.qdb_client
    try:
        data = await questdb_exec(client, sql)
    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, detail=e.response.text[:500]) from e
    except Exception as e:
        raise HTTPException(502, detail=str(e)) from e

    bars = rows_to_bars(rows_as_objects(data), ts_col)
    has_more = len(bars) >= lim
    oldest_ms = min(b["t"] for b in bars) * 1000 if bars else None

    return {
        "symbol_id": symbol_id,
        "timeframe": tf,
        "before_ms": end_ms,
        "resolution": resolution,
        "limit": lim,
        "count": len(bars),
        "has_more_older": has_more,
        "oldest_bar_ms": oldest_ms,
        "bars": bars,
    }


# Permite correr testes que importam a app sem uvicorn
__all__ = ["app"]
