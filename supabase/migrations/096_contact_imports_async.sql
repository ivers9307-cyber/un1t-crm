-- ============================================================
-- 096: Contact import — async background commit
--
-- Big imports (> 1k rows) used to run inline in the request and
-- could time out on Vercel (10/60/300s tier-dependent). v2 lifts
-- that cap to 50k by enqueueing the work into the existing
-- contact_imports table and letting a pg_cron worker drain it.
--
-- Schema changes:
--   - status CHECK is widened to include 'pending' + 'processing'
--   - payload JSONB is added (the queued job's mapping + rows +
--     resolutions + batchTags). Cleared once the job completes
--     so we're not holding the full CSV in the DB forever.
--   - started_processing_at lets the cron detect stuck jobs
--     (longer than 5 min in 'processing' = something went wrong,
--     reset to 'pending' on the next pass)
--
-- The cron worker lives at /api/cron/process-contact-imports and
-- is called by pg_cron every minute via the standard
-- private.app_config.cron_secret bearer auth pattern.
-- ============================================================

BEGIN;

ALTER TABLE contact_imports
  DROP CONSTRAINT IF EXISTS contact_imports_status_check;
ALTER TABLE contact_imports
  ADD CONSTRAINT contact_imports_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'rolling_back', 'rolled_back', 'failed'));

ALTER TABLE contact_imports
  ADD COLUMN IF NOT EXISTS payload JSONB,
  ADD COLUMN IF NOT EXISTS started_processing_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Cron worker grabs jobs in this order. Partial index so we don't
-- carry the index weight for completed batches (the bulk of the
-- table over time).
CREATE INDEX IF NOT EXISTS idx_contact_imports_pending_oldest
  ON contact_imports (created_at ASC)
  WHERE status = 'pending';

COMMENT ON COLUMN contact_imports.payload IS
  'Mig 096: the queued job — { mapping, rows, batch_tag, resolutions }. Populated when status=pending; cleared once the worker completes the import (cuts long-term storage cost).';
COMMENT ON COLUMN contact_imports.started_processing_at IS
  'Mig 096: stamped when the cron worker picks the job up. A row stuck in processing > 5 min is considered crashed and reset to pending on the next pass.';

COMMIT;
