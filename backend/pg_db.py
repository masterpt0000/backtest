"""
Ligação PostgreSQL (SQLAlchemy 2 sync + psycopg3).

``DATABASE_URL`` opcional — se estiver vazio, a app corre só com QuestDB + memória
para jobs; ``/health/postgres`` indica ``disabled``.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
BACKEND_DIR = Path(__file__).resolve().parent


def database_url() -> str | None:
    u = (os.environ.get("DATABASE_URL") or "").strip()
    return u or None


@lru_cache
def get_engine() -> Engine | None:
    url = database_url()
    if not url:
        return None
    # connect_timeout: evita o arranque do uvicorn ficar preso em "Waiting for application startup"
    # quando o Postgres está parado ou o host não responde (TCP pendente durante minutos).
    return create_engine(
        url,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        connect_args={"connect_timeout": 8},
    )


def pg_healthcheck() -> tuple[bool, str]:
    """(ok, mensagem). Sem URL → ok=False mas mensagem 'disabled'."""
    eng = get_engine()
    if eng is None:
        return False, "disabled"
    try:
        with eng.connect() as c:
            c.execute(text("SELECT 1"))
        return True, "ok"
    except Exception as e:
        return False, str(e)


def init_db_schema() -> str | None:
    """
    Cria tabelas se ``DATABASE_URL`` estiver definido.
    Devolve None em sucesso ou mensagem de erro.
    """
    from pg_models import Base

    eng = get_engine()
    if eng is None:
        return None
    try:
        Base.metadata.create_all(bind=eng)
        return None
    except Exception as e:
        return str(e)
