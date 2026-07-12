-- Workflow の run 削除で参照を失う ResultStore object を確実に削除するための outbox。
-- object_key を主キーにして、同じ object の削除予定を冪等に登録する。

CREATE TABLE result_object_deletions (
  object_key        TEXT PRIMARY KEY,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT NOT NULL,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_result_object_deletions_next_attempt_at
  ON result_object_deletions (next_attempt_at, object_key);
