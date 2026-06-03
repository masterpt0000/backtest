import json
import os
import requests
from datetime import datetime
from typing import Optional

DISCORD_WEBHOOKS = {
    "trader_trend_lateral_rsi_3min": "https://discordapp.com/api/webhooks/1489527936716640401/PaZObWmxIYCadv6FK-eioFa-hrNfWN1llOT5OvztjP0ZWHuFoGB-CCpYaL_5QNFUZiG7",
    "trader_trend_strong_3min":      "https://discordapp.com/api/webhooks/1489546355121852426/89Mm0KYcF-riJH5eEch3RglIDCfrqRcmHlGdQgufSm9vz7rABg-2kbyaiHQhz37Bipp6",
    "trader_trend_extreme_30min":    "https://discordapp.com/api/webhooks/1489546202314969099/4sN0OuBf4tnF4zvKrzkBCCREkryiIIZIEEAgOnlMSaGEILck6dadyGdzH-zPAMzXtvkV",
    "trader_trend_fast_15min":       "https://discordapp.com/api/webhooks/1489546306668990545/yjO-nOMuOMCZSOaWHHH-mY1t1Y8DV8tu1wSXlDiRl1MgWipD4jmcgHLOV9_mCwkEKEba",
    "monthly_scanner":               "https://discordapp.com/api/webhooks/1490394680100388884/iDpmSaa-PeujkhCphmJCxXqcGLCtSNCKlvUTZ0942-JnI_ZeKMFkyg4PP3bS6ajOYffv",
    "Errors":                        "https://discord.com/api/webhooks/1490692273833250887/zNDr79Y94Oy9TYXoZgBIvXthR5k-BXOOtsa5E2tSJ96I8XdGII7t1hX6tqnI_WFKr-XG",
}

def get_discord_errors_webhook_url() -> str:
    """Só o webhook da chave \"Errors\" em DISCORD_WEBHOOKS."""
    return (DISCORD_WEBHOOKS.get("Errors") or "").strip()


def install_discord_exception_hooks(bot_name: str, pair: str) -> None:
    """
    Garante que excepções não capturadas (thread principal e threads) enviam alerta
    para o webhook \"Errors\". Preserva o comportamento por omissão (print stderr).
    """
    import sys
    import threading
    import traceback

    _old_sys = sys.excepthook

    def _sys_excepthook(exc_type, exc, tb):
        if exc is not None:
            try:
                send_bot_error(
                    bot_name,
                    pair,
                    context="sys.excepthook (excepção não capturada no thread principal)",
                    exception=exc,
                    traceback_text=''.join(traceback.format_exception(exc_type, exc, tb)),
                )
            except Exception:
                pass
        _old_sys(exc_type, exc, tb)

    sys.excepthook = _sys_excepthook

    if hasattr(threading, 'excepthook'):
        _old_th = threading.excepthook

        def _thread_excepthook(args):
            try:
                e = getattr(args, 'exc_value', None)
                if e is not None:
                    tb_txt = ''
                    if args.exc_traceback is not None:
                        tb_txt = ''.join(traceback.format_exception(
                            args.exc_type, args.exc_value, args.exc_traceback,
                        ))
                    send_bot_error(
                        bot_name,
                        pair,
                        context="threading.excepthook (excepção numa thread)",
                        exception=e,
                        traceback_text=tb_txt,
                    )
            except Exception:
                pass
            _old_th(args)

        threading.excepthook = _thread_excepthook


def get_discord_webhook(strategy_name):
    return DISCORD_WEBHOOKS.get(strategy_name, "https://discordapp.com/api/webhooks/1489527936716640401/PaZObWmxIYCadv6FK-eioFa-hrNfWN1llOT5OvztjP0ZWHuFoGB-CCpYaL_5QNFUZiG7")

# Acumuladores diários por bot — persistidos em ficheiro JSON
_STATS_FILE = os.path.join(os.path.dirname(__file__), "daily_stats.json")
_daily_stats: dict = {}


def _load_stats():
    global _daily_stats
    try:
        if os.path.exists(_STATS_FILE):
            with open(_STATS_FILE, "r", encoding="utf-8") as f:
                _daily_stats = json.load(f)
    except Exception as e:
        print(f"[Discord] Erro ao carregar daily_stats.json: {e}")
        _daily_stats = {}


def _save_stats():
    try:
        # Remover entradas anteriores a hoje
        today_str = datetime.now().strftime("%Y-%m-%d")
        keys_to_delete = [
            key for key in list(_daily_stats.keys())
            if key.split(":")[-1] < today_str
        ]
        for key in keys_to_delete:
            del _daily_stats[key]

        with open(_STATS_FILE, "w", encoding="utf-8") as f:
            json.dump(_daily_stats, f, indent=2)
    except Exception as e:
        print(f"[Discord] Erro ao guardar daily_stats.json: {e}")


def _get_daily_stats(bot_name: str, date: str):
    key = f"{bot_name}:{date}"
    if key not in _daily_stats:
        _daily_stats[key] = {"profit": 0.0, "wins": 0, "losses": 0}
    return _daily_stats[key]


# Carregar ao importar o módulo
_load_stats()

