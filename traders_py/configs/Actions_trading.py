import time
from datetime import datetime, timezone
from configs.get_info_account import *


def _notify_discord_failure(self, context: str, message: str = "", exception=None):
    """
    Envia falha ao webhook \"Errors\" (send_bot_error).
    Usa `message` quando não há exceção; com `exception`, anexa stack trace.
    """
    try:
        import traceback
        from configs.discords_alerts import send_bot_error
        tb = traceback.format_exc() if exception is not None else ""
        send_bot_error(
            getattr(self, 'strategy_name', 'Bot'),
            getattr(self, 'symbol', '?'),
            context=context,
            exception=exception,
            message=message if exception is None else "",
            traceback_text=tb,
        )
    except Exception:
        pass


def _report_error_to_discord(self, exc, context: str):
    """Compat: excepção → Discord."""
    _notify_discord_failure(self, context, message="", exception=exc)


def _has_margin_for_entry_qty(self, base_qty_str, mark_price):
    """
    Verifica na conta (availableBalance) se há margem para a ordem de entrada.
    IM aproximado USDT-M: notional / leverage. Evita -2019 e spam antes de enviar ordem.
    """
    try:
        qty = float(base_qty_str)
    except (TypeError, ValueError):
        return False
    if qty <= 0 or not mark_price or float(mark_price) <= 0:
        return False
    lev = max(1.0, float(getattr(self, 'leverage', 1) or 1))
    notional = qty * float(mark_price)
    im = notional / lev
    buffer = float(getattr(self, 'margin_entry_buffer_ratio', 0.06))
    try:
        acc = self.client.futures_account()
        avail = float(acc.get('availableBalance') or 0)
    except Exception:
        return False
    return avail >= im * (1.0 + buffer)


def _account_has_any_open_position(self, min_abs=1e-12):
    """
    True se a conta USDT-M tiver posição aberta em qualquer símbolo (positionAmt != 0).
    Usado para permitir só uma posição na conta de cada vez (vários bots no mesmo API key).
    """
    try:
        positions = self.client.futures_position_information()
        for p in positions or []:
            amt = float(p.get('positionAmt', 0) or 0)
            if abs(amt) > min_abs:
                return True
        return False
    except Exception as e:
        print(f"[AVISO] Erro ao listar posições globais da conta: {e}")
        return False


def _block_if_account_busy_for_new_entry(self, side_label: str):
    """
    Bloqueia abertura "desde flat" (self.position is None) se já existir posição noutro par.
    Não bloqueia flip no mesmo símbolo (position short/long oposto).
    """
    if not getattr(self, 'one_trade_per_account', True):
        return None
    if self.position is not None:
        return None
    if not _account_has_any_open_position(self):
        return None
    msg = (
        "Conta já tem posição aberta (outro par ou outro bot). "
        "Modo uma trade por conta: não abrir nova até fechar a existente."
    )
    print(f"⏸️ {msg}")
    _notify_discord_failure(self, f"execute_trade {side_label}", message=msg)
    return "no_retry"


def _wait_for_order_fill(self, order_id, timeout_seconds=60, poll_interval=2):
    """Aguarda ordem ser preenchida. Retorna True se FILLED, False se timeout/cancelada."""
    order_id = int(order_id) if order_id is not None else None
    if order_id is None:
        return False
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            order = self.client.futures_get_order(symbol=self.symbol_internal, orderId=order_id)
            status = (order.get('status') or '').strip().upper()
            if status == 'FILLED':
                return True
            if status in ('CANCELED', 'EXPIRED', 'REJECTED'):
                return False
            # Preenchimento parcial pode indicar que está a preencher
            exec_qty = float(order.get('executedQty') or 0)
            orig_qty = float(order.get('origQty') or 0)
            if orig_qty > 0 and exec_qty >= orig_qty:
                return True
        except Exception as e:
            print(f"[AVISO] Erro ao consultar ordem: {e}")
        time.sleep(poll_interval)
    # Uma última verificação após timeout (ordem pode ter preenchido no último segundo)
    try:
        order = self.client.futures_get_order(symbol=self.symbol_internal, orderId=order_id)
        status = (order.get('status') or '').strip().upper()
        if status == 'FILLED':
            return True
    except Exception:
        pass
    return False

def cancel_sl_tp(self):
    """
    Cancela TODAS as ordens SL e TP abertas do símbolo (incluindo órfãs de trades já fechados).
    Assim evita erro 'Unknown order' ao tentar cancelar por ID e remove TP/SL antigos antes de nova trade.
    """
    self.sl_order_id = None
    self.tp_order_id = None
    sl_tp_types = ('STOP', 'TAKE_PROFIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET')
    try:
        open_orders = self.client.futures_get_open_orders(symbol=self.symbol_internal)
        for o in open_orders:
            t = o.get('type') or o.get('orderType', '')
            if t not in sl_tp_types:
                continue
            oid = o.get('orderId') or o.get('order_id')
            if not oid:
                continue
            try:
                self.client.futures_cancel_order(symbol=self.symbol_internal, orderId=oid)
                print(f"✅ Cancelada ordem {t} (ID: {oid})")
            except Exception as e:
                # -2011 Unknown order = ordem já não existe (preenchida ou cancelada)
                err_code = getattr(e, 'code', None) or getattr(e, 'error_code', None)
                is_unknown = err_code == -2011 or '-2011' in str(e)
                if is_unknown:
                    pass  # ordem já desapareceu, ignorar
                else:
                    print(f"⚠️ Erro ao cancelar ordem {oid}: {e}")
    except Exception as e:
        print(f"⚠️ Erro ao listar/cancelar ordens SL/TP: {e}")
    # Cancelar também ordens algo (STOP_MARKET/TAKE_PROFIT_MARKET) se existirem
    try:
        algo_orders = self.client.futures_get_open_algo_orders(symbol=self.symbol_internal)
    except (AttributeError, Exception):
        algo_orders = []
    for o in algo_orders:
        algo_id = o.get('algoId') or o.get('algoOrderId') or o.get('orderId')
        if not algo_id:
            continue
        try:
            self.client.futures_cancel_algo_order(symbol=self.symbol_internal, algoId=algo_id)
            print(f"✅ Cancelada ordem algo (ID: {algo_id})")
        except Exception as e:
            if '-2011' in str(e) or getattr(e, 'code', None) == -2011:
                pass
            else:
                print(f"⚠️ Erro ao cancelar ordem algo {algo_id}: {e}")

def _create_algo_order(self, symbol, side, order_type, trigger_price, close_position=True, working_type='CONTRACT_PRICE'):
    """
    Cria uma ordem algorítmica tentando diferentes métodos dependendo da versão da biblioteca.
    """
    order_params = {
        'symbol': symbol,
        'side': side,
        'type': order_type,
        'triggerPrice': str(trigger_price),
        'closePosition': close_position,
        'workingType': working_type
    }
    
    # Tentar diferentes métodos dependendo da versão da biblioteca
    try:
        if hasattr(self.client, 'futures_create_algo_order'):
            return self.client.futures_create_algo_order(**order_params)
    except AttributeError:
        pass
    
    try:
        if hasattr(self.client, 'new_order_algo'):
            return self.client.new_order_algo(**order_params)
    except AttributeError:
        pass
    
    try:
        if hasattr(self.client, 'futures_new_order_algo'):
            return self.client.futures_new_order_algo(**order_params)
    except AttributeError:
        pass
    
    raise AttributeError("Nenhum método de criação de ordem algorítmica disponível nesta versão da biblioteca python-binance")


