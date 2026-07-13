-- query_history の JSONL 結果に対応する派生 Parquet 結果の参照と期限。
-- 既存の JSONL 参照を変更せず、各 artifact を独立して掃除できるようにする。
ALTER TABLE query_history ADD COLUMN parquet_object_key TEXT;
ALTER TABLE query_history ADD COLUMN parquet_expires_at TEXT;

DROP INDEX idx_query_history_retention;
CREATE INDEX idx_query_history_retention
  ON query_history (submitted_at, id)
  WHERE result_object_key IS NULL AND parquet_object_key IS NULL;

CREATE INDEX idx_query_history_parquet_expiry_cursor
  ON query_history (parquet_expires_at, id)
  WHERE parquet_object_key IS NOT NULL AND parquet_expires_at IS NOT NULL;

CREATE INDEX idx_query_history_parquet_object_key
  ON query_history (parquet_object_key)
  WHERE parquet_object_key IS NOT NULL;
