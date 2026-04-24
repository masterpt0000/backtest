"""
Modelos SQLAlchemy para PostgreSQL (metadados da app, não velas).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class BacktestJobRecord(Base):
    """Snapshot de jobs de backtest (paralelo ao dict em memória ``JOBS``)."""

    __tablename__ = "backtest_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    phase: Mapped[str] = mapped_column(String(512), default="")
    payload_summary: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    request_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    results: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    result_rows: Mapped[list["BacktestResultRow"]] = relationship(
        back_populates="job", cascade="all, delete-orphan"
    )


class StrategySymbolConfig(Base):
    """
    Parâmetros guardados por estratégia vectorbt e opcionalmente por ``symbol_id``
    (QuestDB). ``symbol_id`` NULL = modelo / preset aplicável a vários pares.
    """

    __tablename__ = "strategy_symbol_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    vbt_strategy_id: Mapped[str] = mapped_column(String(128), index=True)
    symbol_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(256), default="")
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    notes: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class BacktestResultRow(Base):
    """
    Uma linha de resultado por (job × par × rank), para consultas e relatórios.
    """

    __tablename__ = "backtest_result_rows"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("backtest_jobs.id", ondelete="CASCADE"), index=True
    )
    symbol_label: Mapped[str] = mapped_column(String(64))
    optimize_rank: Mapped[int | None] = mapped_column(Integer, nullable=True)
    metrics: Mapped[dict] = mapped_column(JSONB, default=dict)
    best_params: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    job: Mapped[BacktestJobRecord] = relationship(back_populates="result_rows")
