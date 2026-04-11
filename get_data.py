import asyncio
import sys
import time
from collections.abc import AsyncIterator

import ccxt.pro as ccxt

SYMBOL = "WLD/USDC:USDC"
TIMEFRAME = "1m"


async def closed_1m_candles(
    symbol: str = SYMBOL,
    timeframe: str = TIMEFRAME,
) -> AsyncIterator[list]:
    """
    Em cada minuto fechado, faz yield de [timestamp_ms, open, high, low, close, volume].
    """

    def candle_with_open(ohlcv: list, open_ms: int) -> list | None:
        for row in ohlcv:
            if row[0] == open_ms:
                return row
        return None

    exchange = ccxt.binance({"options": {"defaultType": "swap"}})
    prev_open: int | None = None
    try:
        while True:
            ohlcv = await exchange.watch_ohlcv(symbol, timeframe)
            if not ohlcv:
                continue
            last_open = int(ohlcv[-1][0])
            if prev_open is not None and last_open != prev_open:
                closed = candle_with_open(ohlcv, prev_open)
                if closed is None:
                    snap = await exchange.fetch_ohlcv(symbol, timeframe, limit=2)
                    closed = candle_with_open(snap, prev_open)
                    if closed is None and len(snap) >= 2 and snap[-2][0] == prev_open:
                        closed = snap[-2]
                if closed is not None:
                    yield closed
            prev_open = last_open
    finally:
        await exchange.close()


async def tick_trades(
    symbol: str = SYMBOL,
    *,
    include_latency: bool = True,
) -> AsyncIterator[dict]:
    """
    Stream de trades (tape / ticks) em tempo real via WebSocket.

    Cada dict inclui **trade_id** (string): ID único do trade na exchange
    (Binance: campo `t` no stream / `id` no CCXT). Usa para deduplicar,
    alinhar com REST e manter backtests consistentes — o mesmo evento
    tem sempre o mesmo trade_id.

    Se ``include_latency`` for True (opcional, default):

    - **exchange_ts**: ms Unix do **trade** na Binance (= ``T`` / ``timestamp`` CCXT).
    - **local_ts**: ms Unix quando o **lote** WebSocket foi recebido (igual para
      todos os trades do mesmo wake).
    - **local_ts_ns**: ns Unix quando este trade é emitido (precisão local;
      ordem / debug dentro do lote).

    **Latência (demo / diagnóstico):** ``lat_ms = local_ts - exchange_ts``.
    Valores muito altos com WebSocket costumam ser **relógio local** (NTP) ou
    **event loop** ocupado. No stream **mark price**, ``T`` é próximo funding, não
    hora do evento — para mark usa ``E`` (ver ``mark_price_funding``).

    A Binance público só envia **ms** no stream; vários trades podem partilhar o
    mesmo ``exchange_ts``. Para ordenação usa **trade_id** e **stream_batch_index**.

    Com ``include_latency=False`` não se acrescentam ``exchange_ts`` / ``local_ts`` /
    ``local_ts_ns`` (ficas com o dict CCXT + ``trade_id`` + ``stream_batch_index``).

    Campos CCXT habituais: timestamp, price, amount, side, symbol, info, …
    Um único wake do socket pode trazer vários trades; todos são emitidos.
    """

    def enrich_trade(
        raw: dict,
        *,
        local_ts_ms: int,
        local_ts_ns: int,
        stream_batch_index: int,
    ) -> dict:
        out = dict(raw)
        tid = out.get("id")
        if tid is None:
            inf = out.get("info")
            if isinstance(inf, dict) and inf.get("t") is not None:
                tid = inf["t"]
        out["trade_id"] = str(tid) if tid is not None else None
        out["stream_batch_index"] = stream_batch_index
        if include_latency:
            out["exchange_ts"] = out.get("timestamp")
            out["local_ts"] = local_ts_ms
            out["local_ts_ns"] = local_ts_ns
        return out

    exchange = ccxt.binance({"options": {"defaultType": "swap"}})
    try:
        while True:
            batch = await exchange.watch_trades(symbol)
            local_ts_ms = int(time.time() * 1000)
            for stream_batch_index, trade in enumerate(batch):
                local_ts_ns = time.time_ns()
                yield enrich_trade(
                    trade,
                    local_ts_ms=local_ts_ms,
                    local_ts_ns=local_ts_ns,
                    stream_batch_index=stream_batch_index,
                )
    finally:
        await exchange.close()


