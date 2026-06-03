"""
Agregados persistentes 1m para facetas pesadas do chart.

Mantém as tabelas raw em QuestDB como fonte de verdade, mas materializa a grelha
``chart_features_1m`` para evitar reagregar ticks/liquidações/livro a cada pedido.
"""

from __future__ import annotations

import asyncio
import math
import os
from typing import Any

import httpx

from questdb_client import async_questdb_exec_raw, parse_ts_to_unix_sec, rows_as_objects, ts_iso

TABLE = "chart_features_1m"
MAX_BACKFILL_MINUTES = 80_000
SYNC_BACKFILL_MAX_MINUTES = max(
    60,
    int(os.environ.get("CHART_FEAT_SYNC_BACKFILL_MAX_MINUTES", "0") or "0"),
)
INSERT_BATCH_ROWS = max(1, int(os.environ.get("CHART_FEAT_INSERT_BATCH_ROWS", "50") or "50"))
_WARMING_KEYS: set[tuple[int, int, int]] = set()

SUM_IDS = (
    "feat_liq_long",
    "feat_liq_short",
    "feat_tick_buy_vol",
    "feat_tick_sell_vol",
)
SNAP_IDS = (
    "feat_oi_snap",
    "feat_mark_px",
    "feat_funding_rate",
    "feat_index_px",
    "feat_ob_imb_snap",
)

DDL = f"""
CREATE TABLE IF NOT EXISTS {TABLE} (
    ts TIMESTAMP,
    symbol_id INT,
    liq_long DOUBLE,
    liq_short DOUBLE,
    tick_buy_vol DOUBLE,
    tick_sell_vol DOUBLE,
    oi_snap DOUBLE,
    mark_px DOUBLE,
    funding_rate DOUBLE,
    index_px DOUBLE,
    ob_spread_avg DOUBLE,
    ob_spread_count INT,
    ob_imb_snap DOUBLE
) timestamp(ts) PARTITION BY MONTH
"""


def _minute_floor(sec: float) -> int:
    return int(math.floor(float(sec) / 60.0) * 60)


def _minute_ceil(sec: float) -> int:
    return int(math.ceil(float(sec) / 60.0) * 60)


def minute_range_for_bars(barriers_sec: list[float], step_est: float) -> tuple[int, int]:
    start = _minute_floor(barriers_sec[0])
    end = _minute_ceil(barriers_sec[-1] + max(60.0, float(step_est)))
    return start, max(end, start + 60)


def _is_long_liquidation(side_raw: object) -> bool:
    s = str(side_raw or "").lower()
    if "short" in s or s == "buy":
        return False
    if "long" in s or s == "sell":
        return True
    return True


def _finite_float(raw: object, default: float = 0.0) -> float:
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _quote_ts(sec: int) -> str:
    return ts_iso(int(sec) * 1000)


async def _safe_rows(client: httpx.AsyncClient, query: str) -> tuple[list[dict[str, Any]], str | None]:
    try:
        return rows_as_objects(await async_questdb_exec_raw(client, query)), None
    except Exception as e:  # noqa: BLE001 - caller decides whether to fallback
        return [], str(e)


async def ensure_chart_features_table(client: httpx.AsyncClient) -> None:
    await async_questdb_exec_raw(client, DDL)


def _empty_minute_rows(start_sec: int, end_sec: int) -> dict[int, dict[str, float | int | None]]:
    rows: dict[int, dict[str, float | int | None]] = {}
    for t in range(start_sec, end_sec, 60):
        rows[t] = {
            "liq_long": 0.0,
            "liq_short": 0.0,
            "tick_buy_vol": 0.0,
            "tick_sell_vol": 0.0,
            "oi_snap": None,
            "mark_px": None,
            "funding_rate": None,
            "index_px": None,
            "ob_spread_sum": 0.0,
            "ob_spread_count": 0,
            "ob_imb_snap": None,
        }
    return rows


def _minute_key(row: dict[str, Any]) -> int | None:
    tv = parse_ts_to_unix_sec(row.get("local_ts"))
    if tv is None:
        return None
    return _minute_floor(tv)


