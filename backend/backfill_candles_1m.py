from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

import ccxt  # type: ignore[import-untyped]

from questdb_client import DEFAULT_QUESTDB, SYMBOL_QUERIES, ts_iso


load_dotenv(Path(__file__).resolve().parent / ".env")

INSERT_BATCH_ROWS = max(1, int(os.environ.get("CANDLES_BACKFILL_INSERT_BATCH_ROWS", "50") or "50"))


def questdb_http_base() -> str:
    return os.environ.get("QUESTDB_HTTP_URL", DEFAULT_QUESTDB).rstrip("/")


def exec_sql(query: str, *, timeout: float = 120.0) -> dict[str, Any]:
    url = questdb_http_base() + "/exec?" + urllib.parse.urlencode({"query": query})
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8").strip()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"QuestDB HTTP {e.code}: {detail[:800]} | SQL: {query[:500]}") from e
    return json.loads(raw) if raw else {}


def rows_as_objects(resp: dict[str, Any]) -> list[dict[str, Any]]:
    cols = [c.get("name", "") for c in (resp.get("columns") or []) if isinstance(c, dict)]
    out: list[dict[str, Any]] = []
    for row in resp.get("dataset") or []:
        if not isinstance(row, list):
            continue
        out.append({cols[i]: row[i] for i in range(min(len(cols), len(row)))})
    return out


def parse_ts_ms(raw: str | None) -> int | None:
    if raw is None:
        return None
    s = raw.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def sql_ts_ms(ms: int) -> str:
    return ts_iso(ms)


def sql_num(v: object) -> str:
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = 0.0
    if not (x == x and abs(x) != float("inf")):
        x = 0.0
    return repr(float(x))


def load_symbols() -> list[tuple[int, str]]:
    last_err: Exception | None = None
    for q in SYMBOL_QUERIES:
        try:
            rows = rows_as_objects(exec_sql(q))
        except Exception as e:  # noqa: BLE001
            last_err = e
            continue
        out: list[tuple[int, str]] = []
        seen: set[int] = set()
        for r in rows:
            sid = r.get("symbol_id")
            code = r.get("code")
            if sid is None or code is None:
                continue
            sid_i = int(sid)
            if sid_i in seen:
                continue
            seen.add(sid_i)
            out.append((sid_i, str(code)))
        if out:
            return sorted(out)
    if last_err:
        raise RuntimeError(f"não foi possível ler symbols: {last_err}") from last_err
    return []


def existing_candle_opens_ms(symbol_id: int, start_ms: int, end_ms: int) -> set[int]:
    q = (
        "SELECT local_ts FROM candles_1m "
        f"WHERE symbol_id = {int(symbol_id)} "
        f"AND local_ts >= '{sql_ts_ms(start_ms)}' AND local_ts < '{sql_ts_ms(end_ms)}'"
    )
    rows = rows_as_objects(exec_sql(q))
    out: set[int] = set()
    for r in rows:
        raw = r.get("local_ts")
        if raw is None:
            continue
        try:
            out.add(parse_ts_ms(str(raw)) or -1)
        except ValueError:
            continue
    out.discard(-1)
    return out


def insert_candles(symbol_id: int, candles: list[list[Any]]) -> int:
    if not candles:
        return 0
    cols = "local_ts, symbol_id, open, high, low, close, volume, exchange_ts"
    inserted = 0
    for i in range(0, len(candles), INSERT_BATCH_ROWS):
        values: list[str] = []
        for c in candles[i : i + INSERT_BATCH_ROWS]:
            if len(c) < 6:
                continue
            ts_ms = int(c[0])
            values.append(
                "("
                f"'{sql_ts_ms(ts_ms)}', {int(symbol_id)}, "
                f"{sql_num(c[1])}, {sql_num(c[2])}, {sql_num(c[3])}, "
                f"{sql_num(c[4])}, {sql_num(c[5])}, '{sql_ts_ms(ts_ms)}'"
                ")"
            )
        if values:
            exec_sql(f"INSERT INTO candles_1m ({cols}) VALUES " + ",".join(values), timeout=180.0)
            inserted += len(values)
    return inserted


def make_exchange() -> Any:
    return ccxt.binance(
        {
            "enableRateLimit": True,
            "rateLimit": 150,
            "options": {"defaultType": "swap"},
        }
    )


