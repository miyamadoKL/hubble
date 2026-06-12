-- Initial schema (design.md §4).
-- Notebooks, saved queries and query history. Full payloads are stored as JSON
-- with a few extracted columns for search / filtering. Result rows are NOT
-- stored here (kept in server memory with TTL sweep).

CREATE TABLE notebooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Full Notebook (cells, variables, context) serialized as JSON.
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_notebooks_updated_at ON notebooks (updated_at DESC);
CREATE INDEX idx_notebooks_name ON notebooks (name);

CREATE TABLE saved_queries (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  statement   TEXT NOT NULL,
  catalog     TEXT,
  schema      TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_saved_queries_updated_at ON saved_queries (updated_at DESC);
CREATE INDEX idx_saved_queries_favorite ON saved_queries (is_favorite);
CREATE INDEX idx_saved_queries_name ON saved_queries (name);

CREATE TABLE query_history (
  id            TEXT PRIMARY KEY,
  -- First 2000 chars of the executed statement.
  statement     TEXT NOT NULL,
  catalog       TEXT,
  schema        TEXT,
  trino_query_id TEXT,
  state         TEXT NOT NULL,
  row_count     INTEGER NOT NULL DEFAULT 0,
  elapsed_ms    INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  notebook_id   TEXT,
  cell_id       TEXT,
  submitted_at  TEXT NOT NULL
);

CREATE INDEX idx_query_history_submitted_at ON query_history (submitted_at DESC);
CREATE INDEX idx_query_history_state ON query_history (state);
CREATE INDEX idx_query_history_notebook ON query_history (notebook_id);
