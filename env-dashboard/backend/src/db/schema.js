'use strict';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(64) UNIQUE NOT NULL,
  password_hash VARCHAR(120) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'analyst',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stations (
  id VARCHAR(16) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  elevation INTEGER,
  installed VARCHAR(20),
  meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id VARCHAR(64) PRIMARY KEY,
  station_id VARCHAR(16) NOT NULL,
  station_name VARCHAR(120),
  severity VARCHAR(16) NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  recommendation TEXT,
  factors JSONB,
  reading JSONB,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_station ON alerts(station_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);

CREATE TABLE IF NOT EXISTS reports (
  id VARCHAR(64) PRIMARY KEY,
  category VARCHAR(32) NOT NULL,
  title VARCHAR(200) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  format VARCHAR(8) NOT NULL DEFAULT 'json',
  params JSONB DEFAULT '{}'::jsonb,
  requested_by VARCHAR(64),
  file_path TEXT,
  file_size INTEGER,
  row_count INTEGER,
  summary JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reports_category ON reports(category);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

CREATE TABLE IF NOT EXISTS ml_runs (
  id VARCHAR(64) PRIMARY KEY,
  model_type VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  metrics JSONB,
  confusion_matrix JSONB,
  roc JSONB,
  feature_importance JSONB,
  drift JSONB,
  latency_ms JSONB,
  threshold JSONB,
  notes TEXT,
  requested_by VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_mlruns_started ON ml_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS readings (
  time TIMESTAMPTZ NOT NULL,
  station_id VARCHAR(16) NOT NULL,
  temperature DOUBLE PRECISION,
  pressure DOUBLE PRECISION,
  humidity DOUBLE PRECISION,
  aqi INTEGER,
  wind DOUBLE PRECISION,
  rainfall DOUBLE PRECISION,
  anomaly INTEGER
);
CREATE INDEX IF NOT EXISTS idx_readings_time ON readings(time DESC);
CREATE INDEX IF NOT EXISTS idx_readings_station ON readings(station_id, time DESC);

CREATE TABLE IF NOT EXISTS maintenance_records (
  id VARCHAR(64) PRIMARY KEY,
  station_id VARCHAR(16) NOT NULL,
  station_name VARCHAR(120),
  risk_score NUMERIC(5,2) NOT NULL,
  failure_probability NUMERIC(5,2),
  factors JSONB,
  recommendation TEXT,
  predicted_window VARCHAR(64),
  mtbf_hours NUMERIC(10,2),
  estimated_cost NUMERIC(10,2),
  downtime_hours NUMERIC(10,2) DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  model_type VARCHAR(32) DEFAULT 'HEURISTIC BASELINE',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mr_station ON maintenance_records(station_id);
CREATE INDEX IF NOT EXISTS idx_mr_recorded ON maintenance_records(recorded_at DESC);

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id BIGSERIAL PRIMARY KEY,
  station_id VARCHAR(16),
  parameter VARCHAR(32),
  issue_type VARCHAR(32) NOT NULL,
  severity VARCHAR(16) NOT NULL DEFAULT 'warning',
  detail TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dqi_detected ON data_quality_issues(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_dqi_station ON data_quality_issues(station_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor VARCHAR(64) NOT NULL,
  action VARCHAR(64) NOT NULL,
  resource VARCHAR(64) NOT NULL,
  resource_id VARCHAR(128),
  old_value JSONB,
  new_value JSONB,
  result VARCHAR(16) NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource, resource_id);

CREATE TABLE IF NOT EXISTS data_quality_snapshots (
  id BIGSERIAL PRIMARY KEY,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingestion_rate DOUBLE PRECISION,
  records_accepted INTEGER,
  records_rejected INTEGER,
  duplicates INTEGER,
  out_of_range INTEGER,
  missing INTEGER,
  latency_ms DOUBLE PRECISION,
  freshness_seconds DOUBLE PRECISION,
  completeness DOUBLE PRECISION,
  validity DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  overall_score DOUBLE PRECISION
);
`;

async function ensureSchema(pg) {
  await pg.query(SCHEMA);
}

module.exports = { ensureSchema, SCHEMA };
