-- 760 — TRIALREGRANT.1: the un1t.online trial credit re-grant ledger op.
--
-- WHY. Richard, 20 Oct 2026: at Hatch Street (un1t.online), a person who
-- CLAIMED the free trial but never used it, and whose trial credits have
-- expired, may have a free class again. un1t.online sells the trial product
-- only once per person, so the CRM adds the credits instead (3 credits,
-- 7-day expiry) through POST /credits/grant, from grantTrial only. That is
-- once ever per person per studio, and the write ledger is the record:
-- un1t_write_events gains the op 'trial_regrant'.
--
-- WHAT.
--   (1) un1t_write_events_op_check admits 'trial_regrant' (every op mig 744
--       allowed is kept: create_client, forgot_password, trial, book,
--       cancel, checkout).
--   (2) un1t_write_events_regrant_user_check: a trial_regrant row names its
--       un1t user (a NULL would slip past the index below, NULLs being
--       distinct in a unique index).
--   (3) un1t_write_events_one_regrant: at most ONE trial_regrant row per
--       person (location, un1t user) that is in flight, in doubt or done.
--       A refused row (un1t.online said no, nothing was granted) frees it
--       for staff to try again. The code also refuses a second re-grant by
--       contact (a person with two un1t accounts); this index is the floor
--       the database itself holds.
--   The trial-method CHECK (method only on op 'trial') and the trial-target
--   CHECK are unchanged: a trial_regrant row has no method and no target.
--
-- GRANTS. No privilege changes: un1t_write_events stays service_role only
-- (mig 744: RLS on, no policy, nothing for anon/authenticated). The new
-- index and CHECKs are not relations a client role can reach.
--   grant: n/a, no new table, view, sequence or function.
--
-- LOCKS. One transaction, 5s lock_timeout. The CHECK swaps scan the ledger
-- (small: a few hundred rows). The index build is on the same small table.
--
-- IDEMPOTENT. Drop-if-exists then add on each CHECK, IF NOT EXISTS on the
-- index. The DO block checks the POST-STATE in the catalog and aborts the
-- whole file.
--
-- ORDER. Apply BEFORE the code that writes op 'trial_regrant' deploys: until
-- then the CHECK refuses the row and the re-grant fails closed (the ledger
-- insert errors before anything is sent, so nothing reaches un1t.online).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_op_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_op_check
  CHECK (op IN ('create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant'));

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_regrant_user_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_regrant_user_check
  CHECK (op <> 'trial_regrant' OR un1t_user_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS un1t_write_events_one_regrant
  ON public.un1t_write_events (location_id, un1t_user_id)
  WHERE op = 'trial_regrant' AND stage IN ('sent', 'unknown', 'done');

COMMENT ON INDEX public.un1t_write_events_one_regrant IS
  'TRIALREGRANT.1 (mig 760): at most one trial credit re-grant per person per studio that is in flight, in doubt or done (a refused one, which granted nothing, does not count). Key trial_regrant:<loc>:<un1tUser>.';

COMMENT ON TABLE public.un1t_write_events IS
  'UN1TWRITE.1 (mig 744): one row per un1t.online write attempt (book, cancel, create_client, forgot_password, trial, checkout; trial_regrant since mig 760). The write-ahead marker, the resume point for retries and approvals, the dedupe of the CRM''s own attempts and the audit trail. Keys: create:<loc>:<contact>, trial:<loc>:<un1tUser>:<product>:<method>, trial_regrant:<loc>:<un1tUser>, book:<loc>:<un1tUser>:<event>, cancel:<loc>:<booking>, pw:<loc>:<un1tUser>:<n>, checkout = the caller''s key (also the idempotency-key header on purchase and credit-grant calls). message is <= 500 chars and never carries a password, token, email or phone. Service role only.';

-- ---------------------------------------------------------------------------
-- Self-check: the post-state in the catalog, never this file's text.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  d text;
  k text;
BEGIN
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.un1t_write_events'::regclass AND conname = 'un1t_write_events_op_check'));
  IF d IS NULL THEN
    RAISE EXCEPTION 'mig 760: un1t_write_events_op_check missing';
  END IF;
  FOREACH k IN ARRAY ARRAY['create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant'] LOOP
    IF d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 760: un1t_write_events_op_check does not admit %: %', k, d;
    END IF;
  END LOOP;

  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.un1t_write_events'::regclass AND conname = 'un1t_write_events_regrant_user_check'));
  IF d IS NULL OR replace(replace(d, '(', ''), ')', '')
       <> 'CHECK op <> ''trial_regrant''::text OR un1t_user_id IS NOT NULL' THEN
    RAISE EXCEPTION 'mig 760: un1t_write_events_regrant_user_check wrong or missing: %', d;
  END IF;

  -- mig 744's trial CHECKs still stand (a re-grant row carries no method).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.un1t_write_events'::regclass
                  AND conname = 'un1t_write_events_trial_method_check') THEN
    RAISE EXCEPTION 'mig 760: un1t_write_events_trial_method_check is gone';
  END IF;

  d := (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'un1t_write_events_one_regrant');
  IF d IS NULL OR d NOT ILIKE 'CREATE UNIQUE INDEX%' OR d NOT LIKE '%(location_id, un1t_user_id) WHERE%'
     OR d NOT LIKE '%''trial_regrant''%' OR d NOT LIKE '%''sent''%' OR d NOT LIKE '%''unknown''%'
     OR d NOT LIKE '%''done''%' OR d LIKE '%''refused''%' THEN
    RAISE EXCEPTION 'mig 760: un1t_write_events_one_regrant wrong or missing: %', d;
  END IF;

  -- Still closed to every client role.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.un1t_write_events'::regclass) THEN
    RAISE EXCEPTION 'mig 760: un1t_write_events carries a policy; it must have none';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
              WHERE table_schema = 'public' AND table_name = 'un1t_write_events'
                AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 760: a client role holds a privilege on public.un1t_write_events';
  END IF;
END $$;

COMMIT;
