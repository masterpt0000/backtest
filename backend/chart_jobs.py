"""
RQ job functions for chart data.

These wrappers keep the official calculations in Python and reuse the same
functions used by FastAPI synchronous fallback endpoints.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
from rq import get_current_job

from chart_bar_features_routes import (
    ChartBarFeaturesBody,
    ChartFootprintBody,
    compute_chart_bar_features,
    compute_chart_footprint,
)
from job_queue import set_cached_result

JOB_HTTP_TIMEOUT = httpx.Timeout(180.0, connect=10.0)


def _set_progress(progress: int) -> None:
    job = get_current_job()
    if job is None:
        return
    job.meta["progress"] = max(0, min(100, int(progress)))
    job.save_meta()


async def _with_client(coro_factory):
    async with httpx.AsyncClient(
        timeout=JOB_HTTP_TIMEOUT,
        limits=httpx.Limits(max_keepalive_connections=10, max_connections=20),
    ) as client:
        return await coro_factory(client)


def run_footprint_job(payload: dict[str, Any]) -> dict[str, Any]:
    _set_progress(5)
    body = ChartFootprintBody(**payload)

    async def _run(client: httpx.AsyncClient) -> dict[str, Any]:
        _set_progress(25)
        result = await compute_chart_footprint(client, body)
        _set_progress(95)
        return result

    result = asyncio.run(_with_client(_run))
    set_cached_result("footprint", payload, result)
    _set_progress(100)
    return result


def run_bar_features_job(payload: dict[str, Any]) -> dict[str, Any]:
    _set_progress(5)
    body = ChartBarFeaturesBody(**payload)

    async def _run(client: httpx.AsyncClient) -> dict[str, Any]:
        _set_progress(25)
        result = await compute_chart_bar_features(client, body)
        _set_progress(95)
        return result

    result = asyncio.run(_with_client(_run))
    set_cached_result("bar-features-v2", payload, result)
    _set_progress(100)
    return result
