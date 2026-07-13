-- Parquet 生成停止後も既存の列とテーブルは tombstone として残し、live 索引だけを JSONL 用へ戻す。
DROP INDEX idx_query_history_parquet_expiry_cursor;
DROP INDEX idx_query_history_parquet_object_key;
DROP INDEX idx_query_history_retention;

CREATE INDEX idx_query_history_retention
  ON query_history (submitted_at, id)
  WHERE result_object_key IS NULL;
