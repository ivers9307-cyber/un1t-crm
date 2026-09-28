-- 657 — ANONCONTACTS.1: signed-out callers (anon) hold nothing on
-- public.contacts, and public.consent_drift_rows() is server-only.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file (read-only, Supabase MCP, 29 Sep 2026). Proven ahead of apply by
-- tests/migration-657-anon-contacts-consent-drift-closed.test.js (PGlite).
--
-- ===========================================================================
-- THE FINDING (follow-ups C56, found planning C49: F4 + F5)
-- ===========================================================================
-- 1. anon kept Supabase's default table privileges on contacts (SELECT and
--    MAINTAIN after mig 653). contacts_select is TO public and calls
--    private.auth_is_in_location, which anon may not execute (no USAGE on
--    schema private either), so every anon read ERRORS:
--      42501 permission denied for function auth_is_in_location
--    Shut by an accident in the policy, not by the grant. A helper grant
--    change, or a new TO public policy that does not call it, would open
--    every contact to the public anon key.
-- 2. consent_drift_rows() (SECURITY INVOKER, returns contact_id, location_id
--    and EMAIL of consent-drifted contacts) carried EXECUTE for PUBLIC, anon,
--    authenticated and service_role. Its only caller is the service-role
--    cron /api/cron/consent-drift-check. A staff session got the drifted
--    emails at its studio; anon got 0 rows. 0 drift rows estate-wide today.
--
-- VERIFIED LIVE (29 Sep): no request with the anon role on /rest/v1/* in
-- three 24 h edge-log windows; /rest/v1/rpc/consent_drift_rows called only
-- by service_role (daily). No SECURITY DEFINER function in public is
-- executable by anon. Views over contacts: contact_location_audience only
-- (security_invoker: an anon read of it now fails on the contacts grant).
-- Re-read after 653 was applied (29 Sep): relacl {postgres=arwdDxtm/postgres,
-- anon=rm/postgres,authenticated=rm/postgres,service_role=arwdDxtm/postgres},
-- every item granted by postgres, no column ACLs, anon and authenticated
-- members of no role; contacts_select SELECT {public} the only policy;
-- consent_drift_rows() proacl as above, called by no other function.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE ALL ON contacts FROM anon, PUBLIC (authenticated untouched: the
--   phone, champ-app and the CRM browser read it signed in).
--   REVOKE EXECUTE ON consent_drift_rows() FROM PUBLIC, anon, authenticated
--   (service_role keeps its own EXECUTE).
--   Pre-check: mig 653 must already be applied (its self-check asserts anon
--   keeps SELECT on contacts; running this first would make 653 abort).
--
-- Guard: tests/anon-contacts-guard.test.js.
-- APPLY: after merge AND after 653 is applied; see
-- docs/superpowers/plans/2026-09-27-followups/C56-ANONCONTACTS.1.md, Task 5.
-- ===========================================================================

BEGIN;

-- REVOKE on contacts locks the hottest table briefly. Fail rather than queue.
SET LOCAL lock_timeout = '5s';

-- Order: 653 first.
DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.contacts', 'UPDATE') THEN
    RAISE EXCEPTION 'mig 657: apply 653_contacts_client_writes_off first (653''s self-check requires anon SELECT on public.contacts)';
  END IF;
END $$;

REVOKE ALL ON TABLE public.contacts FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.consent_drift_rows() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text. Any failure raises and the
-- whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_extra text;
  v_role text;
  v_priv text;
BEGIN
  -- 1. No anon/PUBLIC entry at table or column level (information_schema
  --    lists role NAMES, so another grantor's entry shows here).
  SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
    INTO v_extra
    FROM (
      SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'contacts' AND grantee IN ('anon', 'PUBLIC')
      UNION ALL
      SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'contacts' AND grantee IN ('anon', 'PUBLIC')
    ) g;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'mig 657: anon/PUBLIC still hold privileges on public.contacts: %', v_extra;
  END IF;

  -- 2. The raw ACL (MAINTAIN is not in information_schema).
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
              WHERE c.oid = 'public.contacts'::regclass
                AND (a.grantee = 0 OR a.grantee = 'anon'::regrole::oid)) THEN
    RAISE EXCEPTION 'mig 657: the public.contacts ACL still names anon or PUBLIC';
  END IF;

  -- 3. The real question, per privilege (follows role membership and PUBLIC).
  FOREACH v_role IN ARRAY ARRAY['anon', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF has_table_privilege(v_role, 'public.contacts', v_priv) THEN
        RAISE EXCEPTION 'mig 657: % still holds % on public.contacts', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  IF has_any_column_privilege('anon', 'public.contacts', 'SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'mig 657: anon still holds a column-level privilege on public.contacts';
  END IF;

  -- 4. Signed-in reads and the server path unchanged.
  IF NOT has_table_privilege('authenticated', 'public.contacts', 'SELECT') THEN
    RAISE EXCEPTION 'mig 657: authenticated lost SELECT on public.contacts';
  END IF;
  IF NOT (has_table_privilege('service_role', 'public.contacts', 'SELECT')
          AND has_table_privilege('service_role', 'public.contacts', 'UPDATE')) THEN
    RAISE EXCEPTION 'mig 657: service_role lost SELECT or UPDATE on public.contacts';
  END IF;

  -- 5. consent_drift_rows(): service_role only.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    IF has_function_privilege(v_role, 'public.consent_drift_rows()', 'EXECUTE') THEN
      RAISE EXCEPTION 'mig 657: % can still execute public.consent_drift_rows()', v_role;
    END IF;
  END LOOP;
  IF (SELECT proacl IS NULL FROM pg_proc WHERE oid = 'public.consent_drift_rows()'::regprocedure)
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = 'public.consent_drift_rows()'::regprocedure AND a.grantee = 0) THEN
    RAISE EXCEPTION 'mig 657: public.consent_drift_rows() still carries the PUBLIC default';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.consent_drift_rows()', 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 657: service_role lost EXECUTE on public.consent_drift_rows() (the consent-drift cron needs it)';
  END IF;

  RAISE NOTICE 'mig 657: anon holds nothing on public.contacts; consent_drift_rows() is service_role only.';
END $$;

COMMIT;