async def mark_price_funding(
    symbol: str = SYMBOL,
    *,
    include_latency: bool = True,
) -> AsyncIterator[dict]:
    """
    Stream em tempo real de **mark price** e **funding rate** (Binance futures).

    O CCXT não expõe ``watch_funding_rate`` na Binance; o stream
    ``watch_mark_price`` envia eventos ``markPriceUpdate`` com ``p`` (mark),
    ``i`` (índice), ``r`` (funding rate), ``E`` (**event time**, ms Unix) e
    ``T`` (**próximo funding** — não confundir com hora do evento).

    Cada yield é um dict com:

    - **mark_price**, **index_price**, **funding_rate** (floats ou None)
    - **next_funding_time_ms** (de ``T``: próximo pagamento de funding)
    - **exchange_event_ms** (de ``E``: quando a Binance gerou o update)
    - **symbol**
    - **info**: payload cru da Binance (opcional para debug)

    Com ``include_latency=True`` (default): **exchange_ts** (= ``E``, ms),
    **local_ts** / **local_ts_ns** imediatamente após o ``await`` (relogio local).

    **Latência:** ``local_ts - exchange_ts`` (ambos ms Unix). **Não** uses ``T``
    aqui — é horizonte de funding, não “agora”. Se ``lat_ms`` for ~0 mas o PC
    estiver ~1s adiantado/atrasado vs UTC real, o número mente: alinha NTP.
    """

    def _sf(x) -> float | None:
        if x is None or x == "":
            return None
        try:
            return float(x)
        except (TypeError, ValueError):
            return None

    def enrich(
        raw: dict,
        *,
        local_ts_ms: int,
        local_ts_ns: int,
        exchange_event_ms: int | None,
    ) -> dict:
        info = raw.get("info") if isinstance(raw.get("info"), dict) else {}
        next_ms = info.get("T")
        out: dict = {
            "symbol": raw.get("symbol"),
            "mark_price": _sf(raw.get("markPrice")),
            "index_price": _sf(raw.get("indexPrice")),
            "funding_rate": _sf(info.get("r")),
            "next_funding_time_ms": int(next_ms) if next_ms is not None else None,
            "exchange_event_ms": exchange_event_ms,
            "info": info,
        }
        if include_latency:
            out["exchange_ts"] = (
                exchange_event_ms
                if exchange_event_ms is not None
                else raw.get("timestamp")
            )
            out["local_ts"] = local_ts_ms
            out["local_ts_ns"] = local_ts_ns
        return out

    exchange = ccxt.binance({"options": {"defaultType": "swap"}})
    try:
        while True:
            raw = await exchange.watch_mark_price(symbol)
            local_ns = time.time_ns()
            local_ts_ms = local_ns // 1_000_000
            info = raw.get("info") if isinstance(raw.get("info"), dict) else {}
            ev = info.get("E")
            exchange_event_ms = int(ev) if ev is not None else None
            yield enrich(
                raw,
                local_ts_ms=local_ts_ms,
                local_ts_ns=local_ns,
                exchange_event_ms=exchange_event_ms,
            )
    finally:
        await exchange.close()


async def open_interest_poll(
    symbol: str = SYMBOL,
    *,
    interval_sec: float = 7.5,
    include_latency: bool = True,
) -> AsyncIterator[dict]:
    """
    Open interest (REST), a cada ``interval_sec`` segundos.

    A Binance não expõe OI deste contrato num stream tão directo quanto mark/trades
    no teu setup; o CCXT usa ``fetch_open_interest`` (fapi/dapi). O default
    **7.5 s** situa-se no intervalo **5–10 s** que indicaste; ajusta com
    ``interval_sec`` (respeita rate limits).

    Cada yield inclui **open_interest_amount** (base / contratos), **symbol**,
    **timestamp** / **datetime** (resposta CCXT), **info** bruto. Com
    ``include_latency=True``: **exchange_ts**, **local_ts**, **local_ts_ns**
    (instante após o fetch completar).
    """
    if interval_sec <= 0:
        raise ValueError("interval_sec must be > 0")

    exchange = ccxt.binance({"options": {"defaultType": "swap"}})
    try:
        while True:
            raw = await exchange.fetch_open_interest(symbol)
            local_ns = time.time_ns()
            local_ts_ms = local_ns // 1_000_000
            out: dict = {
                "symbol": raw.get("symbol"),
                "open_interest_amount": raw.get("openInterestAmount"),
                "open_interest_value": raw.get("openInterestValue"),
                "timestamp": raw.get("timestamp"),
                "datetime": raw.get("datetime"),
                "info": raw.get("info"),
            }
            if include_latency:
                out["exchange_ts"] = raw.get("timestamp")
                out["local_ts"] = local_ts_ms
                out["local_ts_ns"] = local_ns
            yield out
            await asyncio.sleep(interval_sec)
    finally:
        await exchange.close()


