-- ============================================================
-- 088: sequence goal tracking
--
-- Tier 1C of the sequences expansion. Lets operators define a
-- "goal" on a sequence — when the contact hits the goal, their
-- enrolment auto-exits with status='completed' so they don't get
-- the day-3 follow-up after they've already converted.
--
-- email_sequences.goal_config (JSONB) shape:
--   { type: 'tag_added', tag: 'race_completed' }
--   { type: 'lead_status', value: 'member' }
--   { type: 'booking_made', event_type_id?: 'uuid-or-null' }
--
-- Runner checks the goal at the START of every step processing
-- pass: if met, mark enrolment exited (NOT completed — distinct
-- terminal state so reporting can distinguish "ran the whole
-- thing" from "exited early due to goal").
--
-- sequence_enrollments.exit_reason already exists for this kind
-- of thing — re-used.
-- ============================================================

BEGIN;

ALTER TABLE email_sequences
  ADD COLUMN IF NOT EXISTS goal_config JSONB;

COMMENT ON COLUMN email_sequences.goal_config IS
  'Optional goal that auto-exits an enrolment when met (mig 088). Schema: { type, ...args }. type values: tag_added (args: tag), lead_status (args: value), booking_made (args: event_type_id?). NULL = no goal, run all steps.';

-- Test-mode metadata bag for accelerated test enrolments. Operator
-- "Send test" button stamps { test: true, accelerated_delay_seconds: 60 }
-- so the runner shrinks delays without changing the configured step
-- gaps for real enrolments.
ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN sequence_enrollments.metadata IS
  'Free-form metadata. Mig 088: { test: true, accelerated_delay_seconds: 60 } marks test enrolments so the runner accelerates step delays.';

COMMIT;
