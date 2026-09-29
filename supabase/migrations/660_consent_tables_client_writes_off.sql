-- 660 — CONSENTCLIENTWRITE.1: no browser or phone session writes consent
-- (public.contact_preferences, public.contact_location_preferences,
-- public.consent_log).
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 29 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-660-consent-tables-client-writes-off.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C64, found planning C56)
-- ===========================================================================
-- All three tables kept Supabase's default table privileges (anon and
-- authenticated: arwdDxtm, from postgres) and ONE permissive FOR ALL policy
-- TO authenticated each (migs 014, 487):
--   contact_preferences_location_scoped           auth_is_in_location(location_id)
--   contact_location_preferences_location_scoped  auth_is_in_location(location_id)
--   consent_log_via_contact                       EXISTS (contact at an auth_is_in_location studio)
-- auth_is_in_location checks studio membership, not role. So ANY active
-- staff member (plain staff and head coaches included) could, from their own
-- login: re-subscribe a customer who had opted out (the SECURITY DEFINER
-- mirror triggers then copy it onto contacts.email_marketing /
-- email_administrative / whatsapp_marketing, which mig 653 made read-only for
-- clients, and onto the home-studio list row); turn off transactional
-- messages; rotate or delete the unsubscribe token (breaking every link
-- already sent); add any contact to their studio's marketing list; and
-- delete or forge consent_log, the audit. None of it wrote consent_log
-- truthfully. The legitimate staff path, /api/contacts/[id]/marketing-
-- preferences, allows master/owner/manager at the contact's studio, marketing
-- channels only, and logs 'admin_panel' + performed_by.
--
-- VERIFIED LIVE (29 Sep, BEFORE this migration):
--   relacl on all three {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--   authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}; no
--   column ACLs; RLS on, not forced; in no publication. A plain staff
--   member's EXPLAIN UPDATE on the two preference tables and EXPLAIN DELETE
--   on consent_log all plan (the privilege check passes; the policy is the
--   only filter). Edge logs (four 24 h windows): every request on the three
--   tables and contact_location_audience was service_role. Members have no
--   profiles row, so no policy ever admitted them.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN
--   (PG 17's `m`: VACUUM/ANALYZE/REINDEX/LOCK) from anon, authenticated,
--   PUBLIC on the three tables. Replace each FOR ALL policy with a FOR SELECT
--   TO authenticated policy with the SAME expression, so reads are unchanged
--   (the self-check compares the expressions). SELECT privileges are NOT
--   changed. End state per table: anon=r, authenticated=r, one policy
--   <table>_select.
--
--   Every writer is service_role: the consent routes (/api/contacts/[id]/
--   marketing-preferences, /api/preferences/[token], /api/unsubscribe/[token]),
--   marketing-consent.js (forms, bookings, events, leads, WhatsApp Flow, the
--   Postmark webhook), whatsapp-consent.js (STOP/START), consent-propagation,
--   host-consent, the admin import and merge_contacts. The triggers are
--   unchanged: the DEFINER mirrors and create-on-insert pair run as postgres;
--   auto_unsubscribe_classpass (INVOKER, on contacts) runs as the contacts
--   writer, which is service_role since mig 653. FK cascades run as the
--   table owner.
--
-- CONSUMERS CHECKED (origin/main e44e8ae2; champ-app 828ce00 + its whole
-- history; un1t-platform, champ-bridge, un1t-sentinel, un1t-pi,
-- un1t-finance-agent): no browser, createAuthClient, phone (any bundle) or
-- other-repo code reads or writes the three tables. The member app's
-- notification screen writes contacts.push_prefs through a route, not these.
--
-- Guard: tests/consent-tables-client-writes-guard.test.js.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C64-CONSENTCLIENTWRITE.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP/CREATE POLICY take ACCESS EXCLUSIVE on tables the campaign sender,
-- the unsubscribe routes and contact creation touch. Abort after 5 s rather
-- than queue a send or an unsubscribe behind this file. Nothing is
-- half-applied: re-run later. Tables are taken in the order the triggers
-- take them (contact_preferences, then contact_location_preferences).
SET LOCAL lock_timeout = '5s';

-- The read rule each FOR ALL policy applies today, as this session renders
-- it, so the self-check can prove the new SELECT policies read the same rows.
-- Empty on a re-run (the old policies are gone), which skips that check.
CREATE TEMP TABLE mig660_old_read_rule ON COMMIT DROP AS
  SELECT tablename::text AS tablename, qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (tablename, policyname) IN (
       ('contact_preferences', 'contact_preferences_location_scoped'),
       ('contact_location_preferences', 'contact_location_preferences_location_scoped'),
       ('consent_log', 'consent_log_via_contact'));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.contact_preferences, public.contact_location_preferences, public.consent_log
  FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS contact_preferences_location_scoped ON public.contact_preferences;
DROP POLICY IF EXISTS contact_preferences_select ON public.contact_preferences;
CREATE POLICY contact_preferences_select ON public.contact_preferences
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

DROP POLICY IF EXISTS contact_location_preferences_location_scoped ON public.contact_location_preferences;
DROP POLICY IF EXISTS contact_location_preferences_select ON public.contact_location_preferences;
CREATE POLICY contact_location_preferences_select ON public.contact_location_preferences
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

DROP POLICY IF EXISTS consent_log_via_contact ON public.consent_log;
DROP POLICY IF EXISTS consent_log_select ON public.consent_log;
CREATE POLICY consent_log_select ON public.consent_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contacts c
                  WHERE c.id = consent_log.contact_id AND private.auth_is_in_location(c.location_id)));

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl text;
  v_rel text;
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
  v_old text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['contact_preferences', 'contact_location_preferences', 'consent_log'] LOOP
    v_rel := 'public.' || v_tbl;

    -- 1. Anything but SELECT, at table or column level, for the client roles, from any grantor.
    SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
      INTO v_extra
      FROM (
        SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl
           AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
        UNION ALL
        SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl
           AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
      ) g;
    IF v_extra IS NOT NULL THEN
      RAISE EXCEPTION 'mig 660: anon/authenticated/PUBLIC still hold write privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The same question asked of the real catalog (role membership, PUBLIC),
    --    one privilege per call. MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 660: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. No column-level write privilege through any path, one privilege per call.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 660: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 4. Reads unchanged; the server still reads and writes.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF NOT has_table_privilege(v_role, v_rel, 'SELECT') THEN
        RAISE EXCEPTION 'mig 660: % lost SELECT on %', v_role, v_rel;
      END IF;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 660: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 5. No write policy left; exactly one policy, the new SELECT one.
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname)
      INTO v_policies
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_tbl
       AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');
    IF v_policies IS NOT NULL THEN
      RAISE EXCEPTION 'mig 660: write policies remain on %: %', v_rel, v_policies;
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public' AND tablename = v_tbl
                         AND policyname = v_tbl || '_select' AND cmd = 'SELECT'
                         AND permissive = 'PERMISSIVE' AND roles = ARRAY['authenticated']::name[]) THEN
      RAISE EXCEPTION 'mig 660: % should keep exactly one policy, %_select FOR SELECT', v_rel, v_tbl;
    END IF;

    -- 6. The new SELECT policy reads exactly what the FOR ALL policy read.
    SELECT qual INTO v_old FROM mig660_old_read_rule WHERE tablename = v_tbl;
    IF FOUND AND NOT EXISTS (SELECT 1 FROM pg_policies
                              WHERE schemaname = 'public' AND tablename = v_tbl
                                AND policyname = v_tbl || '_select' AND qual = v_old) THEN
      RAISE EXCEPTION 'mig 660: %_select does not read the same rows as the policy it replaces', v_tbl;
    END IF;
  END LOOP;

  RAISE NOTICE 'mig 660: contact_preferences, contact_location_preferences and consent_log are read-only for anon/authenticated (one SELECT policy each, same rows); every write is service_role or a trigger.';
END $$;

COMMIT;