def _extract_order_id_from_create_response(resp):
    """
    Resposta de futures_create_order para TP/STOP pode trazer orderId normal
    ou ids de ordem algorítmica (USDC-M / contas novas).
    """
    if not resp or not isinstance(resp, dict):
        return None
    return (
        resp.get('orderId')
        or resp.get('order_id')
        or resp.get('algoId')
        or resp.get('algoOrderId')
    )


def _sync_sl_tp_ids_from_exchange(self):
    """
    Preenche sl_order_id / tp_order_id a partir de ordens REST e ordens ALGO.
    Muitas TP/STOP condicionais só aparecem em futures_get_open_algo_orders.
    """
    try:
        merged = []
        try:
            for o in self.client.futures_get_open_orders(symbol=self.symbol_internal) or []:
                t = o.get('type') or o.get('orderType', '')
                if t in ('STOP', 'TAKE_PROFIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'):
                    merged.append(o)
        except Exception as e:
            print(f"⚠️ Erro ao listar open orders (SL/TP): {e}")
        try:
            for o in self.client.futures_get_open_algo_orders(symbol=self.symbol_internal) or []:
                merged.append(o)
        except (AttributeError, Exception):
            pass
        for o in merged:
            order_type = (o.get('type') or o.get('orderType') or '').upper()
            oid = o.get('algoId') or o.get('algoOrderId') or o.get('orderId') or o.get('order_id')
            if not oid:
                continue
            if order_type in ('STOP', 'STOP_MARKET'):
                self.sl_order_id = oid
            elif order_type in ('TAKE_PROFIT', 'TAKE_PROFIT_MARKET'):
                self.tp_order_id = oid
    except Exception as e:
        print(f"⚠️ Erro ao sincronizar SL/TP da exchange: {e}")


def _set_sl_tp_ids_from_open_orders(self):
    """Compat: sincronização completa REST + algo."""
    _sync_sl_tp_ids_from_exchange(self)

def place_sl_tp(self, position_type, entry_price):
    """
    Coloca SL e TP como ordens LIMIT (TAKE_PROFIT e STOP) para fees maker mais baixas.
    Retorna True só se TP e SL ficarem colocados; em falha parcial remove ordens de proteção criadas.
    """
    self.tp_order_id = None
    self.sl_order_id = None
    try:
        position_qty = get_position_quantity(self)
        if position_qty is None:
            print("❌ Não foi possível obter quantidade da posição para SL/TP.")
            _notify_discord_failure(self, "place_sl_tp", message="Sem quantidade de posição para SL/TP.")
            return False
        if position_type == 'long':
            sl_price = round_price(self, entry_price * (1 - self.sl_percent))
            tp_price = round_price(self, entry_price * (1 + self.tp_percent))
            print(f"📊 Configurando SL/TP LIMIT para LONG:")
            print(f"   Entry: {entry_price}, SL: {sl_price}, TP: {tp_price} (qty: {position_qty})")
            tp_result = self.client.futures_create_order(
                symbol=self.symbol_internal,
                side='SELL',
                type='TAKE_PROFIT',
                quantity=position_qty,
                price=str(tp_price),
                stopPrice=str(tp_price),
                timeInForce='GTC',
                reduceOnly=True
            )
            self.tp_order_id = _extract_order_id_from_create_response(tp_result)
            if self.tp_order_id is None:
                time.sleep(0.4)
                _sync_sl_tp_ids_from_exchange(self)
            if not self.tp_order_id:
                print("❌ TP LONG sem orderId.")
                _notify_discord_failure(self, "place_sl_tp LONG", message="TP LONG sem orderId após create + sync.")
                return False
            print(f"✅ TP LIMIT colocado em {tp_price} (ID: {self.tp_order_id})")
            try:
                sl_result = self.client.futures_create_order(
                    symbol=self.symbol_internal,
                    side='SELL',
                    type='STOP',
                    quantity=position_qty,
                    price=str(sl_price),
                    stopPrice=str(sl_price),
                    timeInForce='GTC',
                    reduceOnly=True
                )
            except Exception as e_sl:
                print(f"❌ SL LONG falhou após TP: {e_sl}")
                _notify_discord_failure(self, "place_sl_tp LONG / SL após TP", exception=e_sl)
                cancel_sl_tp(self)
                return False
            self.sl_order_id = _extract_order_id_from_create_response(sl_result)
            if self.sl_order_id is None:
                time.sleep(0.4)
                _sync_sl_tp_ids_from_exchange(self)
            if not self.sl_order_id:
                print("❌ SL LONG sem orderId.")
                _notify_discord_failure(self, "place_sl_tp LONG", message="SL LONG sem orderId após create + sync.")
                cancel_sl_tp(self)
                return False
            print(f"✅ SL LIMIT colocado em {sl_price} (ID: {self.sl_order_id})")
            return True
        if position_type == 'short':
            sl_price = round_price(self, entry_price * (1 + self.sl_percent))
            tp_price = round_price(self, entry_price * (1 - self.tp_percent))
            print(f"📊 Configurando SL/TP LIMIT para SHORT:")
            print(f"   Entry: {entry_price}, SL: {sl_price}, TP: {tp_price} (qty: {position_qty})")
            tp_result = self.client.futures_create_order(
                symbol=self.symbol_internal,
                side='BUY',
                type='TAKE_PROFIT',
                quantity=position_qty,
                price=str(tp_price),
                stopPrice=str(tp_price),
                timeInForce='GTC',
                reduceOnly=True
            )
            self.tp_order_id = _extract_order_id_from_create_response(tp_result)
            if self.tp_order_id is None:
                time.sleep(0.4)
                _sync_sl_tp_ids_from_exchange(self)
            if not self.tp_order_id:
                print("❌ TP SHORT sem orderId.")
                _notify_discord_failure(self, "place_sl_tp SHORT", message="TP SHORT sem orderId após create + sync.")
                return False
            print(f"✅ TP LIMIT colocado em {tp_price} (ID: {self.tp_order_id})")
            try:
                sl_result = self.client.futures_create_order(
                    symbol=self.symbol_internal,
                    side='BUY',
                    type='STOP',
                    quantity=position_qty,
                    price=str(sl_price),
                    stopPrice=str(sl_price),
                    timeInForce='GTC',
                    reduceOnly=True
                )
            except Exception as e_sl:
                print(f"❌ SL SHORT falhou após TP: {e_sl}")
                _notify_discord_failure(self, "place_sl_tp SHORT / SL após TP", exception=e_sl)
                cancel_sl_tp(self)
                return False
            self.sl_order_id = _extract_order_id_from_create_response(sl_result)
            if self.sl_order_id is None:
                time.sleep(0.4)
                _sync_sl_tp_ids_from_exchange(self)
            if not self.sl_order_id:
                print("❌ SL SHORT sem orderId.")
                _notify_discord_failure(self, "place_sl_tp SHORT", message="SL SHORT sem orderId após create + sync.")
                cancel_sl_tp(self)
                return False
            print(f"✅ SL LIMIT colocado em {sl_price} (ID: {self.sl_order_id})")
            return True
        print(f"❌ Tipo de posição inválido: {position_type}")
        _notify_discord_failure(self, "place_sl_tp", message=f"Tipo de posição inválido: {position_type}")
        return False
    except Exception as e:
        print(f"❌ Erro ao configurar SL/TP: {e}")
        import traceback
        traceback.print_exc()
        _notify_discord_failure(self, "place_sl_tp", exception=e)
        cancel_sl_tp(self)
        return False


