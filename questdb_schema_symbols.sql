-- Schema mínimo QuestDB para backtest (OHLCV 1m, tape, mark/funding, OI,
-- snapshots de order book ~5s, liquidações). Colunas = o que ``store.py`` envia (ILP).
--
-- Livro: o ``store`` grava só métricas agregadas (best bid/ask, spread, profundidade ±1%).
-- Reconstruir L2 tick-a-tick = deltas em memória no simulador a partir destes snapshots.
--
-- Migração: ``DROP TABLE`` fact tables primeiro, ``symbols`` por último, depois corre este ficheiro.
-- Partições + ingest contínuo: nas versões recentes tabelas particionadas usam WAL por defeito;
-- podes acrescentar `` WAL`` antes do ``;`` em cada fact table se quiseres forçar (vê docs QuestDB).

CREATE TABLE IF NOT EXISTS symbols (
    created_at TIMESTAMP,
    symbol_id INT,
    code STRING
) timestamp(created_at) PARTITION BY MONTH;

CREATE TABLE IF NOT EXISTS candles_1m (
    local_ts TIMESTAMP,
    open DOUBLE,
    high DOUBLE,
    low DOUBLE,
    close DOUBLE,
    volume DOUBLE,
    exchange_ts TIMESTAMP,
    symbol_id INT
) timestamp(local_ts) PARTITION BY MONTH;

CREATE TABLE IF NOT EXISTS tick_trades (
    local_ts_ns TIMESTAMP,
    trade_id STRING,
    side SYMBOL,
    price DOUBLE,
    amount DOUBLE,
    exchange_ts TIMESTAMP,
    local_ts TIMESTAMP,
    stream_batch_index INT,
    symbol_id INT
) timestamp(local_ts_ns) PARTITION BY DAY;

CREATE TABLE IF NOT EXISTS mark_price_funding (
    local_ts TIMESTAMP,
    mark_price DOUBLE,
    funding_rate DOUBLE,
    index_price DOUBLE,
    next_funding_time TIMESTAMP,
    exchange_ts TIMESTAMP,
    symbol_id INT
) timestamp(local_ts) PARTITION BY DAY;

CREATE TABLE IF NOT EXISTS open_interest (
    local_ts TIMESTAMP,
    oi_amount DOUBLE,
    exchange_ts TIMESTAMP,
    symbol_id INT
) timestamp(local_ts) PARTITION BY DAY;

CREATE TABLE IF NOT EXISTS order_book (
    local_ts TIMESTAMP,
    best_bid DOUBLE,
    best_ask DOUBLE,
    spread DOUBLE,
    bid_depth_1pct DOUBLE,
    ask_depth_1pct DOUBLE,
    bid_levels INT,
    ask_levels INT,
    exchange_ts TIMESTAMP,
    symbol_id INT
) timestamp(local_ts) PARTITION BY DAY;

CREATE TABLE IF NOT EXISTS liquidations (
    local_ts TIMESTAMP,
    liquidation_id STRING,
    side SYMBOL,
    contracts DOUBLE,
    price DOUBLE,
    exchange_ts TIMESTAMP,
    symbol_id INT
) timestamp(local_ts) PARTITION BY DAY;

CREATE TABLE IF NOT EXISTS chart_features_1m (
    ts TIMESTAMP,
    symbol_id INT,
    liq_long DOUBLE,
    liq_short DOUBLE,
    tick_buy_vol DOUBLE,
    tick_sell_vol DOUBLE,
    oi_snap DOUBLE,
    mark_px DOUBLE,
    funding_rate DOUBLE,
    index_px DOUBLE,
    ob_spread_avg DOUBLE,
    ob_spread_count INT,
    ob_imb_snap DOUBLE
) timestamp(ts) PARTITION BY MONTH;
