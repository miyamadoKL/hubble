-- Phase 4: datasource_id on saved_queries (optional; NULL = unspecified).

ALTER TABLE saved_queries ADD COLUMN datasource_id TEXT;