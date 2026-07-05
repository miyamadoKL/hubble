-- GitHub 連携: OAuth 接続情報とドキュメントの Git リンク。

CREATE TABLE github_connections (
  owner              TEXT PRIMARY KEY,
  github_login       TEXT NOT NULL,
  access_token_enc   TEXT NOT NULL,
  refresh_token_enc  TEXT,
  token_expires_at   TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE document_git_links (
  document_type       TEXT NOT NULL,
  document_id         TEXT NOT NULL,
  path                TEXT NOT NULL,
  branch              TEXT,
  pr_number           INTEGER,
  pr_url              TEXT,
  last_pushed_commit  TEXT,
  last_pushed_hash    TEXT,
  approved_hash       TEXT,
  approved_commit     TEXT,
  checked_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (document_type, document_id)
);
