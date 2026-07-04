-- Query Scheduling feature.
-- A `schedules` row runs a saved statement on a cron schedule; each firing
-- produces a `schedule_runs` row recording that run's outcome (one row per run,
-- even if the run retried internally). Both tables are owner-scoped like the
-- rest of the store. The statement is validated with Trino's
-- `EXPLAIN (TYPE VALIDATE)` at create/update and before every execution.
--
-- Dialect notes (must parse on both SQLite and PostgreSQL):
--   * TEXT primary keys are JS-generated ids (newId), never autoincrement.
--   * Timestamps are ISO 8601 strings in TEXT columns.
--   * Booleans and the retry policy are INTEGER (0/1 and small ints). The retry
--     backoff multiplier is an integer (contract: 1..10), so INTEGER is exact on
--     both dialects and avoids REAL/NUMERIC rounding differences.
--   * No FOREIGN KEY / ON DELETE CASCADE: cascade semantics and PRAGMA support
--     differ across dialects, so runs are deleted by the application layer when a
--     schedule is removed.

CREATE TABLE schedules (
  id                      TEXT PRIMARY KEY,
  owner                   TEXT NOT NULL,
  name                    TEXT NOT NULL,
  statement               TEXT NOT NULL,
  catalog                 TEXT,
  schema                  TEXT,
  cron                    TEXT NOT NULL,
  enabled                 INTEGER NOT NULL DEFAULT 1,
  retry_max_attempts      INTEGER NOT NULL DEFAULT 3,
  retry_backoff_seconds   INTEGER NOT NULL DEFAULT 60,
  retry_backoff_multiplier INTEGER NOT NULL DEFAULT 2,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE INDEX idx_schedules_owner ON schedules (owner);
CREATE INDEX idx_schedules_owner_updated_at ON schedules (owner, updated_at DESC);

CREATE TABLE schedule_runs (
  id             TEXT PRIMARY KEY,
  schedule_id    TEXT NOT NULL,
  owner          TEXT NOT NULL,
  -- 'running' | 'success' | 'failed' | 'aborted' | 'blocked'
  status         TEXT NOT NULL,
  -- Number of attempts actually made for this run.
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
