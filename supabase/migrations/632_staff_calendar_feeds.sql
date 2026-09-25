-- 632 — ICSFEED.1: per-person calendar subscription (iCalendar feed) links.
--
-- NOT APPLIED YET. Apply BEFORE the ICSFEED.1 code deploys: the feed route
-- and /api/me/calendar-feed read and write this table, and without it the
-- feed answers 503 and the management route 500. Applied alone this file
-- changes no behaviour: a new, empty table nothing else reads. Behaviour is
-- proven ahead of apply by a PGlite replay
-- (tests/migration-632-staff-calendar-feeds.test.js), which runs this file
-- verbatim.
--
-- WHAT
--   public.staff_calendar_feeds — ONE row per person who has a calendar link.
--     profile_id      uuid PK → profiles(id) ON DELETE CASCADE
--     token_hash      text NOT NULL UNIQUE, CHECK lowercase sha256 hex
--     created_at      timestamptz NOT NULL DEFAULT now()
--     rotated_at      timestamptz   — set when the person makes a new link
--     last_fetched_at timestamptz   — stamped by the feed at most every 15 min
--
-- WHY A HASH (the widget_tokens / mig 607 model, src/lib/widget-token.js)
--   The link is `…/api/calendar-feed/rcf_<43 base64url chars>.ics`: 256 bits
--   of CSPRNG output. Only its sha256 is stored, so a row read (a backup, a
--   support query, a leaked export) yields no working link. Unsalted sha256 is
--   correct for 256 random bits: there is no dictionary to stretch against;
--   this is a lookup key, not a password hash. The CHECK makes it impossible to
--   store the plaintext by mistake. Cost, accepted: the URL is shown ONCE.
--
-- WHY ONE ROW PER PERSON (profile_id is the PK)
--   "Make a new link" is one UPDATE of token_hash: there is never a moment
--   with two live links, or none. "Turn off" is a DELETE. Two concurrent
--   creates race to the PK and the loser gets a 409.
--
-- DEACTIVATION is NOT handled here. The feed route refuses any profile with
--   active = false or deleted_at set (the widget-auth ACTIVEUSER.1 lock), which
--   covers every door (PUT active:false, DELETE /api/staff/[id], the tombstone,
--   a hand-run SQL flip). A tombstone keeps an inert row: a hash and three
--   timestamps, no PII, for a profile the mig 622 CHECK keeps inactive forever.
--
-- ACCESS: service role only. RLS on with NO policies (zero permissive
--   policies deny authenticated and anon outright), AND the table-level
--   privileges Supabase grants by default are revoked from both browser roles
--   (a table-level GRANT is what made mig 153's column REVOKE a no-op, so the
--   fence is the table, not columns). service_role keeps its four DML
--   privileges, granted explicitly so the file does not depend on defaults.
--   Expected advisor note afterwards: INFO rls_enabled_no_policy on this
--   table, exactly as widget_tokens carries since mig 607. By design.
--
-- LOCKS: CREATE TABLE only. No existing table is touched.
--
-- REPLAYING THIS FILE IS A NO-OP (IF NOT EXISTS; REVOKE/GRANT/COMMENT are
-- idempotent). One explicit transaction, so a failed self-check leaves
-- NOTHING applied (the 613/614/618/622/624/628 convention).
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; run IMMEDIATELY before applying, stop if any
-- answer differs from "Expected")
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The name is free:
--       SELECT to_regclass('public.staff_calendar_feeds') AS t;
--     Expected: t = NULL.
-- (b) The FK target is what the file assumes:
--       SELECT data_type FROM information_schema.columns
--        WHERE table_schema='public' AND table_name='profiles' AND column_name='id';
--     Expected: uuid.
-- (c) Supabase's default privileges on new public tables (information; KEEP
--     the output — it explains why the REVOKE line exists):
--       SELECT pg_get_userbyid(defaclrole) AS owner, defaclacl
--         FROM pg_default_acl
--        WHERE defaclnamespace = 'public'::regnamespace AND defaclobjtype = 'r';
--     Expected: rows granting anon, authenticated and service_role.
-- (d) list_migrations shows no 632.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (e) SELECT column_name, data_type, is_nullable FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='staff_calendar_feeds' ORDER BY 1;
--     Expected 5 rows: created_at timestamptz NO, last_fetched_at timestamptz YES,
--     profile_id uuid NO, rotated_at timestamptz YES, token_hash text NO.
-- (f) SELECT relrowsecurity FROM pg_class WHERE oid = 'public.staff_calendar_feeds'::regclass;
--     Expected: true.
--     SELECT count(*) FROM pg_policy WHERE polrelid = 'public.staff_calendar_feeds'::regclass;
--     Expected: 0.
-- (g) SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--       FROM information_schema.table_privileges
--      WHERE table_schema='public' AND table_name='staff_calendar_feeds' GROUP BY 1 ORDER BY 1;
--     Expected: NO row for anon or authenticated. service_role holds at least
--     DELETE,INSERT,SELECT,UPDATE. (postgres, the owner, holds everything.)
-- (h) SELECT conname FROM pg_constraint
--      WHERE conrelid = 'public.staff_calendar_feeds'::regclass ORDER BY 1;
--     Expected: staff_calendar_feeds_pkey, staff_calendar_feeds_profile_id_fkey,
--     staff_calendar_feeds_token_hash_is_sha256, staff_calendar_feeds_token_hash_key.
-- (i) SELECT count(*) FROM public.staff_calendar_feeds;   Expected: 0.
-- (j) get_advisors (security, then performance). Expected: the INFO
--     rls_enabled_no_policy for staff_calendar_feeds (by design, see ACCESS);
--     nothing else new.
--
-- ROLLBACK (forward-only repo; this is a NEW migration, never an edit here):
--   Revert the ICSFEED.1 code FIRST and let it deploy. Then:
--     BEGIN; DROP TABLE IF EXISTS public.staff_calendar_feeds; COMMIT;
--   Every link anyone subscribed to stops working; re-applying later means
--   everyone makes a new link. Usually unnecessary: the table is inert
--   without the code.

