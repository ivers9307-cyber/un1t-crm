-- 787 — CORPPROMO.1: corporate promos on /corp (the first: 3 free classes at
-- Hatch Street, credits expiring in 7 days).
--
-- WHY. Partner companies share /corp with their staff. A visitor who has never
-- trained at Hatch Street, and whose email or mobile was never used for a free
-- trial, gets the promo's credits put straight onto their un1t.online account
-- with POST /credits/grant (Richard, 28 Oct 2026: the second deliberate caller
-- of that call after TRIALREGRANT.1). Every un1t.online write is a
-- un1t_write_events row, so the ledger gains op 'promo_grant' and origin
-- 'corp_promo'; every claim is a corp_promo_claims row.
--
-- WHAT.
--   (1) un1t_write_events_op_check admits 'promo_grant' (every op mig 786
--       allowed is kept).
--   (2) un1t_write_events_origin_check admits 'corp_promo' (every origin mig
--       781 allowed is kept).
--   (3) un1t_write_events_promo_grant_check: a promo_grant row names its person
--       (un1t_user_id) and its promo (target).
--   (4) un1t_write_events_one_promo_grant: at most ONE promo_grant row per
--       person and promo that is in flight, in doubt or done. A refused row
--       granted nothing and frees it. The code also refuses by email and
--       mobile (a person with two accounts); this index is the floor.
--   (5) corp_promo_claims: one row per claim attempt (status processing ->
--       granted | ineligible | help_requested -> handled | failed). One granted
--       claim per contact and promo per studio (partial unique index).
--
-- GRANTS. corp_promo_claims is service-role only: RLS on, no policy,
-- REVOKE ALL from anon, authenticated, PUBLIC (written by the public
-- /api/public/corp-claims route and read by the approvals provider, both on
-- the service role). un1t_write_events is unchanged (mig 744: service role
-- only).
--   column-grant: n/a, no column-granted table touched.
--
-- LOCKS. One transaction, 5s lock_timeout. The CHECK swaps scan the ledger
-- (small: a few hundred rows).
--
-- IDEMPOTENT. Drop-if-exists then add on each CHECK, IF NOT EXISTS on the
-- table and indexes. The DO block checks the POST-STATE in the catalog.
--
-- ORDER. Apply BEFORE the code deploys: until then the ledger insert for
-- op 'promo_grant' is refused by the CHECK (nothing reaches un1t.online) and
-- the claims insert fails, so /corp answers "try again" (fail closed).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_op_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_op_check
  CHECK (op IN ('create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant', 'fee_charge', 'move', 'promo_grant'));

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_origin_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_origin_check
  CHECK (origin IN ('staff', 'funnel', 'approval', 'mia', 'test_account', 'web_trial', 'fee_run', 'corp_promo'));

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_promo_grant_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_promo_grant_check
  CHECK (op <> 'promo_grant' OR (un1t_user_id IS NOT NULL AND target IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS un1t_write_events_one_promo_grant
  ON public.un1t_write_events (location_id, un1t_user_id, target)
  WHERE op = 'promo_grant' AND stage IN ('done', 'sent', 'unknown');

COMMENT ON INDEX public.un1t_write_events_one_promo_grant IS
  'CORPPROMO.1 (mig 787): at most one promo_grant per person (location, un1t user) and promo (target) in flight, in doubt or done. A refused row frees it.';

COMMENT ON TABLE public.un1t_write_events IS
  'UN1TWRITE.1 (mig 744): one row per un1t.online write attempt (book, cancel, create_client, forgot_password, trial, checkout; trial_regrant since mig 760; fee_charge since mig 781; move since mig 786; promo_grant since mig 787). The write-ahead marker, the resume point for retries and approvals, the dedupe of the CRM''s own attempts and the audit trail. Keys: create:<loc>:<contact>, trial:<loc>:<un1tUser>:<product>:<method>, trial_regrant:<loc>:<un1tUser>, promo_grant:<loc>:<un1tUser>:<promo>, book:<loc>:<un1tUser>:<event>, cancel:<loc>:<booking>, move:<loc>:<booking>:<event> (late_window since mig 786), fee:<loc>:<fee>:<n>, pw:<loc>:<un1tUser>:<n>, checkout = the caller''s key (also the idempotency-key header on purchase and credit-grant calls). message is <= 500 chars and never carries a password, token, email or phone. Service role only.';

CREATE TABLE IF NOT EXISTS public.corp_promo_claims (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  contact_id        uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  promo_key         text        NOT NULL,
  first_name        text,
  last_name         text,
  customer_email    text        NOT NULL,
  customer_phone    text,
  status            text        NOT NULL DEFAULT 'processing'
                      CONSTRAINT corp_promo_claims_status_check
                      CHECK (status IN ('processing', 'granted', 'ineligible', 'help_requested', 'handled', 'failed')),
  reason            text,
  un1t_user_id      text,
  un1t_ledger_id    uuid,
  credits           integer,
  expires_at        timestamptz,
  terms_accepted_at timestamptz,
  terms_source      text,
  terms_version     text,
  attribution       jsonb,
  lead_event_id     text,
  handled_by        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  handled_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_corp_promo_claims_location_status
  ON public.corp_promo_claims (location_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_corp_promo_claims_contact
  ON public.corp_promo_claims (contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_corp_promo_claims_granted
  ON public.corp_promo_claims (location_id, contact_id, promo_key)
  WHERE status = 'granted';

CREATE OR REPLACE TRIGGER trg_corp_promo_claims_updated_at BEFORE UPDATE ON public.corp_promo_claims
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.corp_promo_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.corp_promo_claims FROM anon, authenticated, PUBLIC;

COMMENT ON TABLE public.corp_promo_claims IS
  'CORPPROMO.1 (mig 787): one row per /corp promo claim. processing -> granted | ineligible | help_requested (an approvals card) -> handled | failed (try again). reason carries the code (free_trial_used, trained, holds_credits, active_member, un1t_*). Service role only.';

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
  FOREACH k IN ARRAY ARRAY['create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant', 'fee_charge', 'move', 'promo_grant'] LOOP
    IF d IS NULL OR d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 787: un1t_write_events_op_check does not admit %: %', k, d;
    END IF;
  END LOOP;
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.un1t_write_events'::regclass AND conname = 'un1t_write_events_origin_check'));
  FOREACH k IN ARRAY ARRAY['staff', 'funnel', 'approval', 'mia', 'test_account', 'web_trial', 'fee_run', 'corp_promo'] LOOP
    IF d IS NULL OR d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 787: un1t_write_events_origin_check does not admit %: %', k, d;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.un1t_write_events'::regclass AND conname = 'un1t_write_events_promo_grant_check') THEN
    RAISE EXCEPTION 'mig 787: un1t_write_events_promo_grant_check missing';
  END IF;
  d := (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'un1t_write_events_one_promo_grant');
  IF d IS NULL OR d NOT LIKE 'CREATE UNIQUE INDEX%' OR d NOT LIKE '%(location_id, un1t_user_id, target) WHERE%' THEN
    RAISE EXCEPTION 'mig 787: un1t_write_events_one_promo_grant missing or wrong: %', d;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = 'corp_promo_claims' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'mig 787: corp_promo_claims missing or RLS off';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'corp_promo_claims') THEN
    RAISE EXCEPTION 'mig 787: corp_promo_claims must carry no policy';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
             WHERE table_schema = 'public' AND table_name IN ('corp_promo_claims', 'un1t_write_events')
               AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 787: a client role holds a privilege on corp_promo_claims or un1t_write_events';
  END IF;
END;
$$;

COMMIT;
