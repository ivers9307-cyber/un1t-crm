-- 690 — CONTACTREADSCOPE.1b: a signed-in staff session reads a studio's
-- contacts only while holding the Contacts permission (web OR phone) at that
-- studio. Every column stays readable for them. Members are unchanged: their
-- own contact row, nothing else.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file (read-only, Supabase MCP, 2 Oct 2026). Proven ahead of apply by
-- tests/migration-690-contacts-read-scope.test.js (PGlite; it checks the SQL
-- helper against the real JS resolver over 4,544 permission combinations).
--
-- ===========================================================================
-- THE DECISION (Richard, 30 Sep 2026; follow-ups C53, found planning C49)
-- ===========================================================================
-- "Gate direct contact reads on the Contacts permission: staff keep ALL
-- fields, but only staff holding Contacts AT THAT STUDIO can read that
-- studio's contacts directly; members unchanged." Either toggle (web or
-- phone) admits; names stay hidden on the phone's other lists for someone
-- without Contacts (both Richard's calls).
--
-- VERIFIED LIVE (2 Oct, BEFORE this migration):
--   contacts: relacl postgres + service_role arwdDxtm, authenticated r; anon
--   nothing (657/677); RLS on, not forced; no column ACL; not published. One
--   policy, contacts_select, PERMISSIVE SELECT TO public,
--   USING (private.auth_is_in_location(location_id) OR user_id = auth.uid()):
--   membership, no permission. A contractor coach whose role template turns
--   Contacts off (web and phone) read all 8,713 contacts of their studio.
--   Who changes: 6 contractor-staff logins at the largest studio, each loses
--   8,712 rows (8,713 -> their own row; the two who also belong to a second
--   studio, where they hold Contacts, 8,830 -> 118). Nobody reads more. The
--   3 other memberships without Contacts are at the two studios whose
--   Contacts switch is off, which hold 0 contacts.
--   No SQL resolver for a web permission existed; private.mobile_can_for
--   (migs 218/550/626) covers phone keys without the role-template tier, and
--   is NOT used or changed here (C131 owns it); this helper resolves both
--   namespaces for the one key itself.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   private.auth_contact_read_location_ids() -> uuid[]: the studios where the
--   caller holds Contacts, mirroring resolvePermission (shared/permissions.js)
--   for this one key, in its tier order:
--     1. the studio's features.contacts (explicit false denies, masters too)
--        and the bundle layer (bundlesDenyKey: denied when every bundle that
--        owns 'contacts' in private.permission_key_bundles is explicitly
--        false in features; check:bundle-sql keeps that seed = KEY_BUNDLES);
--     2. master: every studio past tier 1;
--     3. otherwise a profile_locations row at the studio, and, per namespace
--        (web top level, phone under "mobile"), the first tier that states
--        the key: the per-user override, the employment-type role template
--        (location_role_permissions, mig 367), the 'all' role template, then
--        the code default (true for the six roles in
--        DEFAULT_WEB/MOBILE_PERMISSIONS_BY_ROLE, false otherwise);
--     4. web OR phone admits (either toggle shows a Contacts screen).
--   Active, non-deleted profiles only (mig 626's rule).
--   contacts_select: only USING changes, to
--     location_id = ANY ((SELECT helper())::uuid[]) OR user_id = (SELECT auth.uid())
--   The (SELECT …) makes the helper an InitPlan: once per statement, not once
--   per row (today auth_is_in_location runs per row). The ::uuid[] is needed:
--   `= ANY ((SELECT …))` parses as the subquery form and fails. Name,
--   command, roles (public; anon holds no privilege) and the member branch
--   are unchanged. No privilege on contacts changes.
--
-- WHAT A CLIENT SEES: a staff session without Contacts gets no contact rows
-- (their own row if they are also a member); an embed of contacts inside
-- another table's select comes back null (the parent row stays). The phone's
-- Studio dashboard numbers moved to /api/dashboard/studio-contacts first
-- (CONTACTREADSCOPE.1a). Child tables whose staff branch reads contacts as
-- the caller (contact_goals_read and six others) narrow with it; their
-- member branches do not.
--
-- Guard: tests/contacts-read-scope-migration-guard.test.js (later migrations
-- keep this policy on the helper; the helper's role defaults = the JS maps).
-- APPLY: after CONTACTREADSCOPE.1a is live, per
-- docs/superpowers/plans/2026-09-27-followups/C53-CONTACTREADSCOPE.1.md
-- (Task 1b-0 gate, Task 1b-5 probes and the rollback record).
-- ===========================================================================

BEGIN;

-- ALTER POLICY takes ACCESS EXCLUSIVE on public.contacts, the hottest table.
-- Fail after 5 s rather than queue every read behind this file; re-run later.
SET LOCAL lock_timeout = '5s';
-- pg_policies prints qual relative to the search_path; pinned so the
-- self-check's text comparison holds whatever path the applying session has.
SET LOCAL search_path = public;

-- 0. Pre-checks.
DO $$
DECLARE
  v_old text := $q$(private.auth_is_in_location(location_id) OR (user_id = ( SELECT auth.uid() AS uid)))$q$;
  v_new text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)))$q$;
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}'
                       AND with_check IS NULL AND qual IN (v_old, v_new)) THEN
    RAISE EXCEPTION 'mig 690: public.contacts did not start with exactly the 2 Oct contacts_select policy; re-plan (found: %)',
      (SELECT string_agg(policyname || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-'), ' ; ')
         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts');
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass) THEN
    RAISE EXCEPTION 'mig 690: row level security is off on public.contacts';
  END IF;
  IF has_table_privilege('anon', 'public.contacts', 'SELECT') THEN
    RAISE EXCEPTION 'mig 690: anon holds SELECT on public.contacts (mig 657 closed it); find out why first';
  END IF;
  IF to_regclass('public.location_role_permissions') IS NULL OR to_regclass('private.permission_key_bundles') IS NULL THEN
    RAISE EXCEPTION 'mig 690: location_role_permissions or private.permission_key_bundles is missing; re-plan';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
        AND (table_name, column_name) IN (('profiles', 'employment_type'), ('profiles', 'role'), ('profiles', 'active'),
              ('profiles', 'deleted_at'), ('profile_locations', 'permissions'), ('profile_locations', 'role'),
              ('locations', 'features'), ('location_role_permissions', 'employment_type'),
              ('location_role_permissions', 'role'), ('location_role_permissions', 'permissions'))) <> 10 THEN
    RAISE EXCEPTION 'mig 690: a column the helper reads is missing; re-plan';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM private.permission_key_bundles WHERE key = 'contacts') THEN
    RAISE EXCEPTION 'mig 690: private.permission_key_bundles has no contacts row, but KEY_BUNDLES gives contacts to bundle_sales (run check:bundle-sql)';
  END IF;
