-- Phase 2: datasource_id on history and schedules.
-- Existing rows default to 'trino-default' (the legacy single-Trino deployment).

ALTER TABLE query_history ADD COLUMN datasource_id TEXT NOT NULL DEFAULT 'trino-default';
ALTER TABLE schedules ADD COLUMN datasource_id TEXT NOT NULL DEFAULT 'trino-default';

CREATE INDEX idx_query_history_datasource ON query_history (datasource_id);
CREATE INDEX idx_schedules_datasource ON schedules (datasource_id);