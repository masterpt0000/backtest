from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

from chart_feature_aggregates import (
    backfill_chart_features_1m_range,
    infer_chart_features_1m_range,
)
from questdb_client import SYMBOL_QUERIES, async_questdb_exec_raw, rows_as_objects


load_dotenv(Path(__file__).resolve().parent / ".env")


def _parse_ts(raw: str) -> int:
    s = raw.strip()
    if not s:
        raise argparse.ArgumentTypeError("timestamp vazio")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"timestamp inválido: {raw}") from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


async def _all_symbol_ids(client: httpx.AsyncClient) -> list[int]:
    last_err: Exception | None = None
    for q in SYMBOL_QUERIES:
        try:
            rows = rows_as_objects(await async_questdb_exec_raw(client, q))
            out = sorted({int(r["symbol_id"]) for r in rows if r.get("symbol_id") is not None})
            if out:
                return out
        except Exception as e:  # noqa: BLE001
            last_err = e
    if last_err:
        raise RuntimeError(f"não foi possível listar símbolos: {last_err}") from last_err
    return []


async def _run(args: argparse.Namespace) -> None:
    timeout = httpx.Timeout(float(args.timeout), connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        symbol_ids = list(args.symbol_id or [])
        if args.all_symbols:
            symbol_ids = await _all_symbol_ids(client)
        if not symbol_ids:
            raise SystemExit("Indica --symbol-id N ou --all-symbols.")

        now_sec = int(datetime.now(tz=timezone.utc).timestamp())
        explicit_start = _parse_ts(args.start) if args.start else None
        explicit_end = _parse_ts(args.end) if args.end else None
        if args.days is not None:
            explicit_end = explicit_end or now_sec
            explicit_start = explicit_end - int(timedelta(days=float(args.days)).total_seconds())

        total_inserted = 0
        for sid in symbol_ids:
            if explicit_start is None or explicit_end is None:
                start_sec, end_sec = await infer_chart_features_1m_range(client, sid)
            else:
                start_sec, end_sec = explicit_start, explicit_end

            print(
                f"[chart_features_1m] symbol_id={sid} "
                f"{datetime.fromtimestamp(start_sec, tz=timezone.utc).isoformat()} -> "
                f"{datetime.fromtimestamp(end_sec, tz=timezone.utc).isoformat()}"
            )
            res = await backfill_chart_features_1m_range(
                client,
                sid,
                start_sec,
                end_sec,
                chunk_minutes=int(args.chunk_minutes),
            )
            total_inserted += int(res.get("inserted") or 0)
            print(
                f"  chunks={res.get('chunks')} inserted={res.get('inserted')} "
                f"errors={len(res.get('errors') or [])}"
            )
            for err in res.get("errors") or []:
                print(f"  erro: {err}")
        print(f"Concluído. Linhas inseridas: {total_inserted}")


def main() -> None:
    p = argparse.ArgumentParser(description="Preenche QuestDB chart_features_1m a partir das tabelas raw.")
    p.add_argument("--symbol-id", type=int, action="append", help="Pode repetir para vários símbolos.")
    p.add_argument("--all-symbols", action="store_true", help="Backfill para todos os symbol_id da tabela symbols.")
    p.add_argument("--start", help="ISO UTC/local, ex. 2026-04-01T00:00:00Z. Omissão: início de candles_1m.")
    p.add_argument("--end", help="ISO UTC/local. Omissão: fim de candles_1m, ou agora se --days for usado.")
    p.add_argument("--days", type=float, help="Backfill dos últimos N dias.")
    p.add_argument("--chunk-minutes", type=int, default=7 * 24 * 60, help="Tamanho de chunk em minutos.")
    p.add_argument("--timeout", type=float, default=300.0, help="Timeout HTTP QuestDB em segundos.")
    args = p.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
