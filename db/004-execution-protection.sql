ALTER TABLE order_intents
  ADD COLUMN stop_loss_price DECIMAL(36,12) NULL AFTER reduce_only,
  ADD COLUMN take_profit_price DECIMAL(36,12) NULL AFTER stop_loss_price;

CREATE TABLE IF NOT EXISTS market_funding_rates (
  inst_id VARCHAR(80) NOT NULL,
  funding_time DATETIME(3) NOT NULL,
  funding_rate DECIMAL(24,16) NULL,
  next_funding_time DATETIME(3) NULL,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  raw_json JSON NULL,
  PRIMARY KEY (inst_id, funding_time),
  KEY ix_funding_time (funding_time),
  CONSTRAINT fk_funding_instrument FOREIGN KEY (inst_id) REFERENCES instruments(inst_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS market_events (
  event_key VARCHAR(160) PRIMARY KEY,
  event_type ENUM('earnings','macro') NOT NULL,
  symbol VARCHAR(40) NULL,
  title VARCHAR(240) NOT NULL,
  event_time DATETIME(3) NOT NULL,
  impact VARCHAR(40) NULL,
  forecast_value VARCHAR(120) NULL,
  previous_value VARCHAR(120) NULL,
  source VARCHAR(80) NOT NULL,
  recv_ts DATETIME(3) NOT NULL,
  raw_json JSON NULL,
  KEY ix_market_event_time_type (event_time, event_type),
  KEY ix_market_event_symbol_time (symbol, event_time)
) ENGINE=InnoDB;