def _market_reduce_until_flat(self, max_orders=10):
    """Várias ordens MARKET reduceOnly até `positionAmt` ser zero (robusto a poeira/arredondamentos)."""
    for _ in range(max_orders):
        get_current_position(self)
        if self.position is None:
            return True
        q = get_position_quantity(self)
        if q is None:
            print("❌ MARKET reduce: não foi possível calcular qty válida para o resto da posição.")
            return False
        side = 'SELL' if self.position == 'long' else 'BUY'
        try:
            self.client.futures_create_order(
                symbol=self.symbol_internal,
                side=side,
                type='MARKET',
                quantity=q,
                reduceOnly=True,
            )
        except Exception as e:
            print(f"❌ Falha ordem MARKET reduceOnly (qty={q}): {e}")
            get_current_position(self)
            if self.position is None:
                return True
            continue
        time.sleep(0.5)
    get_current_position(self)
    return self.position is None


def _close_position_market_emergency(self, reason=""):
    """Fecha toda a posição ao mercado (reduceOnly). Usado quando SL/TP não pode ficar garantido."""
    get_current_position(self)
    if self.position is None:
        cancel_sl_tp(self)
        self.buyed = False
        self.entry_time = None
        self.trade_direction = None
        return True
    msg = reason or "protecção SL/TP incompleta"
    ok = _market_reduce_until_flat(self)
    if ok:
        print(f"🛑 Posição fechada ao mercado (emergência: {msg}).")
        _notify_discord_failure(
            self, "_close_position_market_emergency",
            message=f"Fecho de emergência ao mercado: {msg}",
        )
        cancel_sl_tp(self)
        self.buyed = False
        self.entry_time = None
        self.trade_direction = None
        self.position = None
        return True
    print(f"❌ Não foi possível fechar toda a posição ao mercado após várias tentativas ({msg}).")
    _notify_discord_failure(
        self,
        "_close_position_market_emergency",
        message=f"Falhou fecho completo ao mercado ({msg}); verifica posição na Binance.",
    )
    return False


def _fetch_guard_price(self):
    """Preço de contrato usado para decidir se o SL/TP local já foi atravessado."""
    try:
        ticker = self.client.futures_symbol_ticker(symbol=self.symbol_internal)
        price = float(ticker.get('price') or 0)
        if price > 0:
            return price
    except Exception as e:
        print(f"⚠️ Guard SL/TP: erro ao obter ticker: {e}")
    try:
        bid, ask = get_bid_ask(self)
        if bid and ask:
            return (float(bid) + float(ask)) / 2.0
    except Exception as e:
        print(f"⚠️ Guard SL/TP: erro ao obter bid/ask: {e}")
    return 0.0


def _low_fee_guard_exit_until_flat(self, close_side, exit_reason, trigger_price, current_price):
    """
    Fecha uma posição que já passou SL/TP mas continua aberta.
    Tenta LIMIT reduceOnly, uma ordem de cada vez; só usa MARKET se todas as tentativas falharem.
    """
    saved_direction = 'LONG' if getattr(self, 'position', None) == 'long' else 'SHORT'
    saved_entry_price = float(getattr(self, 'entry_price', 0) or 0)
    saved_entry_time = getattr(self, 'entry_time', None)
    saved_qty = get_position_quantity(self)

    print(
        f"🛡️ Guard SL/TP activo: {exit_reason} atravessado "
        f"(preço={current_price}, trigger={trigger_price}). A sair com LIMIT reduceOnly..."
    )
    _notify_discord_failure(
        self,
        "SL/TP guard",
        message=(
            f"{exit_reason} atravessado mas posição ainda aberta. "
            f"preço={current_price}, trigger={trigger_price}; a tentar saída LIMIT reduceOnly."
        ),
    )
    cancel_sl_tp(self)

    max_attempts = max(1, int(getattr(self, 'sl_tp_guard_limit_attempts', 6) or 6))
    timeout_sec = max(1, int(getattr(self, 'sl_tp_guard_timeout_sec', 8) or 8))
    for attempt in range(1, max_attempts + 1):
        get_current_position(self)
        if self.position is None:
            break
        qty = get_position_quantity(self)
        if qty is None:
            print("❌ Guard SL/TP: não foi possível obter qty restante para fechar.")
            break
        print(f"🛡️ Guard SL/TP: tentativa LIMIT {attempt}/{max_attempts} qty={qty}.")
        _place_limit_close_and_wait(self, close_side, qty, num_attempts=1, timeout_per_attempt=timeout_sec)

    get_current_position(self)
    if self.position is not None and getattr(self, 'sl_tp_guard_market_fallback', True):
        print("⚠️ Guard SL/TP: LIMIT não fechou tudo; fallback MARKET reduceOnly para não ficar preso.")
        _market_reduce_until_flat(self)

    get_current_position(self)
    if self.position is None:
        exit_price = getattr(self, '_last_close_price', 0.0) or current_price
        if saved_qty is not None:
            _send_discord_trade_alert(
                self,
                saved_direction,
                saved_entry_price,
                exit_price,
                saved_qty,
                saved_entry_time,
                exit_reason=exit_reason,
            )
        self.buyed = False
        self.entry_time = None
        self.trade_direction = None
        cancel_sl_tp(self)
        print(f"✅ Guard SL/TP: posição fechada por {exit_reason}.")
        return True

    print("❌ Guard SL/TP: posição continua aberta após tentativas; verifica manualmente na Binance.")
    _notify_discord_failure(
        self,
        "SL/TP guard",
        message=f"Falhou fechar posição após {exit_reason}; verifica manualmente na Binance.",
    )
    return True


