-- 731 — UN1TDUAL.1: a contact is readable at a studio where they hold an
-- ACTIVE membership, by staff who hold Contacts at that studio, exactly as
-- if the contact lived there. And the contacts list's crossover RPC counts
-- those members as crossovers.
--
-- APPLIED to prod 2026-10-17 (before merge; self-check passed). Proven ahead of apply by
-- tests/migration-731-contacts-read-by-membership.test.js (PGlite; the real
-- 690, 691 and 699 files first, then this one).
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- Hatch Street members who also train at Stillorgan have ONE contact row,
-- and it lives at Stillorgan (location_id = Stillorgan). Their Hatch
-- membership is a contact_memberships row (mig 722; source widened by 726)
-- at Hatch. Since mig 690, contacts_select admits a staff session only at
-- studios where it holds Contacts, by the contact's location_id, so Hatch
-- staff could not read their own members. The decision (UN1TDUAL plan,
-- 17 Oct 2026): an active membership at a studio makes the contact readable
-- there, to exactly the people who can read that studio's contacts.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   1. private.auth_contact_membership_contact_ids() -> uuid[]: the contact
--      ids with an active contact_memberships row at any studio in
--      private.auth_contact_read_location_ids(). It CALLS that resolver
--      (never copies it), so every tier 690/699 apply (studio switch, bundle,
--      master, per-user override, role templates, role defaults, org admin,
--      active non-deleted profiles) applies to the membership branch too.
--      SECURITY DEFINER because contact_memberships has RLS on, no policy and
--      no client privilege (722); signed-in sessions still cannot read it.
--      Any source counts (un1t_online_export, un1t_online_api, ...); only
--      status = 'active' matters, so an ended membership stops it.
--   2. contacts_select: only USING changes, one more OR branch,
--        id = ANY ((SELECT private.auth_contact_membership_contact_ids())::uuid[])
--      in the same InitPlan form as 690's (once per statement; the ::uuid[]
--      is load-bearing). Name, command, roles and the other two branches are
--      unchanged. No privilege on contacts changes.
--   3. public.crossover_contact_ids(loc) (mig 251, service role only): also
--      returns contacts with an active membership at loc whose contact row
--      lives elsewhere (UNION, so distinct), so the contacts list and search
--      show them at Hatch. EXECUTE stays service_role only.
--
-- WHO CHANGES: staff holding Contacts at a studio gain that studio's active
-- members whose contact row lives at another studio. Nobody loses a row.
-- Members are unchanged (own row only). Child tables whose staff branch
-- reads contacts as the caller widen with it, for those contacts only.
--
-- Guard: tests/contacts-read-scope-migration-guard.test.js accepts exactly
-- this branch (by helper name and form) and fails any other widening; it also
-- pins the membership helper's body to the Contacts resolver.
-- APPLY: before the app code that depends on it merges (controller), then
-- get_advisors (security).
-- ROLLBACK (forward migration, in this order):
--   ALTER POLICY contacts_select ON public.contacts USING (
--     location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
--     OR user_id = (SELECT auth.uid()));
--   the CREATE OR REPLACE of public.crossover_contact_ids from mig 251,
--   verbatim, with its REVOKE / GRANT;
--   DROP FUNCTION private.auth_contact_membership_contact_ids();
-- (tests/migration-731-contacts-read-by-membership.test.js runs this record.)
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
  -- 690's USING (699 left it alone), or, on a re-run, this file's.
  v_old text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)))$q$;
  v_new text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))$q$;
  -- normalised md5 (comments and whitespace removed) of crossover_contact_ids:
  -- mig 251's body, or, on a re-run, this file's.
  v_old_cross text := '7d7ec5a504dbfdf6a4ab64cc0362901c';
  v_new_cross text := '5e05a258fd9a91b4be4c969034e4c232';
  v_h text;
  v_fn oid := to_regprocedure('private.auth_contact_read_location_ids()');
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}'
                       AND with_check IS NULL AND qual IN (v_old, v_new)) THEN
    RAISE EXCEPTION 'mig 731: public.contacts does not have exactly the mig 690 contacts_select policy; re-plan (found: %)',
      (SELECT string_agg(policyname || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-'), ' ; ')
         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts');
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass) THEN
    RAISE EXCEPTION 'mig 731: row level security is off on public.contacts';
  END IF;
  IF has_table_privilege('anon', 'public.contacts', 'SELECT') THEN
    RAISE EXCEPTION 'mig 731: anon holds SELECT on public.contacts (mig 657 closed it); find out why first';
  END IF;
  -- the Contacts resolver this file calls (690, 699)
  IF v_fn IS NULL OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef AND prorettype = 'uuid[]'::regtype) THEN
    RAISE EXCEPTION 'mig 731: private.auth_contact_read_location_ids() is missing or not a SECURITY DEFINER uuid[] resolver; apply 690/699 first';
  END IF;
  -- contact_memberships (722): the columns read, and still closed to clients
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_memberships'
        AND column_name IN ('contact_id', 'location_id', 'status')) <> 3 THEN
    RAISE EXCEPTION 'mig 731: public.contact_memberships is missing or lacks contact_id / location_id / status; apply 722 first';
  END IF;
  -- has_any_column_privilege also catches a column-level grant, which
  -- has_table_privilege does not see
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contact_memberships'::regclass)
     OR has_any_column_privilege('anon', 'public.contact_memberships', 'SELECT')
     OR has_any_column_privilege('authenticated', 'public.contact_memberships', 'SELECT') THEN
    RAISE EXCEPTION 'mig 731: contact_memberships is readable by a client or has RLS off (722 closed it); find out why first';
  END IF;
  -- crossover_contact_ids: replaced whole, so a hand edit on prod aborts this file
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_h
    FROM pg_proc WHERE oid = to_regprocedure('public.crossover_contact_ids(uuid)');
  IF v_h IS NULL OR v_h NOT IN (v_old_cross, v_new_cross) THEN
    RAISE EXCEPTION 'mig 731: public.crossover_contact_ids(uuid) is not the mig 251 body (normalised md5 %); re-plan', v_h;
  END IF;
