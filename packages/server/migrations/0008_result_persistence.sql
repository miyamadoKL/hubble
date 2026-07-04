-- Phase 8: persisted query result object references.

ALTER TABLE query_history ADD COLUMN result_object_key TEXT;
ALTER TABLE query_history ADD COLUMN result_expires_at TEXT;

CREATE INDEX idx_query_history_result_expires_at
  ON query_history (result_expires_at)
  WHERE result_object_key IS NOT NULL;
