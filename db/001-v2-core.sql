-- V2 初始事实模型。所有时间使用 UTC，所有租户/账户数据显式隔离。
CREATE TABLE IF NOT EXISTS tenants (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  email VARCHAR(190) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  role ENUM('admin','risk_admin','researcher','trader','approver','auditor') NOT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_user_tenant_email (tenant_id, email),
  KEY ix_user_tenant_role (tenant_id, role),
  CONSTRAINT fk_user_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id BIGINT UNSIGNED PRIMARY KEY,
  username VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_credential_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exchange_accounts (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  exchange VARCHAR(24) NOT NULL DEFAULT 'OKX',
  environment ENUM('live','demo') NOT NULL,
  credential_cipher MEDIUMTEXT NOT NULL,
  status ENUM('pending','connected','degraded','disabled') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_account_owner (tenant_id, owner_user_id, status),
  CONSTRAINT fk_account_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_account_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS instruments (
  inst_id VARCHAR(80) PRIMARY KEY,
  inst_type VARCHAR(24) NOT NULL,
  asset_class ENUM('equity','index','fx','metal','commodity','unknown') NOT NULL DEFAULT 'unknown',
  underlying VARCHAR(80) NOT NULL,
  contract_size DECIMAL(36,12) NOT NULL,
  quote_ccy VARCHAR(16) NOT NULL,
  settle_ccy VARCHAR(16) NULL,
  tick_size DECIMAL(36,12) NOT NULL,
  lot_size DECIMAL(36,12) NOT NULL,
  trading_hours JSON NOT NULL,
  state ENUM('live','halted','expired','unknown') NOT NULL DEFAULT 'unknown',
  source_channel VARCHAR(64) NOT NULL DEFAULT 'instruments',
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  raw_json JSON NOT NULL,
  schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  KEY ix_instrument_class_state (asset_class, state)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ai_research_jobs (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(40) NOT NULL,
  status ENUM('queued','running','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
  current_stage VARCHAR(40) NOT NULL,
  progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
  request_json JSON NOT NULL,
  candidate_id VARCHAR(40) NULL,
  failure_reason VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  KEY ix_ai_job_tenant_time (tenant_id, created_at),
  KEY ix_ai_job_status (status, created_at),
  CONSTRAINT fk_ai_job_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_ai_job_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ai_research_events (
  id VARCHAR(40) PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  tenant_id BIGINT UNSIGNED NOT NULL,
  stage VARCHAR(40) NULL,
  message VARCHAR(500) NOT NULL,
  details_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY ix_ai_event_job_time (job_id, created_at),
  CONSTRAINT fk_ai_event_job FOREIGN KEY (job_id) REFERENCES ai_research_jobs(id),
  CONSTRAINT fk_ai_event_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS strategy_candidates (
  id VARCHAR(40) PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  tenant_id BIGINT UNSIGNED NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('research_only','validation_pending','paper_eligible','live_eligible','rejected','retired') NOT NULL DEFAULT 'research_only',
  spec_json JSON NOT NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME(3) NULL,
  rejected_by BIGINT UNSIGNED NULL,
  rejected_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_candidate_version (job_id, version_no),
  KEY ix_candidate_tenant_status (tenant_id, status, created_at),
  CONSTRAINT fk_candidate_job FOREIGN KEY (job_id) REFERENCES ai_research_jobs(id),
  CONSTRAINT fk_candidate_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_candidate_user FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_candidate_approver FOREIGN KEY (approved_by) REFERENCES users(id),
  CONSTRAINT fk_candidate_rejecter FOREIGN KEY (rejected_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS research_evidence (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  job_id VARCHAR(40) NOT NULL,
  tenant_id BIGINT UNSIGNED NOT NULL,
  evidence_type ENUM('data_quality','backtest','walk_forward','stress','execution_cost','limitation') NOT NULL,
  source_channel VARCHAR(80) NOT NULL,
  source_ref VARCHAR(160) NULL,
  metrics_json JSON NOT NULL,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  raw_json JSON NULL,
  KEY ix_evidence_job_type (job_id, evidence_type),
  CONSTRAINT fk_evidence_job FOREIGN KEY (job_id) REFERENCES ai_research_jobs(id),
  CONSTRAINT fk_evidence_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS strategy_approvals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  candidate_id VARCHAR(40) NOT NULL,
  tenant_id BIGINT UNSIGNED NOT NULL,
  requested_by BIGINT UNSIGNED NOT NULL,
  approved_by BIGINT UNSIGNED NULL,
  target_mode ENUM('paper','live') NOT NULL,
  status ENUM('pending','approved','rejected','revoked') NOT NULL DEFAULT 'pending',
  reason VARCHAR(1000) NULL,
  created_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3) NULL,
  KEY ix_approval_candidate_status (candidate_id, status),
  CONSTRAINT fk_approval_candidate FOREIGN KEY (candidate_id) REFERENCES strategy_candidates(id),
  CONSTRAINT fk_approval_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_approval_requester FOREIGN KEY (requested_by) REFERENCES users(id),
  CONSTRAINT fk_approval_approver FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_intents (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  exchange_account_id VARCHAR(40) NOT NULL,
  requested_by BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(80) NOT NULL,
  inst_id VARCHAR(80) NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  order_type ENUM('limit','market','stop_limit','stop_market') NOT NULL,
  size DECIMAL(36,12) NOT NULL,
  price DECIMAL(36,12) NULL,
  reduce_only BOOLEAN NOT NULL DEFAULT FALSE,
  stop_loss_price DECIMAL(36,12) NULL,
  take_profit_price DECIMAL(36,12) NULL,
  risk_snapshot_json JSON NOT NULL,
  status ENUM('risk_pending','risk_rejected','outbox_pending','sent','confirmed','partially_filled','filled','cancel_pending','cancelled','unknown') NOT NULL DEFAULT 'risk_pending',
  exchange_order_id VARCHAR(80) NULL,
  filled_size DECIMAL(36,12) NOT NULL DEFAULT 0,
  avg_fill_price DECIMAL(36,12) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_order_intent_idem (exchange_account_id, idempotency_key),
  KEY ix_order_intent_tenant_time (tenant_id, created_at),
  CONSTRAINT fk_intent_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_intent_account FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id),
  CONSTRAINT fk_intent_user FOREIGN KEY (requested_by) REFERENCES users(id),
  CONSTRAINT fk_intent_instrument FOREIGN KEY (inst_id) REFERENCES instruments(inst_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_outbox (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  intent_id VARCHAR(40) NOT NULL,
  tenant_id BIGINT UNSIGNED NOT NULL,
  event_type ENUM('submit','cancel','amend') NOT NULL,
  payload_json JSON NOT NULL,
  status ENUM('pending','sending','sent','confirmed','failed','dead_letter') NOT NULL DEFAULT 'pending',
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL,
  last_error VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY ix_outbox_pending (status, next_attempt_at),
  CONSTRAINT fk_outbox_intent FOREIGN KEY (intent_id) REFERENCES order_intents(id),
  CONSTRAINT fk_outbox_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- 行情、运行、成交和复盘事实表。raw_json 保留 OKX 原始事件，便于断线补偿和重算。
CREATE TABLE IF NOT EXISTS market_ticks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,
  inst_id VARCHAR(80) NOT NULL,
  price DECIMAL(36,12) NOT NULL,
  size DECIMAL(36,12) NOT NULL,
  side ENUM('buy','sell','unknown') NOT NULL DEFAULT 'unknown',
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  sequence_no BIGINT UNSIGNED NULL,
  raw_json JSON NOT NULL,
  schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  KEY ix_tick_inst_time (inst_id, source_ts),
  KEY ix_tick_tenant_time (tenant_id, recv_ts),
  CONSTRAINT fk_tick_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS market_candles (
  inst_id VARCHAR(80) NOT NULL,
  timeframe VARCHAR(12) NOT NULL,
  open_time DATETIME(3) NOT NULL,
  open_price DECIMAL(36,12) NOT NULL,
  high_price DECIMAL(36,12) NOT NULL,
  low_price DECIMAL(36,12) NOT NULL,
  close_price DECIMAL(36,12) NOT NULL,
  volume DECIMAL(36,12) NOT NULL,
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  raw_json JSON NOT NULL,
  schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (inst_id, timeframe, open_time),
  KEY ix_candle_time (timeframe, open_time)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS market_orderbook_snapshots (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  inst_id VARCHAR(80) NOT NULL,
  bids_json JSON NOT NULL,
  asks_json JSON NOT NULL,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  sequence_no BIGINT UNSIGNED NULL,
  gap_detected BOOLEAN NOT NULL DEFAULT FALSE,
  raw_json JSON NOT NULL,
  KEY ix_book_inst_time (inst_id, recv_ts)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS strategy_runs (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  strategy_candidate_id VARCHAR(40) NULL,
  run_type ENUM('backtest','paper','live') NOT NULL,
  inst_id VARCHAR(80) NOT NULL,
  timeframe VARCHAR(12) NOT NULL,
  status ENUM('queued','running','completed','failed','stopped') NOT NULL DEFAULT 'queued',
  progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
  metrics_json JSON NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  KEY ix_run_tenant_time (tenant_id, created_at),
  CONSTRAINT fk_run_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_run_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS fills (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  order_intent_id VARCHAR(40) NOT NULL,
  exchange_order_id VARCHAR(80) NULL,
  inst_id VARCHAR(80) NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  size DECIMAL(36,12) NOT NULL,
  price DECIMAL(36,12) NOT NULL,
  fee DECIMAL(36,12) NOT NULL DEFAULT 0,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  raw_json JSON NOT NULL,
  KEY ix_fill_tenant_time (tenant_id, recv_ts),
  CONSTRAINT fk_fill_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_fill_order FOREIGN KEY (order_intent_id) REFERENCES order_intents(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS positions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  exchange_account_id VARCHAR(40) NOT NULL,
  inst_id VARCHAR(80) NOT NULL,
  side ENUM('long','short','flat') NOT NULL DEFAULT 'flat',
  quantity DECIMAL(36,12) NOT NULL DEFAULT 0,
  avg_entry_price DECIMAL(36,12) NULL,
  mark_price DECIMAL(36,12) NULL,
  unrealized_pnl DECIMAL(36,12) NOT NULL DEFAULT 0,
  margin DECIMAL(36,12) NOT NULL DEFAULT 0,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  raw_json JSON NOT NULL,
  UNIQUE KEY uq_position_account_inst (exchange_account_id, inst_id),
  CONSTRAINT fk_position_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_position_account FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS risk_snapshots (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  exchange_account_id VARCHAR(40) NOT NULL,
  state ENUM('normal','caution','restricted','halted') NOT NULL,
  equity DECIMAL(36,12) NOT NULL,
  available DECIMAL(36,12) NOT NULL,
  daily_pnl DECIMAL(36,12) NOT NULL,
  drawdown_pct DECIMAL(18,8) NOT NULL,
  limits_json JSON NOT NULL,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  KEY ix_risk_account_time (exchange_account_id, recv_ts),
  CONSTRAINT fk_risk_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_risk_account FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trade_reviews (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  order_intent_id VARCHAR(40) NOT NULL,
  strategy_candidate_id VARCHAR(40) NULL,
  entry_json JSON NOT NULL,
  exit_json JSON NULL,
  execution_json JSON NOT NULL,
  risk_json JSON NOT NULL,
  attribution_json JSON NOT NULL,
  pnl DECIMAL(36,12) NULL,
  mfe DECIMAL(18,8) NULL,
  mae DECIMAL(18,8) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY ix_trade_review_tenant_time (tenant_id, created_at),
  CONSTRAINT fk_trade_review_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_trade_review_order FOREIGN KEY (order_intent_id) REFERENCES order_intents(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS daily_reviews (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  review_date DATE NOT NULL,
  summary_json JSON NOT NULL,
  attribution_json JSON NOT NULL,
  incidents_json JSON NOT NULL,
  next_actions_json JSON NOT NULL,
  generated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_daily_review_tenant_date (tenant_id, review_date),
  CONSTRAINT fk_daily_review_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  detail_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY ix_audit_tenant_time (tenant_id, created_at),
  CONSTRAINT fk_audit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_audit_user FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB;