def enforce_sl_tp_price_guard(self):
    """
    Proteção local: se o preço já atravessou SL/TP e a Binance ainda mantém a posição,
    força saída com LIMIT reduceOnly antes de deixar a estratégia continuar.
    """
    if not getattr(self, 'sl_tp_guard_enabled', True):
        return False

    get_current_position(self)
    if self.position not in ('long', 'short'):
        return False

    entry_price = float(getattr(self, 'entry_price', 0) or 0)
    sl_pct = float(getattr(self, 'sl_percent', 0) or 0)
    tp_pct = float(getattr(self, 'tp_percent', 0) or 0)
    if entry_price <= 0 or (sl_pct <= 0 and tp_pct <= 0):
        return False

    current_price = _fetch_guard_price(self)
    if current_price <= 0:
        return False

    if self.position == 'long':
        if sl_pct > 0:
            sl_price = round_price(self, entry_price * (1 - sl_pct))
            if current_price <= sl_price:
                return _low_fee_guard_exit_until_flat(self, 'SELL', 'SL Guard', sl_price, current_price)
        if tp_pct > 0:
            tp_price = round_price(self, entry_price * (1 + tp_pct))
            if current_price >= tp_price:
                return _low_fee_guard_exit_until_flat(self, 'SELL', 'TP Guard', tp_price, current_price)

    if self.position == 'short':
        if sl_pct > 0:
            sl_price = round_price(self, entry_price * (1 + sl_pct))
            if current_price >= sl_price:
                return _low_fee_guard_exit_until_flat(self, 'BUY', 'SL Guard', sl_price, current_price)
        if tp_pct > 0:
            tp_price = round_price(self, entry_price * (1 - tp_pct))
            if current_price <= tp_price:
                return _low_fee_guard_exit_until_flat(self, 'BUY', 'TP Guard', tp_price, current_price)

    return False


def _place_limit_close_and_wait(self, side, quantity_str, num_attempts=6, timeout_per_attempt=10):
    """Fecha posição com ordem LIMIT (maker). Várias tentativas com preço atualizado para entrar dentro do candle actual (sem fees).
    side='BUY' para fechar short, 'SELL' para fechar long."""
    for attempt in range(1, num_attempts + 1):
        bid, ask = get_bid_ask(self)
        price = str(bid) if side == 'BUY' else str(ask)
        try:
            order = self.client.futures_create_order(
                symbol=self.symbol_internal,
                side=side,
                type='LIMIT',
                quantity=quantity_str,
                price=price,
                timeInForce='GTC',
                reduceOnly=True
            )
        except Exception as e:
            print(f"[AVISO] Erro ao colocar ordem LIMIT (tentativa {attempt}/{num_attempts}): {e}")
            time.sleep(2)
            continue
        order_id = order.get('orderId')
        if _wait_for_order_fill(self, order_id, timeout_seconds=timeout_per_attempt):
            print(f"[OK] Posicao fechada com LIMIT (maker) ao preco {price} (tentativa {attempt})")
            self._last_close_price = float(price)
            return True
        try:
            self.client.futures_cancel_order(symbol=self.symbol_internal, orderId=order_id)
        except Exception:
            pass
        if attempt < num_attempts:
            time.sleep(1)  # breve pausa antes da próxima tentativa
    print(f"[AVISO] Ordem LIMIT de fecho nao preenchida em {num_attempts} tentativas de {timeout_per_attempt}s cada.")
    return False

def _place_market_entry(self, side, quantity_str):
    """Abre posição com ordem MARKET (taker). Garante entrada; paga mais fees. Retorna (success, entry_price)."""
    try:
        order = self.client.futures_create_order(
            symbol=self.symbol_internal,
            side=side,
            type='MARKET',
            quantity=quantity_str
        )
        order_id = order.get('orderId') or order.get('order_id')
        if order_id is None:
            return False, 0.0
        # MARKET normalmente preenche de imediato; confirmar
        if _wait_for_order_fill(self, order_id, timeout_seconds=15):
            try:
                filled = self.client.futures_get_order(symbol=self.symbol_internal, orderId=int(order_id))
                avg = filled.get('avgPrice')
                entry = float(avg) if avg else 0.0
            except Exception:
                entry = 0.0
            if entry and entry > 0:
                print(f"✅ Entrada MARKET (taker) executada ao preço ~{entry}")
                return True, entry
        get_current_position(self)
        if self.entry_price and self.entry_price > 0:
            print(f"✅ Entrada MARKET executada (entry ~{self.entry_price})")
            return True, self.entry_price
    except Exception as e:
        err_code = getattr(e, 'code', None) or getattr(e, 'error_code', None)
        if err_code == -2019 or '-2019' in str(e):
            # Já filtrado por _has_margin_for_entry_qty; corrida rara — sem log/Discord
            pass
        else:
            print(f"❌ Erro ao colocar ordem MARKET de entrada: {e}")
            _notify_discord_failure(self, "_place_market_entry", exception=e)
    return False, 0.0

def _place_limit_entry_and_wait(self, side, quantity_str, num_attempts=6, timeout_per_attempt=10):
    """Abre posição com LIMIT (maker). Várias tentativas com preço atualizado a cada tentativa. Retorna (success, entry_price)."""
    market_fallback = getattr(self, 'entry_market_fallback', False)

    for attempt in range(1, num_attempts + 1):
        bid, ask = get_bid_ask(self)
        price = round_price(self, bid) if side == 'BUY' else round_price(self, ask)
        price_str = str(price)
        try:
            order = self.client.futures_create_order(
                symbol=self.symbol_internal,
                side=side,
                type='LIMIT',
                quantity=quantity_str,
                price=price_str,
                timeInForce='GTC'
            )
        except Exception as e:
            err_code = getattr(e, 'code', None) or getattr(e, 'error_code', None)
            if err_code == -2019 or '-2019' in str(e):
                # Pré-check devia evitar; corrida rara — sem log/Discord
                return False, 0.0
            print(f"[AVISO] Erro ao colocar ordem LIMIT de entrada (tentativa {attempt}/{num_attempts}): {e}")
            time.sleep(2)
            continue
        order_id = order.get('orderId') or order.get('order_id')
        if order_id is None:
            continue
        if _wait_for_order_fill(self, order_id, timeout_seconds=timeout_per_attempt):
            try:
                filled = self.client.futures_get_order(symbol=self.symbol_internal, orderId=int(order_id))
                avg = filled.get('avgPrice')
                entry = float(avg) if avg else float(price_str)
            except Exception:
                entry = float(price_str)
            print(f"✅ Entrada LIMIT ao preço ~{entry} (tentativa {attempt})")
            return True, entry
        try:
            self.client.futures_cancel_order(symbol=self.symbol_internal, orderId=int(order_id))
        except Exception as e:
            err_code = getattr(e, 'code', None) or getattr(e, 'error_code', None)
            if err_code == -2011 or '-2011' in str(e):
                try:
                    filled = self.client.futures_get_order(symbol=self.symbol_internal, orderId=int(order_id))
                    if (filled.get('status') or '').strip().upper() == 'FILLED':
                        avg = filled.get('avgPrice')
                        entry = float(avg) if avg else float(price_str)
                        print(f"✅ Entrada LIMIT preenchida (após cancel) ~{entry} (tentativa {attempt})")
                        return True, entry
                except Exception:
                    pass
                get_current_position(self)
                if self.entry_price and self.entry_price > 0:
                    return True, self.entry_price
        if attempt < num_attempts:
            time.sleep(1)

    if market_fallback:
        try:
            mp = float(self.client.futures_symbol_ticker(symbol=self.symbol_internal)['price'])
        except Exception:
            mp = 0.0
        if mp and not _has_margin_for_entry_qty(self, quantity_str, mp):
            return False, 0.0
        print("⏱️ Limit não preenchida; a usar MARKET para não perder a trade.")
        return _place_market_entry(self, side, quantity_str)
    print(f"⚠️ Ordem LIMIT de entrada não preenchida em {num_attempts} tentativas de {timeout_per_attempt}s cada.")
    return False, 0.0


