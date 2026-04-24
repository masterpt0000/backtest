#!/usr/bin/env python3
"""
Dados sintéticos na QuestDB para stress-test do gráfico (muitas velas 1m).

Requisitos: QuestDB a correr (REST, por defeito http://127.0.0.1:9000).
Tabela ``candles_1m`` com colunas compatíveis com o store (symbol_id, open, high,
low, close, volume, local_ts, exchange_ts) — igual ao que o ``store.py`` grava.

Uso:
  1. Edita ACTION no bloco abaixo: ``1`` para criar dados, ``0`` para apagar tudo
     deste símbolo de teste.
  2. ``python seed_chart_test_data.py``

Opcional: ``QUESTDB_HTTP_URL=https://host:9000 python seed_chart_test_data.py``

Nota: muitas versões da QuestDB **não implementam** ``DELETE FROM``. Nesse caso o script
não falha: na criação (ACTION=1), se já existirem velas no símbolo e não for possível
apagar, cria um **novo** código ``__CHART_TEST__/USDT#<timestamp>``. Na limpeza (ACTION=0)
explica como apagar manualmente ou actualizar o servidor.
"""

from __future__ import annotations

import json
import os
import random
import sys
from functools import lru_cache
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


# ---------------------------------------------------------------------------
# Configuração (altera aqui)
# ---------------------------------------------------------------------------

# 1 = criar ou recriar símbolo de teste + velas 1m aleatórias
# 0 = apagar todas as velas e linhas do símbolo de teste na tabela symbols
ACTION = 1

# Código único para não confundir com pares reais da Binance
TEST_SYMBOL_CODE = "__CHART_TEST__/USDT"

# Quantas velas de 1 minuto gerar (ex.: 15_000 ≈ ~10 dias)
NUM_1M_CANDLES = 50_000

# Semente do passeio aleatório (None = não fixar)
RANDOM_SEED: int | None = 42

# Velas por pedido HTTP (URL do /exec tem limite prático; ~25–60 costuma ser seguro)
INSERT_BATCH_SIZE = 25

DEFAULT_QUESTDB_HTTP = "http://127.0.0.1:9000"


def _escape_sql_literal(s: str) -> str:
    return s.replace("'", "''")


def questdb_http_base() -> str:
    return (os.environ.get("QUESTDB_HTTP_URL") or DEFAULT_QUESTDB_HTTP).rstrip("/")


def exec_sql(http_base: str, query: str, *, timeout: float = 120.0) -> dict:
    exec_base = http_base.rstrip("/") + "/exec"
    url = exec_base + "?" + urllib.parse.urlencode({"query": query})
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode().strip()
            if not raw:
                return {}
            try:
                data = json.loads(raw)
            except json.JSONDecodeError as e:
                raise RuntimeError(f"JSON inválido da QuestDB: {raw[:300]!r}") from e
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:800]
        raise RuntimeError(f"QuestDB HTTP {e.code}: {body}") from e

    err = data.get("error")
    if isinstance(err, str) and err.strip():
        raise RuntimeError(f"QuestDB: {err}")
    return data


@lru_cache(maxsize=4)
def _questdb_supports_delete_from(http_base: str) -> bool:
    """Muitas builds da QuestDB rejeitam ``DELETE FROM`` no parser (ex.: erro em FROM)."""
    try:
        exec_sql(
            http_base,
            "DELETE FROM candles_1m WHERE symbol_id = -9223372036854775807",
        )
        return True
    except RuntimeError as e:
        msg = str(e).lower()
        if "unexpected token" in msg:
            return False
        raise


def candle_count_for_symbol(http_base: str, symbol_id: int) -> int:
    r = exec_sql(
        http_base,
        f"SELECT count() FROM candles_1m WHERE symbol_id = {symbol_id}",
    )
    ds = r.get("dataset") or []
    if not ds or not ds[0] or ds[0][0] is None:
        return 0
    return int(ds[0][0])


def try_delete_candles_for_symbol(http_base: str, symbol_id: int) -> bool:
    if not _questdb_supports_delete_from(http_base):
        return False
    exec_sql(http_base, f"DELETE FROM candles_1m WHERE symbol_id = {symbol_id}")
    return True


def try_delete_symbol_rows(http_base: str, symbol_id: int) -> bool:
    if not _questdb_supports_delete_from(http_base):
        return False
    exec_sql(http_base, f"DELETE FROM symbols WHERE symbol_id = {symbol_id}")
    return True


def ts_iso_ms(ms: int) -> str:
    d = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def ensure_symbol_id(http_base: str, code: str) -> int:
    esc = _escape_sql_literal(code)
    r = exec_sql(
        http_base,
        f"SELECT symbol_id FROM symbols WHERE code = '{esc}' LIMIT 1",
    )
    ds = r.get("dataset") or []
    if ds and ds[0] and ds[0][0] is not None:
        return int(ds[0][0])

    r2 = exec_sql(http_base, "SELECT max(symbol_id) FROM symbols")
    ds2 = r2.get("dataset") or []
    mx = ds2[0][0] if ds2 and ds2[0] else None
    nxt = int(mx) + 1 if mx is not None else 1

    exec_sql(
        http_base,
        f"INSERT INTO symbols (created_at, symbol_id, code) VALUES (now(), {nxt}, '{esc}')",
    )
    print(f"Novo symbol_id={nxt} code={code!r}")
    return nxt


