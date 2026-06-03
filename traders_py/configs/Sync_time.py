import time

def sync_time_with_binance(self):
    try:
        server_time = self.client.futures_time()
        server_ms = server_time['serverTime']
        local_ms = int(time.time() * 1000)
        offset = server_ms - local_ms
        self.client.timestamp_offset = offset
        if abs(offset) > 1000:
            print(f"[TIME] Hora sincronizada: offset {offset}ms ({offset/1000:.1f}s) com servidor Binance")
    except Exception as e:
        print(f"[AVISO] Nao foi possivel sincronizar hora com Binance: {e}")