END $$;

CREATE TEMP TABLE m731_contacts_acl ON COMMIT DROP AS
  SELECT relacl::text AS acl FROM pg_class WHERE oid = 'public.contacts'::regclass;

-- 1. The membership resolver: delegates the studio set to the Contacts
--    resolver. The inner (SELECT …)::uuid[] makes that call an InitPlan too.
CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT coalesce(array_agg(DISTINCT cm.contact_id), '{}'::uuid[])
    FROM public.contact_memberships cm
   WHERE cm.status = 'active'
     AND cm.location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
$function$;

COMMENT ON FUNCTION private.auth_contact_membership_contact_ids() IS
  'UN1TDUAL.1 (mig 731): contact ids with an ACTIVE contact_memberships row at a studio where the caller holds Contacts (private.auth_contact_read_location_ids(), so every tier of that resolver applies). Read by contacts_select as an InitPlan. tests/contacts-read-scope-migration-guard.test.js pins the delegation.';

-- Mig 678 already makes a new private function executable by authenticated +
-- service_role only; stated here so the file means the same without 678.
REVOKE ALL ON FUNCTION private.auth_contact_membership_contact_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.auth_contact_membership_contact_ids() TO authenticated, service_role;

-- 2. The policy: only USING changes (one more OR branch).
ALTER POLICY contacts_select ON public.contacts USING (
  location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
  OR user_id = (SELECT auth.uid())
  OR id = ANY ((SELECT private.auth_contact_membership_contact_ids())::uuid[])
);

-- 3. The crossover RPC (mig 251): deal holders owned by another studio, plus
--    active members here whose contact row lives at another studio.
CREATE OR REPLACE FUNCTION public.crossover_contact_ids(loc uuid)
RETURNS TABLE (contact_id uuid)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT d.contact_id
    FROM public.deals d
    JOIN public.contacts c ON c.id = d.contact_id
   WHERE d.location_id = loc
     AND c.location_id IS DISTINCT FROM loc   -- owned by ANOTHER studio (or none)
     AND d.contact_id IS NOT NULL
  UNION
  SELECT cm.contact_id
    FROM public.contact_memberships cm
    JOIN public.contacts c ON c.id = cm.contact_id
   WHERE cm.location_id = loc
     AND cm.status = 'active'
     AND c.location_id IS DISTINCT FROM loc