async def order_book_snapshots(
    symbol: str = SYMBOL,
    *,
    interval_sec: float = 5.0,
    limit: int | None = 100,
    include_latency: bool = True,
) -> AsyncIterator[dict]:
    """
    Order book por **snapshot REST** (não stream tick-a-tick), a cada
    ``interval_sec`` segundos — default **5 s**.

    Usa ``fetch_order_book``. ``limit`` controla profundidade (Binance: típico
    5, 10, 20, 50, 100, 500, 1000 — conforme mercado).

    Cada yield: **bids** / **asks** (listas ``[preço, quantidade]``), **nonce**,
    **timestamp** / **datetime**, **symbol**. Com ``include_latency=True``:
    **exchange_ts**, **local_ts**, **local_ts_ns** após o fetch.
    """
    if interval_sec <= 0:
        raise ValueError("interval_sec must be > 0")

    exchange = ccxt.binance({"options": {"defaultType": "swap"}})
    try:
        while True:
            raw = await exchange.fetch_order_book(symbol, limit)
            local_ns = time.time_ns()
            local_ts_ms = local_ns // 1_000_000
            out: dict = {
                "symbol": raw.get("symbol"),
                "bids": raw.get("bids") or [],
                "asks": raw.get("asks") or [],
                "nonce": raw.get("nonce"),
                "timestamp": raw.get("timestamp"),
                "datetime": raw.get("datetime"),
            }
            if include_latency:
                out["exchange_ts"] = raw.get("timestamp")
                out["local_ts"] = local_ts_ms
                out["local_ts_ns"] = local_ns
            yield out
            await asyncio.sleep(interval_sec)
    finally:
        await exchange.close()


async def liquidation_events(
    symbol: str | None = None,
    *,
    symbols: list[str] | None = None,
    include_latency: bool = True,
) -> AsyncIterator[dict]:
    """
    **Todas** as liquidações públicas que o stream enviar (tempo real, WebSocket).

    Usa ``watch_liquidations`` (um par) ou ``watch_liquidations_for_symbols``
    (vários). Não há amostragem: cada evento do feed gera um ``yield``.

    Cada dict segue a estrutura CCXT de liquidation (``symbol``, ``contracts``,
    ``price``, ``side``, ``timestamp``, ``datetime``, ``info``, …) mais:

    - **liquidation_event_id**: string para dedup (``order id`` / ``trade id`` do
      ``info`` se existir; senão chave composta estável).
    - **stream_batch_index**: posição no lote devolvido por um wake.

    Com ``include_latency=True``: **exchange_ts**, **local_ts**, **local_ts_ns**.

    Passa **ou** ``symbol`` (default ``SYMBOL``) **ou** ``symbols=[...]``, não ambos.
    """
    if symbol is not None and symbols is not None:
        raise ValueError("use apenas symbol ou symbols, não os dois")
    if symbols is None:
        sym = symbol if symbol is not None else SYMBOL
        multi = False
    else:
        if not symbols:
            raise ValueError("symbols must be a non-empty list")
        sym = None
        multi = True

    def enrich_liq(
        raw: dict,
        *,
        local_ts_ms: int,
        local_ts_ns: int,
        stream_batch_index: int,
    ) -> dict:
        out = dict(raw)
        info = out.get("info") if isinstance(out.get("info"), dict) else {}
        oid = info.get("i")
        tid = info.get("t")
        if oid is not None:
            ev = f"o{oid}"
        elif tid is not None and tid != 0:
            ev = f"t{tid}"
        else:
            ev = (
                f"{out.get('symbol')}:"
                f"{out.get('timestamp')}:"
                f"{out.get('contracts')}:"
                f"{out.get('price')}:"
                f"{out.get('side')}"
            )
        out["liquidation_event_id"] = ev
        out["stream_batch_index"] = stream_batch_index
        if include_latency:
            out["exchange_ts"] = out.get("timestamp")
            out["local_ts"] = local_ts_ms
            out["local_ts_ns"] = local_ts_ns
        return out

    exchange = ccxt.binance({"options": {"defaultType": "swap"}})
    try:
        while True:
            if multi:
                batch = await exchange.watch_liquidations_for_symbols(symbols)
            else:
                batch = await exchange.watch_liquidations(sym)
            if not batch:
                continue
            local_ts_ms = int(time.time() * 1000)
            for stream_batch_index, liq in enumerate(batch):
                local_ts_ns = time.time_ns()
                yield enrich_liq(
                    liq,
                    local_ts_ms=local_ts_ms,
                    local_ts_ns=local_ts_ns,
                    stream_batch_index=stream_batch_index,
                )
    finally:
        await exchange.close()