def _pre_entry_order_state(self):
    state = getattr(self, 'pre_entry_order', None)
    if not isinstance(state, dict):
        state = {}
        self.pre_entry_order = state
    return state


def cancel_pre_entry_order(self, reason=""):
    state = _pre_entry_order_state(self)
    order_id = state.get('order_id')
    if not order_id:
        state.clear()
        return True
    if getattr(self, 'pre_entry_dry_run', True):
        print(f"[PRE] dry-run cancel {state.get('side')} @{state.get('price')} {reason}".strip())
        state.clear()
        return True
    try:
        self.client.futures_cancel_order(symbol=self.symbol_internal, orderId=int(order_id))
        print(f"[PRE] ordem antecipada cancelada ({state.get('side')} @{state.get('price')}) {reason}".strip())
    except Exception as e:
        err_code = getattr(e, 'code', None) or getattr(e, 'error_code', None)
        if err_code != -2011 and '-2011' not in str(e):
            print(f"[PRE] erro ao cancelar ordem antecipada {order_id}: {e}")
            return False
    state.clear()
    return True


def _pre_entry_order_side(signal_side):
    return 'BUY' if signal_side == 'long' else 'SELL'


def _pre_entry_passive_price(self, signal_side, target_price):
    bid, ask = get_bid_ask(self)
    target = float(target_price)
    if signal_side == 'long':
        px = min(target, float(bid))
    else:
        px = max(target, float(ask))
    return round_price(self, px)


def reconcile_pre_entry_order(self):
    state = _pre_entry_order_state(self)
    order_id = state.get('order_id')
    if not order_id or getattr(self, 'pre_entry_dry_run', True):
        return False
    try:
        order = self.client.futures_get_order(symbol=self.symbol_internal, orderId=int(order_id))
    except Exception as e:
        print(f"[PRE] erro ao consultar ordem antecipada {order_id}: {e}")
        return False
    status = (order.get('status') or '').strip().upper()
    exec_qty = float(order.get('executedQty') or 0)
    if status not in ('FILLED', 'PARTIALLY_FILLED') and exec_qty <= 0:
        if status in ('CANCELED', 'EXPIRED', 'REJECTED'):
            state.clear()
        return False
    if status == 'PARTIALLY_FILLED':
        try:
            self.client.futures_cancel_order(symbol=self.symbol_internal, orderId=int(order_id))
        except Exception:
            pass
    get_current_position(self)
    side = state.get('side')
    if self.position != side:
        print(f"[PRE] ordem preencheu mas posição atual é {self.position}; verifica manualmente.")
        state.clear()
        return False
    avg = order.get('avgPrice')
    if avg:
        try:
            self.entry_price = float(avg)
        except (TypeError, ValueError):
            pass
    self.buyed = True
    self.entry_time = datetime.now(timezone.utc)
    self.trade_direction = 'LONG' if side == 'long' else 'SHORT'
    print(f"[PRE] {self.trade_direction} preenchido por LIMIT post-only ~{self.entry_price}")
    if not place_sl_tp(self, side, self.entry_price):
        print("[PRE] SL/TP falhou após pre-entry; a fechar posição por segurança.")
        _close_position_market_emergency(self, "SL/TP falhou após pre-entry")
    state.clear()
    return True


def manage_pre_entry_order(self, prediction):
    if not getattr(self, 'pre_entry_enabled', False):
        return
    reconcile_pre_entry_order(self)
    get_current_position(self)
    if self.position is not None:
        cancel_pre_entry_order(self, "posição já aberta")
        return
    if not prediction:
        cancel_pre_entry_order(self, "sem trigger")
        return

    side = prediction.get('side')
    if side not in ('long', 'short'):
        cancel_pre_entry_order(self, "side inválido")
        return
    distance = float(prediction.get('distance_pct') or 0.0)
    max_dist = float(getattr(self, 'pre_entry_max_distance_pct', 0.35))
    if distance > max_dist:
        cancel_pre_entry_order(self, f"trigger longe ({distance:.3f}%)")
        return

    target = float(prediction.get('price') or 0.0)
    if target <= 0:
        cancel_pre_entry_order(self, "preço inválido")
        return
    passive_price = _pre_entry_passive_price(self, side, target)
    if passive_price <= 0:
        cancel_pre_entry_order(self, "preço passivo inválido")
        return

    state = _pre_entry_order_state(self)
    reprice_pct = float(getattr(self, 'pre_entry_reprice_pct', 0.03))
    if state.get('side') == side and state.get('price'):
        old_px = float(state['price'])
        if old_px > 0 and abs(passive_price / old_px - 1.0) * 100.0 < reprice_pct:
            now = time.time()
            last_log = float(state.get('last_log_ts') or 0)
            if now - last_log >= float(getattr(self, 'pre_entry_log_interval_sec', 15)):
                print(
                    f"[PRE] mantém {side} LIMIT @{old_px} | trigger={target:.8f} "
                    f"dist={distance:.3f}% rsi={float(prediction.get('rsi') or 0):.2f}"
                )
                state['last_log_ts'] = now
            return

    cancel_pre_entry_order(self, "reprice/novo sinal")

    if getattr(self, 'pre_entry_dry_run', True):
        self.pre_entry_order = {
            'side': side,
            'price': passive_price,
            'target': target,
            'dry_run': True,
            'last_log_ts': time.time(),
        }
        print(
            f"[PRE] dry-run {side.upper()} LIMIT post-only @{passive_price} "
            f"(trigger={target:.8f}, dist={distance:.3f}%, "
            f"rsi={float(prediction.get('rsi') or 0):.2f}, "
            f"natr={float(prediction.get('natr') or 0):.4f}, "
            f"t3d={float(prediction.get('t3_delta') or 0):.4f})"
        )
        return

    blocked = _block_if_account_busy_for_new_entry(self, side.upper())
    if blocked:
        return
    get_total_balance(self)
    ticker = self.client.futures_symbol_ticker(symbol=self.symbol_internal)
    current_price = float(ticker['price'])
    quantity = (self.quantity * self.leverage) / current_price
    quantity_str = adjust_quantity(self, quantity)
    if quantity_str is None or not _has_margin_for_entry_qty(self, quantity_str, current_price):
        print("[PRE] sem quantidade/margem para ordem antecipada.")
        return

    try:
        order = self.client.futures_create_order(
            symbol=self.symbol_internal,
            side=_pre_entry_order_side(side),
            type='LIMIT',
            quantity=quantity_str,
            price=str(passive_price),
            timeInForce='GTX',
        )
    except Exception as e:
        print(f"[PRE] erro ao colocar LIMIT post-only: {e}")
        return
    order_id = order.get('orderId') or order.get('order_id')
    if not order_id:
        print("[PRE] ordem criada sem orderId; não consigo gerir.")
        return
    self.pre_entry_order = {
        'order_id': order_id,
        'side': side,
        'price': passive_price,
        'target': target,
        'qty': quantity_str,
        'last_log_ts': time.time(),
    }
    print(f"[PRE] ordem {side.upper()} LIMIT post-only @{passive_price} qty={quantity_str} id={order_id}")

