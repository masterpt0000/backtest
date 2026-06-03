"""
Corre todos os streams de ``get_data`` e grava em QuestDB via ILP (``questdb``).

**Verificar dados:** com o store a correr, por defeito corre **de hora em hora** (``STORE_VERIFY_INTERVAL_SEC=3600``).
Também: ``python store.py --verify`` — só consulta a QuestDB e sai (código 2 se houver problemas).
``python store.py --verify --auto-repair`` — se falhar, executa ``repair_tick_trades`` com apply e volta a verificar.
``--no-auto-repair`` numa corrida ignora ``STORE_VERIFY_AUTO_REPAIR`` no ambiente.
No processo longo: ``STORE_VERIFY_AUTO_REPAIR=1`` faz o mesmo após cada verificação automática com falhas.

**Reparar ``tick_trades``:** ``python store.py --repair-tick-trades`` (só mostra contagens e amostras).
``python store.py --repair-tick-trades --apply`` remove linhas **irrecuperáveis** (sem ``trade_id`` válido,
preço/amount inválidos) e **duplicados** do mesmo ``(symbol_id, trade_id)``, mantendo uma linha pelo
timestamp de linha QuestDB (``timestamp`` do ILP; override: ``REPAIR_TICK_TRADES_ROW_TS_COL``).
Opções: ``--lookback-hours=24``, ``--keep=newest|oldest``. Não inventa IDs nem preços da Binance.

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
    STORE_VERIFY_AUTO_REPAIR=0       # 1 = após verify com falhas, repair tick_trades + verify outra vez
    STORE_VERIFY_REPAIR_KEEP=newest  # ou oldest (duplicados)
    STORE_VERIFY_REPAIR_LOOKBACK_HOURS=   # vazio = igual a STORE_VERIFY_LOOKBACK_HOURS no repair
    STORE_VERIFY_LOOKBACK_HOURS=24
    STORE_VERIFY_MAX_STALE_SEC=300   # ou none/off/disable para não falhar por atraso
    STORE_VERIFY_TS_COL=local_ts   # ou timestamp se a tabela tiver essa coluna designada
    STORE_STREAM_RETRY_BASE_SEC=2    # backoff após erro WS / rede
    STORE_STREAM_RETRY_MAX_SEC=120
    STORE_TICK_TRADES_DEDUP_KEYS=500000   # LRU de (symbol_id, trade_id) antes do ILP — evita duplicados por replay WS
    STORE_CHART_FEATURES_ENABLED=1
    STORE_CHART_FEATURES_INTERVAL_SEC=300
    STORE_CHART_FEATURES_LOOKBACK_MINUTES=10
    STORE_CHART_FEATURES_LAG_SEC=90
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
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, TypeVar

import httpx
from questdb.ingress import IngressError, Sender, TimestampNanos  # type: ignore[reportMissingModuleSource]

import get_data as gd

_BACKEND_DIR = Path(__file__).resolve().parent / "backend"
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from chart_feature_aggregates import backfill_chart_features_1m_range  # noqa: E402

log = logging.getLogger(__name__)

DEFAULT_QDB_CONF = "http::addr=127.0.0.1:9000;"

_DEFAULT_FLUSH_ROWS = 2000
_DEFAULT_FLUSH_INTERVAL_NS = 1_000_000_000
_DEFAULT_HEARTBEAT_SEC = 600
_DEFAULT_VERIFY_INTERVAL_SEC = 3600
_DEFAULT_VERIFY_TS_COL = "local_ts"


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


def _env_truthy(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


class _TickTradeDedup:
    """
    Evita inserir o mesmo (symbol_id, trade_id) duas vezes (replay do WebSocket / reconexão).

    Mantém um LRU de chaves já enviadas com sucesso e um conjunto de chaves em voo para não
    duplicar enquanto o ``await`` do ILP está pendente. A eviction só remove entradas *committed*.
    """

    def __init__(self, max_committed: int) -> None:
        self._max = max(10_000, int(max_committed))
        self._committed: OrderedDict[tuple[int, str], None] = OrderedDict()
        self._inflight: set[tuple[int, str]] = set()

    def try_begin(self, key: tuple[int, str]) -> bool:
        if key in self._committed or key in self._inflight:
            return False
        self._inflight.add(key)
        return True

    def finish(self, key: tuple[int, str], *, success: bool) -> None:
        self._inflight.discard(key)
        if not success:
            return
        self._committed[key] = None
        self._committed.move_to_end(key)
        while len(self._committed) > self._max:
            self._committed.popitem(last=False)


def _env_max_stale_override(param: float | None) -> float | None:
    """``STORE_VERIFY_MAX_STALE_SEC``: número de segundos, ou ``none``/``off``/``disable`` para desligar."""
    raw = os.environ.get("STORE_VERIFY_MAX_STALE_SEC")
    if raw is None or raw.strip() == "":
        return param
    s = raw.strip().lower()
    if s in ("none", "off", "disable"):
        return None
    return float(raw.strip())


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
        raw = resp.read().decode().strip()
        if not raw:
            return {}
        return json.loads(raw)


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


_T = TypeVar("_T")


async def _stream_loop(
    tag: str,
    factory: Callable[[], AsyncIterator[_T]],
    handle: Callable[[_T], Awaitable[None]],
) -> None:
    """
    Consome um async generator (CCXT / WebSocket) e volta a ligar com backoff
    após ``NetworkError`` (ex. código 1006) ou outras falhas transitórias.
    """
    base = _env_float("STORE_STREAM_RETRY_BASE_SEC", 2.0)
    cap = _env_float("STORE_STREAM_RETRY_MAX_SEC", 120.0)
    delay = base
    while True:
        try:
            async for item in factory():
                delay = base
                await handle(item)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning(
                "%s: %s — %s; nova tentativa em %.1fs",
                tag,
                type(e).__name__,
                e,
                delay,
            )
            await asyncio.sleep(delay)
            delay = min(cap, delay * 2)
            continue
        log.warning("%s: stream terminou — a reiniciar em %.1fs", tag, base)
        await asyncio.sleep(base)


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
    h = float(hours)
    # QuestDB rejeita por vezes ``-24.0`` no dateadd; usar inteiro quando for caso.
    neg = -int(h) if h == int(h) else -h
    return f"dateadd('h', {neg}, now())"


def _http_error_detail(e: urllib.error.HTTPError, *, max_len: int = 450) -> str:
    """Corpo JSON/texto da resposta (QuestDB costuma explicar o 400 aqui)."""
    try:
        raw = e.read().decode("utf-8", errors="replace").strip()
    except Exception:
        return (e.reason or "").strip()
    if len(raw) > max_len:
        return raw[:max_len] + "…"
    return raw or (e.reason or "").strip()


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

    **Coluna de tempo:** por defeito ``local_ts`` (como no ILP do ``store``). Define
    ``STORE_VERIFY_TS_COL=timestamp`` se as fact tables usarem essa coluna.

    **Lookback:** env ``STORE_VERIFY_LOOKBACK_HOURS`` ou argumento (default 24).

    **Staleness:** env ``STORE_VERIFY_MAX_STALE_SEC`` (sobrepõe ``max_stale_sec``) ou ``none`` para desligar.
    """
    lb = lookback_hours
    if lb is None:
        lb = _env_float("STORE_VERIFY_LOOKBACK_HOURS", 24.0)
    stale_limit = _env_max_stale_override(max_stale_sec)
    col = _validate_ts_column(
        (
            ts_col
            or os.environ.get("STORE_VERIFY_TS_COL")
            or _DEFAULT_VERIFY_TS_COL
        ).strip()
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
        q_count = f"SELECT count() FROM {tbl} WHERE {col} >= {since}"
        try:
            r_count = _exec_sql(base, q_count)
        except urllib.error.HTTPError as e:
            detail = _http_error_detail(e)
            warnings.append(
                f"{tbl}: HTTP {e.code} ao contar — {detail or 'sem detalhe'}"
            )
            continue
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError, OSError) as e:
            warnings.append(f"{tbl}: falha na query ({type(e).__name__}: {e})")
            continue
        rows_c = _dataset_rows(r_count)
        if not rows_c or not rows_c[0]:
            tables_out[tbl] = {"rows": 0, "max_ts": None, "stale_sec": None}
            warnings.append(f"{tbl}: resposta vazia ao contar")
            continue
        n = int(rows_c[0][0]) if rows_c[0][0] is not None else 0
        if n == 0:
            tables_out[tbl] = {"rows": 0, "max_ts": None, "stale_sec": None}
            warnings.append(f"{tbl}: sem dados na janela ({lb} h)")
            continue

        # Subquery evita agregados aninhados; QuestDB usa ``datediff`` (não ``date_diff``).
        q_stale = (
            f"SELECT m, datediff('s', m, now()) FROM ("
            f"SELECT max({col}) AS m FROM {tbl} WHERE {col} >= {since}"
            f")"
        )
        try:
            r_stale = _exec_sql(base, q_stale)
        except urllib.error.HTTPError as e:
            detail = _http_error_detail(e)
            warnings.append(
                f"{tbl}: HTTP {e.code} ao ler max/stale — {detail or 'sem detalhe'}"
            )
            tables_out[tbl] = {"rows": n, "max_ts": None, "stale_sec": None}
            continue
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError, OSError) as e:
            warnings.append(f"{tbl}: falha na query max/stale ({type(e).__name__}: {e})")
            tables_out[tbl] = {"rows": n, "max_ts": None, "stale_sec": None}
            continue
        rows_s = _dataset_rows(r_stale)
        if not rows_s or not rows_s[0]:
            tables_out[tbl] = {"rows": n, "max_ts": None, "stale_sec": None}
            warnings.append(f"{tbl}: resposta vazia em max/stale")
            continue
        crow = rows_s[0]
        max_ts = crow[0]
        stale_sec = crow[1]
        tables_out[tbl] = {
            "rows": n,
            "max_ts": max_ts,
            "stale_sec": float(stale_sec) if stale_sec is not None else None,
        }
        if stale_limit is not None and stale_sec is not None:
            if float(stale_sec) > float(stale_limit):
                issues.append(
                    f"{tbl}: dados parados — último ponto há {stale_sec:.0f}s "
                    f"(limite {stale_limit:.0f}s)"
                )

    # Duplicados trade_id — QuestDB costuma rejeitar HAVING dentro desta subquery; usar WHERE exterior.
    try:
        qdup = (
            f"SELECT count() FROM ( "
            f"SELECT symbol_id, trade_id, count() AS n FROM tick_trades "
            f"WHERE {col} >= {since} "
            f"GROUP BY symbol_id, trade_id "
            f") t WHERE t.n > 1"
        )
        rdup = _exec_sql(base, qdup)
        dr = _dataset_rows(rdup)
        if dr and dr[0] and dr[0][0] is not None:
            dup_groups = int(dr[0][0])
            if dup_groups > 0:
                issues.append(
                    f"tick_trades: {dup_groups} pares (symbol_id, trade_id) com linhas duplicadas"
                )
    except urllib.error.HTTPError as e:
        warnings.append(
            f"tick_trades duplicados: HTTP {e.code} — {_http_error_detail(e)}"
        )
    except (urllib.error.URLError, json.JSONDecodeError, ValueError) as e:
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
    except urllib.error.HTTPError as e:
        warnings.append(
            f"tick_trades inválidos: HTTP {e.code} — {_http_error_detail(e)}"
        )
    except (urllib.error.URLError, json.JSONDecodeError, ValueError) as e:
        warnings.append(f"tick_trades inválidos: não verificado ({e})")

    # Gaps em velas 1m (requer LAG no QuestDB recente)
    cg = float(candle_gap_sec)
    lim = max(1, int(max_gap_samples))
    try:
        qgap = (
            f"SELECT symbol_id, prev_ts, ts, gap_sec FROM ( "
            f"SELECT symbol_id, prev_ts, ts, datediff('s', prev_ts, ts) AS gap_sec "
            f"FROM ( "
            f"SELECT symbol_id, {col} AS ts, "
            f"lag({col}) OVER (PARTITION BY symbol_id ORDER BY {col}) AS prev_ts "
            f"FROM candles_1m WHERE {col} >= {since} "
            f") "
            f"WHERE prev_ts IS NOT NULL AND datediff('s', prev_ts, ts) > {cg} "
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
    except urllib.error.HTTPError as e:
        warnings.append(
            f"candles_1m gaps: HTTP {e.code} — {_http_error_detail(e)}"
        )
    except (urllib.error.URLError, json.JSONDecodeError, ValueError) as e:
        warnings.append(f"candles_1m gaps: não verificado — {type(e).__name__}: {e}")

    if len(issues) == 0 and not tables_out and warnings:
        issues.append(
            "Verificação incompleta: nenhuma tabela fact foi consultada com sucesso; "
            "vê os avisos com HTTP/SQL (antes o relatório podia mostrar ok=True sem dados)."
        )
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


def _tick_trades_row_timestamp_column(http_base: str) -> str:
    """Coluna de tempo de linha do ILP (``at=``), por defeito ``timestamp`` — não ``local_ts``."""
    override = os.environ.get("REPAIR_TICK_TRADES_ROW_TS_COL", "").strip()
    if override:
        return _validate_ts_column(override)
    r = _exec_sql(http_base, "SELECT * FROM tick_trades LIMIT 1")
    parsed: list[tuple[str, str]] = []
    for c in r.get("columns") or []:
        if isinstance(c, dict):
            nm = str(c.get("name") or "")
            typ = (c.get("type") or "").upper()
        else:
            nm = str(c[0]) if c else ""
            typ = str(c[1] if len(c) > 1 else "").upper()
        if nm:
            parsed.append((nm, typ))
    for nm, _ in parsed:
        if nm == "timestamp":
            return nm
    for nm, typ in parsed:
        if "TIMESTAMP" in typ and nm != "local_ts":
            return _validate_ts_column(nm)
    raise ValueError(
        "Não detetei coluna de timestamp de linha em tick_trades; define REPAIR_TICK_TRADES_ROW_TS_COL."
    )


def _sql_timestamp_literal(v: Any) -> str:
    if isinstance(v, (int, float)):
        return str(int(v))
    s = str(v).strip()
    return "'" + _escape_sql_literal(s) + "'"


def _invalid_tick_trades_predicate() -> str:
    return (
        "( trade_id IS NULL OR trade_id = '' OR price IS NULL OR price <= 0 "
        "OR amount IS NULL OR amount < 0 )"
    )


def repair_tick_trades_questdb(
    *,
    http_base: str | None = None,
    qdb_conf: str | None = None,
    lookback_hours: float | None = None,
    dry_run: bool = True,
    keep: str = "newest",
) -> dict[str, int]:
    """
    - **Linhas inválidas:** as mesmas condições que ``verify_store_data`` (+ ``trade_id`` vazio).
      Só **DELETE** — não há como preencher trade_id/preço real sem a API da exchange.
    - **Duplicados:** mesmo ``(symbol_id, trade_id)`` com várias linhas; mantém **newest** ou **oldest**
      pelo ``timestamp`` de linha QuestDB; apaga as outras.
    """
    lb = lookback_hours if lookback_hours is not None else _env_float("STORE_VERIFY_LOOKBACK_HOURS", 24.0)
    conf = (qdb_conf or os.environ.get("QDB_CLIENT_CONF") or DEFAULT_QDB_CONF).strip()
    base = (http_base or _resolve_questdb_http_base(ilp_conf=conf)).rstrip("/")
    filter_col = _validate_ts_column(
        (os.environ.get("STORE_VERIFY_TS_COL") or _DEFAULT_VERIFY_TS_COL).strip(),
    )
    since = _sql_since_hours(lb)
    row_ts = _tick_trades_row_timestamp_column(base)
    pred_bad = _invalid_tick_trades_predicate()
    stats = {"invalid_deleted": 0, "dup_rows_deleted": 0, "dup_groups": 0}

    q_count_bad = (
        f"SELECT count() FROM tick_trades WHERE {filter_col} >= {since} AND {pred_bad}"
    )
    n_bad = 0
    try:
        cr = _exec_sql(base, q_count_bad)
        dr = _dataset_rows(cr)
        if dr and dr[0] and dr[0][0] is not None:
            n_bad = int(dr[0][0])
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, ValueError, OSError) as e:
        log.error("Contagem linhas inválidas: %s", e)
        return stats

    if n_bad > 0:
        q_sample = (
            f"SELECT symbol_id, trade_id, price, amount, {filter_col} FROM tick_trades "
            f"WHERE {filter_col} >= {since} AND {pred_bad} LIMIT 15"
        )
        try:
            sr = _exec_sql(base, q_sample)
            log.info("Amostra de linhas inválidas (até 15): %s", _dataset_rows(sr))
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, ValueError, OSError):
            log.warning("Não foi possível obter amostra de inválidas.")

    if not dry_run and n_bad > 0:
        del_bad = f"DELETE FROM tick_trades WHERE {filter_col} >= {since} AND {pred_bad}"
        try:
            _exec_sql(base, del_bad)
            stats["invalid_deleted"] = n_bad
            log.info("Removidas %s linhas inválidas em tick_trades (janela %.2f h).", n_bad, lb)
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, ValueError, OSError) as e:
            log.error("DELETE inválidas falhou: %s", e)

    q_dup_keys = (
        f"SELECT symbol_id, trade_id FROM ( "
        f"SELECT symbol_id, trade_id, count() AS n FROM tick_trades "
        f"WHERE {filter_col} >= {since} "
        f"GROUP BY symbol_id, trade_id "
        f") t WHERE t.n > 1"
    )
    try:
        kr = _exec_sql(base, q_dup_keys)
        keys = _dataset_rows(kr)
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, ValueError, OSError) as e:
        log.error("Lista de duplicados: %s", e)
        return stats

    keep_newest = keep.strip().lower() != "oldest"
    order = "DESC" if keep_newest else "ASC"

    for row in keys:
        if len(row) < 2 or row[0] is None or row[1] is None:
            continue
        sid = int(row[0])
        tid = str(row[1])
        esc = _escape_sql_literal(tid)
        q_ts = (
            f"SELECT {row_ts} FROM tick_trades WHERE symbol_id = {sid} "
            f"AND trade_id = '{esc}' AND {filter_col} >= {since} "
            f"ORDER BY {row_ts} {order}"
        )
        try:
            tr = _exec_sql(base, q_ts)
            trows = _dataset_rows(tr)
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, ValueError, OSError) as e:
            log.warning("symbol_id=%s trade_id=%s: ler timestamps falhou: %s", sid, tid, e)
            continue
        if len(trows) <= 1:
            continue
        stats["dup_groups"] += 1
        ts_vals = [r[0] for r in trows if r and r[0] is not None]
        if len(ts_vals) <= 1:
            continue
        to_drop = ts_vals[1:]
        log.info(
            "Duplicado symbol_id=%s trade_id=%s: %s linhas; manter %s; remover %s timestamp(s).",
            sid,
            tid,
            len(ts_vals),
            ts_vals[0],
            len(to_drop),
        )
        if dry_run:
            continue
        for tv in to_drop:
            lit = _sql_timestamp_literal(tv)
            dq = (
                f"DELETE FROM tick_trades WHERE symbol_id = {sid} "
                f"AND trade_id = '{esc}' AND {row_ts} = {lit}"
            )
            try:
                _exec_sql(base, dq)
                stats["dup_rows_deleted"] += 1
            except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, ValueError, OSError) as e:
                log.warning("DELETE dup falhou sid=%s tid=%s ts=%s: %s", sid, tid, tv, e)

    if dry_run:
        log.info(
            "[dry-run] tick_trades: %s inválidas na janela; %s grupos (symbol_id, trade_id) duplicados.",
            n_bad,
            stats["dup_groups"],
        )
        log.info("Repete com --apply para executar DELETEs (ou define --keep=oldest).")

    return stats


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
    symbol_ids = [sid for sid in (await asyncio.gather(*(registry.id_for(sym) for sym in sym_list))) if sid is not None]
    lock = asyncio.Lock()
    tick_dedup = _TickTradeDedup(_env_int("STORE_TICK_TRADES_DEDUP_KEYS", 500_000))
    tick_dedup_lock = asyncio.Lock()

    async def send_row(
        sender: Sender,
        table: str,
        *,
        symbols_kw: dict[str, Any] | None,
        columns: dict[str, Any],
        at: TimestampNanos | datetime,
    ) -> bool:
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
                return True
            except IngressError as e:
                log.error("QuestDB rejeitou linha em %s: %s", table, e)
            except Exception:
                log.exception("Falha ao escrever em %s", table)
        return False

    async def pump_tick_trades(sender: Sender, sym: str) -> None:
        async def handle(t: dict[str, Any]) -> None:
            tid_raw = t.get("trade_id")
            if not tid_raw:
                return
            tid = str(tid_raw).strip()
            if not tid:
                return
            ns = t.get("local_ts_ns")
            if not isinstance(ns, int):
                return
            try:
                price = float(t["price"])
                amount = float(t["amount"])
            except (KeyError, TypeError, ValueError):
                return
            if price <= 0 or amount < 0:
                return
            sid = await registry.id_for(t.get("symbol"))
            if sid is None:
                return
            dedup_key = (sid, tid)
            async with tick_dedup_lock:
                if not tick_dedup.try_begin(dedup_key):
                    log.debug("tick_trades dedup skip sid=%s trade_id=%s", sid, tid)
                    return
            skw: dict[str, Any] | None = {"side": t.get("side")} if t.get("side") else None
            columns: dict[str, Any] = {
                "symbol_id": sid,
                "trade_id": tid,
                "price": price,
                "amount": amount,
                "exchange_ts": _dt_utc_ms(t.get("exchange_ts")),
                "local_ts": _dt_utc_ms(t.get("local_ts")),
                "stream_batch_index": t.get("stream_batch_index"),
            }
            ok = False
            try:
                ok = await send_row(
                    sender,
                    "tick_trades",
                    symbols_kw=skw,
                    columns=columns,
                    at=TimestampNanos(ns),
                )
            finally:
                async with tick_dedup_lock:
                    tick_dedup.finish(dedup_key, success=ok)

        await _stream_loop(
            f"tick_trades[{sym}]",
            lambda: gd.tick_trades(symbol=sym),
            handle,
        )

    async def pump_mark_funding(sender: Sender, sym: str) -> None:
        async def handle(row: dict[str, Any]) -> None:
            lt = row.get("local_ts")
            if not isinstance(lt, int):
                return
            sid = await registry.id_for(row.get("symbol"))
            if sid is None:
                return
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

        await _stream_loop(
            f"mark_price_funding[{sym}]",
            lambda: gd.mark_price_funding(symbol=sym),
            handle,
        )

    async def pump_open_interest(sender: Sender, sym: str) -> None:
        async def handle(row: dict[str, Any]) -> None:
            lt = row.get("local_ts")
            if not isinstance(lt, int):
                return
            oi = row.get("open_interest_amount")
            if oi is None:
                return
            sid = await registry.id_for(row.get("symbol"))
            if sid is None:
                return
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

        await _stream_loop(
            f"open_interest[{sym}]",
            lambda: gd.open_interest_poll(symbol=sym),
            handle,
        )

    async def pump_order_book(sender: Sender, sym: str) -> None:
        async def handle(snap: dict[str, Any]) -> None:
            lt = snap.get("local_ts")
            if not isinstance(lt, int):
                return
            bids = snap.get("bids") or []
            asks = snap.get("asks") or []
            m = _order_book_metrics(bids, asks)
            if m is None:
                return
            bb, ba, spread, bd, ad, n_b, n_a = m
            sid = await registry.id_for(snap.get("symbol"))
            if sid is None:
                return
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

        await _stream_loop(
            f"order_book[{sym}]",
            lambda: gd.order_book_snapshots(symbol=sym),
            handle,
        )

    async def pump_liquidations_all(sender: Sender) -> None:
        def liq_factory() -> AsyncIterator[dict[str, Any]]:
            if len(sym_list) == 1:
                return gd.liquidation_events(symbol=sym_list[0])
            return gd.liquidation_events(symbols=list(sym_list))

        async def handle(ev: dict[str, Any]) -> None:
            lt = ev.get("local_ts")
            if not isinstance(lt, int):
                return
            lid = ev.get("liquidation_event_id")
            if not lid:
                return
            sid = await registry.id_for(ev.get("symbol"))
            if sid is None:
                return
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

        await _stream_loop("liquidations", liq_factory, handle)

    async def pump_candles(sender: Sender, sym: str) -> None:
        async def handle(c: list) -> None:
            if len(c) < 6:
                return
            open_ms = int(c[0])
            sid = await registry.id_for(sym)
            if sid is None:
                return
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

        await _stream_loop(
            f"candles_1m[{sym}]",
            lambda: gd.closed_1m_candles(symbol=sym),
            handle,
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
    chart_features_enabled = _env_truthy("STORE_CHART_FEATURES_ENABLED", True)
    chart_features_interval_sec = _env_int("STORE_CHART_FEATURES_INTERVAL_SEC", 300)
    chart_features_lookback_minutes = _env_int("STORE_CHART_FEATURES_LOOKBACK_MINUTES", 10)
    chart_features_lag_sec = _env_int("STORE_CHART_FEATURES_LAG_SEC", 90)
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

    if chart_features_enabled:
        log.info(
            "Materialização chart_features_1m activa: cada %s s, lookback=%s min, lag=%s s, symbols=%s.",
            chart_features_interval_sec,
            chart_features_lookback_minutes,
            chart_features_lag_sec,
            symbol_ids,
        )

    auto_repair_after_verify = _env_truthy("STORE_VERIFY_AUTO_REPAIR", False)
    repair_keep = os.environ.get("STORE_VERIFY_REPAIR_KEEP", "newest").strip().lower()
    if repair_keep not in ("newest", "oldest"):
        repair_keep = "newest"
    repair_lb_raw = os.environ.get("STORE_VERIFY_REPAIR_LOOKBACK_HOURS", "").strip()
    repair_lookback_period: float | None
    if repair_lb_raw:
        repair_lookback_period = float(repair_lb_raw)
    else:
        repair_lookback_period = None

    if verify_interval_sec > 0 and auto_repair_after_verify:
        log.info(
            "STORE_VERIFY_AUTO_REPAIR=1: se a verificação falhar, corre reparação tick_trades (apply) "
            "e nova verificação (keep=%s).",
            repair_keep,
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
                log.info("Verificação automática: a executar consultas à QuestDB…")
                rep = await asyncio.to_thread(
                    verify_store_data,
                    http_base=http_base,
                )
                log_store_health_report(rep)
                if not rep.ok and auto_repair_after_verify:
                    log.warning(
                        "Verificação automática: problemas — reparação tick_trades (apply) e nova verificação."
                    )
                    await asyncio.to_thread(
                        repair_tick_trades_questdb,
                        dry_run=False,
                        http_base=http_base,
                        lookback_hours=repair_lookback_period,
                        keep=repair_keep,
                    )
                    rep2 = await asyncio.to_thread(
                        verify_store_data,
                        http_base=http_base,
                    )
                    log.info("Verificação automática: após reparação:")
                    log_store_health_report(rep2)
            except Exception:
                log.exception("Verificação automática dos dados falhou")

    async def periodic_chart_features_1m() -> None:
        await asyncio.sleep(min(15, max(1, chart_features_interval_sec)))
        timeout = httpx.Timeout(120.0, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            while True:
                try:
                    now_sec = int(datetime.now(tz=timezone.utc).timestamp())
                    end_sec = ((now_sec - max(0, chart_features_lag_sec)) // 60) * 60
                    start_sec = end_sec - max(1, chart_features_lookback_minutes) * 60
                    if end_sec > start_sec:
                        total_inserted = 0
                        for sid in symbol_ids:
                            res = await backfill_chart_features_1m_range(
                                client,
                                int(sid),
                                start_sec,
                                end_sec,
                                chunk_minutes=max(60, int(chart_features_lookback_minutes)),
                            )
                            total_inserted += int(res.get("inserted") or 0)
                            errs = res.get("errors") or []
                            if errs:
                                log.warning("chart_features_1m sid=%s errors=%s", sid, errs)
                        log.info(
                            "chart_features_1m: janela %s -> %s, inserted=%s",
                            datetime.fromtimestamp(start_sec, tz=timezone.utc).isoformat(),
                            datetime.fromtimestamp(end_sec, tz=timezone.utc).isoformat(),
                            total_inserted,
                        )
                except Exception:
                    log.exception("Materialização chart_features_1m falhou")
                await asyncio.sleep(max(30, chart_features_interval_sec))

    with Sender.from_conf(
        conf,
        auto_flush_rows=flush_rows,
        auto_flush_interval=flush_interval_ns,
    ) as sender:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(heartbeat())
            if verify_interval_sec > 0:
                tg.create_task(periodic_verify())
            if chart_features_enabled and symbol_ids:
                tg.create_task(periodic_chart_features_1m())
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
        rest = sys.argv[2:]
        auto_repair = _env_truthy("STORE_VERIFY_AUTO_REPAIR", False)
        if "--auto-repair" in rest:
            auto_repair = True
        if "--no-auto-repair" in rest:
            auto_repair = False
        repair_lookback_cli: float | None = None
        repair_keep_cli = "newest"
        for a in rest:
            if a.startswith("--repair-lookback-hours="):
                repair_lookback_cli = float(a.split("=", 1)[1].strip())
            elif a.startswith("--repair-keep="):
                repair_keep_cli = a.split("=", 1)[1].strip().lower()
        if repair_keep_cli not in ("newest", "oldest"):
            log.error("--repair-keep deve ser newest ou oldest")
            raise SystemExit(2)
        rep = verify_store_data()
        log_store_health_report(rep)
        if not rep.ok and auto_repair:
            log.warning(
                "Verificação com problemas — reparação tick_trades (apply) e nova verificação "
                "(keep=%s).",
                repair_keep_cli,
            )
            stats = repair_tick_trades_questdb(
                dry_run=False,
                lookback_hours=repair_lookback_cli,
                keep=repair_keep_cli,
            )
            log.info("Reparação concluída: %s", stats)
            rep2 = verify_store_data()
            log.info("— Verificação após reparação —")
            log_store_health_report(rep2)
            raise SystemExit(0 if rep2.ok else 2)
        raise SystemExit(0 if rep.ok else 2)
    if len(sys.argv) >= 2 and sys.argv[1] in ("--repair-tick-trades", "repair-ticks"):
        dry_run = "--apply" not in sys.argv
        lookback_hours: float | None = None
        keep = "newest"
        for a in sys.argv[2:]:
            if a.startswith("--lookback-hours="):
                lookback_hours = float(a.split("=", 1)[1].strip())
            elif a.startswith("--keep="):
                keep = a.split("=", 1)[1].strip().lower()
        if keep not in ("newest", "oldest"):
            log.error("--keep deve ser newest ou oldest")
            raise SystemExit(2)
        stats = repair_tick_trades_questdb(
            dry_run=dry_run,
            lookback_hours=lookback_hours,
            keep=keep,
        )
        log.info("Resumo reparação tick_trades: %s", stats)
        raise SystemExit(0)
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
