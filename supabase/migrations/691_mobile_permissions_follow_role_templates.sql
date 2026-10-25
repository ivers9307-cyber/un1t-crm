-- 691 — MOBILECANTEMPLATES.1: phone-direct RLS resolves the phone permission
-- exactly like the app, role templates included, once per statement.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file (read-only, Supabase MCP, 1-2 Oct 2026, with mig 678 applied).
-- Proven ahead of apply by tests/migration-691-mobile-can-templates.test.js
-- (PGlite; it checks the SQL against the real hasMobilePermissionForLocation
-- over 37,500 cases).
--
-- ===========================================================================
-- THE DEFECT (follow-ups C131, found planning C53)
-- ===========================================================================
-- VERIFIED LIVE (2 Oct, BEFORE this migration):
--   15 policies on activities, bookings, deals, notes, whatsapp_conversations,
--   whatsapp_messages and whatsapp_templates call
--   private.auth_mobile_can(location_id, key) PER ROW. Behind it,
--   private.mobile_can_for (migs 218, 626) knew the studio switch, master, the
--   per-user .mobile override and private.mobile_permission_defaults, but NOT
--   the role templates (location_role_permissions, migs 364 and 367) that
--   resolvePermission has applied since July; and the defaults table had no
--   reception rows. So:
--     2 head-coach memberships whose 'all' template turns phone WhatsApp off
--       read 1,398 conversations and 2,661 messages;
--     6 contractor memberships whose employment-type template turns phone
--       Tasks off read 70,680 activities;
--     1 fte membership whose template turns phone Bookings ON read none.
--   The app already hid (or showed) those screens; only the data layer was
--   wrong. Nobody who loses access holds a screen that reads it (C131 plan §4,
--   re-counted 2 Oct).
--   Per-row cost: counting one studio's activities as an owner took 25.7 s.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   private.mobile_can_location_ids_for(p_uid, perm_key) -> uuid[]: the studios
--   where that user holds that PHONE key, mirroring
--   hasMobilePermissionForLocation -> resolvePermission (shared/permissions.js)
--   tier by tier:
--     1. the studio's features[key] (explicit false denies, masters too) and
--        the bundle layer (denied when every bundle owning the key is
--        explicitly false; check:bundle-sql keeps the seed = KEY_BUNDLES);
--     2. master: every studio past tier 1;
--     3. otherwise a profile_locations row there, and the first tier that
--        states the key under "mobile", each only as a JSON boolean and only
--        when "mobile" is a JSON object (JS: key in obj, === true):
--          per-user override -> employment-type template (role at the studio,
--          profiles.employment_type) -> 'all' template -> the role default
--          (private.mobile_permission_defaults; absent = false).
--   Active, non-deleted profiles only (mig 626).
--   private.auth_mobile_can_location_ids(perm_key) = the core for auth.uid().
--   The 15 policies: location_id = ANY ((SELECT wrapper('<key>'))::uuid[]),
--   an InitPlan, once per statement. Only USING / WITH CHECK change. The
--   ::uuid[] is load-bearing: without it Postgres parses ANY ((SELECT ...))
--   as the subquery form (uuid = each row's uuid[]) and refuses it.
--   private.mobile_can_for and private.auth_mobile_can keep their signatures,
--   OIDs and ACLs and delegate to the core (no policy calls them any more).
--   private.mobile_permission_defaults: replaced in full from
--   DEFAULT_MOBILE_PERMISSIONS_BY_ROLE (adds reception; 16 rows unchanged).
--   EXECUTE: since mig 678 a new private function is executable by
--   authenticated and service_role; the core is narrowed to service_role
--   (only the DEFINER wrappers, as their owner, reach it), the wrapper keeps
--   authenticated + service_role. No table privilege changes.
--
-- Guards: tests/mobile-can-templates-guard.test.js (defaults = JS map; no
-- per-row form in a later policy; the core keeps its tiers),
-- tests/rls-active-staff-gate.test.js (the active-staff predicate).
-- APPLY: after merge, per
-- docs/superpowers/plans/2026-09-27-followups/C131-MOBILECANTEMPLATES.1.md
-- (Task 5 probes, EXPLAIN and the rollback record).
-- ===========================================================================

BEGIN;

-- ALTER POLICY takes ACCESS EXCLUSIVE on seven tables, three of them in
-- realtime. Fail after 5 s rather than queue every read behind this file.
SET LOCAL lock_timeout = '5s';
-- pg_policies prints quals relative to the search_path; pinned so the
-- self-check's text comparison holds whatever path the applying session has.
SET LOCAL search_path = public;

CREATE TEMP TABLE m691_policies (tbl text, pol text, cmd text, k text) ON COMMIT DROP;
INSERT INTO m691_policies VALUES
  ('activities', 'activities_select', 'SELECT', 'act'), ('activities', 'activities_insert', 'INSERT', 'act'),
  ('activities', 'activities_update', 'UPDATE', 'act'),
  ('bookings', 'bookings_select', 'SELECT', 'bookings'), ('bookings', 'bookings_insert', 'INSERT', 'bookings'),
  ('bookings', 'bookings_update', 'UPDATE', 'bookings'),
  ('deals', 'deals_select', 'SELECT', 'pipeline'), ('deals', 'deals_insert', 'INSERT', 'pipeline'),
  ('deals', 'deals_update', 'UPDATE', 'pipeline'),
  ('notes', 'notes_select', 'SELECT', 'pipeline'), ('notes', 'notes_insert', 'INSERT', 'pipeline'),
  ('notes', 'notes_update', 'UPDATE', 'pipeline'),
  ('whatsapp_conversations', 'wa_conv_select', 'SELECT', 'whatsapp'),
  ('whatsapp_messages', 'wa_msg_select', 'SELECT', 'whatsapp'),
  ('whatsapp_templates', 'wa_tmpl_select', 'SELECT', 'whatsapp');

-- The old and new expression texts, as pg_policies prints them.
CREATE TEMP TABLE m691_texts ON COMMIT DROP AS
  SELECT k,
    CASE WHEN k = 'act'
      THEN '(private.auth_mobile_can(location_id, ''tasks''::text) OR private.auth_mobile_can(location_id, ''pipeline''::text))'
      ELSE format('private.auth_mobile_can(location_id, %L::text)', k) END AS old_text,
    CASE WHEN k = 'act'
      THEN '((location_id = ANY (( SELECT private.auth_mobile_can_location_ids(''tasks''::text) AS auth_mobile_can_location_ids)::uuid[])) OR (location_id = ANY (( SELECT private.auth_mobile_can_location_ids(''pipeline''::text) AS auth_mobile_can_location_ids)::uuid[])))'
      ELSE format('(location_id = ANY (( SELECT private.auth_mobile_can_location_ids(%L::text) AS auth_mobile_can_location_ids)::uuid[]))', k) END AS new_text
  FROM (SELECT DISTINCT k FROM m691_policies) x;

-- 0. Pre-checks.
DO $$
DECLARE
  v_norm text;
  v_bad text;
BEGIN
  -- a. the 15 policies exist, PERMISSIVE, TO authenticated, old (or, on a re-run, new) text
  SELECT string_agg(p.tbl || '.' || p.pol, ', ') INTO v_bad
    FROM m691_policies p JOIN m691_texts t USING (k)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies g
      WHERE g.schemaname = 'public' AND g.tablename = p.tbl AND g.policyname = p.pol
        AND g.cmd = p.cmd AND g.permissive = 'PERMISSIVE' AND g.roles::text = '{authenticated}'
        AND (p.cmd = 'INSERT' OR g.qual IN (t.old_text, t.new_text))
        AND (p.cmd = 'SELECT' OR g.with_check IN (t.old_text, t.new_text)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 691: these policies are not the 1 Oct texts; re-plan: %', v_bad;
  END IF;
  -- b. nothing else calls the per-row resolver
  SELECT string_agg(g.tablename || '.' || g.policyname, ', ') INTO v_bad
    FROM pg_policies g
   WHERE coalesce(g.qual, '') || coalesce(g.with_check, '') ~ '(auth_mobile_can\(|mobile_can_for\()'
     AND NOT EXISTS (SELECT 1 FROM m691_policies p WHERE p.tbl = g.tablename AND p.pol = g.policyname AND g.schemaname = 'public');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 691: a policy outside the 15 calls the per-row phone resolver; re-plan: %', v_bad;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.prosrc ~ 'mobile_can_for\(' AND p.proname NOT IN ('mobile_can_for', 'auth_mobile_can');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 691: another function calls mobile_can_for; re-plan: %', v_bad;
  END IF;
  -- c. the two bodies this file replaces (normalised: comments and whitespace removed)
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_norm
    FROM pg_proc WHERE oid = to_regprocedure('private.mobile_can_for(uuid,uuid,text)');
  IF v_norm IS NULL OR (v_norm <> 'ceb961b928947022d840db8fe244c470'
       AND NOT (SELECT prosrc ~ 'mobile_can_location_ids_for\(' FROM pg_proc WHERE oid = to_regprocedure('private.mobile_can_for(uuid,uuid,text)'))) THEN
    RAISE EXCEPTION 'mig 691: private.mobile_can_for is not the mig 626 body (normalised md5 %); re-plan', v_norm;
  END IF;
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_norm
    FROM pg_proc WHERE oid = to_regprocedure('private.auth_mobile_can(uuid,text)');
  IF v_norm IS NULL OR (v_norm <> '590307b91d424da4441cf8d91fde1746'
       AND NOT (SELECT prosrc ~ 'mobile_can_location_ids_for\(' FROM pg_proc WHERE oid = to_regprocedure('private.auth_mobile_can(uuid,text)'))) THEN
    RAISE EXCEPTION 'mig 691: private.auth_mobile_can is not the mig 550 body (normalised md5 %); re-plan', v_norm;
  END IF;
  -- d. the inputs: templates stay server-written; the columns exist
  IF to_regclass('public.location_role_permissions') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.location_role_permissions'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'location_role_permissions') THEN
    RAISE EXCEPTION 'mig 691: public.location_role_permissions has a policy or no RLS; role templates now decide RLS, so no client may write them';
  END IF;
  IF has_any_column_privilege('authenticated', 'public.profiles', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.profiles', 'INSERT')
     OR has_any_column_privilege('anon', 'public.profiles', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.profiles', 'INSERT') THEN
    RAISE EXCEPTION 'mig 691: a client role can write public.profiles (role / employment_type now decide RLS); find out why first';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
        AND (table_name, column_name) IN (('profiles', 'employment_type'), ('profiles', 'role'), ('profiles', 'active'),
              ('profiles', 'deleted_at'), ('profile_locations', 'permissions'), ('profile_locations', 'role'),
              ('locations', 'features'), ('location_role_permissions', 'employment_type'),
              ('location_role_permissions', 'role'), ('location_role_permissions', 'permissions'))) <> 10 THEN
    RAISE EXCEPTION 'mig 691: a column the resolver reads is missing; re-plan';
  END IF;
  -- e. the bundle seed covers the four keys (check:bundle-sql keeps it = KEY_BUNDLES)
  IF (SELECT count(DISTINCT key) FROM private.permission_key_bundles WHERE key IN ('pipeline', 'tasks', 'bookings', 'whatsapp')) <> 4 THEN
    RAISE EXCEPTION 'mig 691: private.permission_key_bundles lacks a row for one of the four keys (run check:bundle-sql)';
  END IF;
  -- f. the defaults are the 1 Oct seed (16 rows) or, on a re-run, this file's (20)
  IF NOT (
       (SELECT count(*) FROM private.mobile_permission_defaults) IN (16, 20)
       AND NOT EXISTS (
         SELECT 1 FROM private.mobile_permission_defaults d
          WHERE (d.role <> 'reception'
                 AND d.allowed IS DISTINCT FROM (d.role IN ('owner', 'manager', 'head_coach') OR d.key = 'tasks'))
             OR d.key NOT IN ('pipeline', 'tasks', 'bookings', 'whatsapp'))) THEN
    RAISE EXCEPTION 'mig 691: private.mobile_permission_defaults is not the 1 Oct seed; re-plan';
  END IF;
END $$;

CREATE TEMP TABLE m691_acls ON COMMIT DROP AS
  SELECT c.relname::text AS tbl, c.relacl::text AS acl FROM pg_class c
   WHERE c.oid IN ('public.activities'::regclass, 'public.bookings'::regclass, 'public.deals'::regclass, 'public.notes'::regclass,
                   'public.whatsapp_conversations'::regclass, 'public.whatsapp_messages'::regclass, 'public.whatsapp_templates'::regclass)
  UNION ALL
  SELECT p.oid::regprocedure::text, coalesce(p.proacl::text, '-') FROM pg_proc p
   WHERE p.oid IN (to_regprocedure('private.mobile_can_for(uuid,uuid,text)'), to_regprocedure('private.auth_mobile_can(uuid,text)'));

-- 1. The defaults, replaced in full from DEFAULT_MOBILE_PERMISSIONS_BY_ROLE
--    (5 membership roles x the keys a policy asks about; masters never read it).
DELETE FROM private.mobile_permission_defaults;
INSERT INTO private.mobile_permission_defaults (role, key, allowed) VALUES
  ('owner', 'pipeline', true), ('owner', 'tasks', true), ('owner', 'bookings', true), ('owner', 'whatsapp', true),
  ('manager', 'pipeline', true), ('manager', 'tasks', true), ('manager', 'bookings', true), ('manager', 'whatsapp', true),
  ('head_coach', 'pipeline', true), ('head_coach', 'tasks', true), ('head_coach', 'bookings', true), ('head_coach', 'whatsapp', true),
  ('staff', 'pipeline', false), ('staff', 'tasks', true), ('staff', 'bookings', false), ('staff', 'whatsapp', false),
  ('reception', 'pipeline', false), ('reception', 'tasks', true), ('reception', 'bookings', true), ('reception', 'whatsapp', true);

-- 2. The core resolver (see the header for the tier order).
CREATE OR REPLACE FUNCTION private.mobile_can_location_ids_for(p_uid uuid, perm_key text)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT coalesce(array_agg(l.id ORDER BY l.id), '{}'::uuid[])
    FROM public.profiles p
    JOIN public.locations l ON true
    LEFT JOIN public.profile_locations pl
           ON pl.profile_id = p.id AND pl.location_id = l.id
    LEFT JOIN public.location_role_permissions tv
           ON tv.location_id = l.id AND tv.role = pl.role AND tv.employment_type = p.employment_type
    LEFT JOIN public.location_role_permissions ta
           ON ta.location_id = l.id AND ta.role = pl.role AND ta.employment_type = 'all'
    LEFT JOIN private.mobile_permission_defaults d
           ON d.role = pl.role AND d.key = perm_key
   WHERE p.id = p_uid
     AND p.active IS NOT FALSE
     AND p.deleted_at IS NULL
     AND perm_key IS NOT NULL
     -- Tier 1: the studio's switch for the key (binds masters too) ...
     AND coalesce(l.features -> perm_key, 'true'::jsonb) <> 'false'::jsonb
     -- ... and the bundle layer: denied only when the key has an owning
     -- bundle and EVERY owning bundle is explicitly false.
     AND (NOT EXISTS (SELECT 1 FROM private.permission_key_bundles b WHERE b.key = perm_key)
          OR EXISTS (SELECT 1 FROM private.permission_key_bundles b
                      WHERE b.key = perm_key
                        AND coalesce(l.features -> b.bundle, 'true'::jsonb) <> 'false'::jsonb))
     AND (
       -- Tier 2: master, past tier 1, at every studio.
       p.role = 'master'
       -- Tier 3: a membership, then override -> employment-type template ->
       -- 'all' template -> role default, under "mobile", booleans only.
       OR (pl.profile_id IS NOT NULL AND CASE
             WHEN jsonb_typeof(pl.permissions -> 'mobile') = 'object' AND pl.permissions -> 'mobile' ? perm_key
               THEN pl.permissions -> 'mobile' -> perm_key = 'true'::jsonb
             WHEN jsonb_typeof(tv.permissions -> 'mobile') = 'object' AND tv.permissions -> 'mobile' ? perm_key
               THEN tv.permissions -> 'mobile' -> perm_key = 'true'::jsonb
             WHEN jsonb_typeof(ta.permissions -> 'mobile') = 'object' AND ta.permissions -> 'mobile' ? perm_key
               THEN ta.permissions -> 'mobile' -> perm_key = 'true'::jsonb
             ELSE coalesce(d.allowed, false)
           END)
     )
$function$;

COMMENT ON FUNCTION private.mobile_can_location_ids_for(uuid, text) IS
  'MOBILECANTEMPLATES.1 (mig 691): studios where p_uid holds the PHONE key, mirroring hasMobilePermissionForLocation / resolvePermission: features + bundle, master, per-user .mobile override, employment-type template, all template, private.mobile_permission_defaults. tests/migration-691-mobile-can-templates.test.js checks it against the JS resolver; tests/mobile-can-templates-guard.test.js pins the defaults.';

-- 3. The wrapper the policies call.
CREATE OR REPLACE FUNCTION private.auth_mobile_can_location_ids(perm_key text)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT private.mobile_can_location_ids_for((SELECT auth.uid()), perm_key)
$function$;

COMMENT ON FUNCTION private.auth_mobile_can_location_ids(text) IS
  'MOBILECANTEMPLATES.1 (mig 691): the caller''s studios for a PHONE key. Policies call it as (SELECT ...) so it runs once per statement.';

-- 4. The kept entry points delegate (CREATE OR REPLACE keeps OID and ACL).
CREATE OR REPLACE FUNCTION private.mobile_can_for(p_uid uuid, loc_id uuid, perm_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT loc_id IS NOT NULL AND loc_id = ANY (private.mobile_can_location_ids_for(p_uid, perm_key))
$function$;

CREATE OR REPLACE FUNCTION private.auth_mobile_can(loc_id uuid, perm_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT loc_id IS NOT NULL AND loc_id = ANY (private.mobile_can_location_ids_for((SELECT auth.uid()), perm_key))
$function$;

-- 5. EXECUTE for the two new functions (correct with or without mig 678's
--    private default, which would otherwise give the core to authenticated).
REVOKE ALL ON FUNCTION private.mobile_can_location_ids_for(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.mobile_can_location_ids_for(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION private.auth_mobile_can_location_ids(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.auth_mobile_can_location_ids(text) TO authenticated, service_role;

-- 6. The 15 policies: only USING / WITH CHECK change.
ALTER POLICY activities_select ON public.activities
  USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('tasks'))::uuid[])
         OR location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]));
ALTER POLICY activities_insert ON public.activities
  WITH CHECK (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('tasks'))::uuid[])
              OR location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]));
