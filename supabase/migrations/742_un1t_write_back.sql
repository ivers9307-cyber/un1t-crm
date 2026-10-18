-- 742 — UN1TWRITE.1: un1t.online write-back core, shipped dark (plan D,
-- .superpowers/sdd/2026-10-17-un1t-online-write-back, PR 1 "Write core,
-- ledger, guards"; spec docs/superpowers/specs/2026-10-17-un1t-online-write-
-- back-design.md §6.2, §6.3, §6.5).
--
-- WHY. Hatch Street runs on un1t.online. Until now the CRM only READ it (the
-- sync, mig 726). Plan D lets the CRM write a small, fixed set of things back
-- (book, cancel, create a client, forgot-password, the €0 trial, a checkout
-- link). Every write needs a write-ahead record (so a retry, an approval or a
-- crash resumes instead of re-sending), and the mirror the sync keeps must
-- not undo a write the CRM just made because a sync run's pull began a few
-- seconds before it.
--
-- WHAT.
--   (1) un1t_write_events: one row per write attempt (spec §6.2). The partial
--       unique indexes make the database refuse a second attempt in flight
--       for one key, a second done create/trial/forgot-password for one key,
--       and a second done trial for one person and product across the €0
--       charge and the free checkout (the CRM can never grant twice). A done
--       book does not block a later book on the same key (rebook after a
--       cancel).
--   (2) crm_written_at on un1t_bookings, un1t_clients, un1t_transactions,
--       and the BEFORE UPDATE trigger un1t_mirror_keep_crm_write on the
--       three (spec §6.3). The sync never sends crm_written_at, so its upsert
--       leaves it as it was; a row the CRM wrote keeps the CRM's columns
--       against an upsert from a pull that began before the write. Rule, in
--       order:
--         a. OLD.crm_written_at IS NULL, or NEW changes crm_written_at (the
--            CRM's own next write) -> NEW.
--         b. un1t_bookings only, RANK FIRST (the same rule as spec C-4):
--            booked (and anything not terminal) = 0; attended, no_show,
--            cancelled = 1. A higher rank in NEW -> NEW, whatever the times.
--            Otherwise fall through to the time rule.
--         c. NEW.synced_at >= OLD.crm_written_at (the pull began after the
--            write) -> NEW.
--         d. Keep OLD, but take NEW.synced_at, so the sync's history-window
--            count (absent_from_pull) stays right.
--       Both times in (c) are the CRM's own clock (run start vs our write),
--       never un1t.online's. A non-sync writer of these tables must set a
--       fresh crm_written_at, or it is judged as a stale sync by (c)/(d).
--       class_bookings is spec C's table and does not get this trigger.
--   (3) class_booking_requests (the /start queue) gains the terms record the
--       create-client step copies onto the ledger (terms_accepted_at +
--       terms_source + terms_version, the first two set together or not at
--       all) and un1t_steps, the funnel's per-step record
--       ({ explanation_email, forgot_password, booking_confirmation,
--       skips: string[] }, plan Task 22).
--   (4) agent_membership_requests_kind_check gains 'refund_request'. Every
--       kind the live constraint lists is kept: on 18 Oct 2026 that is
--       exactly mig 711's nine (read with pg_get_constraintdef before this
--       file was written).
--
-- GRANTS.
--   grant: un1t_write_events is service_role only: RLS on, NO policy,
--     REVOKE ALL FROM anon, authenticated (the mig 677 default, stated, still
--     right on a database whose defaults were reset). Staff read it through
--     /api routes.
--   column-grant: n/a for crm_written_at, the three un1t_* tables are
--     service_role-only (mig 726).
--   column-grant: n/a for the four class_booking_requests columns. That
--     table has no column-level grant: authenticated holds table-level
--     SELECT/INSERT/UPDATE/DELETE (live 18 Oct 2026), fenced by RLS on with
--     no policy, and this file leaves that ACL as it is.
--   The trigger function needs no EXECUTE grant (CLAUDE.md); it states
--   REVOKE EXECUTE FROM PUBLIC, anon, authenticated anyway.
--
-- LOCKS. One transaction, 5s lock_timeout. ADD COLUMN on the three mirror
-- tables, class_booking_requests and the CHECK swaps are brief (the new
-- columns are nullable with no default; the CHECKs scan small tables).
--
-- IDEMPOTENT. IF NOT EXISTS on the table, columns and indexes, CREATE OR
-- REPLACE on the function (keeps its ACL) and the triggers, drop-if-exists
-- then add on each CHECK. The DO block at the end checks the POST-STATE in
-- the catalog (never this file's text) and aborts the whole file.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) The write ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.un1t_write_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  contact_id        uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  un1t_user_id      text,
  op                text        NOT NULL CONSTRAINT un1t_write_events_op_check
                      CHECK (op IN ('create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout')),
  origin            text        NOT NULL CONSTRAINT un1t_write_events_origin_check
                      CHECK (origin IN ('staff', 'funnel', 'approval', 'mia', 'test_account')),
  origin_ref        text,
  actor_user_id     uuid,
  idempotency_key   text        NOT NULL,
  target            text,
  stage             text        NOT NULL CONSTRAINT un1t_write_events_stage_check
                      CHECK (stage IN ('sent', 'done', 'refused', 'unknown')),
  method            text        CONSTRAINT un1t_write_events_method_check
                      CHECK (method IN ('charge', 'free_checkout')),
  un1t_ref          text,
  terms_accepted_at timestamptz,
  terms_source      text,
  checkout_url      text,
  http_status       int,
  code              text,
  message           text        CONSTRAINT un1t_write_events_message_length_check
                      CHECK (char_length(message) <= 500),
  recovered         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  CONSTRAINT un1t_write_events_trial_method_check CHECK ((op = 'trial') = (method IS NOT NULL))
);

