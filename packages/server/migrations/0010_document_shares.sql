-- 保存済みクエリとノートブックのユーザー間共有。
-- subject_type / subject_value で共有先 (user, group, role) を指定し、
-- permission で view または edit を付与する。

CREATE TABLE document_shares (
  id            TEXT PRIMARY KEY,
  document_type TEXT NOT NULL,
  document_id   TEXT NOT NULL,
  subject_type  TEXT NOT NULL,
  subject_value TEXT NOT NULL,
  permission    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (document_type, document_id, subject_type, subject_value)
);

CREATE INDEX document_shares_document_idx ON document_shares (document_type, document_id);
CREATE INDEX document_shares_subject_idx ON document_shares (subject_type, subject_value);
