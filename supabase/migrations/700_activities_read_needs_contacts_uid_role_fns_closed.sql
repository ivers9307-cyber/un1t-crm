-- 700 — SEC-4: reading activities also needs the Contacts permission
-- (C144 ACTREADCONTACTS.1), and two uid-taking role functions closed to
-- signed-in sessions (C143 UIDFNSWEEP.1).
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file (read-only, Supabase MCP, 2 Oct 2026; migs 690 + 691 applied,
-- 699 not yet). Applies before OR after 699 (the replay runs both).
-- Proven ahead of apply by tests/migration-700-sec-4.test.js (PGlite; the
-- real 690 and 691 files first, the bodies and the policy text this file
-- depends on pinned equal to prod's).
--
-- ===========================================================================
-- C144: activities (THE DECISION: Richard, 2 Oct 2026)
-- ===========================================================================
-- "Reading activities also requires Contacts." Every activity row belongs
-- to a contact (a contact's timeline: emails, notes, WhatsApp, calls), so a
-- session that may not read a studio's contacts may not read its activities.
-- VERIFIED LIVE (2 Oct, BEFORE this migration):
--   activities_select, PERMISSIVE SELECT TO authenticated, USING the 691 form
--   (phone Tasks OR phone Pipeline at the studio, InitPlan); insert / update
--   the same; activities_delete auth_is_manager_at. RLS on, not forced; ACL
--   postgres + service_role arwdDxtm, authenticated arwd, anon nothing; not
--   published; no view reads it.
--   74,076 rows; every one has a contact_id; 2,655 have no studio (readable
--   by no client, before and after); 0 are kind = 'task'.
--   Who changes (each active login's memberships, readable before vs after):
--   14 of 20 non-master memberships read activities today, 13 after. The one
--   that stops is an owner membership at a studio whose Contacts switch is
--   off; that studio holds 0 activity rows. A master loses the same studio
--   (0 rows). ROWS LOST BY ANYONE: 0. Nobody gains. (2 of 6 studios have
--   Contacts switched off; both hold 0 activities.)
--   Cost: an owner's count, 26 ms with the 691 filter, 19 ms with the extra
--   InitPlan (same rows).
-- FIX: only USING of activities_select changes, to
--   (<the 691 tasks-or-pipeline form>)
--   AND location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
-- The helper is mig 690's Contacts resolver (web OR phone; 699 adds the
-- org-admin tier); the (SELECT …)::uuid[] makes it an InitPlan, once per
-- statement (the cast is load-bearing: without it ANY ((SELECT …)) parses as
-- the subquery form and fails). Name, command, roles unchanged. Insert,
-- update and delete policies are NOT changed (C144 is about reads), but a
-- write that reads its row back (insert/update … RETURNING, which the phone's
-- tasks and log-activity calls do) needs this SELECT policy too, so for a
-- session with Tasks and no Contacts those calls are refused whole.
--
-- ===========================================================================
-- C143: uid-taking private functions
-- ===========================================================================
-- VERIFIED LIVE (2 Oct): private.get_user_role(uuid) and
-- private.get_user_role_at(uuid, uuid) (mig 626 bodies, normalised md5
-- 5d6b8c9b… and 31c0a9aa…) answer for ANY user id and are EXECUTE for
-- postgres, authenticated, service_role, so a signed-in SQL session could
-- ask another user's role. Schema private is not exposed to PostgREST (406
-- PGRST106, SEC-3), so this was reachable from SQL only. Nothing references
-- either: no policy, no function body (any schema), no view, no trigger, no
-- column default, no constraint, no pg_depend row; no caller in un1t-crm,
-- champ-app, champ-bridge or un1t-sentinel (only old migrations and tests).
-- FIX: REVOKE EXECUTE from authenticated (and PUBLIC / anon, already
-- absent); postgres and service_role keep it; bodies and OIDs unchanged.
--
-- private.auth_can_read_shift_assignment(p_block_id, p_profile_id) is NOT
-- changed: shift_assignments_select calls it as (block_id, profile_id), so
-- authenticated must keep EXECUTE. Its body (mig 614, md5 3780e385…) uses
-- p_profile_id only as `p_profile_id = (SELECT auth.uid())`; every other
-- branch is the CALLER's (manager at the block's studio, or member there
-- once the roster is published). Passing another user's id therefore
-- answers about the caller, never about that user: it already fails closed
-- for a uid that is not the caller's. The replay proves that property.
--
-- APPLY: after merge (no app code depends on it), per
-- docs/superpowers/plans/2026-09-27-followups/SEC-4.md.
-- ===========================================================================

BEGIN;

-- ALTER POLICY takes ACCESS EXCLUSIVE on public.activities. Fail after 5 s
-- rather than queue every read behind this file; re-run later.
SET LOCAL lock_timeout = '5s';
-- pg_policies prints quals relative to the search_path; pinned so the text
-- comparisons hold whatever path the applying session has.
SET LOCAL search_path = public;