def send_trade_result(
    bot_name: str,
    pair: str,
    direction: str,        # "LONG" ou "SHORT"
    entry_price: float,
    exit_price: float,
    entry_time: datetime,
    exit_time: datetime,
    quantity: float,
    fees: float,
    profit_usdt: float,
    profit_pct: float,
    exit_reason: str = "Sinal",   # "TP", "SL", "Sinal"
    sl_price: float = None,
    tp_price: float = None,
):
    # Atualiza stats do dia e persiste
    today = exit_time.strftime("%Y-%m-%d")
    stats = _get_daily_stats(bot_name, today)
    stats["profit"] += profit_usdt
    if profit_usdt >= 0:
        stats["wins"] += 1
    else:
        stats["losses"] += 1
    _save_stats()

    total_trades = stats["wins"] + stats["losses"]
    win_rate = (stats["wins"] / total_trades * 100) if total_trades > 0 else 0

    duration = exit_time - entry_time
    hours, remainder = divmod(int(duration.total_seconds()), 3600)
    minutes = remainder // 60

    emoji = "🟢" if profit_usdt >= 0 else "🔴"
    direction_emoji = "📈" if direction == "LONG" else "📉"

    exit_reason_emoji = {
        "TP": "🎯 TP atingido",
        "SL": "🛑 SL atingido",
        "Sinal": "📡 Sinal de saída"
    }.get(exit_reason, exit_reason)

    fields = [
        {"name": "🤖 Bot",         "value": bot_name,                                                    "inline": True},
        {"name": "📊 Par",          "value": pair,                                                        "inline": True},
        {"name": f"{direction_emoji} Direção", "value": direction,                                        "inline": True},
        {"name": "🔵 Entrada",      "value": f"`{entry_price:.4f}` às `{entry_time.strftime('%H:%M:%S')}`", "inline": True},
        {"name": "⚪ Saída",        "value": f"`{exit_price:.4f}` às `{exit_time.strftime('%H:%M:%S')}`",   "inline": True},
        {"name": "⏱️ Duração",     "value": f"`{hours}h {minutes}m`",                                    "inline": True},
        {"name": "💰 Lucro",        "value": f"`{profit_usdt:+.4f} USDT` (`{profit_pct:+.2f}%`)",        "inline": True},
        {"name": "💸 Fees",         "value": f"`{fees:.4f} USDT`",                                        "inline": True},
        {"name": "📦 Quantidade",   "value": f"`{quantity}` contratos",                                   "inline": True},
        {"name": "🚪 Saída por",    "value": exit_reason_emoji,                                           "inline": True},
    ]

    if sl_price and tp_price:
        fields.append({"name": "📏 SL / TP", "value": f"`{sl_price:.4f}` / `{tp_price:.4f}`", "inline": True})

    # Stats do dia
    day_emoji = "🟢" if stats["profit"] >= 0 else "🔴"
    fields.append({
        "name": "📅 Dia",
        "value": f"{day_emoji} `{stats['profit']:+.4f} USDT` | {stats['wins']}W / {stats['losses']}L (`{win_rate:.0f}%`)",
        "inline": False
    })

    message = {
        "embeds": [{
            "title": f"{emoji} Trade Fechada — {pair}",
            "color": 3066993 if profit_usdt >= 0 else 15158332,
            "fields": fields,
            "footer": {"text": f"Trading Bot • {exit_time.strftime('%Y-%m-%d %H:%M:%S')}"}
        }]
    }

    try:
        response = requests.post(get_discord_webhook(bot_name), json=message)
        if response.status_code != 204:
            print(f"[Discord] Erro ao enviar alerta: {response.status_code}")
            send_bot_error(
                bot_name,
                pair,
                context="send_trade_result (HTTP)",
                message=f"Falha ao enviar embed de trade: HTTP {response.status_code}",
            )
    except Exception as e:
        print(f"[Discord] Exceção: {e}")
        import traceback
        send_bot_error(
            bot_name,
            pair,
            context="send_trade_result",
            exception=e,
            traceback_text=traceback.format_exc(),
        )


def send_bot_error(
    bot_name: str,
    pair: str,
    *,
    context: str = "",
    exception: Optional[BaseException] = None,
    traceback_text: str = "",
    message: str = "",
):
    """
    Alerta genérico de falha (exceção ou mensagem). Usa apenas get_discord_errors_webhook_url().
    Não propaga exceções. Stack truncada (limite por campo do Discord).
    """
    if not message and exception is None:
        message = "Erro sem detalhe."
    if exception is not None:
        detail = f"`{type(exception).__name__}` — {str(exception)}"
    else:
        detail = message
    if len(detail) > 1024:
        detail = detail[:1021] + "..."

    tb = traceback_text.strip() if traceback_text else ""
    if len(tb) > 900:
        tb = tb[:897] + "..."

    fields = [
        {"name": "🤖 Bot", "value": f"`{bot_name}`", "inline": True},
        {"name": "📊 Par", "value": f"`{pair}`", "inline": True},
    ]
    if context:
        ctx = context[:900] + ("..." if len(context) > 900 else "")
        fields.append({"name": "📍 Contexto", "value": f"`{ctx}`", "inline": False})
    fields.append({"name": "❌ Detalhe", "value": detail, "inline": False})
    if tb:
        stack_val = f"```{tb}```"
        if len(stack_val) > 1024:
            stack_val = f"```{tb[:980]}...```"
        fields.append({"name": "📎 Stack", "value": stack_val, "inline": False})

    payload = {
        "embeds": [{
            "title": "⚠️ Erro no bot",
            "description": "Ocorreu uma exceção ou falha durante a execução.",
            "color": 15158332,
            "fields": fields,
            "footer": {"text": f"Trading Bot • {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"},
        }]
    }
    url = get_discord_errors_webhook_url()
    if not url:
        print(
            '[Discord] Alerta de erro não enviado: falta URL na chave "Errors" em DISCORD_WEBHOOKS.'
        )
        return
    try:
        r = requests.post(url, json=payload, timeout=15)
        if r.status_code != 204:
            print(f"[Discord] Erro ao enviar alerta de erro: {r.status_code}")
    except Exception as ex:
        print(f"[Discord] Falha ao enviar send_bot_error: {ex}")