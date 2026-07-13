-- 現行の zstd JSONL だけを残し、Parquet 互換層の schema を削除する。
DROP TABLE result_parquet_conversion_jobs;
ALTER TABLE query_history DROP COLUMN result_format;
ALTER TABLE query_history DROP COLUMN parquet_object_key;
ALTER TABLE query_history DROP COLUMN parquet_expires_at;
ALTER TABLE query_history DROP COLUMN parquet_encoding_version;
