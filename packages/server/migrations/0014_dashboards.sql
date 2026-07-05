-- Dashboard feature (query/chart panels on a grid layout).
-- Full Dashboard (widgets) is stored as JSON in `data`; `name` / `description`
-- are extracted for search. Owner-scoped like notebooks. `document_shares` kind
-- `dashboard` is supported. Dialect notes match migration 0001/0002 (TEXT ids,
-- ISO timestamps, no FK CASCADE — app-side cascade on delete).

CREATE TABLE dashboards (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL,
  owner       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_dashboards_owner ON dashboards (owner);
CREATE INDEX idx_dashboards_owner_updated_at ON dashboards (owner, updated_at DESC);
CREATE INDEX idx_dashboards_updated_at ON dashboards (updated_at DESC);
CREATE INDEX idx_dashboards_name ON dashboards (name);
