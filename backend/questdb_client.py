"""
Cliente QuestDB (GET /exec) e SQL de velas — espelha ``my-app/lib/questdb.ts``.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

import httpx

DEFAULT_QUESTDB = "http://127.0.0.1:9000"
MAX_POINTS_CAP = 10_000

TIMEFRAME_TO_SAMPLE: dict[str, str | None] = {
    "1m": None,
    "2m": "2m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "45m": "45m",
    "1h": "1h",
    "2h": "2h",
    "3h": "3h",
    "4h": "4h",
    "6h": "6h",
    "12h": "12h",
    "1d": "1d",
    "7d": "7d",
    "1w": "1w",
}


def questdb_http_base() -> str:
    return os.environ.get("QUESTDB_HTTP_URL", DEFAULT_QUESTDB).rstrip("/")


async def async_questdb_exec_raw(client: httpx.AsyncClient, query: str) -> dict[str, Any]:
    """GET ``/exec`` na QuestDB; erros de rede/HTTP propagam como exceções ``httpx``."""
    base = questdb_http_base()
    r = await client.get(f"{base}/exec", params={"query": query})
    r.raise_for_status()
    return r.json()


def candles_ts_column() -> str:
    c = (os.environ.get("QUESTDB_CANDLES_TS_COL") or "local_ts").strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", c):
        raise ValueError(f"QUESTDB_CANDLES_TS_COL inválido: {c!r}")
    return c


def is_valid_timeframe(tf: str) -> bool:
    return tf in TIMEFRAME_TO_SAMPLE


def ts_iso(ms: float | int) -> str:
    d = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def rows_as_objects(resp: dict[str, Any]) -> list[dict[str, Any]]:
    cols_meta = resp.get("columns") or []
    names: list[str] = []
    for c in cols_meta:
        if isinstance(c, dict) and isinstance(c.get("name"), str):
            names.append(c["name"])
        else:
            names.append("")
    out: list[dict[str, Any]] = []
    for row in resp.get("dataset") or []:
        if not isinstance(row, list):
            continue
        o: dict[str, Any] = {}
        for i in range(min(len(names), len(row))):
            o[names[i]] = row[i]
        out.append(o)
    return out


def parse_ts_to_unix_sec(v: Any) -> int | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        x = float(v)
        if x > 1e17:
            return int(x / 1e9)
        if x > 1e14:
            return int(x / 1e6)
        if x > 1e12:
            return int(x / 1000)
        if x > 1e10:
            return int(x)
        return int(x)
    s = str(v).strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        return None


def build_candles_backward_query(
    symbol_id: int,
    timeframe: str,
    before_ms: float | int,
    limit: int,
    ts_col: str | None = None,
    *,
    bar_cap: int | None = None,
) -> tuple[str, str]:
    if timeframe not in TIMEFRAME_TO_SAMPLE:
        raise ValueError(f"timeframe inválido: {timeframe}")
    sample = TIMEFRAME_TO_SAMPLE[timeframe]
    col = ts_col if ts_col is not None else candles_ts_column()
    t_before = ts_iso(before_ms)
    cap = int(bar_cap) if bar_cap is not None else MAX_POINTS_CAP
    cap = max(1, cap)
    lim = min(cap, max(1, int(limit)))

    if sample is None:
        inner = (
            f"SELECT {col}, "
            f"first(open) AS open, max(high) AS high, min(low) AS low, "
            f"last(close) AS close, last(volume) AS volume "
            f"FROM candles_1m "
            f"WHERE symbol_id = {symbol_id} AND {col} < '{t_before}' "
            f"SAMPLE BY 1m ALIGN TO CALENDAR "
            f"ORDER BY {col} DESC "
            f"LIMIT {lim}"
        )
        return ("1m", f"SELECT * FROM ({inner}) x ORDER BY 1 ASC")

    inner = (
        f"SELECT {col}, "
        f"first(open) AS open, max(high) AS high, min(low) AS low, "
        f"last(close) AS close, sum(volume) AS volume "
        f"FROM candles_1m "
        f"WHERE symbol_id = {symbol_id} AND {col} < '{t_before}' "
        f"SAMPLE BY {sample} ALIGN TO CALENDAR "
        f"ORDER BY {col} DESC "
        f"LIMIT {lim}"
    )
    return (sample, f"SELECT * FROM ({inner}) x ORDER BY 1 ASC")


def build_candles_range_query(
    symbol_id: int,
    timeframe: str,
    from_ms: float | int,
    to_ms: float | int,
    limit: int,
    ts_col: str | None = None,
    *,
    bar_cap: int | None = None,
) -> tuple[str, str]:
    if timeframe not in TIMEFRAME_TO_SAMPLE:
        raise ValueError(f"timeframe inválido: {timeframe}")
    sample = TIMEFRAME_TO_SAMPLE[timeframe]
    col = ts_col if ts_col is not None else candles_ts_column()
    t_from = ts_iso(from_ms)
    t_to = ts_iso(to_ms)
    cap = int(bar_cap) if bar_cap is not None else MAX_POINTS_CAP
    cap = max(1, cap)
    lim = min(cap, max(1, int(limit)))

    if sample is None:
        sql = (
            f"SELECT {col}, "
            f"first(open) AS open, max(high) AS high, min(low) AS low, "
            f"last(close) AS close, last(volume) AS volume "
            f"FROM candles_1m "
            f"WHERE symbol_id = {symbol_id} AND {col} >= '{t_from}' AND {col} < '{t_to}' "
            f"SAMPLE BY 1m ALIGN TO CALENDAR "
            f"ORDER BY {col} ASC "
            f"LIMIT {lim}"
        )
        return ("1m", sql)

    sql = (
        f"SELECT {col}, "
        f"first(open) AS open, max(high) AS high, min(low) AS low, "
        f"last(close) AS close, sum(volume) AS volume "
        f"FROM candles_1m "
        f"WHERE symbol_id = {symbol_id} AND {col} >= '{t_from}' AND {col} < '{t_to}' "
        f"SAMPLE BY {sample} ALIGN TO CALENDAR "
        f"ORDER BY {col} ASC "
        f"LIMIT {lim}"
    )
    return (sample, sql)


def rows_to_bars(rows: list[dict[str, Any]], ts_col: str) -> list[dict[str, Any]]:
    bars: list[dict[str, Any]] = []
    for r in rows:
        ts = parse_ts_to_unix_sec(r.get(ts_col))
        if ts is None:
            continue
        try:
            bars.append(
                {
                    "t": ts,
                    "o": float(r["open"]),
                    "h": float(r["high"]),
                    "l": float(r["low"]),
                    "c": float(r["close"]),
                    "v": float(r.get("volume") or 0),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    return bars


SYMBOL_QUERIES = (
    "SELECT symbol_id, last(code) AS code FROM symbols GROUP BY symbol_id ORDER BY symbol_id",
    "SELECT DISTINCT symbol_id, code FROM symbols WHERE code IS NOT NULL ORDER BY symbol_id",
)
