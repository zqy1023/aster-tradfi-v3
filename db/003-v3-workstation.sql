-- V3 trader workstation model. Run inside the configured aster_quant database.
CREATE TABLE IF NOT EXISTS strategy_definitions (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  style ENUM('trend_pullback','atr_breakout','vwap_reversion','portfolio_guard','other') NOT NULL,
  asset_class ENUM('equity','index','fx','metal','commodity','unknown') NOT NULL DEFAULT 'equity',
  primary_timeframe VARCHAR(12) NOT NULL,
  confirmation_timeframe VARCHAR(12) NOT NULL,
  hypothesis VARCHAR(1200) NOT NULL,
  status ENUM('research_only','validation_pending','paper_eligible','live_eligible','retired') NOT NULL DEFAULT 'research_only',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_strategy_tenant_status (tenant_id, status, updated_at),
  CONSTRAINT fk_v3_strategy_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_v3_strategy_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS strategy_versions (
  id VARCHAR(40) PRIMARY KEY,
  strategy_id VARCHAR(40) NOT NULL,
  tenant_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  entry_rules_json JSON NOT NULL,
  exit_rules_json JSON NOT NULL,
  sizing_json JSON NOT NULL,
  filters_json JSON NOT NULL,
  invalidation_json JSON NOT NULL,
  validation_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_strategy_version (strategy_id, version_no),
  KEY ix_strategy_version_tenant (tenant_id, created_at),
  CONSTRAINT fk_v3_strategy_version_strategy FOREIGN KEY (strategy_id) REFERENCES strategy_definitions(id),
  CONSTRAINT fk_v3_strategy_version_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS strategy_signals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  strategy_id VARCHAR(40) NULL,
  inst_id VARCHAR(80) NOT NULL,
  timeframe VARCHAR(12) NOT NULL,
  direction ENUM('long','short','neutral') NOT NULL DEFAULT 'neutral',
  status ENUM('watch','ready','blocked','expired') NOT NULL,
  score TINYINT UNSIGNED NOT NULL DEFAULT 0,
  trigger_distance_pct DECIMAL(18,8) NULL,
  evidence_json JSON NOT NULL,
  blocker_json JSON NOT NULL,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL,
  KEY ix_signal_tenant_inst_time (tenant_id, inst_id, recv_ts),
  KEY ix_signal_status (tenant_id, status, recv_ts),
  CONSTRAINT fk_v3_signal_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_v3_signal_strategy FOREIGN KEY (strategy_id) REFERENCES strategy_definitions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trade_plans (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  exchange_account_id VARCHAR(40) NULL,
  inst_id VARCHAR(80) NOT NULL,
  direction ENUM('long','short','neutral') NOT NULL,
  state ENUM('draft','watching','executable','blocked','invalidated','linked_to_order','closed') NOT NULL DEFAULT 'draft',
  entry_zone_json JSON NOT NULL,
  stop_json JSON NOT NULL,
  targets_json JSON NOT NULL,
  sizing_json JSON NOT NULL,
  invalidation_json JSON NOT NULL,
  evidence_json JSON NOT NULL,
  arbitration_json JSON NOT NULL,
  linked_order_intent_id VARCHAR(40) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_plan_tenant_state (tenant_id, state, updated_at),
  KEY ix_plan_inst (tenant_id, inst_id, updated_at),
  CONSTRAINT fk_v3_plan_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_v3_plan_account FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id),
  CONSTRAINT fk_v3_plan_user FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_v3_plan_order FOREIGN KEY (linked_order_intent_id) REFERENCES order_intents(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS review_reports (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  report_type ENUM('single_trade','daily','weekly','monthly') NOT NULL,
  subject_ref VARCHAR(120) NOT NULL,
  period_start DATETIME(3) NULL,
  period_end DATETIME(3) NULL,
  reconciliation_state ENUM('waiting_fills','exchange_facts_loaded','bill_matched','mismatch') NOT NULL DEFAULT 'waiting_fills',
  summary_json JSON NOT NULL,
  attribution_json JSON NOT NULL,
  execution_quality_json JSON NOT NULL,
  behavior_json JSON NOT NULL,
  chart_marks_json JSON NOT NULL,
  generated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_review_tenant_type_time (tenant_id, report_type, generated_at),
  CONSTRAINT fk_v3_review_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS risk_events (
  id VARCHAR(40) PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  exchange_account_id VARCHAR(40) NULL,
  event_type ENUM('daily_loss','drawdown','correlation','spread','stale_data','system','manual') NOT NULL,
  severity ENUM('info','warn','block','halt') NOT NULL,
  title VARCHAR(180) NOT NULL,
  detail VARCHAR(1000) NOT NULL,
  source_ts DATETIME(3) NULL,
  recv_ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  raw_json JSON NULL,
  KEY ix_risk_event_tenant_time (tenant_id, recv_ts),
  KEY ix_risk_event_severity (tenant_id, severity, recv_ts),
  CONSTRAINT fk_v3_risk_event_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_v3_risk_event_account FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id)
) ENGINE=InnoDB;
