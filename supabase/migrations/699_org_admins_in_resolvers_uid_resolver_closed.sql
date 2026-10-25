-- 699 — SEC-3: organisation admins in the contact and phone resolvers
-- (C137 CONTACTREADORGADMIN.1), the uid-taking phone resolver closed to
-- signed-in sessions (C135 MOBILECANENTRYPTS.1). C132 ACTIVITIESREAD.1 needs
-- no SQL: mig 691 closed it (see below); a guard pins it.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file (read-only, Supabase MCP, 2 Oct 2026, migs 690 + 691 applied).
-- Proven ahead of apply by tests/migration-699-sec-3.test.js (PGlite; the
-- real 690 and 691 files first, their bodies hashed equal to prod's; a
-- 37,920-case parity matrix against the real JS org-admin tier).
--
-- ===========================================================================
-- C132 (activities readable by any studio member): CLOSED BY 691
-- ===========================================================================
-- VERIFIED LIVE (2 Oct): public.activities has one permissive SELECT policy,
-- activities_select, TO authenticated, USING the 691 form (phone Tasks OR
-- phone Pipeline at the studio); insert/update the same; delete
-- auth_is_manager_at. No FOR ALL, no view, no client-executable DEFINER
-- function reads it, not in a publication; anon holds nothing. Rolled-back
-- probes as each of the 6 contractor memberships whose employment-type
-- template switches phone Tasks off: 0 rows at that studio (membership reach
-- there: 70,680); the two who hold Tasks at a second studio read that
-- studio's rows, as the app shows them. tests/activities-read-scope-guard
-- .test.js keeps it so. Nothing here touches activities.
--
-- ===========================================================================
-- C135: private.mobile_can_for(p_uid, loc_id, perm_key)
-- ===========================================================================
-- VERIFIED LIVE (2 Oct): proacl postgres, authenticated, service_role, so a
-- signed-in SQL session could ask whether ANOTHER user holds a phone key at
-- a studio. Schema private is NOT exposed to PostgREST (an Accept-Profile:
-- private request answers 406 PGRST106, "Only the following schemas are
-- exposed: public, graphql_public"), so it was reachable from SQL only.
-- Nothing calls it: no policy, no function body, no view, no trigger, no
-- pg_depend row; no client code. The policies call the caller-only
-- wrapper. FIX: REVOKE EXECUTE from authenticated (postgres and
-- service_role keep it; body and OID unchanged). private.auth_mobile_can
-- (caller-only) is untouched.
--
-- ===========================================================================
-- C137: organisation admins
-- ===========================================================================
-- getCurrentUser (src/lib/auth.js, SAAS-4 / mig 417): a NON-master with a
-- profile_organizations row (role 'org_admin') reaches every ACTIVE studio
-- (locations.active = true) of that organisation; where they hold no
-- profile_locations row they get a synthetic assignment { role: 'owner',
-- permissions: {} }; an explicit membership keeps its own role; role
-- templates load for the role held there (synthetic owner included) and
-- profiles.employment_type. private.auth_contact_read_location_ids (690)
-- and private.mobile_can_location_ids_for (691) knew only explicit
-- memberships, so an org admin read no contact and no phone table at a
-- studio where the app treats them as owner.
-- VERIFIED LIVE (2 Oct): profile_organizations holds 0 rows (role CHECK =
-- 'org_admin'; UNIQUE (profile_id, organization_id); client writes admitted
-- only to masters: profile_organizations_ins/_upd/_del on
-- private.auth_is_master(); a tombstone trigger refuses rows). So this
-- changes nothing live today.
-- FIX: both functions take an effective role per studio,
--   coalesce(pl.role, 'owner' when an org_admin row covers l.organization_id
--            AND coalesce(l.active, false), i.e. active = true,
--            AND there is no membership row)
-- and join the templates (and, for phone keys, the defaults) on it; the
-- per-user override still comes only from a membership row. Masters are
-- unchanged (their branch runs first). CREATE OR REPLACE keeps both OIDs and
-- ACLs; the bodies replaced are pinned by normalised md5 (as 691 does), so a
-- hand edit on prod aborts this file.
--
-- Guards: tests/contacts-read-scope-migration-guard.test.js (also fails a
-- later DISABLE / FORCE / NO FORCE ROW LEVEL SECURITY on contacts),
-- tests/mobile-can-templates-guard.test.js, tests/rls-active-staff-gate
-- .test.js, tests/activities-read-scope-guard.test.js.
-- APPLY: after merge (no app code depends on it). ROLLBACK (POST-677): the
-- CREATE OR REPLACE statements of mig 690 section 1 and mig 691 section 2,
-- verbatim, then GRANT EXECUTE ON FUNCTION private.mobile_can_for(uuid,
-- uuid, text) TO authenticated (pinned by the replay).
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public;

-- 0. Pre-checks.
DO $$
DECLARE
  v_old_contact text := 'bb438f78e24a8630be135418e27fb253';  -- mig 690 body (prod, 2 Oct)
  v_old_core text := 'fd91cdf4aca619f24342ac41939bd03c';     -- mig 691 body (prod, 2 Oct)
  v_new_contact text := '85f3064be28ecc14e3b2c69010b04608';
  v_new_core text := '7980b99077e827dacc5ab6935e6dc592';
  v_h text;
  v_bad text;
BEGIN
  -- a. the two bodies this file replaces (or, on a re-run, this file's)
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_h
    FROM pg_proc WHERE oid = to_regprocedure('private.auth_contact_read_location_ids()');
  IF v_h IS NULL OR v_h NOT IN (v_old_contact, v_new_contact) THEN
    RAISE EXCEPTION 'mig 699: private.auth_contact_read_location_ids is not the mig 690 body (normalised md5 %); re-plan', v_h;
  END IF;
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_h
    FROM pg_proc WHERE oid = to_regprocedure('private.mobile_can_location_ids_for(uuid,text)');
  IF v_h IS NULL OR v_h NOT IN (v_old_core, v_new_core) THEN
    RAISE EXCEPTION 'mig 699: private.mobile_can_location_ids_for is not the mig 691 body (normalised md5 %); re-plan', v_h;
  END IF;
  -- b. the org-admin inputs exist
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
        AND (table_name, column_name) IN (('profile_organizations', 'profile_id'), ('profile_organizations', 'organization_id'),
              ('profile_organizations', 'role'), ('locations', 'organization_id'), ('locations', 'active'))) <> 5 THEN
    RAISE EXCEPTION 'mig 699: a column the org-admin tier reads is missing; re-plan';
  END IF;
  -- c. profile_organizations now decides RLS: only a master may write it
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profile_organizations'::regclass)
     OR has_table_privilege('anon', 'public.profile_organizations', 'INSERT')
     OR has_table_privilege('anon', 'public.profile_organizations', 'UPDATE')
     OR EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'profile_organizations'
                   AND cmd IN ('INSERT', 'UPDATE', 'ALL')
                   AND (coalesce(qual, 'private.auth_is_master()') <> 'private.auth_is_master()'
                        OR coalesce(with_check, 'private.auth_is_master()') <> 'private.auth_is_master()')) THEN
    RAISE EXCEPTION 'mig 699: profile_organizations admits a non-master client write (org_admin now decides RLS, so it would be a self-grant); found: %',
      (SELECT string_agg(policyname || ' ' || cmd || ' USING ' || coalesce(qual, '-') || ' CHECK ' || coalesce(with_check, '-'), ' ; ')
         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profile_organizations');
  END IF;
  -- d. nothing a client fires calls the uid-taking entry point
  SELECT string_agg(x, ', ') INTO v_bad FROM (
    SELECT tablename || '.' || policyname AS x FROM pg_policies
     WHERE coalesce(qual, '') || coalesce(with_check, '') ~ 'mobile_can_for\('
    UNION ALL
    SELECT p.oid::regprocedure::text FROM pg_proc p
     WHERE p.prosrc ~ 'mobile_can_for\(' AND p.oid <> to_regprocedure('private.mobile_can_for(uuid,uuid,text)')
    UNION ALL
    SELECT c.oid::regclass::text FROM pg_class c WHERE c.relkind IN ('v', 'm') AND pg_get_viewdef(c.oid) ~ 'mobile_can_for\(') s;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 699: something still calls private.mobile_can_for; revoking authenticated would break it: %', v_bad;
  END IF;
END $$;

CREATE TEMP TABLE m699_state ON COMMIT DROP AS
  SELECT 'acl:' || p.oid::regprocedure::text AS k, coalesce(p.proacl::text, '-') AS v FROM pg_proc p
   WHERE p.oid IN (to_regprocedure('private.auth_contact_read_location_ids()'), to_regprocedure('private.mobile_can_location_ids_for(uuid,text)'),
                   to_regprocedure('private.auth_mobile_can_location_ids(text)'), to_regprocedure('private.auth_mobile_can(uuid,text)'))
  UNION ALL
  SELECT 'policy:' || tablename || '.' || policyname, permissive || ' ' || cmd || ' ' || roles::text || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-')
    FROM pg_policies WHERE schemaname = 'public'
     AND tablename IN ('contacts', 'activities', 'bookings', 'deals', 'notes', 'whatsapp_conversations', 'whatsapp_messages', 'whatsapp_templates');

-- 1. Contacts (web OR phone): the 690 resolver plus the org-admin tier.
CREATE OR REPLACE FUNCTION private.auth_contact_read_location_ids()
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
    -- SAAS-4 (mig 417): an organisation admin is owner at every ACTIVE studio
    -- of their organisation where they hold no membership.
    LEFT JOIN public.profile_organizations po
           ON po.profile_id = p.id AND po.organization_id = l.organization_id AND po.role = 'org_admin'
          AND coalesce(l.active, false) AND pl.profile_id IS NULL
    CROSS JOIN LATERAL (SELECT coalesce(pl.role, CASE WHEN po.profile_id IS NOT NULL THEN 'owner' END) AS role) er
    LEFT JOIN public.location_role_permissions ta
           ON ta.location_id = l.id AND ta.role = er.role AND ta.employment_type = 'all'
    LEFT JOIN public.location_role_permissions tv
           ON tv.location_id = l.id AND tv.role = er.role AND tv.employment_type = p.employment_type
   WHERE p.id = (SELECT auth.uid())
     AND p.active IS NOT FALSE
     AND p.deleted_at IS NULL
     -- Tier 1: the studio's Contacts switch (binds masters too) ...
     AND coalesce(l.features -> 'contacts', 'true'::jsonb) <> 'false'::jsonb
     -- ... and the bundle layer: denied only when Contacts has an owning
     -- bundle and EVERY owning bundle is explicitly false.
     AND (NOT EXISTS (SELECT 1 FROM private.permission_key_bundles b WHERE b.key = 'contacts')
          OR EXISTS (SELECT 1 FROM private.permission_key_bundles b
                      WHERE b.key = 'contacts'
                        AND coalesce(l.features -> b.bundle, 'true'::jsonb) <> 'false'::jsonb))
     AND (
       -- Tier 2: master, past tier 1, at every studio.
       p.role = 'master'
       OR (er.role IS NOT NULL AND (
         -- Web Contacts: per-user override (membership only), employment-type
         -- template, 'all' template, code default.
         CASE
           WHEN pl.permissions ? 'contacts' THEN pl.permissions -> 'contacts' = 'true'::jsonb
           WHEN tv.permissions ? 'contacts' THEN tv.permissions -> 'contacts' = 'true'::jsonb
           WHEN ta.permissions ? 'contacts' THEN ta.permissions -> 'contacts' = 'true'::jsonb
           ELSE er.role IN ('master', 'owner', 'manager', 'head_coach', 'staff', 'reception')
         END
         OR
         -- Phone Contacts: the same tiers under "mobile".
         CASE
           WHEN pl.permissions -> 'mobile' ? 'contacts' THEN pl.permissions -> 'mobile' -> 'contacts' = 'true'::jsonb
           WHEN tv.permissions -> 'mobile' ? 'contacts' THEN tv.permissions -> 'mobile' -> 'contacts' = 'true'::jsonb
           WHEN ta.permissions -> 'mobile' ? 'contacts' THEN ta.permissions -> 'mobile' -> 'contacts' = 'true'::jsonb
           ELSE er.role IN ('master', 'owner', 'manager', 'head_coach', 'staff', 'reception')
         END
       ))
     )
$function$;

COMMENT ON FUNCTION private.auth_contact_read_location_ids() IS
  'CONTACTREADSCOPE.1 (mig 690) + SEC-3 (mig 699): studios where the caller holds Contacts (web OR phone), mirroring resolvePermission for that key: features.contacts + bundle, master, per-user override, employment-type template, all template, role default; an organisation admin is owner at every active studio of their org where they hold no membership (getCurrentUser SAAS-4). Active, non-deleted profiles only. Read by contacts_select as an InitPlan. tests/contacts-read-scope-migration-guard.test.js pins the role defaults; tests/migration-699-sec-3.test.js checks it against the JS resolver.';

-- 2. Phone keys: the 691 core plus the org-admin tier.
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
    -- SAAS-4 (mig 417): an organisation admin is owner at every ACTIVE studio
    -- of their organisation where they hold no membership.
    LEFT JOIN public.profile_organizations po
           ON po.profile_id = p.id AND po.organization_id = l.organization_id AND po.role = 'org_admin'
          AND coalesce(l.active, false) AND pl.profile_id IS NULL
    CROSS JOIN LATERAL (SELECT coalesce(pl.role, CASE WHEN po.profile_id IS NOT NULL THEN 'owner' END) AS role) er
    LEFT JOIN public.location_role_permissions tv
           ON tv.location_id = l.id AND tv.role = er.role AND tv.employment_type = p.employment_type
    LEFT JOIN public.location_role_permissions ta
           ON ta.location_id = l.id AND ta.role = er.role AND ta.employment_type = 'all'
    LEFT JOIN private.mobile_permission_defaults d
           ON d.role = er.role AND d.key = perm_key
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
       -- Tier 3: a membership (or the org-admin owner), then override
       -- (membership only) -> employment-type template -> 'all' template ->
       -- role default, under "mobile", booleans only.
       OR (er.role IS NOT NULL AND CASE
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
  'MOBILECANTEMPLATES.1 (mig 691) + SEC-3 (mig 699): studios where p_uid holds the PHONE key, mirroring hasMobilePermissionForLocation / resolvePermission: features + bundle, master, per-user .mobile override, employment-type template, all template, private.mobile_permission_defaults; an organisation admin is owner at every active studio of their org where they hold no membership (getCurrentUser SAAS-4). tests/migration-699-sec-3.test.js checks it against the JS resolver.';

-- 3. C135: the uid-taking entry point is not for signed-in sessions.
REVOKE EXECUTE ON FUNCTION private.mobile_can_for(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.mobile_can_for(uuid, uuid, text) TO service_role;

-- 4. Self-check: the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_new_contact text := '85f3064be28ecc14e3b2c69010b04608';
  v_new_core text := '7980b99077e827dacc5ab6935e6dc592';
  v_mcf oid := to_regprocedure('private.mobile_can_for(uuid,uuid,text)');
  v_bad text;
BEGIN
  -- a. both bodies are this file's, DEFINER / STABLE / search_path '' / owned by the migration role
  SELECT string_agg(f, ', ') INTO v_bad FROM (VALUES
      ('private.auth_contact_read_location_ids()', v_new_contact),
      ('private.mobile_can_location_ids_for(uuid,text)', v_new_core)) x(f, h)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(x.f) AND p.prosecdef AND p.provolatile = 's'
                      AND p.prorettype = 'uuid[]'::regtype AND p.proconfig @> ARRAY['search_path=""']
                      AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                      AND md5(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) = x.h);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 699: not this file''s body, or not SECURITY DEFINER / STABLE / search_path '''' / uuid[] / owned by %: %', current_user, v_bad;
  END IF;
  -- b. mobile_can_for: service_role only (postgres as owner)
  IF has_function_privilege('authenticated', v_mcf, 'EXECUTE') OR has_function_privilege('anon', v_mcf, 'EXECUTE')
     OR has_function_privilege('public', v_mcf, 'EXECUTE') OR NOT has_function_privilege('service_role', v_mcf, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 699: EXECUTE on private.mobile_can_for is not service_role only';
  END IF;
  -- c. no other function ACL and no policy on the eight tables moved
  SELECT string_agg(k, ', ') INTO v_bad FROM (
    SELECT s.k FROM m699_state s
     WHERE s.v IS DISTINCT FROM coalesce(
       (SELECT coalesce(p.proacl::text, '-') FROM pg_proc p WHERE 'acl:' || p.oid::regprocedure::text = s.k),
       (SELECT permissive || ' ' || cmd || ' ' || roles::text || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-')
          FROM pg_policies WHERE schemaname = 'public' AND 'policy:' || tablename || '.' || policyname = s.k))
    UNION ALL
    SELECT 'new policy:' || tablename || '.' || policyname FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('contacts', 'activities', 'bookings', 'deals', 'notes', 'whatsapp_conversations', 'whatsapp_messages', 'whatsapp_templates')
       AND NOT EXISTS (SELECT 1 FROM m699_state s WHERE s.k = 'policy:' || tablename || '.' || policyname)) y;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 699: a function ACL or a policy changed; this file changes neither: %', v_bad;
  END IF;
  -- d. the resolvers run: with no signed-in user they return no studio
  IF private.auth_contact_read_location_ids() IS DISTINCT FROM '{}'::uuid[]
     OR private.auth_mobile_can_location_ids('whatsapp') IS DISTINCT FROM '{}'::uuid[] THEN
    RAISE EXCEPTION 'mig 699: a resolver returned studios with no signed-in user';
  END IF;

  RAISE NOTICE 'mig 699: org admins resolve as owner at their org''s active studios (contacts + phone); mobile_can_for is service_role only; no policy changed.';
END $$;

COMMIT;
