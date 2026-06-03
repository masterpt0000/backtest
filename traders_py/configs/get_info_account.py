from decimal import Decimal, ROUND_DOWN, InvalidOperation


def get_position_quantity(self):
    """
    Obtém a quantidade real da posição atual e retorna ajustada conforme precisão.
    Retorna None se não houver posição aberta.
    """
    try:
        positions = self.client.futures_position_information(symbol=self.symbol_internal)
        if positions and len(positions) > 0:
            pos_data = positions[0]
            raw_amt = pos_data.get("positionAmt", "0")
            position_amt = float(raw_amt)

            if abs(position_amt) > 0:
                # Precisão a partir da string da exchange evita floats tipo 12.3/0.1→12.299... que ao
                # usar int(...) fechava a 12.2 e deixava poeira (ex.: 0.1) na conta.
                return adjust_quantity(self, abs(position_amt), position_amt_raw=raw_amt)
        return None
    except Exception as e:
        print(f"⚠️ Erro ao obter quantidade da posição: {e}")
        return None

def adjust_quantity(self, quantity, position_amt_raw=None):
    """
    Ajusta a quantidade conforme os filtros do símbolo (stepSize, minQty).
    Retorna a quantidade como string formatada corretamente.

    Para fechar posição (`positionAmt` da Binance), passar `position_amt_raw=str` da própria resposta REST;
    assim o floor ao step não falha por erros binários na divisão float.
    """
    try:
        # Obter informações do símbolo
        exchange_info = self.client.futures_exchange_info()
        symbol_info = None
        for s in exchange_info.get('symbols', []):
            if s['symbol'] == self.symbol_internal:
                symbol_info = s
                break
        
        if symbol_info:
            # Encontrar filtro LOT_SIZE
            for f in symbol_info.get('filters', []):
                if f['filterType'] == 'LOT_SIZE':
                    # Usar string original para evitar notação científica / floats
                    step_str_raw = str(f.get('stepSize'))
                    step_dec = Decimal(step_str_raw)
                    step_size = float(step_str_raw)
                    min_qty = float(f['minQty'])
                    
                    # Encontrar número de casas decimais do stepSize
                    if 'e' in step_str_raw.lower():
                        # ex: 1e-3
                        decimals = max(0, -int(step_str_raw.lower().split('e')[-1]))
                    elif '.' in step_str_raw:
                        decimals = len(step_str_raw.split('.')[1].rstrip('0'))
                    else:
                        decimals = 0
                    
                    # Ajustar quantidade para múltiplo de stepSize SEM aumentar (floor),
                    # para evitar rejeição por margem insuficiente ao arredondar para cima.
                    if step_dec <= 0 or step_size <= 0:
                        return None
                    # Entradas margem/leverage continuam via float quantidade já existente na base.
                    if position_amt_raw is not None:
                        try:
                            qty_dec = Decimal(str(position_amt_raw).strip()).copy_abs()
                        except InvalidOperation:
                            qty_dec = Decimal(str(abs(float(quantity))))
                        qty_floor = qty_dec.quantize(step_dec, rounding=ROUND_DOWN)
                        if qty_floor < Decimal(str(min_qty)):
                            print(f"⚠️ Quantidade ({qty_floor}) abaixo do mínimo ({min_qty})")
                            return None
                        qty_out = qty_floor
                    else:
                        quantity = (int(quantity / step_size)) * step_size
                        quantity = round(quantity, decimals)
                        if quantity < min_qty:
                            print(f"⚠️ Quantidade ({quantity}) abaixo do mínimo ({min_qty})")
                            return None
                        qty_out = Decimal(str(quantity)).quantize(step_dec, rounding=ROUND_DOWN)
                    
                    # Formatar com precisão exata conforme stepSize (sem float intermédio)
                    if decimals == 0:
                        return str(int(qty_out))
                    return format(qty_out, f".{decimals}f")
        
        # Se não conseguir ajustar, retornar quantidade arredondada como string
        return str(round(quantity, 1))
    except Exception as e:
        print(f"⚠️ Erro ao ajustar quantidade: {e}. Usando quantidade sem ajuste.")
        return str(round(quantity, 1))

