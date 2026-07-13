-- 完了済み JSONL から派生 Parquet を作る durable conversion job。
-- status に running を置かず、単一 replica の worker が pending 行を直列処理する。

ALTER TABLE query_history ADD COLUMN parquet_encoding_version TEXT;

CREATE TABLE result_parquet_conversion_jobs (
  history_id         TEXT PRIMARY KEY,
  source_object_key  TEXT NOT NULL,
  target_object_key  TEXT NOT NULL UNIQUE,
  encoding_version   TEXT NOT NULL,
  status             TEXT NOT NULL,
  attempts           INTEGER NOT NULL,
  next_attempt_at    TEXT NOT NULL,
  last_error_code    TEXT,
  last_error         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_result_parquet_conversion_jobs_due
  ON result_parquet_conversion_jobs (status, next_attempt_at, history_id);
