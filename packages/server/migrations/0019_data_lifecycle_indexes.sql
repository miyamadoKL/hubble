-- 保持期限のページ削除、所有者別一覧、監査検索、期限切れ結果のカーソル走査に使う索引。
-- SQLite と PostgreSQL の双方で同じ検索順を使えるよう、同順位を id で安定化する。

CREATE INDEX idx_query_history_owner_submitted_id
  ON query_history (owner, submitted_at DESC, id DESC);

CREATE INDEX idx_query_history_owner_state_submitted_id
  ON query_history (owner, state, submitted_at DESC, id DESC);

CREATE INDEX idx_query_history_retention
  ON query_history (submitted_at, id)
  WHERE result_object_key IS NULL;

CREATE INDEX idx_query_history_result_expiry_cursor
  ON query_history (result_expires_at, id)
  WHERE result_object_key IS NOT NULL AND result_expires_at IS NOT NULL;

CREATE INDEX idx_query_history_result_object_key
  ON query_history (result_object_key)
  WHERE result_object_key IS NOT NULL;

CREATE INDEX idx_alert_deliveries_terminal_retention
  ON alert_deliveries (status, updated_at, id)
  WHERE status IN ('sent', 'dead');

CREATE INDEX audit_log_action_created_id_idx
  ON audit_log (action, created_at DESC, id DESC);

CREATE INDEX audit_log_datasource_created_id_idx
  ON audit_log (datasource, created_at DESC, id DESC)
  WHERE datasource IS NOT NULL;

CREATE INDEX audit_log_retention_idx
  ON audit_log (created_at, id);

CREATE INDEX idx_schedule_runs_latest
  ON schedule_runs (schedule_id, started_at DESC, id DESC);

CREATE INDEX idx_workflow_runs_latest
  ON workflow_runs (workflow_id, started_at DESC, id DESC);

CREATE INDEX idx_workflow_step_runs_result_expiry_cursor
  ON workflow_step_runs (result_expires_at, id)
  WHERE result_object_key IS NOT NULL AND result_expires_at IS NOT NULL;

CREATE INDEX idx_workflow_step_runs_result_object_key
  ON workflow_step_runs (result_object_key)
  WHERE result_object_key IS NOT NULL;