def backfill_symbol(
    exchange: Any,
    *,
    symbol_id: int,
    code: str,
    start_ms: int,
    end_ms: int,
    limit: int,
    sleep_sec: float,
    replace_existing: bool,
) -> dict[str, int]:
    since = start_ms
    fetched = 0
    inserted = 0
    skipped_existing = 0
    empty_pages = 0
    while since < end_ms:
        try:
            candles = exchange.fetch_ohlcv(code, "1m", since=since, limit=limit)
        except Exception as e:  # noqa: BLE001
            print(f"  erro fetch_ohlcv {code} since={since}: {e}; retry em 5s")
            time.sleep(5.0)
            continue
        if not candles:
            empty_pages += 1
            break

        page = []
        by_ts: dict[int, list[Any]] = {}
        for c in candles:
            if len(c) < 6:
                continue
            t = int(c[0])
            if start_ms <= t < end_ms:
                by_ts[t] = c
        if by_ts:
            lo = min(by_ts)
            hi = max(by_ts) + 60_000
            if replace_existing:
                # QuestDB nem sempre permite DELETE em tabelas WAL/particionadas via /exec.
                # Inserimos a versão REST final; as queries do chart usam SAMPLE BY + last(...)
                # para escolher a correção mais recente por minuto.
                existing: set[int] = set()
            else:
                existing = existing_candle_opens_ms(symbol_id, lo, hi)
            for t in sorted(by_ts):
                if t in existing:
                    skipped_existing += 1
                else:
                    page.append(by_ts[t])
        if page:
            inserted += insert_candles(symbol_id, page)

        fetched += len(candles)
        last_ts = int(candles[-1][0])
        next_since = last_ts + 60_000
        if next_since <= since:
            next_since = since + 60_000
        since = next_since
        if len(candles) < limit and last_ts >= end_ms - 60_000:
            break
        time.sleep(sleep_sec)
    return {
        "fetched": fetched,
        "inserted": inserted,
        "skipped_existing": skipped_existing,
        "empty_pages": empty_pages,
    }


def main() -> None:
    p = argparse.ArgumentParser(description="Backfill histórico de candles_1m para símbolos já existentes.")
    p.add_argument("--all-symbols", action="store_true", help="Usa todos os símbolos da tabela symbols.")
    p.add_argument("--symbol-id", type=int, action="append", help="Filtra por symbol_id; pode repetir.")
    p.add_argument("--days", type=float, default=365.0, help="Dias para trás a partir de --end/agora.")
    p.add_argument("--start", help="ISO timestamp, ex. 2025-05-01T00:00:00Z.")
    p.add_argument("--end", help="ISO timestamp. Omissão: agora - 2 minutos.")
    p.add_argument("--limit", type=int, default=1000)
    p.add_argument("--sleep-sec", type=float, default=0.15)
    p.add_argument(
        "--replace-existing",
        action="store_true",
        help="Apaga candles_1m existentes no intervalo de cada página antes de inserir candles finais REST.",
    )
    args = p.parse_args()

    symbols = load_symbols()
    if args.symbol_id:
        wanted = set(args.symbol_id)
        symbols = [s for s in symbols if s[0] in wanted]
    elif not args.all_symbols:
        raise SystemExit("Usa --all-symbols ou --symbol-id N.")
    if not symbols:
        raise SystemExit("Nenhum símbolo encontrado para backfill.")

    end_ms = parse_ts_ms(args.end) if args.end else int((datetime.now(timezone.utc) - timedelta(minutes=2)).timestamp() * 1000)
    if end_ms is None:
        raise SystemExit("--end inválido")
    start_ms = parse_ts_ms(args.start) if args.start else end_ms - int(timedelta(days=float(args.days)).total_seconds() * 1000)
    if start_ms is None:
        raise SystemExit("--start inválido")
    start_ms = (start_ms // 60_000) * 60_000
    end_ms = (end_ms // 60_000) * 60_000

    print(
        f"Backfill candles_1m: {len(symbols)} símbolo(s), "
        f"{datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).isoformat()} -> "
        f"{datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).isoformat()}"
    )
    exchange = make_exchange()
    try:
        total_inserted = 0
        for idx, (sid, code) in enumerate(symbols, 1):
            print(f"[{idx}/{len(symbols)}] symbol_id={sid} {code}")
            res = backfill_symbol(
                exchange,
                symbol_id=sid,
                code=code,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=max(1, min(1500, int(args.limit))),
                sleep_sec=max(0.0, float(args.sleep_sec)),
                replace_existing=bool(args.replace_existing),
            )
            total_inserted += res["inserted"]
            print(
                f"  fetched={res['fetched']} inserted={res['inserted']} "
                f"existing={res['skipped_existing']}"
            )
        print(f"Concluído. candles_1m inseridos: {total_inserted}")
    finally:
        try:
            exchange.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