if __name__ == "__main__":
    # python get_data.py              -> candles 1m fechados
    # python get_data.py trades       -> tape (ticks); Ctrl+C para parar
    # python get_data.py funding      -> mark + funding; Ctrl+C para parar
    # python get_data.py oi           -> open interest ~7.5s; Ctrl+C para parar
    # python get_data.py book         -> order book snapshot ~5s; Ctrl+C para parar
    # python get_data.py liq          -> liquidações públicas; Ctrl+C para parar

    async def _demo() -> None:
        if len(sys.argv) > 1 and sys.argv[1].lower() in ("liq", "liquidations"):
            async for ev in liquidation_events():
                print(
                    ev.get("liquidation_event_id"),
                    ev.get("datetime"),
                    ev.get("symbol"),
                    ev.get("side"),
                    ev.get("contracts"),
                    ev.get("price"),
                    sep=" | ",
                )
        elif len(sys.argv) > 1 and sys.argv[1].lower() in ("book", "orderbook"):
            async for snap in order_book_snapshots(limit=20):
                bids = snap.get("bids") or []
                asks = snap.get("asks") or []
                bb = bids[0] if bids else None
                ba = asks[0] if asks else None
                print(
                    snap.get("datetime"),
                    "best_bid",
                    bb,
                    "best_ask",
                    ba,
                    "levels",
                    len(bids),
                    len(asks),
                )
        elif len(sys.argv) > 1 and sys.argv[1].lower() in ("oi", "openinterest"):
            async for row in open_interest_poll():
                print(
                    row.get("open_interest_amount"),
                    row.get("datetime"),
                    row.get("exchange_ts"),
                    row.get("local_ts"),
                    sep=" | ",
                )
        elif len(sys.argv) > 1 and sys.argv[1].lower() == "funding":
            async for row in mark_price_funding():
                ex = row.get("exchange_ts")
                loc = row.get("local_ts")
                lat = loc - ex if isinstance(ex, int) and isinstance(loc, int) else None
                print(
                    row.get("mark_price"),
                    row.get("funding_rate"),
                    row.get("next_funding_time_ms"),
                    f"lat_ms={lat}",
                    sep=" | ",
                )
        elif len(sys.argv) > 1 and sys.argv[1].lower() == "trades":
            async for t in tick_trades():
                ex = t.get("exchange_ts")
                lat = (
                    t.get("local_ts") - ex if isinstance(ex, int) else None
                )
                print(
                    t.get("trade_id"),
                    f"lat_ms={lat}",
                    f"batch#{t.get('stream_batch_index')}",
                    f"local_ns={t.get('local_ts_ns')}",
                    t.get("datetime"),
                    t.get("side"),
                    t.get("price"),
                    t.get("amount"),
                    sep=" | ",
                )
        else:
            async for candle in closed_1m_candles():
                print(candle)

    try:
        asyncio.run(_demo())
    except KeyboardInterrupt:
        pass