-- At most one attempt in flight or in doubt per key.
CREATE UNIQUE INDEX IF NOT EXISTS un1t_write_events_one_open
  ON public.un1t_write_events (idempotency_key)
  WHERE stage IN ('sent', 'unknown');

-- At most one done create / trial step / forgot-password per key.
CREATE UNIQUE INDEX IF NOT EXISTS un1t_write_events_one_done
  ON public.un1t_write_events (idempotency_key)
  WHERE stage = 'done' AND op IN ('create_client', 'trial', 'forgot_password');

-- At most one done trial per person and product, across the €0 charge and
-- the free checkout.
CREATE UNIQUE INDEX IF NOT EXISTS un1t_write_events_one_trial
  ON public.un1t_write_events (location_id, un1t_user_id, target)
  WHERE op = 'trial' AND stage = 'done';

CREATE INDEX IF NOT EXISTS un1t_write_events_contact_op
  ON public.un1t_write_events (location_id, contact_id, op, created_at DESC);

COMMENT ON TABLE public.un1t_write_events IS
  'UN1TWRITE.1 (mig 742): one row per un1t.online write attempt (book, cancel, create_client, forgot_password, trial, checkout). The write-ahead marker, the resume point for retries and approvals, the dedupe of the CRM''s own attempts and the audit trail. Keys: create:<loc>:<contact>, trial:<loc>:<un1tUser>:<product>:<method>, book:<loc>:<un1tUser>:<event>, cancel:<loc>:<booking>, pw:<loc>:<un1tUser>, checkout = the caller''s key (also the idempotency-key header on purchase calls). message is <= 500 chars and never carries a password, token, email or phone. Service role only.';

ALTER TABLE public.un1t_write_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.un1t_write_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_write_events TO service_role;

-- ---------------------------------------------------------------------------
-- (2) crm_written_at + the keep-the-CRM-write trigger
-- ---------------------------------------------------------------------------
-- column-grant: n/a, service_role-only tables (mig 726)
ALTER TABLE public.un1t_bookings     ADD COLUMN IF NOT EXISTS crm_written_at timestamptz;
ALTER TABLE public.un1t_clients      ADD COLUMN IF NOT EXISTS crm_written_at timestamptz;
ALTER TABLE public.un1t_transactions ADD COLUMN IF NOT EXISTS crm_written_at timestamptz;

