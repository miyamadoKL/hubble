-- Phase 6: structured audit log for user and scheduled operations.

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
