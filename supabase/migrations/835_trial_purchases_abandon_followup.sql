-- 835 — TRIALABANDON.1: the abandoned-checkout follow-up stamp on trial_purchases.
--
-- APPLY BEFORE THE CODE DEPLOYS. The abandoned checkout sweep
-- (src/lib/trial-checkout-abandoned.js, an arm of the */2 cron
-- /api/cron/process-trial-purchases) selects and writes both columns; without
-- them its first read fails, so it enrols nobody and never stamps its
-- heartbeat (nothing else on the cron is affected).
--
-- WHY: most /trial buyers who start the €39 checkout never pay, and nothing
-- followed them up. The sweep offers each abandoned row of the last 72 hours,
-- once, to the studio's active paid_trial_checkout_abandoned sequences. The
-- stamp is the sweep's cursor: every judged row gets it whatever the answer,
-- so a row is read as a candidate once and never again.
--
--   abandon_followup_at       when the sweep judged this row. NULL = not yet.
--   abandon_followup_outcome  what it decided: enrolled | not_enrolled |
--     no_active_sequence | purchased | staff_handling | recent_followup |
--     active_member | had_trial | no_contact. 'enrolled' inside 14 days is
--     what stops a second follow-up of the same person at the same studio.
--
-- Separate columns, not keys inside the "grant" or attribution jsonb: both of
-- those are written whole by other paths (the grant worker, the checkout
-- route), so a read-modify-write of either from the sweep could lose a
-- concurrent write.
--
-- Existing rows stay NULL. Only rows of the last 72 hours are ever judged, so
-- nothing older than that is followed up at first deploy, and with no active
-- sequence anywhere those are stamped no_active_sequence on the first tick.
--
-- No grant change: no new table, view, sequence or function. trial_purchases
-- stays service-role only (mig 762: RLS on, no policy, no client privilege),
-- and a new column on it inherits that.

ALTER TABLE public.trial_purchases
  ADD COLUMN IF NOT EXISTS abandon_followup_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS abandon_followup_outcome text NULL;

COMMENT ON COLUMN public.trial_purchases.abandon_followup_at IS
  'TRIALABANDON.1 (mig 835): when the abandoned checkout sweep (src/lib/trial-checkout-abandoned.js) judged this row for the paid_trial_checkout_abandoned follow-up. NULL = not judged. Written once, whatever the outcome.';
COMMENT ON COLUMN public.trial_purchases.abandon_followup_outcome IS
  'TRIALABANDON.1 (mig 835): what the abandoned checkout sweep decided for this row: enrolled | not_enrolled | no_active_sequence | purchased | staff_handling | recent_followup | active_member | had_trial | no_contact.';

-- Self-check (POST-state): both columns exist, nullable, with the right types.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'trial_purchases' AND c.is_nullable = 'YES'
     AND ((c.column_name = 'abandon_followup_at' AND c.data_type = 'timestamp with time zone')
       OR (c.column_name = 'abandon_followup_outcome' AND c.data_type = 'text'));
  IF n <> 2 THEN
    RAISE EXCEPTION 'mig 835: trial_purchases.abandon_followup_at / abandon_followup_outcome did not end up as nullable timestamptz + text; nothing was applied';
  END IF;
END $$;