def _ffill_optional_minute_values(
    rows: dict[int, dict[str, float | int | None]],
    field: str,
) -> None:
    last: float | None = None
    for t in sorted(rows):
        v = rows[t].get(field)
        if isinstance(v, (int, float)) and math.isfinite(float(v)):
            last = float(v)
            rows[t][field] = last
        elif last is not None:
            rows[t][field] = last
        else:
            rows[t][field] = 0.0


def _apply_liquidations(
    out: dict[int, dict[str, float | int | None]],
    rows: list[dict[str, Any]],
) -> None:
    for row in rows:
        mt = _minute_key(row)
        if mt is None or mt not in out:
            continue
        amt = abs(_finite_float(row.get("contracts")))
        if amt <= 0:
            continue
        key = "liq_long" if _is_long_liquidation(row.get("side")) else "liq_short"
        out[mt][key] = float(out[mt][key] or 0.0) + amt


def _apply_ticks(
    out: dict[int, dict[str, float | int | None]],
    rows: list[dict[str, Any]],
) -> None:
    for row in rows:
        mt = _minute_key(row)
        if mt is None or mt not in out:
            continue
        amt = abs(_finite_float(row.get("amount")))
        if amt <= 0:
            continue
        side = str(row.get("side") or "").strip().lower()
        if "buy" in side:
            out[mt]["tick_buy_vol"] = float(out[mt]["tick_buy_vol"] or 0.0) + amt
        elif "sell" in side:
            out[mt]["tick_sell_vol"] = float(out[mt]["tick_sell_vol"] or 0.0) + amt


def _apply_last_value(
    out: dict[int, dict[str, float | int | None]],
    rows: list[dict[str, Any]],
    src: str,
    dst: str,
) -> None:
    last_ts_by_minute: dict[int, int] = {}
    for row in rows:
        tv = parse_ts_to_unix_sec(row.get("local_ts"))
        if tv is None:
            continue
        mt = _minute_floor(tv)
        if mt not in out:
            continue
        v = _finite_float(row.get(src), float("nan"))
        if not math.isfinite(v):
            continue
        prev = last_ts_by_minute.get(mt)
        if prev is None or tv >= prev:
            last_ts_by_minute[mt] = tv
            out[mt][dst] = v


def _apply_order_book(
    out: dict[int, dict[str, float | int | None]],
    rows: list[dict[str, Any]],
) -> None:
    last_ts_by_minute: dict[int, int] = {}
    for row in rows:
        tv = parse_ts_to_unix_sec(row.get("local_ts"))
        if tv is None:
            continue
        mt = _minute_floor(tv)
        if mt not in out:
            continue
        sp = _finite_float(row.get("spread"), float("nan"))
        if math.isfinite(sp) and sp >= 0:
            out[mt]["ob_spread_sum"] = float(out[mt]["ob_spread_sum"] or 0.0) + sp
            out[mt]["ob_spread_count"] = int(out[mt]["ob_spread_count"] or 0) + 1
        bd = _finite_float(row.get("bid_depth_1pct"))
        ad = _finite_float(row.get("ask_depth_1pct"))
        tot = bd + ad
        imb = (bd - ad) / tot if tot > 0 else float("nan")
        if not math.isfinite(imb):
            continue
        prev = last_ts_by_minute.get(mt)
        if prev is None or tv >= prev:
            last_ts_by_minute[mt] = tv
            out[mt]["ob_imb_snap"] = imb


def _finalize_minute_rows(rows: dict[int, dict[str, float | int | None]]) -> list[dict[str, float | int]]:
    for field in ("oi_snap", "mark_px", "funding_rate", "index_px", "ob_imb_snap"):
        _ffill_optional_minute_values(rows, field)

    out: list[dict[str, float | int]] = []
    for t in sorted(rows):
        row = rows[t]
        cnt = int(row["ob_spread_count"] or 0)
        sp_avg = float(row["ob_spread_sum"] or 0.0) / cnt if cnt > 0 else 0.0
        out.append(
            {
                "ts": t,
                "liq_long": float(row["liq_long"] or 0.0),
                "liq_short": float(row["liq_short"] or 0.0),
                "tick_buy_vol": float(row["tick_buy_vol"] or 0.0),
                "tick_sell_vol": float(row["tick_sell_vol"] or 0.0),
                "oi_snap": float(row["oi_snap"] or 0.0),
                "mark_px": float(row["mark_px"] or 0.0),
                "funding_rate": float(row["funding_rate"] or 0.0),
                "index_px": float(row["index_px"] or 0.0),
                "ob_spread_avg": sp_avg,
                "ob_spread_count": cnt,
                "ob_imb_snap": float(row["ob_imb_snap"] or 0.0),
            }
        )
    return out


