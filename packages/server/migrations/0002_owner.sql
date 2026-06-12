-- v1.1 auth (design.md §11): owner scoping.
-- Add an `owner` column to every user-owned table. Existing rows default to the
-- empty string here (migrations are static SQL and cannot read TRINO_USER); a
-- startup backfill (src/db/backfill.ts) rewrites empty owners to the configured
-- principal. An empty owner is treated as "legacy / unowned" and is visible in
-- `none` mode for backward compatibility.

ALTER TABLE notebooks      ADD COLUMN owner TEXT NOT NULL DEFAULT '';
ALTER TABLE saved_queries  ADD COLUMN owner TEXT NOT NULL DEFAULT '';
ALTER TABLE query_history  ADD COLUMN owner TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_notebooks_owner      ON notebooks (owner);
CREATE INDEX idx_saved_queries_owner  ON saved_queries (owner);
CREATE INDEX idx_query_history_owner  ON query_history (owner);
