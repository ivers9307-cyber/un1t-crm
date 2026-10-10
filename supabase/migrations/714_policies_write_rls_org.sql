-- 714 — W0.5b: policies / policy_versions WRITES are scoped to the caller's
-- organisation (follow-up to W0.5, mig 713, #1960).
--
-- WHY. W0.5 gave policies an organization_id and narrowed the authenticated
-- SELECT policies to the caller's organisations (policies_read_in_org,
-- policy_versions_read_in_org). The six WRITE policies were left as mig 320
-- made them (mig 626 only added the active-staff gate): any active profile
-- with role master OR OWNER could INSERT, UPDATE or DELETE policies and
-- policy_versions in ANY organisation through the browser client. Reviewer
-- finding on #1960. The app writes policies only through service-role routes
-- (master-only, src/lib/policies.js), so this is defence in depth, but the
-- write side must match the org-scoped read side.
--
-- WHAT. Drop and recreate the six write policies. Masters keep full access.
-- Owners must be a member of the row's organisation
-- (private.auth_is_in_organization, mig 079; active + not tombstoned since
-- mig 626; via a location OR a profile_organizations grant since mig 417).
-- policy_versions is scoped through its parent policies row. UPDATE carries
-- the org check in BOTH USING and WITH CHECK so a row cannot be moved into
-- another organisation. The (select auth.uid()) initplan form and the mig-626
-- (SELECT private.auth_is_active_staff()) gate are kept. Replay-safe (DROP IF
-- EXISTS then CREATE); the self-check at the end aborts the whole file when
-- any of the six is missing or not narrowed.

-- policies -----------------------------------------------------------------
DROP POLICY IF EXISTS "policies_ins" ON public.policies;
CREATE POLICY "policies_ins" ON public.policies FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = (select auth.uid())
         AND (SELECT private.auth_is_active_staff())
         AND (p.role = 'master'::text
              OR (p.role = 'owner'::text AND private.auth_is_in_organization(policies.organization_id)))
    )
  );

DROP POLICY IF EXISTS "policies_upd" ON public.policies;
CREATE POLICY "policies_upd" ON public.policies FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = (select auth.uid())
         AND (SELECT private.auth_is_active_staff())
         AND (p.role = 'master'::text
              OR (p.role = 'owner'::text AND private.auth_is_in_organization(policies.organization_id)))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = (select auth.uid())
         AND (SELECT private.auth_is_active_staff())
         AND (p.role = 'master'::text
              OR (p.role = 'owner'::text AND private.auth_is_in_organization(policies.organization_id)))
    )
  );

DROP POLICY IF EXISTS "policies_del" ON public.policies;
CREATE POLICY "policies_del" ON public.policies FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = (select auth.uid())
         AND (SELECT private.auth_is_active_staff())
         AND (p.role = 'master'::text
              OR (p.role = 'owner'::text AND private.auth_is_in_organization(policies.organization_id)))
    )
  );

-- policy_versions — scoped through the parent policies row ------------------
DROP POLICY IF EXISTS "policy_versions_ins" ON public.policy_versions;
CREATE POLICY "policy_versions_ins" ON public.policy_versions FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = (select auth.uid())
         AND (SELECT private.auth_is_active_staff())
         AND (p.role = 'master'::text
              OR (p.role = 'owner'::text AND EXISTS (
                    SELECT 1 FROM public.policies pp
                     WHERE pp.id = policy_versions.policy_id
                       AND private.auth_is_in_organization(pp.organization_id))))
    )
  );

DROP POLICY IF EXISTS "policy_versions_upd" ON public.policy_versions;
CREATE POLICY "policy_versions_upd" ON public.policy_versions FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = (select auth.uid())
         AND (SELECT private.auth_is_active_staff())
         AND (p.role = 'master'::text
              OR (p.role = 'owner'::text AND EXISTS (
                    SELECT 1 FROM public.policies pp
                     WHERE pp.id = policy_versions.policy_id
                       AND private.auth_is_in_organization(pp.organization_id))))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = (select auth.uid())
         AND (SELECT private.auth_is_active_staff())
         AND (p.role = 'master'::text
              OR (p.role = 'owner'::text AND EXISTS (
                    SELECT 1 FROM public.policies pp
                     WHERE pp.id = policy_versions.policy_id
                       AND private.auth_is_in_organization(pp.organization_id))))
    )
  );

DROP POLICY IF EXISTS "policy_versions_del" ON public.policy_versions;
CREATE POLICY "policy_versions_del" ON public.policy_versions FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = (select auth.uid())
         AND (SELECT private.auth_is_active_staff())
         AND (p.role = 'master'::text
              OR (p.role = 'owner'::text AND EXISTS (
                    SELECT 1 FROM public.policies pp
                     WHERE pp.id = policy_versions.policy_id
                       AND private.auth_is_in_organization(pp.organization_id))))
    )
  );

-- Self-check (reads the POST-state; a failure aborts the whole file): RLS is
-- on both tables, exactly these six write policies exist, every one is
-- permissive, and every clause each one has names auth_is_in_organization and
-- keeps the active-staff gate.
DO $$
DECLARE
  n_narrowed int;
  n_writes int;
  n_rls_on int;
BEGIN
  SELECT count(*) INTO n_rls_on
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relname IN ('policies', 'policy_versions') AND c.relrowsecurity;
  IF n_rls_on <> 2 THEN
    RAISE EXCEPTION 'W0.5b (mig 714): RLS is not enabled on both policies and policy_versions';
  END IF;

  SELECT count(*) INTO n_writes
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename IN ('policies', 'policy_versions') AND cmd <> 'SELECT';

  SELECT count(*) INTO n_narrowed
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (tablename, policyname) IN (
      ('policies', 'policies_ins'), ('policies', 'policies_upd'), ('policies', 'policies_del'),
      ('policy_versions', 'policy_versions_ins'), ('policy_versions', 'policy_versions_upd'),
      ('policy_versions', 'policy_versions_del'))
    AND permissive = 'PERMISSIVE'
    AND (qual IS NULL OR (qual LIKE '%auth_is_in_organization%' AND qual LIKE '%auth_is_active_staff%'))
    AND (with_check IS NULL OR (with_check LIKE '%auth_is_in_organization%' AND with_check LIKE '%auth_is_active_staff%'));

  IF n_narrowed <> 6 OR n_writes <> 6 THEN
    RAISE EXCEPTION 'W0.5b (mig 714): expected exactly 6 org-scoped write policies on policies/policy_versions, found % narrowed of % write policies', n_narrowed, n_writes;
  END IF;
END $$;