END $$;

CREATE TEMP TABLE m690_contacts_acl ON COMMIT DROP AS
  SELECT relacl::text AS acl FROM pg_class WHERE oid = 'public.contacts'::regclass;

-- 1. The resolver (Contacts only; see the header for the tier order).
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
    LEFT JOIN public.location_role_permissions ta
           ON ta.location_id = l.id AND ta.role = pl.role AND ta.employment_type = 'all'
    LEFT JOIN public.location_role_permissions tv
           ON tv.location_id = l.id AND tv.role = pl.role AND tv.employment_type = p.employment_type
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
       OR (pl.profile_id IS NOT NULL AND (
         -- Web Contacts: per-user override, employment-type template, 'all' template, code default.
         CASE
           WHEN pl.permissions ? 'contacts' THEN pl.permissions -> 'contacts' = 'true'::jsonb
           WHEN tv.permissions ? 'contacts' THEN tv.permissions -> 'contacts' = 'true'::jsonb
           WHEN ta.permissions ? 'contacts' THEN ta.permissions -> 'contacts' = 'true'::jsonb
           ELSE pl.role IN ('master', 'owner', 'manager', 'head_coach', 'staff', 'reception')
         END
         OR
         -- Phone Contacts: the same tiers under "mobile".
         CASE
           WHEN pl.permissions -> 'mobile' ? 'contacts' THEN pl.permissions -> 'mobile' -> 'contacts' = 'true'::jsonb
           WHEN tv.permissions -> 'mobile' ? 'contacts' THEN tv.permissions -> 'mobile' -> 'contacts' = 'true'::jsonb
           WHEN ta.permissions -> 'mobile' ? 'contacts' THEN ta.permissions -> 'mobile' -> 'contacts' = 'true'::jsonb
           ELSE pl.role IN ('master', 'owner', 'manager', 'head_coach', 'staff', 'reception')
         END
       ))
     )