COMMENT ON COLUMN public.un1t_bookings.crm_written_at IS
  'UN1TWRITE.1 (mig 742): when the CRM last wrote this row after a un1t.online write. The sync never sets it; un1t_mirror_keep_crm_write keeps the CRM''s columns against a sync upsert pulled before this time (rank first: a terminal status from the sync always wins over booked).';
COMMENT ON COLUMN public.un1t_clients.crm_written_at IS
  'UN1TWRITE.1 (mig 742): when the CRM last wrote this row after a un1t.online write. The sync never sets it; un1t_mirror_keep_crm_write keeps the CRM''s columns against a sync upsert pulled before this time.';
COMMENT ON COLUMN public.un1t_transactions.crm_written_at IS
  'UN1TWRITE.1 (mig 742): when the CRM last wrote this row after a un1t.online write. The sync never sets it; un1t_mirror_keep_crm_write keeps the CRM''s columns against a sync upsert pulled before this time.';

CREATE OR REPLACE FUNCTION public.un1t_mirror_keep_crm_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_synced timestamptz;
BEGIN
  -- a. Not a sync overwrite of a CRM write.
  IF OLD.crm_written_at IS NULL OR NEW.crm_written_at IS DISTINCT FROM OLD.crm_written_at THEN
    RETURN NEW;
  END IF;

  -- b. Rank first, bookings only: a terminal status beats booked whatever the times.
  IF TG_TABLE_NAME = 'un1t_bookings' THEN
    IF (CASE WHEN lower(NEW.status) IN ('attended', 'no_show', 'cancelled') THEN 1 ELSE 0 END)
       > (CASE WHEN lower(OLD.status) IN ('attended', 'no_show', 'cancelled') THEN 1 ELSE 0 END) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- c. The pull began after the CRM's write: the sync's view is newer.
  IF NEW.synced_at >= OLD.crm_written_at THEN
    RETURN NEW;
  END IF;

  -- d. A pull from before the write: keep the CRM's row, take the new synced_at.
  v_synced := NEW.synced_at;
  NEW := OLD;
  NEW.synced_at := v_synced;
  RETURN NEW;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.un1t_mirror_keep_crm_write() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.un1t_mirror_keep_crm_write() IS
  'UN1TWRITE.1 (mig 742): BEFORE UPDATE on un1t_bookings, un1t_clients, un1t_transactions. A sync upsert (crm_written_at unchanged) whose synced_at is before OLD.crm_written_at keeps every OLD column except synced_at. On un1t_bookings a terminal status (attended, no_show, cancelled) over a non-terminal one always wins first. A non-sync writer must set a fresh crm_written_at.';

CREATE OR REPLACE TRIGGER un1t_mirror_keep_crm_write
  BEFORE UPDATE ON public.un1t_bookings
  FOR EACH ROW EXECUTE FUNCTION public.un1t_mirror_keep_crm_write();
CREATE OR REPLACE TRIGGER un1t_mirror_keep_crm_write
  BEFORE UPDATE ON public.un1t_clients
  FOR EACH ROW EXECUTE FUNCTION public.un1t_mirror_keep_crm_write();
CREATE OR REPLACE TRIGGER un1t_mirror_keep_crm_write
  BEFORE UPDATE ON public.un1t_transactions
  FOR EACH ROW EXECUTE FUNCTION public.un1t_mirror_keep_crm_write();

-- ---------------------------------------------------------------------------
-- (3) The /start queue: terms record + the funnel's per-step record
-- ---------------------------------------------------------------------------
-- column-grant: n/a, class_booking_requests has no column-level grant (table-level only, RLS on, no policy)
ALTER TABLE public.class_booking_requests
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS terms_source      text,
  ADD COLUMN IF NOT EXISTS terms_version     text,
  ADD COLUMN IF NOT EXISTS un1t_steps        jsonb;