def get_total_balance(self):
    account = self.client.futures_account()
    # Usar availableBalance (o que podes usar para novas posições); evita -2019 Margin is insufficient
    available = account.get('availableBalance')
    total = account.get('totalWalletBalance', 0)
    balance_to_use = float(available) if available is not None and str(available).strip() != '' else float(total)
    # Parte do saldo por bot quando corres vários pares na mesma conta (evita todos usarem 80% em simultâneo).
    share = float(getattr(self, 'margin_wallet_share', 0.80))
    concurrent = max(1, int(getattr(self, 'concurrent_bots', 1)))
    # Usar só share/concurrent do disponível: fees, arredondamentos e outras posições
    self.quantity = balance_to_use * share / concurrent
    self._last_available_balance = balance_to_use
    # print(f"🔄 Available: {balance_to_use}, Quantity (margin to use): {self.quantity}")

def get_current_position(self):
    self.position = None
    self.entry_price = 0
    self.sl_order_id = None
    self.tp_order_id = None
    get_total_balance(self)
    try:
        # Obter posições
        positions = self.client.futures_position_information(symbol=self.symbol_internal)
        if positions and len(positions) > 0:
            pos_data = positions[0]
            position_amt = float(pos_data['positionAmt'])
            
            if abs(position_amt) > 0:
                if position_amt > 0:
                    self.position = 'long'
                else:
                    self.position = 'short'
                
                self.entry_price = float(pos_data.get('entryPrice', 0))
        
        # Obter ordens abertas TP/SL: REST (STOP, TAKE_PROFIT) e/ou algo (STOP_MARKET, TAKE_PROFIT_MARKET)
        open_orders = []
        try:
            all_orders = self.client.futures_get_open_orders(symbol=self.symbol_internal)
            for o in all_orders:
                t = o.get('type') or o.get('orderType', '')
                if t in ('STOP', 'TAKE_PROFIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'):
                    open_orders.append(o)
        except Exception:
            pass
        if not open_orders:
            try:
                open_orders = self.client.futures_get_open_algo_orders(symbol=self.symbol_internal)
            except (AttributeError, Exception):
                pass
        for order in open_orders:
            order_type = order.get('type') or order.get('orderType', '')
            oid = order.get('algoId') or order.get('algoOrderId') or order.get('orderId')
            if order_type in ('STOP', 'STOP_MARKET'):
                self.sl_order_id = oid
            elif order_type in ('TAKE_PROFIT', 'TAKE_PROFIT_MARKET'):
                self.tp_order_id = oid
        
        # print(f"🔄 SL order ID: {self.sl_order_id}, TP order ID: {self.tp_order_id}")
        # print(f"🔄 Posição atual: {self.position}, Quantidade: {self.quantity}, Preço de entrada: {self.entry_price}")
    except Exception as e:
        print(f"⚠️ Erro ao obter posição atual: {e}")

def get_tick_size(self):
    """Retorna tick_size (float) e price_precision (int) para o símbolo."""
    try:
        exchange_info = self.client.futures_exchange_info()
        for s in exchange_info.get('symbols', []):
            if s['symbol'] == self.symbol_internal:
                for f in s.get('filters', []):
                    if f['filterType'] == 'PRICE_FILTER':
                        tick = f.get('tickSize')
                        if tick is not None:
                            tick_size = float(tick)
                            if tick_size >= 1:
                                return tick_size, 0
                            dec = len(str(tick_size).split('.')[-1].rstrip('0'))
                            return tick_size, dec
                break
    except Exception as e:
        print(f"⚠️ Erro ao obter tick size: {e}")
    return 0.01, 2

def round_price(self, price):
    """Arredonda preço ao tick do símbolo (para ordens limit = maker)."""
    tick_size, precision = get_tick_size(self)
    if tick_size <= 0:
        return round(price, precision)
    return round(round(price / tick_size) * tick_size, precision)

def get_bid_ask(self):
    """Retorna (best_bid, best_ask) para ordens limit (maker)."""
    try:
        # Binance Futures: depth limit deve ser 5, 10, 20, 50, 100 ou 500 (não 1)
        book = self.client.futures_order_book(symbol=self.symbol_internal, limit=5)
        bids = book.get('bids') or []
        asks = book.get('asks') or []
        if bids and asks:
            bid = float(bids[0][0])
            ask = float(asks[0][0])
            return round_price(self, bid), round_price(self, ask)
    except Exception as e:
        print(f"⚠️ Erro ao obter book: {e}")
    ticker = self.client.futures_symbol_ticker(symbol=self.symbol_internal)
    p = float(ticker['price'])
    return round_price(self, p), round_price(self, p)