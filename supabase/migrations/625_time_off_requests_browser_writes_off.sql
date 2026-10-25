-- 625 — LEAVEGUARD.1: the browser loses INSERT (and DELETE, TRUNCATE,
-- REFERENCES, TRIGGER) on time_off_requests; the dead INSERT and UPDATE
-- policies go. End state: a SELECT grant and exactly one SELECT policy.
--
-- NOT APPLIED YET. Apply AFTER mig 624 (which revoked UPDATE; this file's
-- self-check asserts the end state of both). No code in this PR depends on it:
-- every writer of this table is a service-role route, which grants do not bind.
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-625-time-off-requests-browser-writes-off.test.js), which
-- recreates the prod grants and policies, shows the hole is real, runs 624 and
-- this file verbatim, and asserts everything the header claims.
--
-- THE HOLE. "Staff can create own time off" (mig 048, TO authenticated since
-- mig 050, "intentionally retained" by mig 320) checks only
-- profile_id = auth.uid(). So any signed-in client holding the anon key can
-- INSERT its own row with status = 'approved' (and reviewed_by = anyone, and
-- any total_days). The allowance trigger trg_update_holiday_allowance
-- (mig 011, body mig 616) is AFTER UPDATE only, so NOTHING is charged: approved
-- holiday that never touches the balance, and that every reader (roster
-- copy-week skip, clashes, calendars) treats as real leave. LEAVE.5 already
-- noticed the trigger's blind spot for the on-behalf POST and inserts pending
-- then updates; the browser door was never closed.
--
-- CONSUMERS CHECKED (22 Sep 2026, this branch):
--   src/ mobile/ shared/ — every .from('time_off_requests') write:
--     src/app/api/schedule/time-off/route.js                    .insert (POST), .update (approveRecordedLeave)
--     src/app/api/schedule/time-off/[id]/route.js               .update x2 (PUT, the cancel ask)
--     src/app/api/schedule/time-off/[id]/cancel-request/route.js .update x2
--   all through createServerClient() (service_role). No .upsert and no .delete
--   anywhere. The only RLS-bound reader is shared/dashboard-data.js (the
--   phone, anon-key client): a SELECT of id/type/start_date/end_date/status/
--   created_at, kept by this file.
--   supabase/migrations — no function INSERTs into, DELETEs from or TRUNCATEs
--   this table. tombstone_staff_profile() (mig 622) UPDATEs it and runs as
--   service_role. The profiles -> time_off_requests ON DELETE CASCADE runs as
--   the table owner (RI triggers), so no grant here affects it.
--   supabase/functions — no reference.
--   champ-app, un1t-platform: NOT read by this branch; the owner checks them
--   before apply (mig 624's own sweep of 21 Sep found no writer there).
--
-- WHAT THIS FILE DOES
--   * REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER from anon,
--     authenticated and PUBLIC. UPDATE is already gone after mig 624; it is
--     named again so the end state is this file's claim and not an ordering
--     assumption (a no-op when 624 ran first).
--       - DELETE: no policy grants it, so RLS refuses it today; the grant
--         behind it is dead weight, and a future permissive DELETE policy
--         would silently arm it.
--       - TRUNCATE bypasses RLS entirely. PostgREST cannot issue it, but a
--         SECURITY INVOKER function that TRUNCATEs would run with it.
--       - REFERENCES / TRIGGER: harmless today (a FK or a trigger needs DDL,
--         which neither role can issue through PostgREST), revoked anyway
--         because nothing uses them and "exactly SELECT" is the end state a
--         reader can check at a glance. Same call as mig 622 on profiles.
--   * SELECT is untouched (table and column level): the phone reads it.
--   * DROP POLICY "Staff can create own time off": with no INSERT grant behind
--     it, a policy that reads "staff can create" is misleading.
--   * DROP POLICY "time_off_requests_update" (mig 600): the same shape, with
--     no UPDATE grant behind it since mig 624. A policy is inert without a
--     grant, but it would silently re-arm the browser write the day anyone
--     re-granted UPDATE.
--
-- GRANTOR RULE. A REVOKE removes only grants made by the role issuing it.
-- Every anon/authenticated grant on this table was granted by `postgres`
-- (read 21 Sep 2026, owner `postgres`), so apply as postgres (Supabase MCP
-- apply_migration does). A grant from any other grantor survives the REVOKE,
-- and the DO block below then ABORTS THE WHOLE FILE: revoke it as its grantor
-- first. One explicit transaction, so an abort leaves nothing applied (the
-- 613/614/618/622/624 convention); verified against the catalog, never
-- against this text (the mig 153 lesson).
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; re-run IMMEDIATELY before applying, stop if
-- any answer differs from "Expected")
-- ─────────────────────────────────────────────────────────────────────────
-- (a) Mig 624 is applied (UPDATE already revoked):
--       SELECT has_table_privilege('authenticated','public.time_off_requests','UPDATE');   -- false
--
-- (b) The grants this file revokes. KEEP THE OUTPUT, it is the rollback recipe:
--       SELECT grantor, grantee, privilege_type, NULL AS column_name
--         FROM information_schema.table_privileges
--        WHERE table_schema='public' AND table_name='time_off_requests'
--          AND grantee IN ('anon','authenticated','PUBLIC')
--       UNION ALL
--       SELECT grantor, grantee, privilege_type, column_name
--         FROM information_schema.column_privileges
--        WHERE table_schema='public' AND table_name='time_off_requests'
--          AND grantee IN ('anon','authenticated','PUBLIC') AND privilege_type <> 'SELECT'
--        ORDER BY 2, 3, 4;
--     Expected (prod as read 21 Sep, once 624 has run): for each of anon and
--     authenticated, grantor postgres: DELETE, INSERT, REFERENCES, SELECT,
--     TRIGGER, TRUNCATE. No PUBLIC rows. No column rows. Any grantor other
--     than postgres: stop (see GRANTOR RULE).
--
-- (c) The policies. KEEP THE OUTPUT (qual / with_check) alongside (b):
--       SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
--        WHERE schemaname='public' AND tablename='time_off_requests' ORDER BY 1;
--     Expected: "Staff can create own time off" INSERT {authenticated},
--     time_off_requests_select SELECT, time_off_requests_update UPDATE, the
--     last matching mig 600 (the rollback recipe below recreates it from there).
--
-- (d) Forensics, not a blocker: rows that look browser-inserted (approved
--     with no reviewer: every route stamps reviewed_by when it approves):
--       SELECT id, profile_id, type, start_date, end_date, total_days, created_at
--         FROM public.time_off_requests
--        WHERE status = 'approved' AND reviewed_by IS NULL ORDER BY created_at;
--     Expected: 0 rows. A row is a CANDIDATE (older code may once have
--     approved without stamping a reviewer), not proof; if it is a holiday,
--     check its allowance was charged, report it to the owner, and do not
--     "fix" it in this apply.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (e) SELECT r AS role, p AS privilege, has_table_privilege(r, 'public.time_off_requests', p) AS held
--       FROM unnest(ARRAY['anon','authenticated']) r,
--            unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
--      ORDER BY 1, 2;
--     Expected: held = true for SELECT only, for both roles. (has_table_privilege
--     reads the real catalog, privileges inherited through role membership and
--     PUBLIC included, which information_schema does not always list.)
--       SELECT has_table_privilege('service_role','public.time_off_requests','INSERT');   -- true
-- (f) SELECT policyname, cmd FROM pg_policies
--      WHERE schemaname='public' AND tablename='time_off_requests' ORDER BY 1;
--     Expected: exactly one row, time_off_requests_select SELECT.
-- (g) get_advisors (type = security). Expected: nothing new.
-- (h) Smoke, once deployed: file a leave request as a coach from the web and
--     from the phone (both go through POST /api/schedule/time-off): 201.
--
-- ROLLBACK (only if a real browser writer turns up): re-grant exactly what
-- (b) listed, as postgres, and recreate the policies as mig 048/050 and mig
-- 600 left them:
--   GRANT INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.time_off_requests TO anon, authenticated;
--   CREATE POLICY "Staff can create own time off" ON public.time_off_requests
--     FOR INSERT TO authenticated WITH CHECK (profile_id = (SELECT auth.uid()));
--   CREATE POLICY "time_off_requests_update" ON public.time_off_requests
--     FOR UPDATE TO authenticated
--     USING (
--       private.auth_is_manager_at(location_id)
--       OR (profile_id = (SELECT auth.uid()) AND status = 'pending'::text)
--     )
--     WITH CHECK (
--       private.auth_is_manager_at(location_id)
--       OR status = 'cancelled'::text
--     );
-- (The UPDATE GRANT stays revoked: that is mig 624's, and re-granting it
-- reopens 624's hole. The recreated UPDATE policy is inert without it.)

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.time_off_requests FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS "Staff can create own time off" ON public.time_off_requests;
DROP POLICY IF EXISTS "time_off_requests_update" ON public.time_off_requests;

DO $$
DECLARE
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
BEGIN
  -- Anything but SELECT, at table or column level, for the browser roles.
  SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (grantor ' || grantor || ')', ', ')
    INTO v_extra
    FROM (
      SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'time_off_requests'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
      UNION ALL
      SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'time_off_requests'
         AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
    ) g;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'mig 625: anon/authenticated still hold write privileges on public.time_off_requests: %', v_extra;
  END IF;

  -- The same question asked of the real catalog: has_table_privilege counts
  -- privileges inherited through role membership and from PUBLIC, which the
  -- information_schema views above do not always list. Insurance.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.time_off_requests', v_priv) THEN
        RAISE EXCEPTION 'mig 625: % still holds % on public.time_off_requests', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  -- SELECT must survive for both browser roles (the phone reads this table
  -- with the anon key; anon's own read is refused by RLS, as today).
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT has_table_privilege(v_role, 'public.time_off_requests', 'SELECT') THEN
      RAISE EXCEPTION 'mig 625: % lost SELECT on public.time_off_requests', v_role;
    END IF;
  END LOOP;

  -- No policy may be left that would arm a write if a grant came back.
  SELECT string_agg(policyname || ' ' || cmd, ', ')
    INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'time_off_requests'
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 625: write policies remain on public.time_off_requests: %', v_policies;
  END IF;
END $$;

COMMIT;
