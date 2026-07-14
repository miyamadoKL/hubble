-- 新規 database が現行仕様だけを持つための単一 baseline schema。
-- owner は application write の必須値であり、空文字を既定値にしない。

CREATE TABLE notebooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  owner       TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_notebooks_updated_at ON notebooks (updated_at DESC);
CREATE INDEX idx_notebooks_name ON notebooks (name);
CREATE INDEX idx_notebooks_owner ON notebooks (owner);

CREATE TABLE saved_queries (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  statement     TEXT NOT NULL,
  catalog       TEXT,
  schema        TEXT,
  is_favorite   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  owner         TEXT NOT NULL,
  datasource_id TEXT
);

CREATE INDEX idx_saved_queries_updated_at ON saved_queries (updated_at DESC);
CREATE INDEX idx_saved_queries_favorite ON saved_queries (is_favorite);
CREATE INDEX idx_saved_queries_name ON saved_queries (name);
CREATE INDEX idx_saved_queries_owner ON saved_queries (owner);

CREATE TABLE query_history (
  id             TEXT PRIMARY KEY,
  statement      TEXT NOT NULL,
  catalog        TEXT,
  schema         TEXT,
  trino_query_id TEXT,
  state          TEXT NOT NULL,
  row_count      INTEGER NOT NULL DEFAULT 0,
  elapsed_ms     INTEGER NOT NULL DEFAULT 0,
  error_message  TEXT,
  notebook_id    TEXT,
  cell_id        TEXT,
  submitted_at   TEXT NOT NULL,
  owner          TEXT NOT NULL,
  datasource_id  TEXT NOT NULL DEFAULT 'trino-default',
  result_object_key  TEXT,
  result_expires_at  TEXT,
  result_columns_json TEXT
);

CREATE INDEX idx_query_history_submitted_at ON query_history (submitted_at DESC);
CREATE INDEX idx_query_history_state ON query_history (state);
CREATE INDEX idx_query_history_notebook ON query_history (notebook_id);
CREATE INDEX idx_query_history_owner ON query_history (owner);
CREATE INDEX idx_query_history_datasource ON query_history (datasource_id);
CREATE INDEX idx_query_history_owner_submitted_id
  ON query_history (owner, submitted_at DESC, id DESC);
CREATE INDEX idx_query_history_owner_state_submitted_id
  ON query_history (owner, state, submitted_at DESC, id DESC);
CREATE INDEX idx_query_history_result_expires_at
  ON query_history (result_expires_at)
  WHERE result_object_key IS NOT NULL;
CREATE INDEX idx_query_history_result_expiry_cursor
  ON query_history (result_expires_at, id)
  WHERE result_object_key IS NOT NULL AND result_expires_at IS NOT NULL;
CREATE INDEX idx_query_history_result_object_key
  ON query_history (result_object_key)
  WHERE result_object_key IS NOT NULL;
CREATE INDEX idx_query_history_retention
  ON query_history (submitted_at, id)
  WHERE result_object_key IS NULL;

CREATE TABLE schedules (
  id                       TEXT PRIMARY KEY,
  owner                    TEXT NOT NULL,
  name                     TEXT NOT NULL,
  statement                TEXT NOT NULL,
  catalog                  TEXT,
  schema                   TEXT,
  cron                     TEXT NOT NULL,
  enabled                  INTEGER NOT NULL DEFAULT 1,
  retry_max_attempts       INTEGER NOT NULL DEFAULT 3,
  retry_backoff_seconds    INTEGER NOT NULL DEFAULT 60,
  retry_backoff_multiplier INTEGER NOT NULL DEFAULT 2,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  datasource_id            TEXT NOT NULL DEFAULT 'trino-default',
  principal_snapshot       TEXT,
  notifications            TEXT
);

CREATE INDEX idx_schedules_owner ON schedules (owner);
CREATE INDEX idx_schedules_owner_updated_at ON schedules (owner, updated_at DESC);
CREATE INDEX idx_schedules_datasource ON schedules (datasource_id);

CREATE TABLE schedule_runs (
  id             TEXT PRIMARY KEY,
  schedule_id    TEXT NOT NULL,
  owner          TEXT NOT NULL,
  status         TEXT NOT NULL,
  attempt        INTEGER NOT NULL DEFAULT 0,
  trino_query_id TEXT,
  error_type     TEXT,
  error_message  TEXT,
  row_count      INTEGER,
  elapsed_ms     INTEGER,
  scheduled_for  TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);

CREATE INDEX idx_schedule_runs_schedule_started ON schedule_runs (schedule_id, started_at DESC);
CREATE INDEX idx_schedule_runs_owner ON schedule_runs (owner);
CREATE UNIQUE INDEX idx_schedule_runs_one_running
  ON schedule_runs (schedule_id) WHERE status = 'running';
CREATE INDEX idx_schedule_runs_latest
  ON schedule_runs (schedule_id, started_at DESC, id DESC);

CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  datasource TEXT,
  detail     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_log_created_at_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_actor_created_at_idx ON audit_log (actor, created_at DESC);
CREATE INDEX audit_log_action_created_id_idx
  ON audit_log (action, created_at DESC, id DESC);
CREATE INDEX audit_log_datasource_created_id_idx
  ON audit_log (datasource, created_at DESC, id DESC)
  WHERE datasource IS NOT NULL;
CREATE INDEX audit_log_retention_idx ON audit_log (created_at, id);