ALTER POLICY activities_update ON public.activities
  USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('tasks'))::uuid[])
         OR location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]))
  WITH CHECK (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('tasks'))::uuid[])
              OR location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]));
ALTER POLICY bookings_select ON public.bookings USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('bookings'))::uuid[]));
ALTER POLICY bookings_insert ON public.bookings WITH CHECK (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('bookings'))::uuid[]));
ALTER POLICY bookings_update ON public.bookings
  USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('bookings'))::uuid[]))
  WITH CHECK (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('bookings'))::uuid[]));
ALTER POLICY deals_select ON public.deals USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]));
ALTER POLICY deals_insert ON public.deals WITH CHECK (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]));
ALTER POLICY deals_update ON public.deals
  USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]))
  WITH CHECK (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]));
ALTER POLICY notes_select ON public.notes USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]));
ALTER POLICY notes_insert ON public.notes WITH CHECK (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]));
ALTER POLICY notes_update ON public.notes
  USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]))
  WITH CHECK (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('pipeline'))::uuid[]));
ALTER POLICY wa_conv_select ON public.whatsapp_conversations USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('whatsapp'))::uuid[]));
ALTER POLICY wa_msg_select ON public.whatsapp_messages USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('whatsapp'))::uuid[]));
ALTER POLICY wa_tmpl_select ON public.whatsapp_templates USING (location_id = ANY ((SELECT private.auth_mobile_can_location_ids('whatsapp'))::uuid[]));

