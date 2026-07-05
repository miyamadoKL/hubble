-- Alert feature (threshold-based notifications on saved query results).
-- An `alerts` row references a saved query, evaluates it on a cron schedule,
-- compares a selected column value against a threshold, and sends notifications
-- on state transitions. Owner-scoped like schedules. Dialect notes match
-- migration 0003 (TEXT ids, ISO timestamps, INTEGER booleans, JSON in TEXT).

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
