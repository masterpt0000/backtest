"""
CRUD de presets de backtest (PostgreSQL: ``strategy_symbol_configs``).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from pg_db import get_engine
from pg_models import StrategySymbolConfig

router = APIRouter(prefix="/api/presets", tags=["presets"])


def _require_engine():
    eng = get_engine()
    if eng is None:
        raise HTTPException(
            503,
            detail="PostgreSQL não configurado (define DATABASE_URL no .env do backend).",
        )
    return eng


def _row_out(r: StrategySymbolConfig) -> dict[str, Any]:
    return {
        "id": r.id,
        "vbt_strategy_id": r.vbt_strategy_id,
        "symbol_id": r.symbol_id,
        "name": r.name,
        "params": r.params if isinstance(r.params, dict) else {},
        "notes": r.notes or "",
        "is_active": r.is_active,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


class PresetCreateBody(BaseModel):
    vbt_strategy_id: str = Field(..., min_length=1, max_length=128)
    symbol_id: int | None = Field(None, description="NULL = preset multi-par ou modelo")
    name: str = Field("", max_length=256)
    notes: str = ""
    params: dict[str, Any] = Field(default_factory=dict)


class PresetPatchBody(BaseModel):
    name: str | None = Field(None, max_length=256)
    notes: str | None = None
    params: dict[str, Any] | None = None
    is_active: bool | None = None


@router.get("")
def list_presets(
    vbt_strategy_id: str | None = Query(None),
    symbol_id: int | None = Query(None, description="Inclui presets desse par + presets sem par (globais)"),
) -> dict[str, Any]:
    eng = _require_engine()
    with Session(eng) as session:
        q = select(StrategySymbolConfig).where(StrategySymbolConfig.is_active.is_(True))
        if vbt_strategy_id:
            q = q.where(StrategySymbolConfig.vbt_strategy_id == vbt_strategy_id.strip())
        if symbol_id is not None:
            q = q.where(
                or_(
                    StrategySymbolConfig.symbol_id == symbol_id,
                    StrategySymbolConfig.symbol_id.is_(None),
                )
            )
        q = q.order_by(StrategySymbolConfig.updated_at.desc())
        rows = session.scalars(q).all()
        return {"presets": [_row_out(r) for r in rows]}


@router.get("/{preset_id}")
def get_preset(preset_id: int) -> dict[str, Any]:
    eng = _require_engine()
    with Session(eng) as session:
        r = session.get(StrategySymbolConfig, preset_id)
        if r is None:
            raise HTTPException(404, detail="preset não encontrado")
        return _row_out(r)


@router.post("")
def create_preset(body: PresetCreateBody) -> dict[str, Any]:
    eng = _require_engine()
    params = dict(body.params) if body.params else {}
    with Session(eng) as session:
        rec = StrategySymbolConfig(
            vbt_strategy_id=body.vbt_strategy_id.strip(),
            symbol_id=body.symbol_id,
            name=(body.name or "").strip() or "Sem nome",
            notes=body.notes or "",
            params=params,
            is_active=True,
        )
        session.add(rec)
        session.commit()
        session.refresh(rec)
        return _row_out(rec)


@router.patch("/{preset_id}")
def patch_preset(preset_id: int, body: PresetPatchBody) -> dict[str, Any]:
    eng = _require_engine()
    with Session(eng) as session:
        r = session.get(StrategySymbolConfig, preset_id)
        if r is None:
            raise HTTPException(404, detail="preset não encontrado")
        if body.name is not None:
            r.name = body.name.strip() or r.name
        if body.notes is not None:
            r.notes = body.notes
        if body.params is not None:
            r.params = dict(body.params)
        if body.is_active is not None:
            r.is_active = body.is_active
        r.updated_at = datetime.now(timezone.utc)
        session.commit()
        session.refresh(r)
        return _row_out(r)


@router.delete("/{preset_id}")
def delete_preset(preset_id: int) -> dict[str, bool]:
    eng = _require_engine()
    with Session(eng) as session:
        r = session.get(StrategySymbolConfig, preset_id)
        if r is None:
            raise HTTPException(404, detail="preset não encontrado")
        session.delete(r)
        session.commit()
        return {"deleted": True}