BEGIN;

CREATE TABLE IF NOT EXISTS public.staff_calendar_feeds (
  profile_id      uuid        NOT NULL,
  token_hash      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  rotated_at      timestamptz,
  last_fetched_at timestamptz,
  CONSTRAINT staff_calendar_feeds_pkey PRIMARY KEY (profile_id),
  CONSTRAINT staff_calendar_feeds_profile_id_fkey
    FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT staff_calendar_feeds_token_hash_key UNIQUE (token_hash),
  CONSTRAINT staff_calendar_feeds_token_hash_is_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE public.staff_calendar_feeds ENABLE ROW LEVEL SECURITY;

-- Deliberately NO policies (see ACCESS in the header).
REVOKE ALL ON public.staff_calendar_feeds FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_calendar_feeds TO service_role;

-- Self-check (the mig 153b habit: verify the catalog, not this text).
-- CREATE TABLE IF NOT EXISTS silently KEEPS a same-named table of another
-- shape; a RAISE here aborts the transaction, so nothing half-applies.
DO $$
DECLARE
  v_cols   text;
  v_bad    text;
  v_cons   int;
BEGIN
  SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'staff_calendar_feeds';
  IF v_cols IS DISTINCT FROM
     'created_at:timestamp with time zone:NO,last_fetched_at:timestamp with time zone:YES,profile_id:uuid:NO,rotated_at:timestamp with time zone:YES,token_hash:text:NO' THEN
    RAISE EXCEPTION 'mig 632: staff_calendar_feeds has the wrong shape (%); a table of that name existed before this file and CREATE TABLE IF NOT EXISTS kept it', v_cols;
  END IF;

  SELECT count(*) INTO v_cons
    FROM pg_constraint
   WHERE conrelid = 'public.staff_calendar_feeds'::regclass
     AND conname IN ('staff_calendar_feeds_pkey', 'staff_calendar_feeds_profile_id_fkey',
                     'staff_calendar_feeds_token_hash_key', 'staff_calendar_feeds_token_hash_is_sha256');
  IF v_cons <> 4 THEN
    RAISE EXCEPTION 'mig 632: expected 4 constraints on staff_calendar_feeds, found %', v_cons;
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.staff_calendar_feeds'::regclass) THEN
    RAISE EXCEPTION 'mig 632: RLS is not enabled on staff_calendar_feeds';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.staff_calendar_feeds'::regclass) THEN
    RAISE EXCEPTION 'mig 632: staff_calendar_feeds must carry NO policies (service role only)';
  END IF;

  SELECT string_agg(r || ':' || p, ',' ORDER BY r, p) INTO v_bad
    FROM unnest(ARRAY['anon', 'authenticated']) AS r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
   WHERE has_table_privilege(r, 'public.staff_calendar_feeds', p);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 632: browser roles still hold %', v_bad;
  END IF;

  IF NOT (has_table_privilege('service_role', 'public.staff_calendar_feeds', 'SELECT')
      AND has_table_privilege('service_role', 'public.staff_calendar_feeds', 'INSERT')
      AND has_table_privilege('service_role', 'public.staff_calendar_feeds', 'UPDATE')
      AND has_table_privilege('service_role', 'public.staff_calendar_feeds', 'DELETE')) THEN
    RAISE EXCEPTION 'mig 632: service_role lacks a privilege the routes need';
  END IF;
END $$;

COMMENT ON TABLE public.staff_calendar_feeds IS
  'ICSFEED.1 (mig 632): one private calendar-subscription link per person. Only sha256(token) is stored; the URL is shown once. Service role only (RLS on, no policies, browser grants revoked). The feed route refuses a profile with active=false or deleted_at set, so deactivation stops the link without a write here.';
COMMENT ON COLUMN public.staff_calendar_feeds.token_hash IS
  'sha256 hex of the rcf_ token in the feed URL. Never the token itself (CHECK staff_calendar_feeds_token_hash_is_sha256).';
COMMENT ON COLUMN public.staff_calendar_feeds.last_fetched_at IS
  'Last time a calendar app fetched the feed; stamped at most every 15 minutes. Shown to the person as "last checked by your calendar".';

COMMIT;