async def _existing_minutes(
    client: httpx.AsyncClient,
    symbol_id: int,
    start_sec: int,
    end_sec: int,
) -> set[int]:
    q = (
        f"SELECT ts FROM {TABLE} "
        f"WHERE symbol_id = {int(symbol_id)} "
        f"AND ts >= '{_quote_ts(start_sec)}' AND ts < '{_quote_ts(end_sec)}'"
    )
    rows, err = await _safe_rows(client, q)
    if err:
        return set()
    out: set[int] = set()
    for row in rows:
        tv = parse_ts_to_unix_sec(row.get("ts"))
        if tv is not None:
            out.add(_minute_floor(tv))
    return out


async def _fetch_raw_fact_rows(
    client: httpx.AsyncClient,
    symbol_id: int,
    start_sec: int,
    end_sec: int,
) -> tuple[list[list[dict[str, Any]]], list[str]]:
    sid = int(symbol_id)
    lo = _quote_ts(start_sec)
    hi = _quote_ts(end_sec)
    queries = (
        (
            "liquidations",
            f"SELECT local_ts, contracts, side FROM liquidations "
            f"WHERE symbol_id = {sid} AND local_ts >= '{lo}' AND local_ts < '{hi}'",
        ),
        (
            "tick_trades",
            f"SELECT local_ts, amount, side FROM tick_trades "
            f"WHERE symbol_id = {sid} AND local_ts >= '{lo}' AND local_ts < '{hi}'",
        ),
        (
            "open_interest",
            f"SELECT local_ts, oi_amount FROM open_interest "
            f"WHERE symbol_id = {sid} AND local_ts >= '{lo}' AND local_ts < '{hi}' "
            "ORDER BY local_ts ASC",
        ),
        (
            "mark_price_funding",
            f"SELECT local_ts, mark_price, funding_rate, index_price FROM mark_price_funding "
            f"WHERE symbol_id = {sid} AND local_ts >= '{lo}' AND local_ts < '{hi}' "
            "ORDER BY local_ts ASC",
        ),
        (
            "order_book",
            f"SELECT local_ts, spread, bid_depth_1pct, ask_depth_1pct FROM order_book "
            f"WHERE symbol_id = {sid} AND local_ts >= '{lo}' AND local_ts < '{hi}' "
            "ORDER BY local_ts ASC",
        ),
    )
    fetched = await asyncio.gather(*(_safe_rows(client, q) for _, q in queries))
    errors: list[str] = []
    out: list[list[dict[str, Any]]] = []
    for (name, _), (rows, err) in zip(queries, fetched):
        if err:
            errors.append(f"{name}: {err}")
            out.append([])
        else:
            out.append(rows)
    return out, errors


def _sql_num(v: object) -> str:
    x = _finite_float(v)
    return repr(float(x))


async def _insert_values_with_split(
    client: httpx.AsyncClient,
    cols: str,
    values: list[str],
) -> None:
    if not values:
        return
    sql = f"INSERT INTO {TABLE} ({cols}) VALUES " + ",".join(values)
    try:
        await async_questdb_exec_raw(client, sql)
        return
    except (httpx.RemoteProtocolError, httpx.ReadError, httpx.ConnectError):
        if len(values) <= 1:
            raise
        mid = len(values) // 2
        await _insert_values_with_split(client, cols, values[:mid])
        await _insert_values_with_split(client, cols, values[mid:])


