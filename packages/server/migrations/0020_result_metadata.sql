-- 結果オブジェクトの列情報と形式を履歴行へ保存する。
ALTER TABLE query_history ADD COLUMN result_columns_json TEXT;
ALTER TABLE query_history ADD COLUMN result_format TEXT;
