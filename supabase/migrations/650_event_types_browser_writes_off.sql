-- 650 — EVENTTYPERLS.1b: the browser roles can READ booking types (event_types)
-- as before, and can no longer write them. Every write is a guarded
-- service-role route since EVENTTYPERLS.1a (#1825).
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 28 Sep 2026): the evidence
-- for the fix, not proof it landed. Behaviour is proven ahead of apply by a
-- PGlite replay (tests/migration-650-event-types-browser-writes-off.test.js),
-- which recreates the live grants (Supabase's default privileges), policy,
-- helpers and trigger, shows the hole, runs this file verbatim, asserts
-- everything below, and runs the ROLLBACK recorded at the end of this header.
--
-- THE HOLE. One policy, event_types_location_scoped (mig 014): PERMISSIVE
-- FOR ALL TO authenticated USING/WITH CHECK private.auth_is_in_location(
-- location_id) — true for ANY active member of the studio, whatever their
-- role. With Supabase's default table grants (anon/authenticated arwdDxtm),
-- a plain staff member's own JWT could INSERT, UPDATE and DELETE booking
-- types at their studio: deactivate the live one, point webhook_url at their
-- own endpoint (it receives every booking), flip create_in_glofox. The
-- booking-type form did exactly this with the browser client until
-- EVENTTYPERLS.1a; the routes (POST /api/bookings/event-types,
-- PUT/DELETE /api/bookings/event-types/[id]) allow a master or MANAGER_ROLES
-- at the row's studio only.
--
-- VERIFIED LIVE (28 Sep, BEFORE this migration; re-read 28 Sep ~23:40 UTC
-- after #1825 merged, unchanged):
--   relacl {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--           authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres};
--   every anon/authenticated grant made by postgres; owner postgres; no
--   column ACLs; not in any publication; no dependent view; neither anon nor
--   authenticated is a member of another role; one trigger
--   (event_types_updated_at, BEFORE UPDATE). One policy (above). RLS
--   enabled, not forced. 4 rows, 1 active, 0 with a webhook_url.
--   Latest applied migration 649; no 650.
--
-- CONSUMERS CHECKED (28 Sep, origin/main 048cbc21 = #1825 merged):
--   Writers: only the two routes above, service role
--   (tests/event-types-writers.test.js pins the exact list; EventForm.jsx no
--   longer imports createBrowserClient). No SQL function writes event_types.
--   RLS-bound readers, which keep SELECT with the same predicate:
--     mobile/lib/bookings-api.js:14  bookings → event_types(id, name, duration_minutes, color)
--     mobile/lib/contacts-api.js:139 bookings → event_types(name, color)
--     event_type_reminders' four policies: EXISTS (SELECT 1 FROM event_types et …)
--     champ-app src/lib/load-session-report.js:21,58: bookings → event_types(id, name)
--       (a customer is not a studio member, so the embed is already null).
--   Every other reader is service role (the /bookings pages, the public
--   booking pages, crons, the agent), so neither grants nor policies bind it.
--   SQL: handle_new_booking, log_booking_status_change read it (SECURITY
--   DEFINER). FKs in (blocked_times CASCADE, bookings SET NULL,
--   event_type_reminders CASCADE) run as the owner.
--   un1t-platform, champ-bridge, un1t-sentinel: no reference.
--
-- WHAT THIS FILE DOES (one transaction, the 613/614/618/622/625 convention)
--   * lock_timeout 5s: the policy swap takes an ACCESS EXCLUSIVE lock on a
--     table live bookings read; wait at most 5s for it, then fail (whole file
--     rolls back, re-run later) rather than queue every reader behind us.
--   * DROP event_types_location_scoped (FOR ALL) and CREATE event_types_select
--     (FOR SELECT TO authenticated, the SAME predicate). Same transaction, so
--     readers never see a gap. One permissive policy per (table, command)
--     (CLAUDE.md), no restrictive policy (CLAUDE.md: a restrictive FOR ALL
--     kills SELECT). private.auth_is_in_location already reads
--     (SELECT auth.uid()) inside, so there is no per-row auth.uid() call.
--   * REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER from anon,
--     authenticated and PUBLIC. With no write policy left RLS would refuse the
--     writes anyway; the grants go too so a future permissive write policy
--     cannot silently re-arm them, and because TRUNCATE ignores RLS entirely.
--     REFERENCES/TRIGGER need DDL neither role can issue; revoked so "no
--     write privilege" is the end state a reader checks at a glance (as mig
--     625). MAINTAIN (Postgres 17's `m`: VACUUM/ANALYZE/REINDEX/LOCK, no data
--     write, no PostgREST path) is left as mig 625 left it, so relacl ends at
--     anon=rm/postgres, authenticated=rm/postgres; that is C15 GRANTSWEEP's.
--   * SELECT (table level) is untouched for both roles. anon has no policy,
--     so it reads nothing, as today (anon tidy-up is C15 GRANTSWEEP's).
--     service_role keeps arwdDxtm (it bypasses RLS; the routes use it).
--
-- END STATE, per role and command:
--   authenticated  SELECT   granted; rows where private.auth_is_in_location(location_id)
--                           (a member of the studio, or a master) — unchanged
--   authenticated  INSERT / UPDATE / DELETE / TRUNCATE   42501 permission denied
--   anon           SELECT   granted; 0 rows (no policy admits anon) — unchanged
--   anon           INSERT / UPDATE / DELETE / TRUNCATE   42501 permission denied
--   service_role   everything, RLS bypassed — unchanged
--
-- GRANTOR RULE. A REVOKE removes only grants made by the role issuing it.
-- Every anon/authenticated grant here was made by postgres (read 28 Sep), so
-- apply as postgres (Supabase MCP apply_migration does). A grant from another
-- grantor survives, and the DO block then ABORTS THE WHOLE FILE: revoke it as
-- its grantor first. Verified against the catalog, never this text (mig 153).
--
-- PRE-APPLY and POST-APPLY checks and the staff probe: plan C39
-- (docs/superpowers/plans/2026-09-27-followups/C39-EVENTTYPERLS.1.md,
-- Task 1b-4 Steps 1 and 5). The replay runs the rollback below verbatim.
--
-- ROLLBACK (forward-only: a NEW migration, applied the same way; restores
-- the pre-650 relacl and policy exactly; no data is touched either way):
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   DROP POLICY IF EXISTS event_types_select ON public.event_types;
--   DROP POLICY IF EXISTS event_types_location_scoped ON public.event_types;
--   CREATE POLICY event_types_location_scoped ON public.event_types
--     FOR ALL TO authenticated
--     USING (private.auth_is_in_location(location_id))
--     WITH CHECK (private.auth_is_in_location(location_id));
--   GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.event_types TO anon, authenticated;
--   COMMIT;
-- END ROLLBACK

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS event_types_location_scoped ON public.event_types;
DROP POLICY IF EXISTS event_types_select ON public.event_types;
CREATE POLICY event_types_select ON public.event_types
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.event_types FROM anon, authenticated, PUBLIC;

DO $$
DECLARE
  v_extra text;
  v_role text;
  v_priv text;
  v_policies text;
BEGIN
  -- Anything but SELECT, at table or column level, for the browser roles.
  SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (grantor ' || grantor || ')', ', ')
    INTO v_extra
    FROM (
      SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'event_types'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
      UNION ALL
      SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'event_types'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
    ) g;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'mig 650: anon/authenticated still hold write privileges on public.event_types: %', v_extra;
  END IF;

  -- The same question of the real catalog: has_table_privilege counts
  -- privileges inherited through role membership and from PUBLIC.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.event_types', v_priv) THEN
        RAISE EXCEPTION 'mig 650: % still holds % on public.event_types', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  -- SELECT must survive for authenticated (the phone's embeds, the reminders
  -- policies' EXISTS), service_role must still write (the routes), and RLS
  -- must still be on.
  IF NOT has_table_privilege('authenticated', 'public.event_types', 'SELECT') THEN
    RAISE EXCEPTION 'mig 650: authenticated lost SELECT on public.event_types';
  END IF;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.event_types', v_priv) THEN
      RAISE EXCEPTION 'mig 650: service_role lost % on public.event_types', v_priv;
    END IF;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.event_types'::regclass) THEN
    RAISE EXCEPTION 'mig 650: RLS is off on public.event_types';
  END IF;

  -- Exactly one policy: the permissive SELECT for authenticated.
  SELECT string_agg(policyname || ' ' || cmd || ' ' || permissive || ' ' || roles::text, ', ')
    INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'event_types'
     AND NOT (policyname = 'event_types_select' AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND roles = '{authenticated}'::name[]);
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 650: unexpected policies on public.event_types: %', v_policies;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_types' AND policyname = 'event_types_select') THEN
    RAISE EXCEPTION 'mig 650: event_types_select is missing';
  END IF;
END $$;

COMMIT;
