-- PIPELINE5.6 — audit table for the nightly pipeline-reclassify cron.
--
-- Mirror of glofox_sync_runs (mig 141): one row per cron tick (or
-- per manual one-shot backfill via the admin UI). Captures what
-- the classifier moved so the operator can:
--   - Spot a sudden mass-shift (a threshold change misfiring)
--   - Investigate "why did this deal end up in lapsed?" by
--     looking at the most-recent run that touched the contact
--   - Watch the at-risk → lapsed → dormant funnel over time
--
-- The 'samples' JSONB carries the first ~25 moves for each run
-- so the operator can spot-check without joining to deals/audit.

CREATE TABLE IF NOT EXISTS pipeline_classification_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     UUID REFERENCES locations(id),
  -- 'cron' (nightly tick), 'manual' (admin button), 'backfill'
  -- (one-shot post-migration sweep). All share the same orchestrator.
  source          TEXT NOT NULL CHECK (source IN ('cron', 'manual', 'backfill')),
  -- Whether this was a dry-run preview (no UPDATEs) or a real run.
  dry_run         BOOLEAN NOT NULL DEFAULT false,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  duration_ms     INT,
  -- Counts.
  contacts_seen   INT NOT NULL DEFAULT 0,
  deals_moved     INT NOT NULL DEFAULT 0,
  deals_unchanged INT NOT NULL DEFAULT 0,
  deals_created   INT NOT NULL DEFAULT 0,  -- contacts with no open deal got a fresh one
  errors          INT NOT NULL DEFAULT 0,
  -- Per-stage delta — { from_slug→{to_slug→count} } so the operator
  -- can see "200 contacts moved from trial_active → dormant" at a
  -- glance.
  movement_matrix JSONB,
  -- First 25 moves for spot-checking.
  samples         JSONB,
  -- Cause of failure for the cron tick itself (NOT per-contact).
  error_message   TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'success', 'partial', 'failed')),
  created_by      UUID REFERENCES profiles(id) ON DELETE SET NULL  -- null for cron
);

CREATE INDEX IF NOT EXISTS idx_pipeline_classification_runs_started
  ON pipeline_classification_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_classification_runs_location
  ON pipeline_classification_runs (location_id, started_at DESC);

ALTER TABLE pipeline_classification_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY pipeline_classification_runs_select ON pipeline_classification_runs
  FOR SELECT USING (
    location_id IN (
      SELECT location_id FROM profile_locations WHERE profile_id = auth.uid()
    )
  );
