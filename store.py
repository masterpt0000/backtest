"""
Corre todos os streams de ``get_data`` e grava em QuestDB via ILP (``questdb``).

**Verificar dados:** com o store a correr, por defeito corre **de hora em hora** (``STORE_VERIFY_INTERVAL_SEC=3600``).
Também: ``python store.py --verify`` ou ``verify_store_data()`` — contagens, duplicados em ``trade_id``,
gaps em ``candles_1m`` e staleness. ``STORE_VERIFY_INTERVAL_SEC=0`` desliga a verificação automática.

**Vários símbolos (por defeito):** insere os pares CCXT na tabela QuestDB ``symbols`` (coluna ``code``);
o ``store.py`` faz ``SELECT DISTINCT code FROM symbols`` e arranca um stream por código.

**Override:** lista ``symbols=`` em ``run_store`` ou env ``STORE_SYMBOLS`` (vírgulas), ex.::

    set STORE_SYMBOLS=WLD/USDC:USDC,BTC/USDT:USDT

Cada par corre streams CCXT próprios; liquidações usam um único WebSocket multi-par quando há mais de um símbolo.

Uso típico **servidor / encher BD para backtest**
    - Define ``QDB_CLIENT_CONF`` com o IP interno da QuestDB (ex. ``http::addr=10.0.0.5:9000;``).
    - Corre em background: ``nohup python store.py >> store.log 2>&1 &``
    - Para parar com flush do buffer: ``kill -INT <pid>`` (SIGINT). Evita ``kill -9`` se quiseres não perder o que está em buffer.

Variáveis de ambiente (opcional, para throughput de backfill)::

    STORE_AUTO_FLUSH_ROWS=2000
    STORE_AUTO_FLUSH_INTERVAL_NS=1000000000
    STORE_HEARTBEAT_SEC=600
    STORE_VERIFY_INTERVAL_SEC=3600   # 0 = só manual (--verify / verify_store_data)
    STORE_VERIFY_LOOKBACK_HOURS=24
    STORE_VERIFY_TS_COL=timestamp   # se o DDL usar outro nome de coluna de tempo
    QUESTDB_HTTP_URL=http://127.0.0.1:9000   # /exec para listar ``symbols`` e registry (obrigatório se ILP for tcp::…)

Cria a tabela ``symbols`` e fact tables com ``symbol_id`` — vê ``questdb_schema_symbols.sql``.

Dependência: ``pip install questdb``
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import signal
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from questdb.ingress import IngressError, Sender, TimestampNanos  # type: ignore[reportMissingModuleSource]

import get_data as gd

log = logging.getLogger(__name__)

DEFAULT_QDB_CONF = "http::addr=127.0.0.1:9000;"

_DEFAULT_FLUSH_ROWS = 2000
_DEFAULT_FLUSH_INTERVAL_NS = 1_000_000_000
_DEFAULT_HEARTBEAT_SEC = 600
_DEFAULT_VERIFY_INTERVAL_SEC = 3600


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return int(float(raw))


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return float(raw)


def _fetch_symbol_codes_from_questdb(http_base: str) -> list[str]:
    """Lê os códigos CCXT a ingerir a partir da tabela ``symbols`` (INSERT manual na QuestDB)."""
    try:
        r = _exec_sql(
            http_base,
            "SELECT DISTINCT code FROM symbols WHERE code IS NOT NULL",
        )
    except urllib.error.URLError as e:
        log.error("QuestDB /exec (SELECT DISTINCT code FROM symbols): %s", e)
        raise
    ds = r.get("dataset") or []
    seen: set[str] = set()
    for row in ds:
        if not row or row[0] is None:
            continue
        c = str(row[0]).strip()
        if c:
            seen.add(c)
    out = sorted(seen)
    if not out:
        raise ValueError(
            "A tabela symbols não tem nenhum code. Faz INSERT na QuestDB (vê "
            "questdb_schema_symbols.sql) ou define STORE_SYMBOLS=PAIR1,PAIR2."
        )
    return out


def _resolve_store_symbols(http_base: str, explicit: list[str] | None) -> list[str]:
    if explicit is not None:
        out = [s.strip() for s in explicit if s and str(s).strip()]
        if not out:
            raise ValueError("symbols (lista) não pode ser vazia")
        return out
    raw = os.environ.get("STORE_SYMBOLS", "").strip()
    if raw:
        out = [s.strip() for s in raw.split(",") if s.strip()]
        if not out:
            raise ValueError("STORE_SYMBOLS está vazio ou só tem vírgulas")
        return out
    return _fetch_symbol_codes_from_questdb(http_base)


def _escape_sql_literal(s: str) -> str:
    return s.replace("'", "''")


def _http_url_from_ilp_conf(conf: str) -> str | None:
    """
    Deriva a base do Web Console / ``/exec`` a partir de ``QDB_CLIENT_CONF``.

    - ``http::addr=host:port`` -> ``http://host:port``
    - ``tcp::addr=host:port``  -> ``http://host:9000`` (REST na QuestDB usa 9000;
      ILP TCP costuma ser 9009 no mesmo host)
    """
    conf = conf.strip().lower()
    if conf.startswith("http::"):
        prefix = "http::"
    elif conf.startswith("tcp::"):
        prefix = "tcp::"
    else:
        return None
    plen = len(prefix)
    for raw in conf.split(";"):
        part = raw.strip()
        if part.lower().startswith(prefix):
            part = part[plen:]
        if part.lower().startswith("addr="):
            hostport = part[5:].strip()
            if prefix == "tcp::":
                if ":" in hostport:
                    host, _ilp_port = hostport.rsplit(":", 1)
                else:
                    host = hostport
                return f"http://{host}:9000"
            return "http://" + hostport
    return None


def _resolve_questdb_http_base(*, ilp_conf: str) -> str:
    u = os.environ.get("QUESTDB_HTTP_URL", "").strip()
    if u:
        return u.rstrip("/")
    derived = _http_url_from_ilp_conf(ilp_conf)
    if derived:
        return derived.rstrip("/")
    raise ValueError(
        "Define QUESTDB_HTTP_URL (ex. http://127.0.0.1:9000) ou QDB_CLIENT_CONF em "
        "http::addr=host:port; ou tcp::addr=host:port; (REST assumido em host:9000)."
    )


def _exec_sql(http_base: str, query: str, *, timeout: float = 60.0) -> dict[str, Any]:
    # QuestDB /exec usa GET com ``query`` na URL; POST devolve 405 Method Not Allowed.
    exec_base = http_base.rstrip("/") + "/exec"
    url = exec_base + "?" + urllib.parse.urlencode({"query": query})
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


class _SymbolRegistry:
    """Catálogo ``symbols`` na QuestDB: code CCXT -> symbol_id (via /exec)."""

    def __init__(self, http_base: str) -> None:
        self._http = http_base.rstrip("/")
        self._cache: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def id_for(self, code: str | None) -> int | None:
        if not code or not str(code).strip():
            return None
        c = str(code).strip()
        async with self._lock:
            if c in self._cache:
                return self._cache[c]
            return await asyncio.to_thread(self._ensure_sync, c)

    def _ensure_sync(self, code: str) -> int:
        esc = _escape_sql_literal(code)
        try:
            r = _exec_sql(
                self._http,
                f"SELECT symbol_id FROM symbols WHERE code = '{esc}' LIMIT 1",
            )
        except urllib.error.URLError as e:
            log.error("QuestDB /exec (SELECT symbols): %s", e)
            raise
        ds = r.get("dataset") or []
        if ds and ds[0] and ds[0][0] is not None:
            sid = int(ds[0][0])
            self._cache[code] = sid
            return sid

        try:
            r2 = _exec_sql(self._http, "SELECT max(symbol_id) FROM symbols")
        except urllib.error.URLError as e:
            log.error("QuestDB /exec (max symbol_id): %s", e)
            raise
        ds2 = r2.get("dataset") or []
        mx = ds2[0][0] if ds2 and ds2[0] else None
        nxt = int(mx) + 1 if mx is not None else 1

        ins = (
            f"INSERT INTO symbols (created_at, symbol_id, code) "
            f"VALUES (now(), {nxt}, '{esc}')"
        )
        try:
            _exec_sql(self._http, ins)
        except urllib.error.URLError as e:
            log.error("QuestDB /exec (INSERT symbols): %s", e)
            raise

        self._cache[code] = nxt
        log.info("Novo symbol_id=%s code=%s", nxt, code)
        return nxt

    async def warm(self, codes: list[str]) -> None:
        for c in codes:
            if c:
                await self.id_for(c)


def _dt_utc_ms(ms: int | None) -> datetime | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)


def _order_book_metrics(
    bids: list,
    asks: list,
) -> tuple[float, float, float, float, float, int, int] | None:
    if not bids or not asks:
        return None
    try:
        bb = float(bids[0][0])
        ba = float(asks[0][0])
    except (IndexError, TypeError, ValueError):
        return None
    spread = ba - bb
    mid = (bb + ba) / 2.0
    if mid <= 0:
        return bb, ba, spread, 0.0, 0.0, len(bids), len(asks)
    lo = mid * 0.99
    hi = mid * 1.01
    bid_depth = sum(float(x[1]) for x in bids if float(x[0]) >= lo)
    ask_depth = sum(float(x[1]) for x in asks if float(x[0]) <= hi)
    return bb, ba, spread, bid_depth, ask_depth, len(bids), len(asks)


def _clean_columns(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


_STORE_FACT_TABLES: tuple[str, ...] = (
    "tick_trades",
    "mark_price_funding",
    "open_interest",
    "order_book",
    "liquidations",
    "candles_1m",
)


def _validate_ts_column(name: str) -> str:
    n = name.strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", n):
        raise ValueError(f"ts_col inválido (só [A-Za-z0-9_]): {name!r}")
    return n


def _sql_since_hours(hours: float) -> str:
    if hours <= 0:
        raise ValueError("lookback_hours deve ser > 0")
    return f"dateadd('h', {-float(hours)}, now())"


def _dataset_rows(resp: dict[str, Any]) -> list[list[Any]]:
    return resp.get("dataset") or []


def _fetch_symbol_id_to_code(http_base: str) -> dict[int, str]:
    """Melhor esforço: ``last(code)`` por ``symbol_id``."""
    queries = (
        "SELECT symbol_id, last(code) FROM symbols GROUP BY symbol_id",
        "SELECT symbol_id, code FROM symbols LATEST ON created_at PARTITION BY symbol_id",
    )
    for q in queries:
        try:
            r = _exec_sql(http_base, q)
        except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError):
            continue
        rows = _dataset_rows(r)
        out: dict[int, str] = {}
        for row in rows:
            if len(row) >= 2 and row[0] is not None and row[1] is not None:
                out[int(row[0])] = str(row[1])
        if out:
            return out
    return {}


@dataclass
class StoreHealthReport:
    """Resultado de ``verify_store_data`` (gaps, duplicados, atraso, contagens)."""

    ok: bool
    lookback_hours: float
    ts_col: str
    issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    tables: dict[str, dict[str, Any]] = field(default_factory=dict)
    candle_gaps: list[dict[str, Any]] = field(default_factory=list)
    duplicate_trade_groups: int = 0
    invalid_tick_trades: int = 0


def verify_store_data(
    *,
    http_base: str | None = None,
    qdb_conf: str | None = None,
    lookback_hours: float | None = None,
    ts_col: str | None = None,
    candle_gap_sec: float = 90.0,
    max_stale_sec: float | None = 300.0,
    max_gap_samples: int = 50,
) -> StoreHealthReport:
    """
    Consulta a QuestDB (GET ``/exec``) e verifica integridade recente dos dados gravados pelo store.

    - **Contagens** e **último timestamp** por fact table (janela = ``lookback_hours``).
    - **Staleness:** se ``max_stale_sec`` não for ``None``, emite *issue* quando há linhas mas o
      último ponto é mais antigo que esse limiar (stream parado / ingest falhou).
    - **tick_trades:** grupos ``(symbol_id, trade_id)`` com ``count > 1``; linhas com preço/amount inválidos.
    - **candles_1m:** intervalos entre velas consecutivas (por ``symbol_id``) acima de ``candle_gap_sec``
      (esperado ~60 s; tolerância para atrasos da exchange).

    **Coluna de tempo:** por defeito ``timestamp`` (tabelas criadas só por ILP). Se o DDL usar outro nome
    (ex. ``local_ts_ns``), passa ``ts_col=...`` ou define ``STORE_VERIFY_TS_COL``.

    **Lookback:** env ``STORE_VERIFY_LOOKBACK_HOURS`` ou argumento (default 24).
    """
    lb = lookback_hours
    if lb is None:
        lb = _env_float("STORE_VERIFY_LOOKBACK_HOURS", 24.0)
    col = _validate_ts_column(
        (ts_col or os.environ.get("STORE_VERIFY_TS_COL") or "timestamp").strip()
    )
    issues: list[str] = []
    warnings: list[str] = []
    tables_out: dict[str, dict[str, Any]] = {}
    candle_gaps: list[dict[str, Any]] = []
    dup_groups = 0
    invalid_ticks = 0

    conf = (qdb_conf or os.environ.get("QDB_CLIENT_CONF") or DEFAULT_QDB_CONF).strip()
    base = (http_base or _resolve_questdb_http_base(ilp_conf=conf)).rstrip("/")
    since = _sql_since_hours(lb)

    id_to_code = _fetch_symbol_id_to_code(base)

    for tbl in _STORE_FACT_TABLES:
        q = (
            f"SELECT count(), max({col}), date_diff('s', max({col}), now()) "
            f"FROM {tbl} WHERE {col} >= {since}"
        )
        try:
            r = _exec_sql(base, q)
        except urllib.error.HTTPError as e:
            warnings.append(f"{tbl}: HTTP {e.code} ao contar (tabela existe?)")
            continue
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError, OSError) as e:
            warnings.append(f"{tbl}: falha na query ({type(e).__name__}: {e})")
            continue
        rows = _dataset_rows(r)
        if not rows or not rows[0]:
            tables_out[tbl] = {"rows": 0, "max_ts": None, "stale_sec": None}
            warnings.append(f"{tbl}: resposta vazia ou sem linhas agregadas")
            continue
        crow = rows[0]
        n = int(crow[0]) if crow[0] is not None else 0
        max_ts = crow[1]
        stale_sec = crow[2]
        tables_out[tbl] = {
            "rows": n,
            "max_ts": max_ts,
            "stale_sec": float(stale_sec) if stale_sec is not None else None,
        }
        if n == 0:
            warnings.append(f"{tbl}: sem dados na janela ({lb} h)")
        elif max_stale_sec is not None and stale_sec is not None:
            if float(stale_sec) > float(max_stale_sec):
                issues.append(
                    f"{tbl}: dados parados — último ponto há {stale_sec:.0f}s "
                    f"(limite {max_stale_sec:.0f}s)"
                )

    # Duplicados trade_id
    try:
        qdup = (
            f"SELECT count() FROM ( "
            f"SELECT symbol_id, trade_id FROM tick_trades "
            f"WHERE {col} >= {since} "
            f"GROUP BY symbol_id, trade_id "
            f"HAVING count() > 1 "
            f") dups"
        )
        rdup = _exec_sql(base, qdup)
        dr = _dataset_rows(rdup)
        if dr and dr[0] and dr[0][0] is not None:
            dup_groups = int(dr[0][0])
            if dup_groups > 0:
                issues.append(
                    f"tick_trades: {dup_groups} pares (symbol_id, trade_id) com linhas duplicadas"
                )
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, ValueError) as e:
        warnings.append(f"tick_trades duplicados: não verificado ({e})")

    # Ticks inválidos
    try:
        qbad = (
            f"SELECT count() FROM tick_trades WHERE {col} >= {since} AND ( "
            f"trade_id IS NULL OR price IS NULL OR price <= 0 "
            f"OR amount IS NULL OR amount < 0 "
            f")"
        )
        rbad = _exec_sql(base, qbad)
        br = _dataset_rows(rbad)
        if br and br[0] and br[0][0] is not None:
            invalid_ticks = int(br[0][0])
            if invalid_ticks > 0:
                issues.append(f"tick_trades: {invalid_ticks} linhas com trade_id/preço/amount inválidos")
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, ValueError) as e:
        warnings.append(f"tick_trades inválidos: não verificado ({e})")

    # Gaps em velas 1m (requer LAG no QuestDB recente)
    cg = float(candle_gap_sec)
    lim = max(1, int(max_gap_samples))
    try:
        qgap = (
            f"SELECT symbol_id, prev_ts, ts, gap_sec FROM ( "
            f"SELECT symbol_id, prev_ts, ts, date_diff('s', prev_ts, ts) AS gap_sec "
            f"FROM ( "
            f"SELECT symbol_id, {col} AS ts, "
            f"lag({col}) OVER (PARTITION BY symbol_id ORDER BY {col}) AS prev_ts "
            f"FROM candles_1m WHERE {col} >= {since} "
            f") "
            f"WHERE prev_ts IS NOT NULL AND date_diff('s', prev_ts, ts) > {cg} "
            f") LIMIT {lim}"
        )
        rgap = _exec_sql(base, qgap)
        for row in _dataset_rows(rgap):
            if len(row) < 4:
                continue
            sid = int(row[0]) if row[0] is not None else -1
            candle_gaps.append(
                {
                    "symbol_id": sid,
                    "code": id_to_code.get(sid),
                    "prev_ts": row[1],
                    "ts": row[2],
                    "gap_sec": float(row[3]) if row[3] is not None else None,
                }
            )
        if candle_gaps:
            issues.append(
                f"candles_1m: {len(candle_gaps)} gap(s) > {cg:.0f}s "
                f"(mostrando até {lim}; consecutivas podem ser várias por buraco)"
            )
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, ValueError) as e:
        warnings.append(f"candles_1m gaps: não verificado — {type(e).__name__}: {e}")

    ok = len(issues) == 0
    return StoreHealthReport(
        ok=ok,
        lookback_hours=lb,
        ts_col=col,
        issues=issues,
        warnings=warnings,
        tables=tables_out,
        candle_gaps=candle_gaps,
        duplicate_trade_groups=dup_groups,
        invalid_tick_trades=invalid_ticks,
    )


def log_store_health_report(rep: StoreHealthReport) -> None:
    """Envia o relatório para o logger (INFO/WARNING/ERROR)."""
    log.info(
        "Verificação dados QuestDB: lookback=%.2f h ts_col=%s ok=%s",
        rep.lookback_hours,
        rep.ts_col,
        rep.ok,
    )
    for tbl, info in sorted(rep.tables.items()):
        log.info(
            "  %s: rows=%s max_ts=%s stale_sec=%s",
            tbl,
            info.get("rows"),
            info.get("max_ts"),
            info.get("stale_sec"),
        )
    for w in rep.warnings:
        log.warning("  [aviso] %s", w)
    for i in rep.issues:
        log.error("  [problema] %s", i)
    for g in rep.candle_gaps[:20]:
        log.error(
            "  gap vela: symbol_id=%s code=%s gap_sec=%s até %s",
            g.get("symbol_id"),
            g.get("code"),
            g.get("gap_sec"),
            g.get("ts"),
        )
    if len(rep.candle_gaps) > 20:
        log.error("  ... e mais %s gap(s)", len(rep.candle_gaps) - 20)


async def run_store(
    *,
    qdb_conf: str | None = None,
    symbols: list[str] | None = None,
) -> None:
    conf = (qdb_conf or os.environ.get("QDB_CLIENT_CONF") or DEFAULT_QDB_CONF).strip()
    http_base = _resolve_questdb_http_base(ilp_conf=conf)
    sym_list = _resolve_store_symbols(http_base, symbols)
    registry = _SymbolRegistry(http_base)
    await registry.warm(sym_list)
    lock = asyncio.Lock()

    async def send_row(
        sender: Sender,
        table: str,
        *,
        symbols_kw: dict[str, Any] | None,
        columns: dict[str, Any],
        at: TimestampNanos | datetime,
    ) -> None:
        cols = _clean_columns(columns)
        syms: dict[str, str] = {}
        if symbols_kw:
            syms = {
                k: str(v)
                for k, v in symbols_kw.items()
                if v is not None and str(v).strip() != ""
            }
        async with lock:
            try:
                sender.row(
                    table,
                    symbols=syms if syms else None,
                    columns=cols,
                    at=at,
                )
            except IngressError as e:
                log.error("QuestDB rejeitou linha em %s: %s", table, e)
            except Exception:
                log.exception("Falha ao escrever em %s", table)

    async def pump_tick_trades(sender: Sender, sym: str) -> None:
        async for t in gd.tick_trades(symbol=sym):
            tid = t.get("trade_id")
            if not tid:
                continue
            ns = t.get("local_ts_ns")
            if not isinstance(ns, int):
                continue
            sid = await registry.id_for(t.get("symbol"))
            if sid is None:
                continue
            skw: dict[str, Any] | None = {"side": t.get("side")} if t.get("side") else None
            columns: dict[str, Any] = {
                "symbol_id": sid,
                "trade_id": str(tid),
                "price": float(t["price"]),
                "amount": float(t["amount"]),
                "exchange_ts": _dt_utc_ms(t.get("exchange_ts")),
                "local_ts": _dt_utc_ms(t.get("local_ts")),
                "stream_batch_index": t.get("stream_batch_index"),
            }
            await send_row(
                sender,
                "tick_trades",
                symbols_kw=skw,
                columns=columns,
                at=TimestampNanos(ns),
            )

    async def pump_mark_funding(sender: Sender, sym: str) -> None:
        async for row in gd.mark_price_funding(symbol=sym):
            lt = row.get("local_ts")
            if not isinstance(lt, int):
                continue
            sid = await registry.id_for(row.get("symbol"))
            if sid is None:
                continue
            columns: dict[str, Any] = {
                "symbol_id": sid,
                "local_ts": _dt_utc_ms(lt),
                "mark_price": row.get("mark_price"),
                "funding_rate": row.get("funding_rate"),
                "index_price": row.get("index_price"),
                "next_funding_time": _dt_utc_ms(row.get("next_funding_time_ms")),
                "exchange_ts": _dt_utc_ms(row.get("exchange_ts")),
            }
            await send_row(
                sender,
                "mark_price_funding",
                symbols_kw=None,
                columns=columns,
                at=TimestampNanos(int(lt) * 1_000_000),
            )

    async def pump_open_interest(sender: Sender, sym: str) -> None:
        async for row in gd.open_interest_poll(symbol=sym):
            lt = row.get("local_ts")
            if not isinstance(lt, int):
                continue
            oi = row.get("open_interest_amount")
            if oi is None:
                continue
            sid = await registry.id_for(row.get("symbol"))
            if sid is None:
                continue
            columns: dict[str, Any] = {
                "symbol_id": sid,
                "local_ts": _dt_utc_ms(lt),
                "oi_amount": float(oi),
                "exchange_ts": _dt_utc_ms(row.get("exchange_ts")),
            }
            await send_row(
                sender,
                "open_interest",
                symbols_kw=None,
                columns=columns,
                at=TimestampNanos(int(lt) * 1_000_000),
            )

    async def pump_order_book(sender: Sender, sym: str) -> None:
        async for snap in gd.order_book_snapshots(symbol=sym):
            lt = snap.get("local_ts")
            if not isinstance(lt, int):
                continue
            bids = snap.get("bids") or []
            asks = snap.get("asks") or []
            m = _order_book_metrics(bids, asks)
            if m is None:
                continue
            bb, ba, spread, bd, ad, n_b, n_a = m
            sid = await registry.id_for(snap.get("symbol"))
            if sid is None:
                continue
            columns: dict[str, Any] = {
                "symbol_id": sid,
                "local_ts": _dt_utc_ms(lt),
                "best_bid": bb,
                "best_ask": ba,
                "spread": spread,
                "bid_depth_1pct": bd,
                "ask_depth_1pct": ad,
                "bid_levels": n_b,
                "ask_levels": n_a,
                "exchange_ts": _dt_utc_ms(snap.get("exchange_ts")),
            }
            await send_row(
                sender,
                "order_book",
                symbols_kw=None,
                columns=columns,
                at=TimestampNanos(int(lt) * 1_000_000),
            )

    async def pump_liquidations_all(sender: Sender) -> None:
        if len(sym_list) == 1:
            stream = gd.liquidation_events(symbol=sym_list[0])
        else:
            stream = gd.liquidation_events(symbols=list(sym_list))
        async for ev in stream:
            lt = ev.get("local_ts")
            if not isinstance(lt, int):
                continue
            lid = ev.get("liquidation_event_id")
            if not lid:
                continue
            sid = await registry.id_for(ev.get("symbol"))
            if sid is None:
                continue
            skw: dict[str, Any] | None = {"side": ev.get("side")} if ev.get("side") else None
            columns: dict[str, Any] = {
                "symbol_id": sid,
                "local_ts": _dt_utc_ms(lt),
                "liquidation_id": str(lid),
                "contracts": float(ev["contracts"]) if ev.get("contracts") is not None else None,
                "price": float(ev["price"]) if ev.get("price") is not None else None,
                "exchange_ts": _dt_utc_ms(ev.get("exchange_ts")),
            }
            await send_row(
                sender,
                "liquidations",
                symbols_kw=skw,
                columns=columns,
                at=TimestampNanos(int(lt) * 1_000_000),
            )

    async def pump_candles(sender: Sender, sym: str) -> None:
        async for c in gd.closed_1m_candles(symbol=sym):
            if len(c) < 6:
                continue
            open_ms = int(c[0])
            sid = await registry.id_for(sym)
            if sid is None:
                continue
            columns: dict[str, Any] = {
                "symbol_id": sid,
                "open": float(c[1]),
                "high": float(c[2]),
                "low": float(c[3]),
                "close": float(c[4]),
                "volume": float(c[5]),
                "exchange_ts": _dt_utc_ms(open_ms),
                "local_ts": _dt_utc_ms(open_ms),
            }
            await send_row(
                sender,
                "candles_1m",
                symbols_kw=None,
                columns=columns,
                at=TimestampNanos(open_ms * 1_000_000),
            )

    if "HOST" in conf.upper():
        log.warning(
            "QDB_CLIENT_CONF contém HOST (placeholder); usa localhost ou o IP/hostname real da QuestDB."
        )

    log.info("QuestDB ILP: %s", conf.strip())
    log.info(
        "Símbolos (%s): %s — Ctrl+C para parar.",
        len(sym_list),
        ", ".join(sym_list),
    )

    hb_sec = _env_int("STORE_HEARTBEAT_SEC", _DEFAULT_HEARTBEAT_SEC)
    verify_interval_sec = _env_int(
        "STORE_VERIFY_INTERVAL_SEC", _DEFAULT_VERIFY_INTERVAL_SEC
    )
    flush_rows = _env_int("STORE_AUTO_FLUSH_ROWS", _DEFAULT_FLUSH_ROWS)
    flush_interval_ns = _env_int(
        "STORE_AUTO_FLUSH_INTERVAL_NS", _DEFAULT_FLUSH_INTERVAL_NS
    )

    if verify_interval_sec > 0:
        log.info(
            "Verificação automática dos dados a cada %s s (~%.1f min).",
            verify_interval_sec,
            verify_interval_sec / 60.0,
        )

    async def heartbeat() -> None:
        n = 0
        while True:
            await asyncio.sleep(hb_sec)
            n += 1
            log.info(
                "Heartbeat #%s (~%s s): activo. Ex.: `SELECT count() FROM tick_trades;`",
                n,
                n * hb_sec,
            )

    async def periodic_verify() -> None:
        while True:
            await asyncio.sleep(verify_interval_sec)
            try:
                rep = await asyncio.to_thread(
                    verify_store_data,
                    http_base=http_base,
                )
                log_store_health_report(rep)
            except Exception:
                log.exception("Verificação automática dos dados falhou")

    with Sender.from_conf(
        conf,
        auto_flush_rows=flush_rows,
        auto_flush_interval=flush_interval_ns,
    ) as sender:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(heartbeat())
            if verify_interval_sec > 0:
                tg.create_task(periodic_verify())
            for sym in sym_list:
                tg.create_task(pump_tick_trades(sender, sym))
                tg.create_task(pump_mark_funding(sender, sym))
                tg.create_task(pump_open_interest(sender, sym))
                tg.create_task(pump_order_book(sender, sym))
                tg.create_task(pump_candles(sender, sym))
            tg.create_task(pump_liquidations_all(sender))


def _shutdown_signal(_signum: int, _frame: object | None) -> None:
    raise KeyboardInterrupt


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if len(sys.argv) >= 2 and sys.argv[1] in ("--verify", "verify"):
        rep = verify_store_data()
        log_store_health_report(rep)
        raise SystemExit(0 if rep.ok else 2)
    signal.signal(signal.SIGINT, _shutdown_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _shutdown_signal)
    try:
        try:
            asyncio.run(run_store())
        except* Exception as eg:
            log.error("Pelo menos um stream falhou — vê a causa abaixo.")
            for exc in eg.exceptions:
                log.error("  %s: %s", type(exc).__name__, exc, exc_info=exc)
            raise SystemExit(1) from eg
    except KeyboardInterrupt:
        log.info("Interrompido (Ctrl+C).")


if __name__ == "__main__":
    main()
