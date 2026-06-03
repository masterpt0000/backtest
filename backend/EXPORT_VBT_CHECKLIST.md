# Checklist: exportar estratégia para `*_vbt.py` com custos reproduzíveis

Use este guia quando quiseres repetir offline (script Python / notebook) o mesmo backtest que validaste na UI ou no job FastAPI.

## 1. Congelar parâmetros

- Copiar `best_params` (e thresholds efectivos, se aplicável) da linha de resultado favorita no job concluído.
- Anotar os três campos globais de execução usados na corrida:
  - `exec_fee_pct_per_fill`
  - `exec_slippage_pct`
  - `exec_half_spread_pct`

Estes valores também aparecem por linha de resultado quando o backend os inclui na resposta.

## 2. Alinhar indicadores e sinais

- Colocar ou gerar um módulo em `my_strategies/` com `compute_indicators` e `compute_signals_vectorized` equivalentes ao que correste (vectorbt **ou** tradução manual se vieste do builder).
- Rever manualmente qualquer estratégia builder exportada como código: não há conversão JSON→Python fiável sem revisão humana.

## 3. Vectorbt — mesmo mapping que o job

No `Portfolio.from_signals`, reproduzir a mesma política que `monthly_scanner_vbt._vbt_exec_portfolio_kwargs`:

- `fees = exec_fee_pct_per_fill / 100` (só se positivo).
- `slippage = (exec_slippage_pct + exec_half_spread_pct) / 100` (só se positivo).

Manter slippage e meio-spread **separados** nos teus metadados/comentários para auditoria; fundir apenas ao chamar vectorbt.

## 4. Builder offline

Se repetires lógica OHLC tipo `run_builder_backtest`, usar as mesmas percentagens com:

- compra executável vs referência: `ref * (1 + adverse)`
- venda executável: `ref * (1 - adverse)`
- com `adverse = (exec_slippage_pct + exec_half_spread_pct) / 100`
- fee por fill sobre o notional da transição (ver implementação em `builder_vbt_engine.py`).

## 5. Sanity checks

- Baseline `exec_*` todos a zero deve bater com corridas antigas sem custos.
- Aumentar apenas `exec_fee_pct_per_fill` deve não aumentar o retorno esperado num exemplo com trades.
