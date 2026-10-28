-- 783 — FEES.2: class_fees.waive_rule, the automatic forgiveness rule that
-- waived a fee.
--
-- WHY. Richard, 28 Oct 2026: some offences are forgiven automatically, each
-- rule switchable per studio (locations.settings.un1t_online.fees.forgiveness):
--   swap           a late cancel followed within minutes by a booking into
--                  another class (a move, not an offence; on by default)
--   spot_refilled  someone else booked the freed spot (off by default)
--   new_member     the member's first 14 days at the studio, or on a trial
--                  (on by default)
--   first_offence  the first offence in a rolling 60 days (on by default)
--   monthly_cap    past the studio's monthly fee cap per member (off)
-- The fee is still written (status 'waived', waived_at set, waived_by NULL)
-- so staff see what was forgiven and why; waive_rule names the rule. A staff
-- waiver leaves it NULL.
--
-- GRANTS. class_fees stays service role only (mig 781); a new column on a
-- table with no client privilege needs no grant decision.
--   -- column-grant: n/a, class_fees has no client privilege (mig 781).
--
-- LOCKS. One transaction, 5s lock_timeout; class_fees is new and tiny.
--
-- ORDER. Apply BEFORE the FEES.2 code deploys: until then an auto-waived row
-- names a column that does not exist and the night's insert fails whole
-- (the run logs and retries the next night; nothing is charged in between,
-- because a failed insert leaves no pending row).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.class_fees ADD COLUMN IF NOT EXISTS waive_rule text;

ALTER TABLE public.class_fees
  DROP CONSTRAINT IF EXISTS class_fees_waive_rule_check;
ALTER TABLE public.class_fees
  ADD CONSTRAINT class_fees_waive_rule_check
  CHECK (
    waive_rule IS NULL
    OR (status = 'waived' AND waive_rule IN ('swap', 'spot_refilled', 'new_member', 'first_offence', 'monthly_cap'))
  );

COMMENT ON COLUMN public.class_fees.waive_rule IS
  'FEES.2 (mig 783): the automatic forgiveness rule that waived this fee (swap | spot_refilled | new_member | first_offence | monthly_cap); NULL for a staff waiver or a fee not waived.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'class_fees' AND column_name = 'waive_rule') THEN
    RAISE EXCEPTION 'mig 783: class_fees.waive_rule missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
             WHERE table_schema = 'public' AND table_name = 'class_fees'
               AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 783: a client role holds a privilege on class_fees';
  END IF;
END;
$$;

COMMIT;