CREATE TABLE document_shares (
  id            TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id   TEXT NOT NULL,
  subject_type  TEXT NOT NULL,
  subject_value TEXT NOT NULL,
  permission    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (document_type, document_id, subject_type, subject_value)
);

CREATE INDEX document_shares_document_idx ON document_shares (document_type, document_id);
CREATE INDEX document_shares_subject_idx ON document_shares (subject_type, subject_value);

CREATE TABLE workflows (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  stages              TEXT NOT NULL,
  datasource_id       TEXT NOT NULL,
  cron                TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  retry               TEXT NOT NULL,
  owner               TEXT NOT NULL,
  principal_snapshot  TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_workflows_owner ON workflows (owner);
CREATE INDEX idx_workflows_owner_updated_at ON workflows (owner, updated_at DESC);

CREATE TABLE workflow_runs (
  id             TEXT PRIMARY KEY,
  workflow_id    TEXT NOT NULL,
  owner          TEXT NOT NULL,
  status         TEXT NOT NULL,
  trigger        TEXT NOT NULL,
  scheduled_for  TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  elapsed_ms     INTEGER
);

CREATE INDEX idx_workflow_runs_workflow_started ON workflow_runs (workflow_id, started_at DESC);
CREATE INDEX idx_workflow_runs_owner ON workflow_runs (owner);
CREATE UNIQUE INDEX idx_workflow_runs_one_running
  ON workflow_runs (workflow_id) WHERE status = 'running';
CREATE INDEX idx_workflow_runs_latest
  ON workflow_runs (workflow_id, started_at DESC, id DESC);

CREATE TABLE workflow_step_runs (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  workflow_id         TEXT NOT NULL,
  step_id             TEXT NOT NULL,
  stage_index         INTEGER NOT NULL,
  name                TEXT NOT NULL,
  datasource_id       TEXT NOT NULL,
  status              TEXT NOT NULL,
  attempt             INTEGER NOT NULL DEFAULT 0,
  row_count           INTEGER,
  elapsed_ms          INTEGER,
  error_type          TEXT,
  error_message       TEXT,
  result_object_key   TEXT,
  result_expires_at   TEXT,
  started_at          TEXT,
  finished_at         TEXT
);

CREATE INDEX idx_workflow_step_runs_run_id ON workflow_step_runs (run_id);
CREATE INDEX idx_workflow_step_runs_result_expires ON workflow_step_runs (result_expires_at);
CREATE INDEX idx_workflow_step_runs_result_expiry_cursor
  ON workflow_step_runs (result_expires_at, id)
  WHERE result_object_key IS NOT NULL AND result_expires_at IS NOT NULL;
CREATE INDEX idx_workflow_step_runs_result_object_key
  ON workflow_step_runs (result_object_key)
  WHERE result_object_key IS NOT NULL;

CREATE TABLE github_connections (
  owner              TEXT PRIMARY KEY,
  github_login       TEXT NOT NULL,
  access_token_enc   TEXT NOT NULL,
  refresh_token_enc  TEXT,
  token_expires_at   TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE document_git_links (
  document_type       TEXT NOT NULL,
  document_id         TEXT NOT NULL,
  path                TEXT NOT NULL,
  branch              TEXT,
  pr_number           INTEGER,
  pr_url              TEXT,
  last_pushed_commit  TEXT,
  last_pushed_hash    TEXT,
  approved_hash       TEXT,
  approved_commit     TEXT,
  checked_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (document_type, document_id)
);

CREATE TABLE alerts (
  id                  TEXT PRIMARY KEY,
  owner               TEXT NOT NULL,
  name                TEXT NOT NULL,
  saved_query_id      TEXT NOT NULL,
  column_name         TEXT NOT NULL,
  op                  TEXT NOT NULL,
  value               TEXT NOT NULL,
  selector            TEXT NOT NULL,
  rearm               INTEGER NOT NULL DEFAULT 0,
  muted               INTEGER NOT NULL DEFAULT 0,
  cron                TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'unknown',
  last_triggered_at   TEXT,
  notifications       TEXT NOT NULL,
  principal_snapshot  TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_alerts_owner ON alerts (owner);
CREATE INDEX idx_alerts_owner_updated_at ON alerts (owner, updated_at DESC);

CREATE TABLE dashboards (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL,
  owner       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_dashboards_owner ON dashboards (owner);
CREATE INDEX idx_dashboards_owner_updated_at ON dashboards (owner, updated_at DESC);
CREATE INDEX idx_dashboards_updated_at ON dashboards (updated_at DESC);
CREATE INDEX idx_dashboards_name ON dashboards (name);

CREATE TABLE alert_deliveries (
  id                TEXT PRIMARY KEY,
  alert_id          TEXT NOT NULL,
  owner             TEXT NOT NULL,
  channel           TEXT NOT NULL,
  payload           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT NOT NULL,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_alert_deliveries_status_next_attempt_at
  ON alert_deliveries (status, next_attempt_at);
CREATE INDEX idx_alert_deliveries_alert_id ON alert_deliveries (alert_id);
CREATE INDEX idx_alert_deliveries_terminal_retention
  ON alert_deliveries (status, updated_at, id)
  WHERE status IN ('sent', 'dead');

CREATE TABLE result_object_deletions (
  object_key        TEXT PRIMARY KEY,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT NOT NULL,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_result_object_deletions_next_attempt_at
  ON result_object_deletions (next_attempt_at, object_key);