$function$;

-- Server-side only (the contacts page + search route, service-role client).
REVOKE ALL ON FUNCTION public.crossover_contact_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crossover_contact_ids(uuid) TO service_role;

-- 4. Self-check: the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_new text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))$q$;
  v_new_cross text := '5e05a258fd9a91b4be4c969034e4c232';
  v_fn oid := to_regprocedure('private.auth_contact_membership_contact_ids()');
  v_read oid := to_regprocedure('private.auth_contact_read_location_ids()');
  v_cross oid := to_regprocedure('public.crossover_contact_ids(uuid)');
  v_found text;
BEGIN
  -- a. the helper: DEFINER, STABLE, empty search_path, uuid[], owned by the
  --    migration role, and it delegates to the Contacts resolver
  IF v_fn IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef AND provolatile = 's'
          AND prorettype = 'uuid[]'::regtype AND proconfig @> ARRAY['search_path=""']
          AND proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND prosrc ~ 'private\.auth_contact_read_location_ids\(\)'
          AND prosrc ~ 'status = ''active''') THEN
    RAISE EXCEPTION 'mig 731: private.auth_contact_membership_contact_ids is missing, not SECURITY DEFINER / STABLE / search_path '''' / uuid[] / owned by %, or does not delegate to auth_contact_read_location_ids', current_user;
  END IF;
  -- b. EXECUTE: authenticated and service_role only, on both helpers
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', v_read, 'EXECUTE')
     OR has_function_privilege('anon', v_read, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 731: EXECUTE on the contact read helpers must be authenticated + service_role only';
  END IF;
  -- c. exactly one policy, same shape, the new USING (both helpers in the
  --    (SELECT …)::uuid[] InitPlan form)
  SELECT string_agg(policyname || ' ' || permissive || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-')
                    || ' CHECK ' || coalesce(with_check, '-'), ' ; ')
    INTO v_found FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts';
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}'
                       AND with_check IS NULL AND qual = v_new) THEN
    RAISE EXCEPTION 'mig 731: contacts_select is not the expected policy; found: %', v_found;
  END IF;
  -- d. RLS on, not forced; the table ACL untouched; still no client write, no anon read
  IF NOT (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass) THEN
    RAISE EXCEPTION 'mig 731: contacts RLS changed';
  END IF;
  IF (SELECT relacl::text FROM pg_class WHERE oid = 'public.contacts'::regclass) IS DISTINCT FROM (SELECT acl FROM m731_contacts_acl) THEN
    RAISE EXCEPTION 'mig 731: the contacts ACL changed; this file must not touch privileges';
  END IF;
  IF has_table_privilege('anon', 'public.contacts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.contacts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.contacts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.contacts', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.contacts', 'SELECT') THEN
    RAISE EXCEPTION 'mig 731: contacts privileges are not 653/657''s (authenticated SELECT only, anon nothing)';
  END IF;
  -- e. crossover_contact_ids: this file's body, INVOKER, service_role only
  IF v_cross IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = v_cross AND NOT prosecdef AND provolatile = 's'
          AND md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) = v_new_cross) THEN
    RAISE EXCEPTION 'mig 731: public.crossover_contact_ids is not this file''s SECURITY INVOKER / STABLE body';
  END IF;
  IF has_function_privilege('authenticated', v_cross, 'EXECUTE')
     OR has_function_privilege('anon', v_cross, 'EXECUTE')
     OR has_function_privilege('public', v_cross, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_cross, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 731: EXECUTE on public.crossover_contact_ids must be service_role only';
  END IF;
  -- f. the helper runs: with no signed-in user it returns no contact
  IF private.auth_contact_membership_contact_ids() IS DISTINCT FROM '{}'::uuid[] THEN
    RAISE EXCEPTION 'mig 731: the membership helper returned contacts with no signed-in user';
  END IF;

  RAISE NOTICE 'mig 731: contacts_select also admits active members of a studio where the caller holds Contacts; crossover_contact_ids counts them; privileges unchanged.';
END $$;

COMMIT;
