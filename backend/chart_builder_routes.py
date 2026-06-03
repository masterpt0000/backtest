"""
CRUD de estratégias do construtor visual (PostgreSQL: ``chart_builder_strategies``).
"""

from __future__ import annotations

import re
import uuid
from typing import Annotated, Any, Literal, Union

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from pg_db import get_engine
from pg_models import ChartBuilderStrategy

router = APIRouter(prefix="/api/chart/builder-strategies", tags=["chart-builder"])

INDICATOR_KINDS = frozenset({"sma", "atr", "macd", "talib", "derived", "trend_composite"})
OPS = frozenset({"cross_up", "cross_down", "gt", "lt", "ge", "le", "eq"})
BB_BANDS = frozenset({"upper", "mid", "lower"})
# Operandos especiais aceites nas ``if lines`` (fecho OHLC das velas da simulação).
SPECIAL_OPERAND_REFS = frozenset({"close"})
# Séries facetas vindas das tabelas fact (liquidations etc.) — mesmo prefixo no front/back.
FEAT_OPERAND_RE = re.compile(r"^feat_[a-z][a-z0-9_]*$", re.I)


def _allowed_operand_ref(ref: str, indicator_ids: set[str]) -> bool:
    return ref in SPECIAL_OPERAND_REFS or ref in indicator_ids or bool(FEAT_OPERAND_RE.fullmatch(ref))




def _require_engine():
    eng = get_engine()
    if eng is None:
        raise HTTPException(
            503,
            detail="PostgreSQL não configurado (define DATABASE_URL no .env do backend).",
        )
    return eng


class OperandIndicator(BaseModel):
    type: Literal["indicator"] = "indicator"
    ref: str = Field(..., min_length=1, max_length=128)
    bollingerBand: Literal["upper", "mid", "lower"] | None = None
    shift: int = Field(0, ge=0, le=500)


class OperandConstant(BaseModel):
    type: Literal["constant"] = "constant"
    value: float


class OperandEntrySnap(BaseModel):
    """Valor memorizado do indicador na entrada (saídas com ``entry(...)``)."""

    type: Literal["entry_snap"] = "entry_snap"
    ref: str = Field(..., min_length=1, max_length=128)
    bollingerBand: Literal["upper", "mid", "lower"] | None = None


class OperandAdjusted(BaseModel):
    """``valor(inner) + add`` — ex.: ``entry(t1, 50)`` → inner entry_snap(t1), add 50."""

    type: Literal["adjusted"] = "adjusted"
    inner: OperandEntrySnap
    add: float


BuilderOperandIn = Annotated[
    Union[OperandIndicator, OperandConstant, OperandEntrySnap, OperandAdjusted],
    Field(discriminator="type"),
]


class BuilderConditionIn(BaseModel):
    left: BuilderOperandIn
    right: BuilderOperandIn
    op: Literal["cross_up", "cross_down", "gt", "lt", "ge", "le", "eq"]


class BuilderLogicExprIn(BaseModel):
    """Árvore AND/OR: ``atom`` = condição; ``all`` / ``any`` = grupos (parêntesis)."""

    kind: Literal["atom", "all", "any"]
    condition: BuilderConditionIn | None = None
    children: list["BuilderLogicExprIn"] | None = None

    @model_validator(mode="after")
    def kind_shape(self) -> BuilderLogicExprIn:
        if self.kind == "atom":
            if self.condition is None:
                raise ValueError("atom exige condition")
            if self.children:
                raise ValueError("atom não pode ter children")
        else:
            if self.condition is not None:
                raise ValueError("all/any não usam condition")
            if not self.children or len(self.children) < 1:
                raise ValueError("all/any exigem pelo menos um filho")
        return self


class BuilderEntryRuleIn(BaseModel):
    applyFilter: bool = False
    ifLine: str | None = Field(None, max_length=4096)
    expr: BuilderLogicExprIn | None = None
    enabled: bool | None = None


class BuilderRulesIn(BaseModel):
    filterIf: str | None = Field(None, max_length=4096)
    filter: BuilderLogicExprIn | None = None
    zoneLongIf: str | None = Field(None, max_length=4096)
    zoneLong: BuilderLogicExprIn | None = None
    zoneLongApplyFilter: bool = True
    zoneLongWaitCandles: int = Field(10, ge=0, le=500)
    zoneShortIf: str | None = Field(None, max_length=4096)
    zoneShort: BuilderLogicExprIn | None = None
    zoneShortApplyFilter: bool = True
    zoneShortWaitCandles: int = Field(10, ge=0, le=500)
    long: BuilderEntryRuleIn | None = None
    short: BuilderEntryRuleIn | None = None
    exitLongIf: str | None = Field(None, max_length=4096)
    exitShortIf: str | None = Field(None, max_length=4096)
    exitLong: BuilderLogicExprIn | None = None
    exitShort: BuilderLogicExprIn | None = None
    entrySnapEnabled: bool | None = None


