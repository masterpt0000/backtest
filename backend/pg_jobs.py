"""
Persistência opcional de jobs de backtest em PostgreSQL.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete
from sqlalchemy.orm import Session

from pg_db import get_engine
from pg_models import BacktestJobRecord, BacktestResultRow


def _ts(ts: float | None) -> datetime | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(float(ts), tz=timezone.utc)


def persist_job_upsert(job_id: str, row: dict[str, Any]) -> None:
    """
    Grava ou actualiza o estado do job.
    Ignora silenciosamente se ``DATABASE_URL`` não estiver definido.
    Falhas de PostgreSQL não interrompem o backtest.
    """
    eng = get_engine()
    if eng is None:
        return
    try:
        jid = uuid.UUID(job_id)
    except ValueError:
        return

    started = _ts(row.get("started_at")) or datetime.now(timezone.utc)
    finished = _ts(row.get("finished_at"))

    try:
        with Session(eng) as session:
            rec = session.get(BacktestJobRecord, jid)
            if rec is None:
                rec = BacktestJobRecord(
                    id=jid,
                    status=str(row.get("status") or "unknown"),
                    progress=int(row.get("progress") or 0),
                    phase=str(row.get("phase") or ""),
                    payload_summary=row.get("payload_summary"),
                    request_payload=row.get("request_payload"),
                    results=row.get("results"),
                    error=row.get("error"),
                    started_at=started,
                    finished_at=finished,
                )
                session.add(rec)
            else:
                rec.status = str(row.get("status") or rec.status)
                rec.progress = int(row.get("progress") or 0)
                rec.phase = str(row.get("phase") or "")
                if "payload_summary" in row:
                    rec.payload_summary = row.get("payload_summary")
                if "request_payload" in row:
                    rec.request_payload = row.get("request_payload")
                if "results" in row:
                    rec.results = row.get("results")
                if "error" in row:
                    rec.error = row.get("error")
                rec.finished_at = finished
            session.commit()
    except Exception:
        return

    st = row.get("status")
    try:
        if st == "completed":
            _replace_result_rows(jid, row.get("results") or [])
        elif st == "error":
            _replace_result_rows(jid, [])
    except Exception:
        pass


def _replace_result_rows(job_uuid: uuid.UUID, results: list[Any]) -> None:
    eng = get_engine()
    if eng is None:
        return
    try:
        with Session(eng) as session:
            session.execute(delete(BacktestResultRow).where(BacktestResultRow.job_id == job_uuid))
            for item in results:
                if not isinstance(item, dict):
                    continue
                sym = str(item.get("symbol") or item.get("base") or "?")[:64]
                rank = item.get("optimize_rank")
                rk = int(rank) if rank is not None else None
                metrics = {
                    k: item[k]
                    for k in item
                    if k
                    not in (
                        "best_params",
                        "symbol",
                        "base",
                        "optimize_rank",
                    )
                }
                bp = item.get("best_params")
                best_params = bp if isinstance(bp, dict) else None
                session.add(
                    BacktestResultRow(
                        job_id=job_uuid,
                        symbol_label=sym,
                        optimize_rank=rk,
                        metrics=metrics,
                        best_params=best_params,
                    )
                )
            session.commit()
    except Exception:
        pass
