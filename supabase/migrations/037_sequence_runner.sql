-- Phase 2a — sequence runner foundation.
--
-- The schema for email_sequences / sequence_steps / sequence_enrollments
-- has existed since mig 005 but nothing actually fires steps. Adding
-- the missing infrastructure: per-enrollment retry/error tracking +
-- a unique index that prevents duplicate enrollments + an index that
-- the cron job can hit cheaply to find due rows.

ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS last_processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_step_send_id UUID,
  ADD COLUMN IF NOT EXISTS last_error          TEXT,
  ADD COLUMN IF NOT EXISTS error_count         INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_type         TEXT,
  ADD COLUMN IF NOT EXISTS source_ref          TEXT;

COMMENT ON COLUMN sequence_enrollments.last_error IS
  'Most recent error from the runner. Cleared on successful step send. error_count auto-pauses the enrollment after N failures (5).';

CREATE UNIQUE INDEX IF NOT EXISTS sequence_enrollments_unique_active
  ON sequence_enrollments(sequence_id, contact_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS sequence_enrollments_due_idx
  ON sequence_enrollments(next_step_at)
  WHERE status = 'active' AND next_step_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS sequence_enrollments_status_idx
  ON sequence_enrollments(status);

COMMENT ON INDEX sequence_enrollments_unique_active IS
  'Stops a contact getting double-enrolled in the same sequence. Completed/exited/paused rows do not block re-enrolment.';