ALTER TABLE public.class_booking_requests
  DROP CONSTRAINT IF EXISTS class_booking_requests_terms_source_check;
ALTER TABLE public.class_booking_requests
  ADD CONSTRAINT class_booking_requests_terms_source_check
  CHECK (terms_source IN ('website', 'whatsapp_flow', 'test_account'));

ALTER TABLE public.class_booking_requests
  DROP CONSTRAINT IF EXISTS class_booking_requests_terms_pair_check;
ALTER TABLE public.class_booking_requests
  ADD CONSTRAINT class_booking_requests_terms_pair_check
  CHECK ((terms_accepted_at IS NULL) = (terms_source IS NULL));

COMMENT ON COLUMN public.class_booking_requests.terms_accepted_at IS
  'UN1TWRITE.1 (mig 742): when the person accepted un1t.online''s terms and liability waiver for this request; copied onto the create_client ledger row. Set together with terms_source.';
COMMENT ON COLUMN public.class_booking_requests.terms_source IS
  'UN1TWRITE.1 (mig 742): where the terms were accepted: website, whatsapp_flow or test_account.';
COMMENT ON COLUMN public.class_booking_requests.terms_version IS
  'UN1TWRITE.1 (mig 742): the version of the terms text shown when they were accepted.';
COMMENT ON COLUMN public.class_booking_requests.un1t_steps IS
  'UN1TWRITE.1 (mig 742): the un1t.online funnel''s per-step record for this request: { explanation_email, forgot_password, booking_confirmation, skips: string[] }.';

-- ---------------------------------------------------------------------------
-- (4) Approval kind 'refund_request' (every live kind kept)
-- ---------------------------------------------------------------------------
ALTER TABLE public.agent_membership_requests
  DROP CONSTRAINT IF EXISTS agent_membership_requests_kind_check;
ALTER TABLE public.agent_membership_requests
  ADD CONSTRAINT agent_membership_requests_kind_check
  CHECK (kind = ANY (ARRAY[
    'pause'::text,
    'cancellation'::text,
    'class_booking'::text,
    'consultation'::text,
    'class_cancellation'::text,
    'event_booking'::text,
    'event_cancellation'::text,
    'membership_purchase'::text,
    'event_move'::text,
    'refund_request'::text
  ]));

-- ---------------------------------------------------------------------------
-- Self-check: the post-state in the catalog, never this file's text.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t     text;
  d     text;
  k     text;
  v_fn  oid := 'public.un1t_mirror_keep_crm_write()'::regprocedure;