async def _insert_minute_rows(
    client: httpx.AsyncClient,
    symbol_id: int,
    rows: list[dict[str, float | int]],
) -> None:
    sid = int(symbol_id)
    cols = (
        "ts, symbol_id, liq_long, liq_short, tick_buy_vol, tick_sell_vol, "
        "oi_snap, mark_px, funding_rate, index_px, ob_spread_avg, ob_spread_count, ob_imb_snap"
    )
    for i in range(0, len(rows), INSERT_BATCH_ROWS):
        values: list[str] = []
        for row in rows[i : i + INSERT_BATCH_ROWS]:
            values.append(
                "("
                f"'{_quote_ts(int(row['ts']))}', {sid}, "
                f"{_sql_num(row['liq_long'])}, {_sql_num(row['liq_short'])}, "
                f"{_sql_num(row['tick_buy_vol'])}, {_sql_num(row['tick_sell_vol'])}, "
                f"{_sql_num(row['oi_snap'])}, {_sql_num(row['mark_px'])}, "
                f"{_sql_num(row['funding_rate'])}, {_sql_num(row['index_px'])}, "
                f"{_sql_num(row['ob_spread_avg'])}, {int(row['ob_spread_count'])}, "
                f"{_sql_num(row['ob_imb_snap'])}"
                ")"
            )
        await _insert_values_with_split(client, cols, values)


async def _seed_from_previous_cache(
    client: httpx.AsyncClient,
    symbol_id: int,
    start_sec: int,
    rows: dict[int, dict[str, float | int | None]],
) -> None:
    """Continua snapshots ffill quando o backfill é feito por chunks."""
    if not rows:
        return
    first_minute = min(rows)
    q = (
        "SELECT oi_snap, mark_px, funding_rate, index_px, ob_imb_snap "
        f"FROM {TABLE} WHERE symbol_id = {int(symbol_id)} "
        f"AND ts < '{_quote_ts(start_sec)}' ORDER BY ts DESC LIMIT 1"
    )
    cached, err = await _safe_rows(client, q)
    if err or not cached:
        return
    prev = cached[0]
    for field in ("oi_snap", "mark_px", "funding_rate", "index_px", "ob_imb_snap"):
        v = _finite_float(prev.get(field), float("nan"))
        if math.isfinite(v):
            rows[first_minute][field] = v


async def backfill_chart_features_1m(
    client: httpx.AsyncClient,
    symbol_id: int,
    start_sec: int,
    end_sec: int,
    *,
    enforce_sync_limit: bool = True,
) -> dict[str, Any]:
    await ensure_chart_features_table(client)
    start_sec = _minute_floor(start_sec)
    end_sec = _minute_ceil(end_sec)
    total_minutes = max(0, int((end_sec - start_sec) / 60))
    if total_minutes == 0:
        return {"inserted": 0, "errors": []}
    if total_minutes > MAX_BACKFILL_MINUTES:
        raise ValueError(f"range demasiado grande para backfill 1m ({total_minutes} minutos)")
    if enforce_sync_limit and (SYNC_BACKFILL_MAX_MINUTES <= 0 or total_minutes > SYNC_BACKFILL_MAX_MINUTES):
        raise RuntimeError(
            f"backfill 1m adiado: {total_minutes} minutos excede limite síncrono "
            f"{SYNC_BACKFILL_MAX_MINUTES}"
        )

    existing = await _existing_minutes(client, symbol_id, start_sec, end_sec)
    wanted = set(range(start_sec, end_sec, 60))
    missing = sorted(wanted - existing)
    if not missing:
        return {"inserted": 0, "errors": []}

    raw_rows, errors = await _fetch_raw_fact_rows(client, symbol_id, start_sec, end_sec)
    if errors:
        raise RuntimeError("; ".join(errors))
    minute_rows = _empty_minute_rows(start_sec, end_sec)
    await _seed_from_previous_cache(client, symbol_id, start_sec, minute_rows)
    _apply_liquidations(minute_rows, raw_rows[0])
    _apply_ticks(minute_rows, raw_rows[1])
    _apply_last_value(minute_rows, raw_rows[2], "oi_amount", "oi_snap")
    _apply_last_value(minute_rows, raw_rows[3], "mark_price", "mark_px")
    _apply_last_value(minute_rows, raw_rows[3], "funding_rate", "funding_rate")
    _apply_last_value(minute_rows, raw_rows[3], "index_price", "index_px")
    _apply_order_book(minute_rows, raw_rows[4])

    finalized = [r for r in _finalize_minute_rows(minute_rows) if int(r["ts"]) in missing]
    await _insert_minute_rows(client, symbol_id, finalized)
    return {"inserted": len(finalized), "errors": errors}