-- 0. Pre-checks.
DO $$
DECLARE
  v_old text := $q$((location_id = ANY (( SELECT private.auth_mobile_can_location_ids('tasks'::text) AS auth_mobile_can_location_ids)::uuid[])) OR (location_id = ANY (( SELECT private.auth_mobile_can_location_ids('pipeline'::text) AS auth_mobile_can_location_ids)::uuid[])))$q$;
  v_new text := $q$(((location_id = ANY (( SELECT private.auth_mobile_can_location_ids('tasks'::text) AS auth_mobile_can_location_ids)::uuid[])) OR (location_id = ANY (( SELECT private.auth_mobile_can_location_ids('pipeline'::text) AS auth_mobile_can_location_ids)::uuid[]))) AND (location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])))$q$;
  -- the Contacts helper: mig 690's body (prod, 2 Oct) or mig 699's
  v_contact_690 text := 'bb438f78e24a8630be135418e27fb253';
  v_contact_699 text := '85f3064be28ecc14e3b2c69010b04608';
  v_fn oid := to_regprocedure('private.auth_contact_read_location_ids()');
  v_h text;
  v_bad text;
BEGIN
  -- a. activities_select is the 691 policy (or, on a re-run, this file's)
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'activities' AND policyname = 'activities_select'
                    AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{authenticated}'
                    AND with_check IS NULL AND qual IN (v_old, v_new)) THEN
    RAISE EXCEPTION 'mig 700: activities_select is not the mig 691 policy; re-plan (found: %)',
      (SELECT string_agg(policyname || ' ' || permissive || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-'), ' ; ')
         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'activities');
  END IF;
  -- b. no other policy lets a client read activities (one reader, so the AND binds)
  SELECT string_agg(policyname || ' ' || cmd || ' ' || roles::text, ' ; ') INTO v_bad FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'activities' AND policyname <> 'activities_select'
     AND (cmd IN ('SELECT', 'ALL') OR permissive <> 'PERMISSIVE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 700: activities has another SELECT/ALL or restrictive policy; re-plan: %', v_bad;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.activities'::regclass) THEN
    RAISE EXCEPTION 'mig 700: row level security is off on public.activities';
  END IF;
  IF has_table_privilege('anon', 'public.activities', 'SELECT') THEN
    RAISE EXCEPTION 'mig 700: anon holds SELECT on public.activities; find out why first';
  END IF;
  -- c. the Contacts helper is 690's (or 699's), DEFINER, uuid[], executable by authenticated
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_h FROM pg_proc WHERE oid = v_fn;
  IF v_h IS NULL OR v_h NOT IN (v_contact_690, v_contact_699) THEN
    RAISE EXCEPTION 'mig 700: private.auth_contact_read_location_ids is not the mig 690 / 699 body (normalised md5 %); re-plan', v_h;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef AND provolatile = 's' AND prorettype = 'uuid[]'::regtype)
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 700: private.auth_contact_read_location_ids is not a STABLE SECURITY DEFINER uuid[] function authenticated can execute';
  END IF;
  -- d. the two role functions exist with the mig 626 bodies (prod, 2 Oct) ...
  SELECT string_agg(f, ', ') INTO v_bad FROM (VALUES
      ('private.get_user_role(uuid)', '5d6b8c9bf57b916f1cbfd9ccc4194558'),
      ('private.get_user_role_at(uuid,uuid)', '31c0a9aaab3d9424a3214971d8d746f8')) x(f, h)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(x.f)
                      AND md5(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) = x.h);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 700: not the mig 626 body (or missing): %; re-plan', v_bad;
  END IF;
  -- ... and nothing a client fires calls them (a policy, a function body, a view)
  SELECT string_agg(x, ', ') INTO v_bad FROM (
    SELECT schemaname || '.' || tablename || '.' || policyname AS x FROM pg_policies
     WHERE coalesce(qual, '') || coalesce(with_check, '') ~ 'get_user_role(_at)?\('
    UNION ALL
    SELECT p.oid::regprocedure::text FROM pg_proc p
     WHERE p.prosrc ~ 'get_user_role(_at)?\('
       AND p.oid NOT IN (to_regprocedure('private.get_user_role(uuid)'), to_regprocedure('private.get_user_role_at(uuid,uuid)'))
    UNION ALL
    SELECT c.oid::regclass::text FROM pg_class c WHERE c.relkind IN ('v', 'm') AND pg_get_viewdef(c.oid) ~ 'get_user_role(_at)?\(') s;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 700: something calls private.get_user_role / get_user_role_at; revoking authenticated would break it: %', v_bad;
  END IF;
END $$;

