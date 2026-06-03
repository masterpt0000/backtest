"""
Carrega estratégias para o chart a partir de ``my_strategies/``:

* ``*.json`` — objeto com ``id``, ``name``/``label``, ``indicators`` (ver doc em baixo).
* ``*.py`` — módulo opcional com ``get_chart_strategy_for_ui()`` → mesmo formato que o JSON
  (ex.: derivar defaults de ``get_strategy_parameters()``). Ficheiros sem essa função são ignorados.

Ignora nomes que começam por ``_``.
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path
from typing import Any

_STRATEGIES_DIR = Path(__file__).resolve().parent / "my_strategies"
_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_VALID_KINDS = frozenset({"ema", "bollinger", "rsi", "talib", "trend_composite"})
_VALID_GROUPS = frozenset({"overlays", "studies"})


def _strategy_dir() -> Path:
    return _STRATEGIES_DIR


def _validate_indicator(raw: Any, fname: str, idx: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"{fname}: indicators[{idx}] deve ser um objeto")
    ind_id = raw.get("id")
    if not isinstance(ind_id, str) or not _ID_RE.match(ind_id):
        raise ValueError(
            f"{fname}: indicators[{idx}].id inválido (usa a-z, números, _; começa com letra)"
        )
    label = raw.get("label")
    if label is None:
        label = raw.get("name")
    if not isinstance(label, str) or not label.strip():
        raise ValueError(f"{fname}: indicators[{idx}] precisa de label ou name")
    group = raw.get("group")
    if group not in _VALID_GROUPS:
        raise ValueError(
            f"{fname}: indicators[{idx}].group deve ser overlays ou studies"
        )
    kind = raw.get("kind")
    if kind not in _VALID_KINDS:
        raise ValueError(
            f"{fname}: indicators[{idx}].kind deve ser ema, bollinger, rsi, talib ou trend_composite"
        )
    params = raw.get("params")

    if kind == "trend_composite":
        if params is None or not isinstance(params, dict):
            raise ValueError(f"{fname}: indicators[{idx}].params.trendComposite obrigatório")
        tc = params.get("trendComposite") or params.get("trend_composite")
        if not isinstance(tc, dict) or not tc:
            raise ValueError(f"{fname}: indicators[{idx}].params.trendComposite obrigatório")
        out_tc: dict[str, Any] = {"trendComposite": tc}
        if isinstance(params.get("timeframe"), str) and params["timeframe"].strip():
            out_tc["timeframe"] = params["timeframe"].strip()
        if isinstance(params.get("source"), str) and params["source"].strip():
            out_tc["source"] = params["source"].strip()
        dlb = params.get("deltaLookbackBars")
        if isinstance(dlb, int) and dlb >= 0:
            out_tc["deltaLookbackBars"] = dlb
        if isinstance(params.get("deltaNormalizeByPrice"), bool):
            out_tc["deltaNormalizeByPrice"] = params["deltaNormalizeByPrice"]
        return {
            "id": ind_id,
            "label": label.strip(),
            "group": group,
            "kind": kind,
            "params": out_tc,
        }

    out_params: dict[str, Any] = {}
    if params is not None:
        if not isinstance(params, dict):
            raise ValueError(f"{fname}: indicators[{idx}].params deve ser objeto")
        if "period" in params:
            p = params["period"]
            if not isinstance(p, int) or p < 1:
                raise ValueError(f"{fname}: indicators[{idx}].params.period inválido")
            out_params["period"] = p
        if "mult" in params:
            m = params["mult"]
            if not isinstance(m, (int, float)) or float(m) <= 0:
                raise ValueError(f"{fname}: indicators[{idx}].params.mult inválido")
            out_params["mult"] = float(m)
        if kind == "talib":
            tf = params.get("talibFunction")
            if not isinstance(tf, str) or not tf.strip():
                raise ValueError(
                    f"{fname}: indicators[{idx}].params.talibFunction obrigatório para kind talib"
                )
            out_params["talibFunction"] = tf.strip()
            tpx = params.get("talibParams")
            if isinstance(tpx, dict):
                num: dict[str, float] = {}
                for pk, pv in tpx.items():
                    if isinstance(pk, str) and isinstance(pv, (int, float)):
                        num[pk] = float(pv)
                if num:
                    out_params["talibParams"] = num

    if kind == "bollinger":
        out_params.setdefault("period", 20)
        out_params.setdefault("mult", 2)
    elif kind == "ema" or kind == "rsi":
        out_params.setdefault("period", 14 if kind == "rsi" else 21)

    return {
        "id": ind_id,
        "label": label.strip(),
        "group": group,
        "kind": kind,
        "params": out_params,
    }


def _validate_strategy(raw: Any, fname: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"{fname}: raiz deve ser um objeto JSON")
    sid = raw.get("id")
    if not isinstance(sid, str) or not _ID_RE.match(sid):
        raise ValueError(f"{fname}: id inválido (usa a-z, números, _; começa com letra)")
    name = raw.get("name")
    label = raw.get("label")
    if name is not None and not isinstance(name, str):
        raise ValueError(f"{fname}: name deve ser string")
    if label is not None and not isinstance(label, str):
        raise ValueError(f"{fname}: label deve ser string")
    title = (label or name or "").strip()
    if not title:
        raise ValueError(f"{fname}: define name ou label para o nome no site")
    vbt = raw.get("vbt_strategy")
    if vbt is not None and (not isinstance(vbt, str) or not vbt.strip()):
        raise ValueError(f"{fname}: vbt_strategy, se presente, deve ser string não vazia")
    is_builder = bool(raw.get("isBuilderStrategy")) or bool(raw.get("is_builder_strategy"))
    builder_spec: dict[str, Any] | None = None
    raw_bs = raw.get("builderSpec")
    if raw_bs is None:
        raw_bs = raw.get("builder_spec")
    if isinstance(raw_bs, dict):
        builder_spec = raw_bs

    inds = raw.get("indicators")
    if inds is None:
        inds = []
    if not isinstance(inds, list):
        raise ValueError(f"{fname}: indicators deve ser lista")

    # Estratégia do construtor: permitir apenas ``builderSpec.indicators`` quando a raíz não lista indicadores.
    if is_builder and len(inds) == 0 and builder_spec is not None:
        bs_inds = builder_spec.get("indicators")
        if isinstance(bs_inds, list) and bs_inds:
            inds = bs_inds

    if is_builder and (not isinstance(inds, list) or len(inds) == 0):
        raise ValueError(
            f"{fname}: isBuilderStrategy precisa de ``indicators`` na raíz ou dentro de builderSpec",
        )

    indicators = [_validate_indicator(x, fname, i) for i, x in enumerate(inds)]
    out: dict[str, Any] = {
        "id": sid,
        "label": title,
        "indicators": indicators,
    }
    if isinstance(vbt, str) and vbt.strip():
        out["vbt_strategy"] = vbt.strip()
    if is_builder:
        if not isinstance(builder_spec, dict):
            raise ValueError(
                f"{fname}: builderSpec obrigatório (objecto) quando isBuilderStrategy é true",
            )
        out["isBuilderStrategy"] = True
        out["builderSpec"] = builder_spec
    return out


def _load_python_chart_strategy(path: Path) -> dict[str, Any] | None:
    """Importa ``path`` e chama ``get_chart_strategy_for_ui()`` se existir."""
    mod_name = f"_chart_strat_{path.stem}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise ValueError("spec do módulo inválido")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fn = getattr(mod, "get_chart_strategy_for_ui", None)
    if not callable(fn):
        return None
    raw = fn()
    if not isinstance(raw, dict):
        raise ValueError("get_chart_strategy_for_ui() deve devolver um dict")
    return _validate_strategy(raw, path.name)


def load_strategies_from_disk() -> tuple[list[dict[str, Any]], list[str]]:
    """
    Lê ``*.json`` e ``*.py`` (com ``get_chart_strategy_for_ui``) em ``my_strategies/``.
    """
    strategies: list[dict[str, Any]] = []
    errors: list[str] = []
    d = _strategy_dir()
    if not d.is_dir():
        return strategies, [f"pasta inexistente: {d} (cria my_strategies/)"]

    candidates = [
        p
        for p in d.iterdir()
        if not p.name.startswith("_") and p.suffix in (".json", ".py")
    ]
    candidates.sort(key=lambda p: p.name.lower())

    seen_ids: set[str] = set()
    for path in candidates:
        try:
            if path.suffix == ".json":
                raw = json.loads(path.read_text(encoding="utf-8"))
                strat = _validate_strategy(raw, path.name)
            else:
                strat = _load_python_chart_strategy(path)
                if strat is None:
                    continue
            if strat["id"] in seen_ids:
                errors.append(f"{path.name}: id duplicado {strat['id']!r}")
                continue
            seen_ids.add(strat["id"])
            strategies.append(strat)
        except (json.JSONDecodeError, ValueError, OSError) as e:
            errors.append(f"{path.name}: {e}")
        except Exception as e:  # noqa: BLE001 — módulos user podem falhar ao importar
            errors.append(f"{path.name}: {e}")

    return strategies, errors