async def infer_chart_features_1m_range(
    client: httpx.AsyncClient,
    symbol_id: int,
) -> tuple[int, int]:
    """Usa ``candles_1m`` como grelha principal para decidir o intervalo a materializar."""
    sid = int(symbol_id)
    q = f"SELECT min(local_ts) AS lo, max(local_ts) AS hi FROM candles_1m WHERE symbol_id = {sid}"
    rows, err = await _safe_rows(client, q)
    if err:
        raise RuntimeError(f"candles_1m: {err}")
    if not rows:
        raise ValueError(f"sem candles_1m para symbol_id={sid}")
    lo = parse_ts_to_unix_sec(rows[0].get("lo"))
    hi = parse_ts_to_unix_sec(rows[0].get("hi"))
    if lo is None or hi is None:
        raise ValueError(f"sem intervalo válido em candles_1m para symbol_id={sid}")
    return _minute_floor(lo), _minute_ceil(hi + 60)


async def backfill_chart_features_1m_range(
    client: httpx.AsyncClient,
    symbol_id: int,
    start_sec: int,
    end_sec: int,
    *,
    chunk_minutes: int = 7 * 24 * 60,
) -> dict[str, Any]:
    """Backfill chunked para intervalos grandes sem exceder o limite por chamada."""
    await ensure_chart_features_table(client)
    start_sec = _minute_floor(start_sec)
    end_sec = _minute_ceil(end_sec)
    if end_sec <= start_sec:
        return {"symbol_id": int(symbol_id), "inserted": 0, "chunks": 0, "errors": []}
    chunk_minutes = max(60, min(MAX_BACKFILL_MINUTES, int(chunk_minutes)))
    step = chunk_minutes * 60
    inserted = 0
    chunks = 0
    errors: list[str] = []
    cur = start_sec
    while cur < end_sec:
        nxt = min(end_sec, cur + step)
        res = await backfill_chart_features_1m(
            client,
            symbol_id,
            cur,
            nxt,
            enforce_sync_limit=False,
        )
        inserted += int(res.get("inserted") or 0)
        errors.extend(str(e) for e in (res.get("errors") or []))
        chunks += 1
        cur = nxt
    return {
        "symbol_id": int(symbol_id),
        "start_sec": start_sec,
        "end_sec": end_sec,
        "inserted": inserted,
        "chunks": chunks,
        "errors": errors,
    }


async def fetch_chart_features_1m_rows(
    client: httpx.AsyncClient,
    symbol_id: int,
    start_sec: int,
    end_sec: int,
) -> list[dict[str, Any]]:
    q = (
        "SELECT ts, liq_long, liq_short, tick_buy_vol, tick_sell_vol, "
        "oi_snap, mark_px, funding_rate, index_px, ob_spread_avg, ob_spread_count, ob_imb_snap "
        f"FROM {TABLE} WHERE symbol_id = {int(symbol_id)} "
        f"AND ts >= '{_quote_ts(start_sec)}' AND ts < '{_quote_ts(end_sec)}' "
        "ORDER BY ts ASC"
    )
    return rows_as_objects(await async_questdb_exec_raw(client, q))


def _derived_tick(buy: float, sell: float, ratio_cap: float = 1_000_000.0) -> tuple[float, float]:
    buy = max(0.0, buy if math.isfinite(buy) else 0.0)
    sell = max(0.0, sell if math.isfinite(sell) else 0.0)
    if sell <= 1e-14:
        ratio = ratio_cap if buy > 1e-14 else 0.0
    else:
        ratio = min(buy / sell, ratio_cap)
    tot = buy + sell
    imb = (buy - sell) / tot if tot > 1e-14 else 0.0
    return ratio, imb


