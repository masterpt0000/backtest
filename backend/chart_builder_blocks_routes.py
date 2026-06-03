"""
CRUD de blocos reutilizáveis do construtor visual.

Os blocos são templates globais guardados em PostgreSQL. Ao inserir um bloco
numa estratégia, o frontend copia o conteúdo para o spec da estratégia.
"""

from __future__ import annotations

import re
import uuid
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from pg_db import get_engine
from pg_models import ChartBuilderBlock

router = APIRouter(prefix="/api/chart/builder-blocks", tags=["chart-builder"])

BLOCK_KINDS = frozenset(
    {
        "filter",
        "zone_long",
        "zone_short",
        "entry_long",
        "entry_short",
        "exit_long",
        "exit_short",
        "group",
    }
)
REF_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\[(?:\d+)\])?(?:\.(?:upper|mid|lower))?$")
CALL_RE = re.compile(r"\b(?:ema|sma|rsi|delta|roc|abs|min|max|normalise|normalize)\s*\(", re.I)
RESERVED = {
    "and",
    "or",
    "not",
    "true",
    "false",
    "ema",
    "sma",
    "rsi",
    "delta",
    "roc",
    "abs",
    "min",
    "max",
    "normalise",
    "normalize",
}


def _require_engine():
    eng = get_engine()
    if eng is None:
        raise HTTPException(
            503,
            detail="PostgreSQL não configurado (define DATABASE_URL no .env do backend).",
        )
    return eng


def _refs_from_if_line(line: str | None) -> list[str]:
    if not line:
        return []
    cleaned = CALL_RE.sub("(", line)
    out: set[str] = set()
    for token in re.findall(r"[A-Za-z_][A-Za-z0-9_]*(?:\[(?:\d+)\])?(?:\.(?:upper|mid|lower))?", cleaned):
        base = token.split("[", 1)[0].split(".", 1)[0]
        if base.lower() in RESERVED:
            continue
        out.add(token)
    return sorted(out)


class BuilderBlockSpecIn(BaseModel):
    model_config = {"extra": "allow"}

    ifLine: str = Field(..., min_length=1, max_length=4096)
    expr: dict[str, Any] | None = None
    waitCandles: int | None = Field(None, ge=0, le=500)
    requiredIndicators: list[dict[str, Any]] = Field(default_factory=list)
    requiredRefs: list[str] = Field(default_factory=list)
    requiredFacts: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_refs(self) -> "BuilderBlockSpecIn":
        refs = set(self.requiredRefs)
        for ref in _refs_from_if_line(self.ifLine):
            refs.add(ref)
        for ref in refs:
            if not REF_RE.fullmatch(ref):
                raise ValueError(f"referência inválida no bloco: {ref!r}")
        self.requiredRefs = sorted(refs)
        self.requiredFacts = sorted(
            {r.split("[", 1)[0].split(".", 1)[0].lower() for r in refs if r.lower().startswith("feat_")}
        )
        return self


class BuilderBlockBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    kind: Literal[
        "filter",
        "zone_long",
        "zone_short",
        "entry_long",
        "entry_short",
        "exit_long",
        "exit_short",
        "group",
    ]
    description: str = Field("", max_length=4096)
    spec: BuilderBlockSpecIn


def _row_to_dict(row: ChartBuilderBlock) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name or "",
        "kind": row.kind,
        "description": row.description or "",
        "spec": row.spec if isinstance(row.spec, dict) else {},
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.get("")
def list_builder_blocks() -> dict[str, Any]:
    eng = get_engine()
    if eng is None:
        return {"blocks": [], "postgres": "disabled"}
    with Session(eng) as session:
        rows = session.scalars(
            select(ChartBuilderBlock).order_by(ChartBuilderBlock.updated_at.desc())
        ).all()
        return {"blocks": [_row_to_dict(r) for r in rows], "postgres": "ok"}


@router.post("")
def create_builder_block(body: BuilderBlockBody) -> dict[str, Any]:
    eng = _require_engine()
    row = ChartBuilderBlock(
        id=uuid.uuid4(),
        name=body.name.strip(),
        kind=body.kind,
        description=body.description.strip(),
        spec=body.spec.model_dump(mode="json"),
    )
    with Session(eng) as session:
        session.add(row)
        session.commit()
        session.refresh(row)
    return _row_to_dict(row)


@router.put("/{block_id:uuid}")
def put_builder_block(block_id: uuid.UUID, body: BuilderBlockBody) -> dict[str, Any]:
    eng = _require_engine()
    with Session(eng) as session:
        row = session.get(ChartBuilderBlock, block_id)
        if row is None:
            raise HTTPException(404, detail="bloco não encontrado")
        row.name = body.name.strip()
        row.kind = body.kind
        row.description = body.description.strip()
        row.spec = body.spec.model_dump(mode="json")
        session.commit()
        session.refresh(row)
    return _row_to_dict(row)


@router.delete("/{block_id:uuid}")
def delete_builder_block(block_id: uuid.UUID) -> dict[str, Any]:
    eng = _require_engine()
    with Session(eng) as session:
        row = session.get(ChartBuilderBlock, block_id)
        if row is None:
            raise HTTPException(404, detail="bloco não encontrado")
        session.delete(row)
        session.commit()
    return {"deleted": True}