-- 7. Self-check: the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_bad text;
  v_core oid := to_regprocedure('private.mobile_can_location_ids_for(uuid,text)');
  v_wrap oid := to_regprocedure('private.auth_mobile_can_location_ids(text)');
BEGIN
  -- a. four DEFINER / STABLE / search_path '' functions owned by the migration role
  SELECT string_agg(f, ', ') INTO v_bad FROM unnest(ARRAY[
      'private.mobile_can_location_ids_for(uuid,text)', 'private.auth_mobile_can_location_ids(text)',
      'private.mobile_can_for(uuid,uuid,text)', 'private.auth_mobile_can(uuid,text)']) f
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(f) AND p.prosecdef AND p.provolatile = 's'
                      AND p.proconfig @> ARRAY['search_path=""']
                      AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 691: not SECURITY DEFINER / STABLE / search_path '''' / owned by %: %', current_user, v_bad;
  END IF;
  -- b. EXECUTE: wrapper authenticated + service_role; core service_role only; anon and PUBLIC neither
  IF NOT has_function_privilege('authenticated', v_wrap, 'EXECUTE') OR NOT has_function_privilege('service_role', v_wrap, 'EXECUTE')
     OR has_function_privilege('anon', v_wrap, 'EXECUTE') OR has_function_privilege('public', v_wrap, 'EXECUTE')
     OR has_function_privilege('authenticated', v_core, 'EXECUTE') OR has_function_privilege('anon', v_core, 'EXECUTE')
     OR has_function_privilege('public', v_core, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_core, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 691: EXECUTE on the new functions is not wrapper = authenticated + service_role, core = service_role';
  END IF;
  -- c. the 15 policies carry the new text; nothing calls the per-row form
  SELECT string_agg(p.tbl || '.' || p.pol || ' USING ' || coalesce(g.qual, '-') || ' CHECK ' || coalesce(g.with_check, '-'), ' ; ') INTO v_bad
    FROM m691_policies p JOIN m691_texts t USING (k)
    LEFT JOIN pg_policies g ON g.schemaname = 'public' AND g.tablename = p.tbl AND g.policyname = p.pol
   WHERE g.policyname IS NULL OR g.cmd <> p.cmd OR g.roles::text <> '{authenticated}' OR g.permissive <> 'PERMISSIVE'
      OR (p.cmd <> 'INSERT' AND g.qual IS DISTINCT FROM t.new_text)
      OR (p.cmd <> 'SELECT' AND g.with_check IS DISTINCT FROM t.new_text);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 691: a policy is not the expected text; found: %', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE coalesce(qual, '') || coalesce(with_check, '') ~ '(auth_mobile_can\(|mobile_can_for\()') THEN
    RAISE EXCEPTION 'mig 691: a policy still calls the per-row phone resolver';
  END IF;
  -- d. no table or kept-function ACL moved
  IF EXISTS (
       SELECT 1 FROM m691_acls a
        WHERE a.acl IS DISTINCT FROM coalesce(
          (SELECT c.relacl::text FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = a.tbl),
          (SELECT coalesce(p.proacl::text, '-') FROM pg_proc p WHERE p.oid::regprocedure::text = a.tbl))) THEN
    RAISE EXCEPTION 'mig 691: a table or kept-function ACL changed; this file changes no privilege on them';
  END IF;
  -- e. the defaults: 20 rows, 5 roles x 4 keys, the JS values
  IF (SELECT count(*) FROM private.mobile_permission_defaults) <> 20
     OR EXISTS (SELECT 1 FROM private.mobile_permission_defaults
                 WHERE role NOT IN ('owner', 'manager', 'head_coach', 'staff', 'reception')
                    OR key NOT IN ('pipeline', 'tasks', 'bookings', 'whatsapp')
                    OR allowed IS DISTINCT FROM (role IN ('owner', 'manager', 'head_coach') OR key = 'tasks'
                                                 OR (role = 'reception' AND key IN ('bookings', 'whatsapp')))) THEN
    RAISE EXCEPTION 'mig 691: private.mobile_permission_defaults is not the 20 JS rows';
  END IF;
  -- f. the resolver runs: with no signed-in user it returns no studio
  IF private.auth_mobile_can_location_ids('whatsapp') IS DISTINCT FROM '{}'::uuid[]
     OR private.mobile_can_for(NULL, NULL, 'whatsapp') IS NOT FALSE THEN
    RAISE EXCEPTION 'mig 691: the resolver returned studios with no signed-in user';
  END IF;

  RAISE NOTICE 'mig 691: phone-direct RLS follows role templates (once per statement); reception defaults added; no table privilege changed.';
END $$;

COMMIT;