def _commission_to_quote(self, commission, asset):
    """Converte uma fee para a moeda quote do símbolo (USDT/USDC).
    Se a commissionAsset já for quote, retorna direto. Caso contrário (ex: BNB),
    usa o ticker da Binance Futures para converter.
    BNFCR = Binance Futures Commission Rebate (fee zero por promoção/rebate)."""
    if not commission or commission == 0.0:
        return 0.0  # fee já é zero, não há nada a converter
    quote_assets = {'USDT', 'USDC', 'BUSD', 'BNFCR'}
    asset = (asset or '').upper()
    if not asset or asset in quote_assets:
        return commission
    sym   = self.symbol_internal.upper()
    quote = 'USDC' if sym.endswith('USDC') else 'USDT'
    for pair in (f"{asset}{quote}", f"{asset}USDT", f"{asset}USDC"):
        try:
            price = float(self.client.futures_symbol_ticker(symbol=pair)['price'])
            converted = commission * price
            print(f"ℹ️ Fee {commission} {asset} convertida para {converted:.6f} {quote}")
            return converted
        except Exception:
            continue
    print(f"⚠️ Não foi possível converter fee {commission} {asset} → {quote}. A usar 0.")
    return 0.0


def _fetch_close_fees(self, close_side, since_dt=None):
    """Vai buscar à Binance as fees reais das trades de fecho (em moeda quote).
    Retorna (fees_total, close_trades) onde close_trades é a lista de fills."""
    try:
        kwargs = dict(symbol=self.symbol_internal, limit=20)
        if since_dt:
            kwargs['startTime'] = int(since_dt.timestamp() * 1000) - 1000
        trades = self.client.futures_account_trades(**kwargs)
        close_trades = [
            t for t in trades
            if t.get('side') == close_side and float(t.get('realizedPnl', 0)) != 0
        ]
        total_fees = sum(
            _commission_to_quote(self, float(ct.get('commission', 0)), ct.get('commissionAsset', ''))
            for ct in close_trades
        )
        return total_fees, close_trades
    except Exception as e:
        print(f"⚠️ Erro ao obter fees da Binance: {e}")
        return 0.0, []


def reconcile_open_position_from_exchange(self):
    """
    Alinha estado com a Binance: posição sem SL/TP completo → tenta colocar; se falhar, fecha ao mercado.
    buyed só fica True quando SL/TP estão presentes. Posição sem buyed mas com SL/TP → só preenche buyed.
    """
    get_current_position(self)
    if self.position is None:
        if getattr(self, 'buyed', False):
            print("⚠️ buyed=True mas sem posição na exchange; a limpar estado local.")
            self.buyed = False
            self.entry_time = None
            self.trade_direction = None
        return
    ep = float(getattr(self, 'entry_price', 0) or 0)
    need_buyed = not getattr(self, 'buyed', False)
    need_sl_tp = (
        getattr(self, 'sl_order_id', None) is None
        or getattr(self, 'tp_order_id', None) is None
    )
    if not need_buyed and not need_sl_tp:
        return
    if need_sl_tp:
        if ep <= 0:
            print("⚠️ Posição sem SL/TP e entry_price inválido; a fechar ao mercado.")
            _close_position_market_emergency(self, "entry_price inválido na reconciliação")
            return
        print("🔧 SL/TP em falta com posição aberta; a colocar proteção...")
        cancel_sl_tp(self)
        if not place_sl_tp(self, self.position, ep):
            print("❌ Não foi possível garantir SL/TP; a fechar posição ao mercado.")
            _notify_discord_failure(
                self, "reconcile_open_position_from_exchange",
                message="place_sl_tp falhou na reconciliação; vai fechar ao mercado.",
            )
            _close_position_market_emergency(self, "falha SL/TP na reconciliação")
            return
        get_current_position(self)
    if need_buyed and self.position is not None:
        print("⚠️ Posição aberta na exchange mas buyed=False; a sincronizar (proteção já colocada).")
        self.buyed = True
        self.trade_direction = 'LONG' if self.position == 'long' else 'SHORT'
        if getattr(self, 'entry_time', None) is None:
            self.entry_time = datetime.now(timezone.utc)


def check_sl_tp_hit(self):
    """
    Detecta se a posição foi fechada pelo exchange (SL ou TP) entre ciclos.
    Deve ser chamado no início de cada ciclo, antes de correr a estratégia.
    Envia alerta Discord com dados reais obtidos via futures_account_trades.
    """
    if not getattr(self, 'buyed', False):
        return

    # Guardar estado ANTES de get_current_position o sobrescrever
    saved_entry_price = getattr(self, 'entry_price', 0.0)
    saved_direction   = getattr(self, 'trade_direction', None)
    saved_entry_time  = getattr(self, 'entry_time', None)

    get_current_position(self)

    if self.position is not None:
        return  # posição ainda aberta

    # --- SL ou TP atingido ---
    print(f"🛑 Posição {saved_direction or '?'} fechada por SL/TP detectada.")

    t_exit    = datetime.now(timezone.utc)
    exit_price = 0.0
    qty        = 0.0
    pnl_gross  = 0.0

    try:
        close_side          = 'SELL' if saved_direction == 'LONG' else 'BUY'
        fees, close_trades  = _fetch_close_fees(self, close_side, since_dt=saved_entry_time)

        if close_trades:
            for ct in close_trades:
                qty       += float(ct.get('qty', 0))
                pnl_gross += float(ct.get('realizedPnl', 0))

            total_val  = sum(float(ct['qty']) * float(ct['price']) for ct in close_trades)
            total_qty  = sum(float(ct['qty']) for ct in close_trades)
            exit_price = total_val / total_qty if total_qty > 0 else 0.0

            last_ms = max(ct.get('time', 0) for ct in close_trades)
            if last_ms:
                t_exit = datetime.fromtimestamp(last_ms / 1000, tz=timezone.utc)

            pnl_net = pnl_gross - fees
            lev     = getattr(self, 'leverage', 1) or 1
            ep      = saved_entry_price if saved_entry_price else exit_price
            margin  = ep * qty / lev if ep > 0 else 1
            pct     = (pnl_net / margin * 100) if margin > 0 else 0.0

            # Inferir SL vs TP pelo preço de saída vs entrada
            if saved_direction == 'LONG':
                exit_reason = 'TP' if exit_price > ep else 'SL'
            elif saved_direction == 'SHORT':
                exit_reason = 'TP' if exit_price < ep else 'SL'
            else:
                exit_reason = 'SL'  # fallback conservador
            print(f"ℹ️ Saída inferida como {exit_reason} (entry={ep:.4f}, exit={exit_price:.4f})")

            try:
                from configs.discords_alerts import send_trade_result
                send_trade_result(
                    bot_name    = getattr(self, 'strategy_name', 'Bot'),
                    pair        = getattr(self, 'symbol', '?'),
                    direction   = saved_direction or '?',
                    entry_price = ep,
                    exit_price  = exit_price,
                    entry_time  = saved_entry_time or t_exit,
                    exit_time   = t_exit,
                    quantity    = qty,
                    fees        = fees,
                    profit_usdt = pnl_net,
                    profit_pct  = pct,
                    exit_reason = exit_reason,
                )
                print(f"📨 Discord: alerta SL/TP enviado ({saved_direction}, pnl={pnl_net:+.2f} USDT)")
            except Exception as e:
                print(f"[Discord] Erro ao enviar alerta SL/TP: {e}")
                _notify_discord_failure(self, "check_sl_tp_hit / send_trade_result", exception=e)
        else:
            print(f"⚠️ Nenhum trade de fecho encontrado na API para o alerta Discord.")
    except Exception as e:
        print(f"⚠️ Erro ao consultar trades de fecho (SL/TP): {e}")

    # Resetar estado
    self.buyed           = False
    self.entry_time      = None
    self.trade_direction = None