BuilderLogicExprIn.model_rebuild()


class BuilderRiskIn(BaseModel):
    takeProfitPct: float = Field(0.0, ge=0.0, le=1000.0)
    stopLossPct: float = Field(0.0, ge=0.0, le=1000.0)
    trailingStopPct: float = Field(0.0, ge=0.0, le=1000.0)


class ChartBuilderSpecIn(BaseModel):
    version: Literal[1] = 1
    name: str = Field(..., min_length=1, max_length=256)
    indicators: list[dict[str, Any]] = Field(..., min_length=1)
    rules: BuilderRulesIn
    risk: BuilderRiskIn

    @model_validator(mode="after")
    def validate_indicators_and_refs(self) -> ChartBuilderSpecIn:
        ids: set[str] = set()
        for raw in self.indicators:
            if not isinstance(raw, dict):
                raise ValueError("cada indicador deve ser um objecto")
            iid = raw.get("id")
            kind = raw.get("kind")
            if not isinstance(iid, str) or not iid.strip():
                raise ValueError("indicador sem id")
            if kind not in INDICATOR_KINDS:
                raise ValueError(f"kind de indicador inválido: {kind!r}")
            group = raw.get("group")
            if group not in ("overlays", "studies"):
                raise ValueError(f"group inválido: {group!r}")
            if iid in ids:
                raise ValueError(f"id de indicador duplicado: {iid}")
            ids.add(iid)

        def check_operand(op: BuilderOperandIn) -> None:
            if isinstance(op, OperandConstant):
                return
            if isinstance(op, OperandAdjusted):
                check_operand(op.inner)
                return
            if isinstance(op, OperandEntrySnap):
                if not _allowed_operand_ref(op.ref, ids):
                    raise ValueError(f"referência de indicador desconhecida: {op.ref!r}")
                if op.bollingerBand is not None and op.bollingerBand not in BB_BANDS:
                    raise ValueError("bollingerBand inválido")
                return
            assert isinstance(op, OperandIndicator)
            if not _allowed_operand_ref(op.ref, ids):
                raise ValueError(f"referência de indicador desconhecida: {op.ref!r}")
            if op.bollingerBand is not None:
                # BBANDS TA-Lib (multi-saída); validação branda para refs que não são bandas
                if op.bollingerBand not in BB_BANDS:
                    raise ValueError("bollingerBand inválido")

        def check_cond(cond: BuilderConditionIn) -> None:
            if cond.op not in OPS:
                raise ValueError(f"op inválido: {cond.op!r}")
            check_operand(cond.left)
            check_operand(cond.right)

        def iter_atoms(expr: BuilderLogicExprIn | None) -> list[BuilderConditionIn]:
            if expr is None:
                return []
            if expr.kind == "atom":
                assert expr.condition is not None
                return [expr.condition]
            return [a for ch in (expr.children or []) for a in iter_atoms(ch)]

        if not (self.rules.filterIf and self.rules.filterIf.strip()):
            for cond in iter_atoms(self.rules.filter):
                check_cond(cond)

        for ent in (self.rules.long, self.rules.short):
            if ent is None:
                continue
            if ent.ifLine and ent.ifLine.strip():
                continue
            for cond in iter_atoms(ent.expr):
                check_cond(cond)

        if not (self.rules.exitLongIf and self.rules.exitLongIf.strip()):
            for cond in iter_atoms(self.rules.exitLong):
                check_cond(cond)

        if not (self.rules.exitShortIf and self.rules.exitShortIf.strip()):
            for cond in iter_atoms(self.rules.exitShort):
                check_cond(cond)

        return self


class ChartBuilderCreateBody(BaseModel):
    spec: dict[str, Any]


class ChartBuilderPutBody(BaseModel):
    spec: dict[str, Any]


def _chain_dict_to_expr_dict(chain: dict[str, Any]) -> dict[str, Any]:
    parts = chain.get("parts") or []
    between = list(chain.get("between") or [])
    if not isinstance(parts, list) or len(parts) < 1:
        raise ValueError("chain inválida")
    if len(parts) == 1:
        return {"kind": "atom", "condition": parts[0]}
    acc: dict[str, Any] = {"kind": "atom", "condition": parts[0]}
    for j, op in enumerate(between):
        if j + 1 >= len(parts):
            break
        right = {"kind": "atom", "condition": parts[j + 1]}
        if op == "and":
            acc = {"kind": "all", "children": [acc, right]}
        elif op == "or":
            acc = {"kind": "any", "children": [acc, right]}
        else:
            raise ValueError("between inválido")
    return acc


