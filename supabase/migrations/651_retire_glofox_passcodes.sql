-- 651 — PASSCODEREAD.1: members' Glofox passwords are no longer kept, and
-- glofox_push_events is server-only.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 28 Sep 2026),
-- the evidence for the fix, not proof it landed. Behaviour is proven ahead of
-- apply by a PGlite replay (tests/migration-651-retire-glofox-passcodes.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C40, found planning C35 SECFIX.3)
-- ===========================================================================
-- findOrCreateGlofoxMember (src/lib/glofox-push.js) registers a new Glofox
-- member with a random initial password, and GLOFOX3.5 (migs 143, 146) also
-- stored it on contacts.glofox_passcode and glofox_push_events.passcode_sent
-- for a welcome email ({{glofox_passcode}}). That email was never switched on
-- (0 sequences, campaigns or templates use the tag; 0 sequences trigger on
-- glofox_account_created), and mig 146's "cleared post-welcome / 30-day TTL"
-- was never built. So the stored copies were write-only, while:
--   * contacts_select + Supabase's default table grant let any staff member at
--     the contact's studio read contacts.glofox_passcode from their own session
--     (and through the security_invoker view contact_location_audience);
--   * glofox_push_events_select + the default grant did the same for
--     passcode_sent (and the Glofox `user` payload in glofox_response);
--   * service-role select('*') reads of contacts (the contact page, the
--     contacts list/search/detail APIs, the PUT echo) shipped the value to
--     every browser that opened or listed such a contact. No grant can
--     reach those.
--
-- VERIFIED LIVE (28 Sep, BEFORE this migration; counts only, no values read):
--   contacts: 27 non-null glofox_passcode (26 Stillorgan, 1 Hatch Street),
--   all minted by the class-booking approval path since 14 Jul; 0 have a
--   user_id. glofox_push_events: 27 non-null passcode_sent, all on
--   status='created' rows. As a plain Stillorgan staff member (own JWT):
--   26 readable on contacts, 26 through contact_location_audience, 27 (of 59
--   visible rows) on glofox_push_events. relacl on both tables: anon and
--   authenticated = arwdDxtm; no column ACLs; neither table is in
--   supabase_realtime. No browser, phone, champ-app or other-repo code reads
--   glofox_push_events; the two RPCs that do are not client-executable.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
-- The code that stops writing both columns deploys FIRST (the same PR). This
-- file then:
--   1. clears the stored values (irreversible, by design: nothing reads them);
--   2. adds CHECK (… IS NULL) on both columns, so nothing can store one again,
--      the service role included (an old deploy, a script, a hand INSERT);
--   3. marks both columns DEPRECATED (a later migration drops them, and must
--      recreate contact_location_audience without glofox_passcode first);
--   4. revokes every client privilege on glofox_push_events (server-only);
--   5. self-checks the catalog and aborts the whole file otherwise.
-- contacts GRANTS ARE NOT TOUCHED: the value is gone, and column-granting the
-- hottest table would bind 100+ client reads (the phone, champ-app) for nothing.
--
-- APPLY ≥1 h AFTER the PASSCODEREAD.1 deploy is live. Old code writes the
-- column this CHECK forbids: its link write would fail and leave a created
-- but unlinked Glofox member for the Review tab.
--
-- ROLLBACK (only if something breaks), as a new forward migration. The
-- cleared values cannot come back, and must not:
--   BEGIN;
--   ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_glofox_passcode_retired;
--   ALTER TABLE public.glofox_push_events DROP CONSTRAINT IF EXISTS glofox_push_events_passcode_retired;
--   GRANT ALL ON public.glofox_push_events TO anon, authenticated;
--   COMMIT;
-- (The last line restores the 28 Sep relacl exactly. Drop the constraints
-- BEFORE reverting the code.)

BEGIN;

-- The CHECKs take an ACCESS EXCLUSIVE lock on contacts for a few ms to
-- validate 8.8k rows. Fail rather than queue behind a long query; re-run later.
SET LOCAL lock_timeout = '5s';