BEGIN
  -- The ledger: a table, RLS on, no policy, nothing for a client role.
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'un1t_write_events'
                    AND c.relkind = 'r' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'mig 742: un1t_write_events missing or RLS off';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.un1t_write_events'::regclass) THEN
    RAISE EXCEPTION 'mig 742: un1t_write_events carries a policy; it must have none';
  END IF;
  IF has_table_privilege('authenticated', 'public.un1t_write_events', 'SELECT')
     OR has_table_privilege('anon', 'public.un1t_write_events', 'SELECT')
     OR EXISTS (SELECT 1 FROM information_schema.table_privileges
                 WHERE table_schema = 'public' AND table_name = 'un1t_write_events'
                   AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 742: a client role holds a privilege on public.un1t_write_events';
  END IF;

  -- The four indexes, with their keys and predicates.
  d := (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'un1t_write_events_one_open');
  IF d IS NULL OR d NOT ILIKE 'CREATE UNIQUE INDEX%' OR d NOT LIKE '%(idempotency_key) WHERE%'
     OR d NOT LIKE '%''sent''%' OR d NOT LIKE '%''unknown''%' OR d LIKE '%''done''%' THEN
    RAISE EXCEPTION 'mig 742: un1t_write_events_one_open wrong or missing: %', d;
  END IF;
  d := (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'un1t_write_events_one_done');
  IF d IS NULL OR d NOT ILIKE 'CREATE UNIQUE INDEX%' OR d NOT LIKE '%(idempotency_key) WHERE%'
     OR d NOT LIKE '%''done''%' OR d NOT LIKE '%''create_client''%' OR d NOT LIKE '%''trial''%'
     OR d NOT LIKE '%''forgot_password''%' OR d LIKE '%''book''%' THEN
    RAISE EXCEPTION 'mig 742: un1t_write_events_one_done wrong or missing: %', d;
  END IF;
  d := (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'un1t_write_events_one_trial');
  IF d IS NULL OR d NOT ILIKE 'CREATE UNIQUE INDEX%' OR d NOT LIKE '%(location_id, un1t_user_id, target) WHERE%'
     OR d NOT LIKE '%''trial''%' OR d NOT LIKE '%''done''%' THEN
    RAISE EXCEPTION 'mig 742: un1t_write_events_one_trial wrong or missing: %', d;
  END IF;
  d := (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'un1t_write_events_contact_op');
  IF d IS NULL OR d NOT LIKE '%(location_id, contact_id, op, created_at DESC)%' THEN
    RAISE EXCEPTION 'mig 742: un1t_write_events_contact_op wrong or missing: %', d;
  END IF;

  -- The trigger function: closed to client roles.
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 742: a client role can execute public.un1t_mirror_keep_crm_write()';
  END IF;

  -- crm_written_at + an enabled BEFORE UPDATE FOR EACH ROW trigger on each mirror table.
  FOREACH t IN ARRAY ARRAY['un1t_bookings', 'un1t_clients', 'un1t_transactions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = t
                      AND column_name = 'crm_written_at' AND data_type = 'timestamp with time zone') THEN
      RAISE EXCEPTION 'mig 742: %.crm_written_at missing or not timestamptz', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = ('public.' || t)::regclass
                      AND tgname = 'un1t_mirror_keep_crm_write'
                      AND NOT tgisinternal AND tgenabled <> 'D'
                      AND tgfoid = v_fn
                      AND (tgtype & 1) = 1      -- FOR EACH ROW
                      AND (tgtype & 2) = 2      -- BEFORE
                      AND (tgtype & 16) = 16    -- UPDATE
                      AND (tgtype & 12) = 0) THEN -- not INSERT/DELETE
      RAISE EXCEPTION 'mig 742: % lacks the enabled BEFORE UPDATE row trigger un1t_mirror_keep_crm_write', t;
    END IF;
  END LOOP;

  -- The /start queue's new columns and CHECKs.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'class_booking_requests'
         AND column_name IN ('terms_accepted_at', 'terms_source', 'terms_version', 'un1t_steps')) <> 4 THEN
    RAISE EXCEPTION 'mig 742: class_booking_requests is missing a terms or un1t_steps column';
  END IF;
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.class_booking_requests'::regclass AND conname = 'class_booking_requests_terms_source_check'));
  IF d IS NULL OR d NOT LIKE '%''website''%' OR d NOT LIKE '%''whatsapp_flow''%' OR d NOT LIKE '%''test_account''%' THEN
    RAISE EXCEPTION 'mig 742: class_booking_requests_terms_source_check wrong: %', d;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.class_booking_requests'::regclass
                    AND conname = 'class_booking_requests_terms_pair_check') THEN
    RAISE EXCEPTION 'mig 742: class_booking_requests_terms_pair_check missing';
  END IF;

  -- The kind CHECK admits refund_request and every kind mig 711 allowed.
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.agent_membership_requests'::regclass AND conname = 'agent_membership_requests_kind_check'));
  IF d IS NULL THEN
    RAISE EXCEPTION 'mig 742: agent_membership_requests_kind_check missing';
  END IF;
  FOREACH k IN ARRAY ARRAY['pause', 'cancellation', 'class_booking', 'consultation', 'class_cancellation',
                           'event_booking', 'event_cancellation', 'membership_purchase', 'event_move',
                           'refund_request'] LOOP
    IF d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 742: agent_membership_requests_kind_check does not admit %: %', k, d;
    END IF;
  END LOOP;
END $$;

COMMIT;
