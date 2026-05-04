-- ============================================================
-- 089: sequence send-time window + day-of-week filtering
--
-- Tier 2B. Per-sequence delivery window so message steps don't
-- fire at 3am or on weekends if the operator doesn't want them
-- to. Computed in Europe/Dublin time (the studio's timezone).
--
-- send_window:
--   {
--     start_hour: 9,      // local hour, 0-23
--     end_hour: 17,       // local hour, exclusive
--     skip_days: [0, 6]   // 0=Sunday … 6=Saturday
--   }
--
-- Runner check: when computing next_step_at, if the result falls
-- outside the window OR on a skip day, push it forward to the
-- next acceptable slot. Wait + non-message steps (apply_tag,
-- update_field, internal_task) ignore the window — they're
-- silent operations.
-- ============================================================

BEGIN;

ALTER TABLE email_sequences
  ADD COLUMN IF NOT EXISTS send_window JSONB;

COMMENT ON COLUMN email_sequences.send_window IS
  'Optional delivery window in Europe/Dublin time (mig 089). Schema: { start_hour, end_hour, skip_days }. Runner pushes message-step next_step_at forward to the next acceptable slot. Non-message steps (apply_tag, update_field, internal_task) ignore.';

COMMIT;