-- 1. Clear the stored values.
UPDATE public.contacts SET glofox_passcode = NULL WHERE glofox_passcode IS NOT NULL;
UPDATE public.glofox_push_events SET passcode_sent = NULL WHERE passcode_sent IS NOT NULL;

-- 2. Nothing may store one again.
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_glofox_passcode_retired;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_glofox_passcode_retired CHECK (glofox_passcode IS NULL);
ALTER TABLE public.glofox_push_events DROP CONSTRAINT IF EXISTS glofox_push_events_passcode_retired;
ALTER TABLE public.glofox_push_events ADD CONSTRAINT glofox_push_events_passcode_retired CHECK (passcode_sent IS NULL);

-- 3. Deprecated.
COMMENT ON COLUMN public.contacts.glofox_passcode IS
  'DEPRECATED (mig 651, PASSCODEREAD.1): always NULL (CHECK contacts_glofox_passcode_retired). Glofox member passwords are never stored; {{glofox_passcode}} renders empty. Dropped by a later migration (recreate contact_location_audience without it first).';
COMMENT ON COLUMN public.glofox_push_events.passcode_sent IS
  'DEPRECATED (mig 651, PASSCODEREAD.1): always NULL (CHECK glofox_push_events_passcode_retired). Dropped by a later migration.';

-- 4. glofox_push_events is server-only (every reader and writer is service_role).
REVOKE ALL ON TABLE public.glofox_push_events FROM anon, authenticated, PUBLIC;

-- 5. Self-check: the catalog and the data, never this file (the 153 → 153b rule).
DO $$
DECLARE
  priv text;
  spec record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.contacts WHERE glofox_passcode IS NOT NULL) THEN
    RAISE EXCEPTION 'PASSCODEREAD.1: a contacts.glofox_passcode value survived';
  END IF;
  IF EXISTS (SELECT 1 FROM public.glofox_push_events WHERE passcode_sent IS NOT NULL) THEN
    RAISE EXCEPTION 'PASSCODEREAD.1: a glofox_push_events.passcode_sent value survived';
  END IF;

  FOR spec IN SELECT * FROM (VALUES
      ('public.contacts'::regclass, 'contacts_glofox_passcode_retired'),
      ('public.glofox_push_events'::regclass, 'glofox_push_events_passcode_retired')) v(tbl, con)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = spec.tbl AND c.conname = spec.con AND c.contype = 'c' AND c.convalidated) THEN
      RAISE EXCEPTION 'PASSCODEREAD.1: CHECK % is missing or not validated on %', spec.con, spec.tbl;
    END IF;
  END LOOP;

  FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('authenticated', 'public.glofox_push_events', priv)
       OR has_table_privilege('anon', 'public.glofox_push_events', priv) THEN
      RAISE EXCEPTION 'PASSCODEREAD.1: % on public.glofox_push_events survived for a client role', priv;
    END IF;
  END LOOP;
  FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
    IF has_any_column_privilege('authenticated', 'public.glofox_push_events', priv)
       OR has_any_column_privilege('anon', 'public.glofox_push_events', priv) THEN
      RAISE EXCEPTION 'PASSCODEREAD.1: a column-level % on public.glofox_push_events survived for a client role', priv;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
              WHERE table_schema = 'public' AND table_name = 'glofox_push_events' AND grantee = 'PUBLIC') THEN
    RAISE EXCEPTION 'PASSCODEREAD.1: PUBLIC still holds a privilege on public.glofox_push_events';
  END IF;

  -- This migration must NOT narrow contacts (the phone and champ-app read it).
  IF NOT (has_table_privilege('authenticated', 'public.contacts', 'SELECT')
          AND has_table_privilege('authenticated', 'public.contacts', 'UPDATE')) THEN
    RAISE EXCEPTION 'PASSCODEREAD.1: contacts grants changed — this migration must not touch them';
  END IF;

  RAISE NOTICE 'PASSCODEREAD.1 mig 651: Glofox passcodes cleared and CHECK-refused; glofox_push_events is server-only.';
END $$;

COMMIT;
