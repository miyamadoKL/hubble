-- Alert通知をチャネル単位で再試行するための配信outbox。
-- payloadはAlert削除後も配送できる自己完結したsnapshotを保持する。

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
