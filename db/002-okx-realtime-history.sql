USE aster_quant_v2;

-- 最新行情快照用于服务重启恢复；逐笔、K 线和盘口保留历史事实。
CREATE TABLE IF NOT EXISTS market_ticker_snapshots (
  inst_id VARCHAR(80) PRIMARY KEY,
  last_price DECIMAL(36,12) NULL,
  bid_price DECIMAL(36,12) NULL,
  ask_price DECIMAL(36,12) NULL,
  bid_size DECIMAL(36,12) NOT NULL DEFAULT 0,
  ask_size DECIMAL(36,12) NOT NULL DEFAULT 0,
  volume_24h DECIMAL(36,12) NOT NULL DEFAULT 0,
  change_24h DECIMAL(18,8) NULL,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  sequence_no BIGINT NULL,
  raw_json JSON NOT NULL,
  KEY ix_ticker_recv (recv_ts)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS market_trades (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  inst_id VARCHAR(80) NOT NULL,
  trade_id VARCHAR(100) NOT NULL,
  price DECIMAL(36,12) NOT NULL,
  size DECIMAL(36,12) NOT NULL,
  side ENUM('buy','sell','unknown') NOT NULL DEFAULT 'unknown',
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  raw_json JSON NOT NULL,
  UNIQUE KEY uq_market_trade (inst_id, trade_id),
  KEY ix_market_trade_time (inst_id, source_ts)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exchange_account_snapshots (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  exchange_account_id VARCHAR(40) NOT NULL,
  equity DECIMAL(36,12) NOT NULL DEFAULT 0,
  available DECIMAL(36,12) NOT NULL DEFAULT 0,
  daily_pnl DECIMAL(36,12) NOT NULL DEFAULT 0,
  source VARCHAR(40) NOT NULL,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  raw_json JSON NOT NULL,
  KEY ix_account_snapshot_time (exchange_account_id, recv_ts),
  CONSTRAINT fk_snapshot_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_snapshot_account FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exchange_orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  exchange_account_id VARCHAR(40) NOT NULL,
  exchange_order_id VARCHAR(100) NOT NULL,
  client_order_id VARCHAR(100) NULL,
  inst_id VARCHAR(80) NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  position_side VARCHAR(16) NOT NULL DEFAULT 'net',
  order_type VARCHAR(32) NOT NULL,
  state VARCHAR(32) NOT NULL,
  price DECIMAL(36,12) NULL,
  size DECIMAL(36,12) NOT NULL DEFAULT 0,
  filled_size DECIMAL(36,12) NOT NULL DEFAULT 0,
  avg_fill_price DECIMAL(36,12) NULL,
  last_fill_price DECIMAL(36,12) NULL,
  last_fill_size DECIMAL(36,12) NOT NULL DEFAULT 0,
  fee DECIMAL(36,12) NOT NULL DEFAULT 0,
  fee_currency VARCHAR(20) NULL,
  pnl DECIMAL(36,12) NOT NULL DEFAULT 0,
  reduce_only BOOLEAN NOT NULL DEFAULT FALSE,
  source VARCHAR(40) NOT NULL,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  raw_json JSON NOT NULL,
  UNIQUE KEY uq_exchange_order (exchange_account_id, exchange_order_id),
  KEY ix_exchange_order_time (tenant_id, source_ts),
  CONSTRAINT fk_exchange_order_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_exchange_order_account FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exchange_fills (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  exchange_account_id VARCHAR(40) NOT NULL,
  exchange_order_id VARCHAR(100) NOT NULL,
  client_order_id VARCHAR(100) NULL,
  trade_id VARCHAR(100) NOT NULL,
  inst_id VARCHAR(80) NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  size DECIMAL(36,12) NOT NULL,
  price DECIMAL(36,12) NOT NULL,
  fee DECIMAL(36,12) NOT NULL DEFAULT 0,
  fee_currency VARCHAR(20) NULL,
  pnl DECIMAL(36,12) NOT NULL DEFAULT 0,
  source VARCHAR(40) NOT NULL,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  raw_json JSON NOT NULL,
  UNIQUE KEY uq_exchange_fill (exchange_account_id, trade_id),
  KEY ix_exchange_fill_time (tenant_id, source_ts),
  CONSTRAINT fk_exchange_fill_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_exchange_fill_account FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exchange_positions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  exchange_account_id VARCHAR(40) NOT NULL,
  inst_id VARCHAR(80) NOT NULL,
  position_side VARCHAR(16) NOT NULL DEFAULT 'net',
  side ENUM('long','short','flat') NOT NULL DEFAULT 'flat',
  quantity DECIMAL(36,12) NOT NULL DEFAULT 0,
  available_quantity DECIMAL(36,12) NOT NULL DEFAULT 0,
  avg_entry_price DECIMAL(36,12) NULL,
  mark_price DECIMAL(36,12) NULL,
  unrealized_pnl DECIMAL(36,12) NOT NULL DEFAULT 0,
  realized_pnl DECIMAL(36,12) NOT NULL DEFAULT 0,
  margin DECIMAL(36,12) NOT NULL DEFAULT 0,
  notional_usd DECIMAL(36,12) NOT NULL DEFAULT 0,
  leverage DECIMAL(18,8) NULL,
  liquidation_price DECIMAL(36,12) NULL,
  source VARCHAR(40) NOT NULL,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  raw_json JSON NOT NULL,
  UNIQUE KEY uq_exchange_position (exchange_account_id, inst_id, position_side),
  KEY ix_exchange_position_tenant (tenant_id, inst_id),
  CONSTRAINT fk_exchange_position_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_exchange_position_account FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id)
) ENGINE=InnoDB;
