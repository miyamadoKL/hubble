-- Query Workflow feature.
-- A `workflows` row defines ordered stages of SQL steps; each run produces
-- `workflow_runs` and per-step `workflow_step_runs` rows. Owner-scoped like
-- schedules. Dialect notes match migration 0003 (TEXT ids, ISO timestamps,
-- INTEGER booleans, no FK CASCADE — app-side cascade on delete).

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