CREATE TEMP TABLE m700_state ON COMMIT DROP AS
  SELECT 'policy:' || policyname AS k, permissive || ' ' || cmd || ' ' || roles::text || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-') AS v
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'activities' AND policyname <> 'activities_select'
  UNION ALL
  SELECT 'table:activities', relacl::text || ' ' || relrowsecurity::text || ' ' || relforcerowsecurity::text
    FROM pg_class WHERE oid = 'public.activities'::regclass
  UNION ALL
  SELECT 'acl:' || p.oid::regprocedure::text, coalesce(p.proacl::text, '-') FROM pg_proc p
   WHERE p.oid IN (to_regprocedure('private.auth_contact_read_location_ids()'), to_regprocedure('private.auth_mobile_can_location_ids(text)'),
                   to_regprocedure('private.auth_can_read_shift_assignment(uuid,uuid)'));

-- 1. C144: the activities read also needs Contacts. Only USING changes.
ALTER POLICY activities_select ON public.activities
  USING ((location_id = ANY ((SELECT private.auth_mobile_can_location_ids('tasks'))::uuid[])
          OR location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]))
         AND location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[]));

-- 2. C143: the uid-taking role functions are not for signed-in sessions.
REVOKE EXECUTE ON FUNCTION private.get_user_role(uuid), private.get_user_role_at(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.get_user_role(uuid), private.get_user_role_at(uuid, uuid) TO service_role;

-- 3. Self-check: the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_new text := $q$(((location_id = ANY (( SELECT private.auth_mobile_can_location_ids('tasks'::text) AS auth_mobile_can_location_ids)::uuid[])) OR (location_id = ANY (( SELECT private.auth_mobile_can_location_ids('pipeline'::text) AS auth_mobile_can_location_ids)::uuid[]))) AND (location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])))$q$;
  v_bad text;
BEGIN
  -- a. activities_select: same name / command / roles, the new USING
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'activities' AND policyname = 'activities_select'
                    AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{authenticated}'
                    AND with_check IS NULL AND qual = v_new) THEN
    RAISE EXCEPTION 'mig 700: activities_select is not the expected policy; found: %',
      (SELECT string_agg(policyname || ' USING ' || coalesce(qual, '-'), ' ; ') FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'activities' AND policyname = 'activities_select');
  END IF;
  -- b. no other activities policy, the table ACL / RLS, or a kept function ACL moved
  SELECT string_agg(k, ', ') INTO v_bad FROM (
    SELECT s.k FROM m700_state s
     WHERE s.v IS DISTINCT FROM coalesce(
       (SELECT permissive || ' ' || cmd || ' ' || roles::text || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-')
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'activities' AND 'policy:' || policyname = s.k),
       (SELECT relacl::text || ' ' || relrowsecurity::text || ' ' || relforcerowsecurity::text
          FROM pg_class WHERE oid = 'public.activities'::regclass AND s.k = 'table:activities'),
       (SELECT coalesce(p.proacl::text, '-') FROM pg_proc p WHERE 'acl:' || p.oid::regprocedure::text = s.k))
    UNION ALL
    SELECT 'new policy:' || policyname FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'activities' AND policyname <> 'activities_select'
       AND NOT EXISTS (SELECT 1 FROM m700_state s WHERE s.k = 'policy:' || policyname)) y;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 700: something besides activities_select''s USING and the two role functions'' EXECUTE changed: %', v_bad;
  END IF;
  -- c. the two role functions: service_role (and the owner) only
  SELECT string_agg(f, ', ') INTO v_bad FROM unnest(ARRAY['private.get_user_role(uuid)', 'private.get_user_role_at(uuid,uuid)']) f
   WHERE has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE')
      OR has_function_privilege('anon', to_regprocedure(f), 'EXECUTE')
      OR has_function_privilege('public', to_regprocedure(f), 'EXECUTE')
      OR NOT has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 700: EXECUTE is not service_role only on: %', v_bad;
  END IF;
  -- d. the shift-assignment helper keeps authenticated (shift_assignments_select calls it)
  IF NOT has_function_privilege('authenticated', to_regprocedure('private.auth_can_read_shift_assignment(uuid,uuid)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 700: authenticated lost EXECUTE on private.auth_can_read_shift_assignment';
  END IF;
  -- e. the helper runs: with no signed-in user it returns no studio
  IF private.auth_contact_read_location_ids() IS DISTINCT FROM '{}'::uuid[] THEN
    RAISE EXCEPTION 'mig 700: the Contacts helper returned studios with no signed-in user';
  END IF;

  RAISE NOTICE 'mig 700: reading activities needs phone Tasks or Pipeline AND Contacts at the studio; get_user_role / get_user_role_at are service_role only.';
END $$;

COMMIT;

-- ===========================================================================
-- ROLLBACK (POST-677; pinned by tests/migration-700-sec-4.test.js)
-- ===========================================================================
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- ALTER POLICY activities_select ON public.activities
--   USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('tasks'))::uuid[])
--          OR location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]));
-- GRANT EXECUTE ON FUNCTION private.get_user_role(uuid), private.get_user_role_at(uuid, uuid) TO authenticated;
-- COMMIT;
-- ===========================================================================
