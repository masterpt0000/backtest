"""
Feed live em memória (CCXT Pro + REST): ticks, liquidações, mark/funding, livro, OI.
Sem leitura QuestDB — a BD pode continuar a ser preenchida pelo ``store.py`` em paralelo.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Any
from urllib.parse import unquote

log = logging.getLogger(__name__)

try:
    import ccxt.pro as ccxtpro  # type: ignore[import-untyped]
except ImportError:
    ccxtpro = None


def _sf(x: Any) -> float | None:
    if x is None or x == "":
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


class SymbolFeed:
    """Um par CCXT; várias corrotinas partilham o mesmo ``exchange``."""

    def __init__(self, symbol_id: int, code: str) -> None:
        self.symbol_id = symbol_id
        self.code = code
        self.exchange = ccxtpro.binance({"options": {"defaultType": "swap"}})
        self._closing = False
        self._tasks: list[asyncio.Task[Any]] = []
        self._fetch_lock = asyncio.Lock()

        self.ticks: deque[dict[str, Any]] = deque(maxlen=600)
        self.liquidations: deque[dict[str, Any]] = deque(maxlen=800)
        self.order_book_series: deque[dict[str, Any]] = deque(maxlen=200)
        self.open_interest_series: deque[dict[str, Any]] = deque(maxlen=200)
        self.funding: dict[str, Any] | None = None
        self.last_error: str | None = None

    def _set_err(self, msg: str) -> None:
        self.last_error = msg
        log.warning("SymbolFeed sid=%s %s: %s", self.symbol_id, self.code, msg)

    async def start(self) -> None:
        self._tasks = [
            asyncio.create_task(self._trade_loop(), name=f"feed-trades-{self.symbol_id}"),
            asyncio.create_task(self._liq_loop(), name=f"feed-liq-{self.symbol_id}"),
            asyncio.create_task(self._mark_loop(), name=f"feed-mark-{self.symbol_id}"),
            asyncio.create_task(self._book_loop(), name=f"feed-book-{self.symbol_id}"),
            asyncio.create_task(self._oi_loop(), name=f"feed-oi-{self.symbol_id}"),
        ]

    async def stop(self) -> None:
        self._closing = True
        for t in self._tasks:
            t.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        try:
            await self.exchange.close()
        except Exception as e:
            log.debug("exchange.close: %s", e)

    async def _trade_loop(self) -> None:
        while not self._closing:
            try:
                batch = await self.exchange.watch_trades(self.code)
                now = int(time.time())
                for tr in batch:
                    ts = tr.get("timestamp")
                    tsec = int(ts // 1000) if isinstance(ts, (int, float)) else now
                    tid = tr.get("id")
                    if tid is None and isinstance(tr.get("info"), dict):
                        tid = tr["info"].get("t")
                    self.ticks.append(
                        {
                            "t": tsec,
                            "price": float(tr["price"]),
                            "amount": float(tr.get("amount") or 0),
                            "trade_id": str(tid) if tid is not None else "",
                            "side": str(tr.get("side") or ""),
                        }
                    )
            except asyncio.CancelledError:
                break
            except Exception as e:
                self._set_err(f"watch_trades: {e!s}")
                await asyncio.sleep(1.0)

    async def _liq_loop(self) -> None:
        while not self._closing:
            try:
                batch = await self.exchange.watch_liquidations(self.code)
                now = int(time.time())
                for liq in batch:
                    ts = liq.get("timestamp")
                    tsec = int(ts // 1000) if isinstance(ts, (int, float)) else now
                    row: dict[str, Any] = {
                        "t": tsec,
                        "price": _sf(liq.get("price")),
                        "contracts": _sf(liq.get("contracts")),
                        "side": str(liq.get("side") or ""),
                    }
                    self.liquidations.append(row)
            except asyncio.CancelledError:
                break
            except Exception as e:
                self._set_err(f"watch_liquidations: {e!s}")
                await asyncio.sleep(1.5)

    async def _mark_loop(self) -> None:
        while not self._closing:
            try:
                raw = await self.exchange.watch_mark_price(self.code)
                local_sec = int(time.time())
                info = raw.get("info") if isinstance(raw.get("info"), dict) else {}
                ev = info.get("E")
                exchange_ms = int(ev) if ev is not None else None
                next_ms = info.get("T")
                next_sec = int(next_ms // 1000) if next_ms is not None else None
                ex_ts_sec = int(exchange_ms // 1000) if exchange_ms is not None else local_sec
                self.funding = {
                    "t": local_sec,
                    "mark_price": _sf(raw.get("markPrice")),
                    "funding_rate": _sf(info.get("r")),
                    "index_price": _sf(raw.get("indexPrice")),
                    "next_funding_time": next_sec,
                    "exchange_ts": ex_ts_sec,
                }
            except asyncio.CancelledError:
                break
            except Exception as e:
                self._set_err(f"watch_mark_price: {e!s}")
                await asyncio.sleep(1.0)

    async def _book_loop(self) -> None:
        interval = 2.0
        while not self._closing:
            try:
                async with self._fetch_lock:
                    ob = await self.exchange.fetch_order_book(self.code, 50)
                local_sec = int(time.time())
                bids = ob.get("bids") or []
                asks = ob.get("asks") or []
                bb = float(bids[0][0]) if bids else 0.0
                ba = float(asks[0][0]) if asks else 0.0
                bd = sum(float(x[1]) for x in bids[:20] if len(x) >= 2)
                ad = sum(float(x[1]) for x in asks[:20] if len(x) >= 2)
                tot = bd + ad
                imb = (bd - ad) / tot if tot > 0 else None
                self.order_book_series.append(
                    {
                        "t": local_sec,
                        "best_bid": bb,
                        "best_ask": ba,
                        "spread": ba - bb if ba and bb else 0.0,
                        "bid_depth_1pct": bd,
                        "ask_depth_1pct": ad,
                        "imbalance": imb,
                    }
                )
            except asyncio.CancelledError:
                break
            except Exception as e:
                self._set_err(f"order_book: {e!s}")
                await asyncio.sleep(2.0)
            else:
                await asyncio.sleep(interval)

    async def _oi_loop(self) -> None:
        interval = 5.0
        while not self._closing:
            try:
                async with self._fetch_lock:
                    raw = await self.exchange.fetch_open_interest(self.code)
                local_sec = int(time.time())
                amt = raw.get("openInterestAmount")
                if amt is not None:
                    try:
                        self.open_interest_series.append(
                            {"t": local_sec, "oi": float(amt)}
                        )
                    except (TypeError, ValueError):
                        pass
            except asyncio.CancelledError:
                break
            except Exception as e:
                self._set_err(f"open_interest: {e!s}")
                await asyncio.sleep(interval)
            else:
                await asyncio.sleep(interval)

    async def fetch_ohlcv(self, timeframe: str, limit: int) -> list[dict[str, Any]]:
        async with self._fetch_lock:
            ohlcv = await self.exchange.fetch_ohlcv(self.code, timeframe, limit=limit)
        # Binance/CCXT por vezes repetem o mesmo período; o chart exige ``t`` estritamente crescente.
        by_t: dict[int, dict[str, Any]] = {}
        for row in ohlcv:
            ts_ms, o, h, l, c, v = row
            t = int(ts_ms // 1000)
            by_t[t] = {
                "t": t,
                "o": float(o),
                "h": float(h),
                "l": float(l),
                "c": float(c),
                "v": float(v),
            }
        return [by_t[k] for k in sorted(by_t.keys())]

    def build_snapshot(
        self,
        *,
        ticks_limit: int,
        series_limit: int,
        liq_limit: int,
    ) -> dict[str, Any]:
        tick_list = list(self.ticks)
        tick_list.reverse()
        tick_list = tick_list[:ticks_limit]

        liq_list = list(self.liquidations)
        liq_list.reverse()
        liq_list = liq_list[:liq_limit]

        oi_all = list(self.open_interest_series)
        oi_slice = oi_all[-series_limit:] if len(oi_all) > series_limit else oi_all

        ob_all = list(self.order_book_series)
        ob_slice = ob_all[-series_limit:] if len(ob_all) > series_limit else ob_all

        now_sec = int(time.time())
        last_tick_sec = tick_list[0]["t"] if tick_list else None
        stale_sec = (now_sec - last_tick_sec) if last_tick_sec is not None else None

        errors: list[str] = []
        if self.last_error:
            errors.append(self.last_error)

        return {
            "symbol_id": self.symbol_id,
            "server_now_sec": now_sec,
            "last_tick_stale_sec": stale_sec,
            "ticks": tick_list,
            "funding": self.funding,
            "open_interest_series": oi_slice,
            "order_book_series": ob_slice,
            "liquidations": liq_list,
            "errors": errors,
            "live_source": "memory",
        }


class LiveFeedHub:
    """Um feed por ``symbol_id``; vários pares em simultâneo são permitidos (várias abas / símbolos)."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._by_id: dict[int, SymbolFeed] = {}

    async def shutdown(self) -> None:
        async with self._lock:
            feeds = list(self._by_id.values())
            self._by_id.clear()
        for f in feeds:
            await f.stop()

    async def ensure(self, symbol_id: int, code: str) -> SymbolFeed:
        if ccxtpro is None:
            raise RuntimeError(
                "ccxt (pro) não instalado. Adiciona `ccxt` a backend/requirements.txt e instala."
            )
        code = unquote(code.strip())
        if not code:
            raise ValueError("code vazio")

        async with self._lock:
            existing = self._by_id.get(symbol_id)
            if existing is not None and existing.code == code:
                return existing
            old = self._by_id.pop(symbol_id, None)

        if old is not None:
            await old.stop()

        nf = SymbolFeed(symbol_id, code)
        await nf.start()
        async with self._lock:
            self._by_id[symbol_id] = nf
        return nf