def aggregate_1m_rows_to_bars(
    rows: list[dict[str, Any]],
    barriers_sec: list[float],
    step_est: float,
) -> dict[str, list[float]]:
    n = len(barriers_sec)
    out: dict[str, list[float]] = {
        fid: [0.0] * n for fid in (*SUM_IDS, *SNAP_IDS, "feat_ob_spread_avg")
    }
    spread_num = [0.0] * n
    spread_den = [0.0] * n
    snap_seen = {fid: [False] * n for fid in SNAP_IDS}

    sorted_rows = sorted(rows, key=lambda r: parse_ts_to_unix_sec(r.get("ts")) or 0)
    bi = 0
    for row in sorted_rows:
        tv = parse_ts_to_unix_sec(row.get("ts"))
        if tv is None:
            continue
        while bi < n:
            hi = barriers_sec[bi + 1] if bi + 1 < n else barriers_sec[bi] + max(60.0, step_est)
            if tv < hi:
                break
            bi += 1
        if bi >= n or tv < barriers_sec[bi]:
            continue
        out["feat_liq_long"][bi] += _finite_float(row.get("liq_long"))
        out["feat_liq_short"][bi] += _finite_float(row.get("liq_short"))
        out["feat_tick_buy_vol"][bi] += _finite_float(row.get("tick_buy_vol"))
        out["feat_tick_sell_vol"][bi] += _finite_float(row.get("tick_sell_vol"))
        cnt = max(0.0, _finite_float(row.get("ob_spread_count")))
        if cnt > 0:
            spread_num[bi] += _finite_float(row.get("ob_spread_avg")) * cnt
            spread_den[bi] += cnt
        for src, dst in (
            ("oi_snap", "feat_oi_snap"),
            ("mark_px", "feat_mark_px"),
            ("funding_rate", "feat_funding_rate"),
            ("index_px", "feat_index_px"),
            ("ob_imb_snap", "feat_ob_imb_snap"),
        ):
            out[dst][bi] = _finite_float(row.get(src))
            snap_seen[dst][bi] = True

    for i in range(n):
        out["feat_ob_spread_avg"][i] = spread_num[i] / spread_den[i] if spread_den[i] > 0 else 0.0

    for fid in SNAP_IDS:
        last = 0.0
        for i in range(n):
            if snap_seen[fid][i]:
                last = out[fid][i]
            else:
                out[fid][i] = last

    ratio = [0.0] * n
    imbalance = [0.0] * n
    for i in range(n):
        ratio[i], imbalance[i] = _derived_tick(
            out["feat_tick_buy_vol"][i],
            out["feat_tick_sell_vol"][i],
        )
    out["feat_tick_buy_sell_ratio"] = ratio
    out["feat_tick_imbalance"] = imbalance
    return out


async def chart_features_from_1m_cache(
    client: httpx.AsyncClient,
    symbol_id: int,
    barriers_sec: list[float],
    step_est: float,
    *,
    warm_missing: bool = True,
) -> tuple[dict[str, list[float]], dict[str, Any]]:
    start_sec, end_sec = minute_range_for_bars(barriers_sec, step_est)
    await ensure_chart_features_table(client)
    rows = await fetch_chart_features_1m_rows(client, symbol_id, start_sec, end_sec)
    expected = max(1, int((end_sec - start_sec) / 60))
    meta: dict[str, Any] = {"inserted": 0, "errors": [], "warming": False}

    if len(rows) < expected:
        key = (int(symbol_id), int(start_sec), int(end_sec))
        if warm_missing and key not in _WARMING_KEYS:
            _WARMING_KEYS.add(key)

            async def _warm() -> None:
                try:
                    await backfill_chart_features_1m(
                        client,
                        symbol_id,
                        start_sec,
                        end_sec,
                        enforce_sync_limit=False,
                    )
                finally:
                    _WARMING_KEYS.discard(key)

            asyncio.create_task(_warm())
        meta["warming"] = True
        meta["coverage"] = round(len(rows) / expected, 4)

    return aggregate_1m_rows_to_bars(rows, barriers_sec, step_est), meta