$function$;

COMMENT ON FUNCTION private.auth_contact_read_location_ids() IS
  'CONTACTREADSCOPE.1 (mig 690): studios where the caller holds Contacts (web OR phone), mirroring resolvePermission for that key: features.contacts + bundle, master, per-user override, employment-type template, all template, role default. Active, non-deleted profiles only. Read by contacts_select as an InitPlan. tests/contacts-read-scope-migration-guard.test.js pins the role defaults to shared/permissions.js; tests/migration-690-contacts-read-scope.test.js checks it against the JS resolver.';

-- Mig 678 already makes a new private function executable by authenticated +
-- service_role only; stated here as well so the file means the same on a
-- database without 678, and the self-check below proves the result.
REVOKE ALL ON FUNCTION private.auth_contact_read_location_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.auth_contact_read_location_ids() TO authenticated, service_role;

-- 2. The policy: only USING changes.
ALTER POLICY contacts_select ON public.contacts USING (
  location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
  OR user_id = (SELECT auth.uid())
);

-- 3. Self-check: the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_new text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)))$q$;
  v_fn oid := to_regprocedure('private.auth_contact_read_location_ids()');
  v_found text;
BEGIN
  -- a. the helper: DEFINER, STABLE, empty search_path, uuid[], owned by the migration role
  IF v_fn IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef AND provolatile = 's'
          AND prorettype = 'uuid[]'::regtype AND proconfig @> ARRAY['search_path=""']
          AND proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'mig 690: private.auth_contact_read_location_ids is missing or not SECURITY DEFINER / STABLE / search_path '''' / uuid[] / owned by %', current_user;
  END IF;
  -- b. EXECUTE: authenticated and service_role only
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0) THEN
    RAISE EXCEPTION 'mig 690: EXECUTE on the helper must be authenticated + service_role only';
  END IF;
  -- c. exactly one policy, same shape, the new USING
  SELECT string_agg(policyname || ' ' || permissive || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-')
                    || ' CHECK ' || coalesce(with_check, '-'), ' ; ')
    INTO v_found FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts';
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}'
                       AND with_check IS NULL AND qual = v_new) THEN
    RAISE EXCEPTION 'mig 690: contacts_select is not the expected policy; found: %', v_found;
  END IF;
  -- d. RLS on, not forced; the table ACL untouched; still no client write, no anon read
  IF NOT (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass) THEN
    RAISE EXCEPTION 'mig 690: contacts RLS changed';
  END IF;
  IF (SELECT relacl::text FROM pg_class WHERE oid = 'public.contacts'::regclass) IS DISTINCT FROM (SELECT acl FROM m690_contacts_acl) THEN
    RAISE EXCEPTION 'mig 690: the contacts ACL changed; this file must not touch privileges';
  END IF;
  IF has_table_privilege('anon', 'public.contacts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.contacts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.contacts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.contacts', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.contacts', 'SELECT') THEN
    RAISE EXCEPTION 'mig 690: contacts privileges are not 653/657''s (authenticated SELECT only, anon nothing)';
  END IF;
  -- e. the helper runs: with no signed-in user it returns no studio
  IF private.auth_contact_read_location_ids() IS DISTINCT FROM '{}'::uuid[] THEN
    RAISE EXCEPTION 'mig 690: the helper returned studios with no signed-in user';
  END IF;

  RAISE NOTICE 'mig 690: contacts_select now needs Contacts (web or phone) at the studio; members unchanged; privileges unchanged.';
END $$;

COMMIT;
