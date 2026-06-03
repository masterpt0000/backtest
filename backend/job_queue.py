"""
Redis/RQ helpers for chart jobs.

RQ is deliberately only orchestration: the math stays in Python worker functions.
"""

from __future__ import annotations

import hashlib
import os
from typing import Any, Callable

import orjson
import redis
from rq import Queue
from rq.job import Job

DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"
DEFAULT_QUEUE = "chart"
DEFAULT_RESULT_TTL = 60 * 60
DEFAULT_FAILURE_TTL = 60 * 30
DEFAULT_JOB_TIMEOUT = 60 * 20
CACHE_PREFIX = "chart-job-cache"


def redis_url() -> str:
    return os.environ.get("REDIS_URL", DEFAULT_REDIS_URL).strip() or DEFAULT_REDIS_URL


def queue_name() -> str:
    return os.environ.get("RQ_QUEUE_NAME", DEFAULT_QUEUE).strip() or DEFAULT_QUEUE


def redis_conn() -> redis.Redis:
    return redis.Redis.from_url(redis_url(), decode_responses=False)


def rq_queue() -> Queue:
    return Queue(queue_name(), connection=redis_conn())


def stable_payload_hash(payload: Any) -> str:
    raw = orjson.dumps(payload, option=orjson.OPT_SORT_KEYS)
    return hashlib.blake2b(raw, digest_size=20).hexdigest()


def cache_key(kind: str, payload: Any) -> str:
    return f"{CACHE_PREFIX}:{kind}:{stable_payload_hash(payload)}"


def get_cached_result(kind: str, payload: Any) -> dict[str, Any] | None:
    raw = redis_conn().get(cache_key(kind, payload))
    if not raw:
        return None
    try:
        parsed = orjson.loads(raw)
    except orjson.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def set_cached_result(kind: str, payload: Any, result: dict[str, Any], ttl: int = DEFAULT_RESULT_TTL) -> None:
    redis_conn().setex(cache_key(kind, payload), ttl, orjson.dumps(result))


def enqueue_chart_job(
    *,
    kind: str,
    payload: dict[str, Any],
    func: Callable[..., dict[str, Any]],
    timeout: int = DEFAULT_JOB_TIMEOUT,
) -> dict[str, Any]:
    cached = get_cached_result(kind, payload)
    if cached is not None:
        return {
            "job_id": f"cache:{stable_payload_hash(payload)}",
            "status": "finished",
            "cached": True,
            "result": cached,
        }

    q = rq_queue()
    key = cache_key(kind, payload)
    existing_id = redis_conn().get(f"{key}:job_id")
    if existing_id:
        jid = existing_id.decode("utf-8") if isinstance(existing_id, bytes) else str(existing_id)
        return {"job_id": jid, "status": "queued", "cached": False}

    job = q.enqueue(
        func,
        payload,
        job_timeout=timeout,
        result_ttl=DEFAULT_RESULT_TTL,
        failure_ttl=DEFAULT_FAILURE_TTL,
        meta={"kind": kind, "progress": 0, "cache_key": key},
    )
    redis_conn().setex(f"{key}:job_id", DEFAULT_RESULT_TTL, job.id)
    return {"job_id": job.id, "status": "queued", "cached": False}


def chart_job_status(job_id: str) -> dict[str, Any]:
    if job_id.startswith("cache:"):
        return {"job_id": job_id, "status": "finished", "cached": True}
    try:
        job = Job.fetch(job_id, connection=redis_conn())
    except Exception as e:  # noqa: BLE001
        return {"job_id": job_id, "status": "missing", "error": str(e)}

    status = job.get_status(refresh=True)
    out: dict[str, Any] = {
        "job_id": job.id,
        "status": str(status),
        "progress": int(job.meta.get("progress") or 0),
        "cached": False,
    }
    if job.is_finished:
        out["status"] = "finished"
        out["progress"] = 100
        out["result"] = job.result
    elif job.is_failed:
        out["status"] = "failed"
        out["error"] = job.exc_info or "job failed"
    return out
