-- GLOFOX2.2 — daily bulk-sync cron audit table.
--
-- Each cron tick produces one row per (location, started_at). Tracks:
--   - When the run started + finished (duration on the report)
--   - How many leads were processed across all pages
--   - Per-action summary (create / update / ambiguous / invalid / error)
--   - First error message if any (for at-a-glance debugging)
--   - Filter that was used (so we know the lookback window applied)
--
-- The cron also stamps cron_heartbeat (existing infrastructure) so
-- the dashboard heartbeat tile still surfaces "last successful run".
-- This table is for the richer per-run drilldown.

CREATE TABLE IF NOT EXISTS glofox_sync_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   UUID REFERENCES locations(id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  duration_ms   INT,
  pages_fetched INT DEFAULT 0,
  leads_processed INT DEFAULT 0,
  total_available INT,                         -- as reported by Glofox total_count
  filter_used   JSONB,                         -- what UserFilters body was sent
  summary       JSONB,                         -- { create, update, ambiguous, invalid, error }
  first_error   TEXT,                          -- first per-lead error message (debug aid)
  status        TEXT NOT NULL DEFAULT 'running' -- running / completed / failed
);

CREATE INDEX IF NOT EXISTS idx_glofox_sync_runs_location ON glofox_sync_runs (location_id);
CREATE INDEX IF NOT EXISTS idx_glofox_sync_runs_started_at ON glofox_sync_runs (started_at DESC);

ALTER TABLE glofox_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY glofox_sync_runs_select ON glofox_sync_runs
  FOR SELECT USING (
    location_id IN (
      SELECT location_id FROM profile_locations WHERE profile_id = auth.uid()
    )
  );