def _list_test_symbol_rows(http_base: str) -> list[tuple[int, str]]:
    """Símbolos cujo ``code`` contém o marcador ``__CHART_TEST__`` (inclui sufixos ``#...``)."""
    marker = "__CHART_TEST__"
    esc = _escape_sql_literal(marker)
    try:
        r = exec_sql(
            http_base,
            "SELECT DISTINCT symbol_id, code FROM symbols "
            f"WHERE strpos(code, '{esc}') > 0 ORDER BY symbol_id",
        )
    except RuntimeError:
        c = _escape_sql_literal(TEST_SYMBOL_CODE)
        r = exec_sql(
            http_base,
            f"SELECT DISTINCT symbol_id, code FROM symbols WHERE code = '{c}'",
        )
    out: list[tuple[int, str]] = []
    for row in r.get("dataset") or []:
        if len(row) >= 2 and row[0] is not None and row[1] is not None:
            out.append((int(row[0]), str(row[1])))
    return out


def delete_test_data(http_base: str, code: str) -> None:
    rows = _list_test_symbol_rows(http_base)
    if not rows:
        print(f"Nada a apagar: nenhum símbolo com marcador __CHART_TEST__ (pedido base {code!r}).")
        return

    if not _questdb_supports_delete_from(http_base):
        print(
            "Esta instância da QuestDB não suporta ``DELETE FROM`` (comportamento habitual). "
            "Não é possível apagar linhas por SQL.\n\n"
            "Opções:\n"
            "  • Actualizar a QuestDB para uma versão com DELETE, ou\n"
            "  • Ver o guia oficial (padrão «replace table» / partições), com backup:\n"
            "    https://questdb.com/docs/operations/modifying-data/\n"
        )
        print("Símbolos de teste encontrados (apaga manualmente se precisares):")
        for sid, c in rows:
            print(f"  symbol_id={sid}  code={c!r}")
        return

    for sid, c in rows:
        try_delete_candles_for_symbol(http_base, sid)
        print(f"Apagadas velas: symbol_id={sid} ({c!r})")
        try_delete_symbol_rows(http_base, sid)
        print(f"Apagado em symbols: symbol_id={sid}")


def generate_candles(num: int, *, end_ms: int) -> list[tuple[int, float, float, float, float, float]]:
    """
    Gera ``num`` velas 1m terminando em ``end_ms`` (última vela abre nesse minuto alinhado).
    Retorna lista de (open_ms, o, h, l, c, v).
    """
    if RANDOM_SEED is not None:
        random.seed(RANDOM_SEED)

    # Alinhar ao minuto UTC
    end_ms = end_ms - (end_ms % 60_000)
    start_ms = end_ms - (num - 1) * 60_000

    price = 50_000.0 + random.uniform(-500, 500)
    out: list[tuple[int, float, float, float, float, float]] = []

    for i in range(num):
        open_ms = start_ms + i * 60_000
        o = price
        drift = random.gauss(0, 0.0015) * o
        c = max(0.01, o + drift)
        wick = abs(random.gauss(0, 0.0008)) * o
        h = max(o, c) + wick
        l = max(0.01, min(o, c) - wick)
        vol = max(0.01, random.lognormvariate(2.0, 1.2))
        out.append((open_ms, float(o), float(h), float(l), float(c), float(vol)))
        price = c

    return out


def insert_candles_batch(
    http_base: str,
    symbol_id: int,
    rows: list[tuple[int, float, float, float, float, float]],
) -> None:
    """INSERT multi-linha via /exec (GET)."""
    parts: list[str] = []
    for open_ms, o, h, l, c, v in rows:
        ts = ts_iso_ms(open_ms)
        parts.append(
            f"('{ts}', {symbol_id}, {o}, {h}, {l}, {c}, {v}, '{ts}')"
        )
    values_sql = ",\n".join(parts)
    q = (
        "INSERT INTO candles_1m "
        "(local_ts, symbol_id, open, high, low, close, volume, exchange_ts) VALUES "
        f"{values_sql}"
    )
    exec_sql(http_base, q)


def seed(http_base: str) -> None:
    code = TEST_SYMBOL_CODE
    sid = ensure_symbol_id(http_base, code)

    if try_delete_candles_for_symbol(http_base, sid):
        print(f"Removidas velas anteriores deste símbolo (symbol_id={sid}).")
    else:
        n = candle_count_for_symbol(http_base, sid)
        if n > 0:
            ts = int(datetime.now(timezone.utc).timestamp())
            code = f"{TEST_SYMBOL_CODE}#{ts}"
            sid = ensure_symbol_id(http_base, code)
            print(
                f"Aviso: QuestDB sem DELETE; {TEST_SYMBOL_CODE!r} já tinha {n} velas. "
                f"A usar novo par {code!r} (symbol_id={sid})."
            )

    end_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    candles = generate_candles(NUM_1M_CANDLES, end_ms=end_ms)
    total = len(candles)
    for i in range(0, total, INSERT_BATCH_SIZE):
        chunk = candles[i : i + INSERT_BATCH_SIZE]
        insert_candles_batch(http_base, sid, chunk)
        done = min(i + INSERT_BATCH_SIZE, total)
        print(f"  Inseridas {done}/{total} velas…")

    print(
        f"Concluído: {total} velas 1m — code={code!r} (symbol_id={sid}). "
        "Escolhe este par no chart."
    )


def main() -> int:
    base = questdb_http_base()
    try:
        exec_sql(base, "SELECT 1")
    except urllib.error.URLError as e:
        print(f"Erro a ligar à QuestDB ({base}): {e}", file=sys.stderr)
        return 1
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1

    try:
        if ACTION == 0:
            delete_test_data(base, TEST_SYMBOL_CODE)
            return 0
        if ACTION == 1:
            seed(base)
            return 0
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1

    print("ACTION tem de ser 0 (apagar) ou 1 (criar).", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