def _normalize_rules_dict(rules: Any) -> dict[str, Any]:
    """Compat: condição única, ``chain`` linear e ``filter`` em formato antigo → ``expr`` árvore."""
    if not isinstance(rules, dict):
        return {}
    out = dict(rules)
    for key in ("long", "short"):
        v = out.get(key)
        if v is None or not isinstance(v, dict):
            continue
        if "expr" not in v and "chain" not in v and "applyFilter" not in v and "left" in v:
            out[key] = {"applyFilter": False, "expr": {"kind": "atom", "condition": dict(v)}}
            continue
        v = dict(v)
        if "chain" in v and isinstance(v["chain"], dict) and "expr" not in v:
            v["expr"] = _chain_dict_to_expr_dict(v["chain"])
            del v["chain"]
            out[key] = v
        elif isinstance(v.get("expr"), dict) and "parts" in v["expr"] and "kind" not in v["expr"]:
            v["expr"] = _chain_dict_to_expr_dict(v["expr"])
            out[key] = v
    filt = out.get("filter")
    if isinstance(filt, dict) and "parts" in filt and "kind" not in filt:
        out["filter"] = _chain_dict_to_expr_dict(filt)

    def _exit_to_expr(x: Any) -> Any:
        if x is None:
            return None
        if isinstance(x, dict) and "kind" not in x and "left" in x:
            return {"kind": "atom", "condition": x}
        return x

    for ek in ("exitLong", "exitShort"):
        if ek in out:
            out[ek] = _exit_to_expr(out.get(ek))
    return out


def _parse_spec(data: dict[str, Any]) -> ChartBuilderSpecIn:
    payload = dict(data)
    if isinstance(payload.get("rules"), dict):
        payload["rules"] = _normalize_rules_dict(payload["rules"])
    try:
        return ChartBuilderSpecIn.model_validate(payload)
    except Exception as e:
        raise HTTPException(400, detail=f"spec inválido: {e}") from e


@router.get("")
def list_builder_strategies() -> dict[str, Any]:
    eng = get_engine()
    if eng is None:
        return {"strategies": [], "postgres": "disabled"}
    with Session(eng) as session:
        rows = session.scalars(
            select(ChartBuilderStrategy).order_by(ChartBuilderStrategy.updated_at.desc())
        ).all()
        return {
            "strategies": [
                {
                    "id": str(r.id),
                    "name": r.name or "",
                    "updated_at": r.updated_at.isoformat() if r.updated_at else None,
                }
                for r in rows
            ],
            "postgres": "ok",
        }


@router.get("/{strategy_id:uuid}")
def get_builder_strategy(strategy_id: uuid.UUID) -> dict[str, Any]:
    eng = _require_engine()
    with Session(eng) as session:
        row = session.get(ChartBuilderStrategy, strategy_id)
        if row is None:
            raise HTTPException(404, detail="estratégia não encontrada")
        spec = row.spec if isinstance(row.spec, dict) else {}
        return {
            "id": str(row.id),
            "name": row.name or "",
            "spec": spec,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }


@router.post("")
def create_builder_strategy(body: ChartBuilderCreateBody) -> dict[str, Any]:
    eng = _require_engine()
    spec = _parse_spec(body.spec)
    row = ChartBuilderStrategy(
        id=uuid.uuid4(),
        name=spec.name.strip(),
        spec=spec.model_dump(mode="json"),
    )
    with Session(eng) as session:
        session.add(row)
        session.commit()
        session.refresh(row)
    return {"id": str(row.id), "name": row.name, "spec": row.spec}


@router.put("/{strategy_id:uuid}")
def put_builder_strategy(strategy_id: uuid.UUID, body: ChartBuilderPutBody) -> dict[str, Any]:
    eng = _require_engine()
    spec = _parse_spec(body.spec)
    with Session(eng) as session:
        row = session.get(ChartBuilderStrategy, strategy_id)
        if row is None:
            raise HTTPException(404, detail="estratégia não encontrada")
        row.name = spec.name.strip()
        row.spec = spec.model_dump(mode="json")
        session.commit()
        session.refresh(row)
    return {"id": str(row.id), "name": row.name, "spec": row.spec}


@router.delete("/{strategy_id:uuid}")
def delete_builder_strategy(strategy_id: uuid.UUID) -> dict[str, Any]:
    eng = _require_engine()
    with Session(eng) as session:
        row = session.get(ChartBuilderStrategy, strategy_id)
        if row is None:
            raise HTTPException(404, detail="estratégia não encontrada")
        session.delete(row)
        session.commit()
    return {"deleted": True}