def _sync_state_if_position_matches_signal(self, signal):
    """
    Quando a posição já está no sentido do sinal (ex.: outra instância consumiu margem e abriu trade,
    ou a ordem preencheu entre tentativas), alinha buyed/SL/TP e devolve True para o loop terminar com 'ok'.
    """
    if signal == 'long' and self.position != 'long':
        return False
    if signal == 'short' and self.position != 'short':
        return False
    if self.position not in ('long', 'short'):
        return False
    # Modo "estrito": não assumir posições externas nem alterar buyed fora do momento de entrada.
    print("ℹ️ Posição já aberta no sentido do sinal; modo estrito: não sincroniza buyed/SL/TP automaticamente.")
    return True


def _send_discord_trade_alert(self, direction, entry_price, exit_price, quantity, entry_time=None, exit_reason='Sinal'):
    """Envia alerta de fecho de trade para Discord. Fees obtidas da Binance. Nunca lança exceção."""
    try:
        from configs.discords_alerts import send_trade_result
        qty = float(quantity)    if quantity    else 0.0
        ep  = float(entry_price) if entry_price else 0.0
        xp  = float(exit_price)  if exit_price  else 0.0

        # Buscar fees reais da Binance (janela desde entry_time ou últimos 5 min)
        close_side = 'SELL' if direction == 'LONG' else 'BUY'
        fees, _    = _fetch_close_fees(self, close_side, since_dt=entry_time)

        pnl     = (xp - ep) * qty if direction == 'LONG' else (ep - xp) * qty
        pnl_net = pnl - fees
        lev     = getattr(self, 'leverage', 1) or 1
        margin  = ep * qty / lev
        pct     = (pnl_net / margin * 100) if margin > 0 else 0.0
        t_entry = entry_time or datetime.now(timezone.utc)
        t_exit  = datetime.now(timezone.utc)
        send_trade_result(
            bot_name    = getattr(self, 'strategy_name', 'Bot'),
            pair        = getattr(self, 'symbol', '?'),
            direction   = direction,
            entry_price = ep,
            exit_price  = xp,
            entry_time  = t_entry,
            exit_time   = t_exit,
            quantity    = qty,
            fees        = fees,
            profit_usdt = pnl_net,
            profit_pct  = pct,
            exit_reason = exit_reason,
        )
        print(f"📨 Discord: alerta enviado ({direction} {getattr(self, 'symbol', '')}, pnl={pnl_net:+.2f} USDT)")
    except Exception as e:
        print(f"[Discord] Erro ao enviar alerta: {e}")
        _notify_discord_failure(self, "_send_discord_trade_alert", exception=e)


