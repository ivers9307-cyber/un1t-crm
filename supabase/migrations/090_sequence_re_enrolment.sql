-- ============================================================
-- 090: sequence re-enrolment with cooldown
--
-- Tier 3C. Lets the same contact enter the same sequence again
-- after their previous enrolment has ended (completed/exited)
-- AT LEAST N days ago. NULL or 0 keeps the existing behaviour
-- (single-enrolment-per-contact).
--
-- Use case: a yearly anniversary sequence should re-fire each
-- year. Today the unique-active index in mig 037 prevents that
-- because there's no cooldown awareness.
--
-- Implementation: enrolContacts() and the trigger handlers gain
-- a cooldown check that consults the most recent terminal
-- enrolment for the (sequence, contact) pair.
-- ============================================================

BEGIN;

ALTER TABLE email_sequences
  ADD COLUMN IF NOT EXISTS re_enrolment_cooldown_days INT;

COMMENT ON COLUMN email_sequences.re_enrolment_cooldown_days IS
  'Mig 090: when set (>0), the same contact can be re-enrolled in this sequence after their previous enrolment ended (completed/exited) at least N days ago. NULL or 0 = single-enrolment-per-contact (default behaviour).';

COMMIT;