def execute_trade(self, signal):
    get_current_position(self)
    closed_now_slow = False
    if signal == 'long':
        if self.position == 'long':
            _sync_state_if_position_matches_signal(self, 'long')
            return "ok"
        cancel_sl_tp(self)
        blocked = _block_if_account_busy_for_new_entry(self, "LONG")
        if blocked:
            return blocked
        try:
            get_total_balance(self)
            ticker = self.client.futures_symbol_ticker(symbol=self.symbol_internal)
            current_price = float(ticker['price'])
            quantity = (self.quantity * self.leverage) / current_price
            quantity_str = adjust_quantity(self, quantity)
            if quantity_str is None:
                print("❌ Quantidade inválida ou saldo insuficiente.")
                _notify_discord_failure(self, "execute_trade LONG", message="Quantidade inválida ou saldo insuficiente (pré-entrada).")
                # Falha estrutural (minQty/filters) ou saldo pequeno → não adianta repetir em loop
                return "no_retry"
            bal = getattr(self, '_last_available_balance', None)
            if bal is not None:
                print(f"💰 Margem disponível: {bal:.2f} | A usar (80%): {self.quantity:.2f} | qty(base): {quantity_str}")
            if self.position == 'short':
                # Flip único: BUY (short_qty + long_qty) fecha o short e abre o long atomicamente
                old_entry_price = getattr(self, 'entry_price', 0.0)
                old_entry_time  = getattr(self, 'entry_time', None)
                short_qty = get_position_quantity(self)
                if short_qty is None:
                    print("⚠️ Não foi possível obter quantidade da posição para flip.")
                    return "no_retry"
                flip_qty = adjust_quantity(self, float(short_qty) + float(quantity_str))
                if flip_qty is None:
                    _notify_discord_failure(self, "execute_trade LONG", message="Flip qty inválida após ajuste de LOT_SIZE (pré-entrada).")
                    return "no_retry"
                if not _has_margin_for_entry_qty(self, flip_qty, current_price):
                    _notify_discord_failure(self, "execute_trade LONG", message="Margem insuficiente para flip SHORT→LONG (pré-entrada).")
                    return "no_retry"
                if not self.buyed:
                    closed_now_slow = True
                print(f"📤 Ordem LIMIT BUY (flip SHORT→LONG) qty={flip_qty} (short={short_qty} + long={quantity_str})...")
                ok, self.entry_price = _place_limit_entry_and_wait(self, 'BUY', flip_qty)
                if ok and not closed_now_slow:
                    _send_discord_trade_alert(self, 'SHORT', old_entry_price, self.entry_price, short_qty, old_entry_time)
            else:
                if not _has_margin_for_entry_qty(self, quantity_str, current_price):
                    _notify_discord_failure(self, "execute_trade LONG", message="Margem insuficiente para abrir LONG (pré-entrada).")
                    return "no_retry"
                print(f"📤 Ordem LIMIT BUY (maker) para LONG qty={quantity_str}...")
                ok, self.entry_price = _place_limit_entry_and_wait(self, 'BUY', quantity_str)
            if not ok:
                # _place_limit_entry_and_wait já tem várias tentativas; repetir no loop só gera spam
                return "no_retry"
            time.sleep(1)
            get_current_position(self)
            if self.buyed_before_slow and closed_now_slow:
                self.buyed_before_slow = False
            elif not self.buyed_before_slow and closed_now_slow:
                self.buyed_before_slow = True
            print(f"🔧 Configurando SL/TP LIMIT para LONG...")
            if not place_sl_tp(self, 'long', self.entry_price):
                print("❌ SL/TP falhou após entrada — a fechar posição (sem ficar sem proteção).")
                _notify_discord_failure(
                    self, "execute_trade LONG",
                    message="place_sl_tp falhou após entrada LONG; fecho de emergência ao mercado.",
                )
                _close_position_market_emergency(self, "SL/TP falhou após entrada LONG")
                return "ok"
            self.buyed = True
            self.entry_time = datetime.now(timezone.utc)
            self.trade_direction = 'LONG'
            print(f"✅ LONG concluído (entrada + SL/TP em limit).")
            return "ok"
        except Exception as e:
            print(f"❌ Erro ao abrir LONG: {e}")
            import traceback
            traceback.print_exc()
            _report_error_to_discord(self, e, "execute_trade LONG")
            return "no_retry"

    elif signal == 'short':
        if self.position == 'short':
            _sync_state_if_position_matches_signal(self, 'short')
            return "ok"
        cancel_sl_tp(self)
        blocked = _block_if_account_busy_for_new_entry(self, "SHORT")
        if blocked:
            return blocked
        try:
            get_total_balance(self)
            ticker = self.client.futures_symbol_ticker(symbol=self.symbol_internal)
            current_price = float(ticker['price'])
            quantity = (self.quantity * self.leverage) / current_price
            quantity_str = adjust_quantity(self, quantity)
            if quantity_str is None:
                print("❌ Quantidade inválida ou saldo insuficiente.")
                _notify_discord_failure(self, "execute_trade SHORT", message="Quantidade inválida ou saldo insuficiente (pré-entrada).")
                return "no_retry"
            bal = getattr(self, '_last_available_balance', None)
            if bal is not None:
                print(f"💰 Margem disponível: {bal:.2f} | A usar (80%): {self.quantity:.2f} | qty(base): {quantity_str}")
            if self.position == 'long':
                # Flip único: SELL (long_qty + short_qty) fecha o long e abre o short atomicamente
                old_entry_price = getattr(self, 'entry_price', 0.0)
                old_entry_time  = getattr(self, 'entry_time', None)
                long_qty = get_position_quantity(self)
                if long_qty is None:
                    print("⚠️ Não foi possível obter quantidade da posição para flip.")
                    return "no_retry"
                flip_qty = adjust_quantity(self, float(long_qty) + float(quantity_str))
                if flip_qty is None:
                    _notify_discord_failure(self, "execute_trade SHORT", message="Flip qty inválida após ajuste de LOT_SIZE (pré-entrada).")
                    return "no_retry"
                if not _has_margin_for_entry_qty(self, flip_qty, current_price):
                    _notify_discord_failure(self, "execute_trade SHORT", message="Margem insuficiente para flip LONG→SHORT (pré-entrada).")
                    return "no_retry"
                if not self.buyed:
                    closed_now_slow = True
                print(f"📤 Ordem LIMIT SELL (flip LONG→SHORT) qty={flip_qty} (long={long_qty} + short={quantity_str})...")
                ok, self.entry_price = _place_limit_entry_and_wait(self, 'SELL', flip_qty)
                if ok and not closed_now_slow:
                    _send_discord_trade_alert(self, 'LONG', old_entry_price, self.entry_price, long_qty, old_entry_time)
            else:
                if not _has_margin_for_entry_qty(self, quantity_str, current_price):
                    _notify_discord_failure(self, "execute_trade SHORT", message="Margem insuficiente para abrir SHORT (pré-entrada).")
                    return "no_retry"
                print(f"📤 Ordem LIMIT SELL (maker) para SHORT qty={quantity_str}...")
                ok, self.entry_price = _place_limit_entry_and_wait(self, 'SELL', quantity_str)
            if not ok:
                return "no_retry"
            time.sleep(1)
            get_current_position(self)
            if self.buyed_before_slow and closed_now_slow:
                self.buyed_before_slow = False
            elif not self.buyed_before_slow and closed_now_slow:
                self.buyed_before_slow = True
            print(f"🔧 Configurando SL/TP LIMIT para SHORT...")
            if not place_sl_tp(self, 'short', self.entry_price):
                print("❌ SL/TP falhou após entrada — a fechar posição (sem ficar sem proteção).")
                _notify_discord_failure(
                    self, "execute_trade SHORT",
                    message="place_sl_tp falhou após entrada SHORT; fecho de emergência ao mercado.",
                )
                _close_position_market_emergency(self, "SL/TP falhou após entrada SHORT")
                return "ok"
            self.buyed = True
            self.entry_time = datetime.now(timezone.utc)
            self.trade_direction = 'SHORT'
            print(f"✅ SHORT concluído (entrada + SL/TP em limit).")
            return "ok"
        except Exception as e:
            print(f"❌ Erro ao abrir SHORT: {e}")
            import traceback
            traceback.print_exc()
            _report_error_to_discord(self, e, "execute_trade SHORT")
            return "no_retry"

    elif signal == 'sell':
        if self.position == 'long':
            position_qty = get_position_quantity(self)
            if position_qty is None:
                return
            if self.buyed_before_slow:
                return "change_slow"
            cancel_sl_tp(self)
            if _place_limit_close_and_wait(self, 'SELL', position_qty):
                _market_reduce_until_flat(self)
                get_current_position(self)
                if self.position is None:
                    _send_discord_trade_alert(self, 'LONG',
                        getattr(self, 'entry_price', 0.0),
                        getattr(self, '_last_close_price', 0.0),
                        position_qty,
                        getattr(self, 'entry_time', None))
                    self.buyed = False
                else:
                    print(
                        f"[AVISO] Após LIMIT+MARKET, a posição não ficou totalmente fechada ({getattr(self, 'symbol', '?')}); "
                        "verifica manualmente na exchange."
                    )
            else:
                # LIMIT não preenchida — verificar se posição ainda existe
                get_current_position(self)
                if self.position is not None:
                    print("[AVISO] LIMIT close falhou; a fechar ao mercado para não deixar posição sem proteção.")
                    _close_position_market_emergency(self, "sinal sell LONG: LIMIT close falhou em todas as tentativas")
                # Se position é None, o SL/TP já fechou a posição — check_sl_tp_hit tratará do estado no próximo ciclo
        elif self.position == 'short':
            position_qty = get_position_quantity(self)
            if position_qty is None:
                return
            if self.buyed_before_slow:
                return "change_slow"
            cancel_sl_tp(self)
            if _place_limit_close_and_wait(self, 'BUY', position_qty):
                _market_reduce_until_flat(self)
                get_current_position(self)
                if self.position is None:
                    _send_discord_trade_alert(self, 'SHORT',
                        getattr(self, 'entry_price', 0.0),
                        getattr(self, '_last_close_price', 0.0),
                        position_qty,
                        getattr(self, 'entry_time', None))
                    self.buyed = False
                else:
                    print(
                        f"[AVISO] Após LIMIT+MARKET, a posição não ficou totalmente fechada ({getattr(self, 'symbol', '?')}); "
                        "verifica manualmente na exchange."
                    )
            else:
                # LIMIT não preenchida — verificar se posição ainda existe
                get_current_position(self)
                if self.position is not None:
                    print("[AVISO] LIMIT close falhou; a fechar ao mercado para não deixar posição sem proteção.")
                    _close_position_market_emergency(self, "sinal sell SHORT: LIMIT close falhou em todas as tentativas")
                # Se position é None, o SL/TP já fechou a posição — check_sl_tp_hit tratará do estado no próximo ciclo
        else:
            print("No position to close.")
    
    return "ok"