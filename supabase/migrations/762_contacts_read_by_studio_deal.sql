-- 762 — ORGCONTACTS.0: a contact holding a DEAL at a studio is readable by
-- staff who hold Contacts there, through the same helper that admits an
-- active membership (731), a un1t.online client (732) and a Glofox crossover
-- member (758).
--
-- Proven by tests/migration-762-contacts-read-by-studio-deal.test.js (PGlite;
-- the real 690, 691, 699, 731, 732 and 758 files first, then this one).
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- The web contacts list has shown a studio's deal holders who live at another
-- studio since mig 251 (public.crossover_contact_ids reads deals), and the
-- contact page's gate (canViewContact) admits them, but RLS never did: the
-- helper behind contacts_select reads memberships, un1t clients and Glofox
-- crossovers only. The phone directory lists the RPC's ids and then reads the
-- rows through RLS, so a deal-only crossover (a Stillorgan member on Hatch's
-- waitlist board) was in the web list and missing from the phone's. One
-- definition of "at this studio" for both: the deal joins the helper. This is
-- Phase 0 of docs/superpowers/specs/2026-10-20-org-shared-contacts-whatsapp-design.md
-- (§4, "deals added to the RLS helper"); the contact_studios table of Phase 1
-- replaces every branch of this helper in a later migration.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   private.auth_contact_membership_contact_ids() keeps its name, signature
--   and ACL (CREATE OR REPLACE) and gains a fourth UNION branch: contacts
--   holding a deals row (any status: a closed deal is still a relationship,
--   and the RPC never filtered on it either) at a studio in
--   private.auth_contact_read_location_ids(), in the (SELECT …)::uuid[]
--   InitPlan form, so every tier of that resolver applies.
--   contacts_select and public.crossover_contact_ids(uuid) are NOT altered
--   (the policy already reads the helper; the RPC already returns deal
--   holders). The self-check asserts both.
--
-- WHO CHANGES: staff holding Contacts at a studio gain that studio's deal
-- holders whose contact lives elsewhere, on the phone and anywhere else RLS
-- binds. Nobody loses a row. Members unchanged (own row only).
--
-- Guard: tests/contacts-read-scope-migration-guard.test.js accepts exactly
-- 731's, 732's, 758's and this file's helper body and fails any other.
-- APPLY: before the app code that depends on it merges, then get_advisors
-- (security).
-- ROLLBACK (forward migration): section 2 of mig 758, verbatim (the CREATE
--   OR REPLACE of private.auth_contact_membership_contact_ids() with its
--   REVOKE / GRANT). tests/migration-762-contacts-read-by-studio-deal.test.js
--   runs this record.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
-- pg_policies prints qual relative to the search_path; pinned so the
-- self-check's text comparison holds whatever path the applying session has.
SET LOCAL search_path = public;

-- 0. Pre-checks.
DO $$
DECLARE
  v_qual text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))$q$;
  -- normalised md5 (comments and whitespace removed): mig 758's body, or,
  -- on a re-run, this file's.
  v_old_helper text := '7cd4abc90399d971eb0c7f347dd63da4';
  v_new_helper text := '65daa4835035bf30cad782fdd7bc6e4e';
  v_h text;
  v_fn oid := to_regprocedure('private.auth_contact_read_location_ids()');
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}'
                       AND with_check IS NULL AND qual = v_qual) THEN
    RAISE EXCEPTION 'mig 762: public.contacts does not have exactly the mig 731 contacts_select policy; re-plan (found: %)',
      (SELECT string_agg(policyname || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-'), ' ; ')
         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts');
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass) THEN
    RAISE EXCEPTION 'mig 762: row level security is off on public.contacts';
  END IF;
  IF v_fn IS NULL OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef AND prorettype = 'uuid[]'::regtype) THEN
    RAISE EXCEPTION 'mig 762: private.auth_contact_read_location_ids() is missing or not a SECURITY DEFINER uuid[] resolver; apply 690/699 first';
  END IF;
  IF to_regclass('public.deals') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'deals' AND column_name = 'contact_id') THEN
    RAISE EXCEPTION 'mig 762: public.deals.contact_id is missing';
  END IF;
  -- the function is replaced whole, so a hand edit on prod aborts this file
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_h
    FROM pg_proc WHERE oid = to_regprocedure('private.auth_contact_membership_contact_ids()');
  IF v_h IS NULL OR v_h NOT IN (v_old_helper, v_new_helper) THEN
    RAISE EXCEPTION 'mig 762: private.auth_contact_membership_contact_ids() is not the mig 758 body (normalised md5 %); re-plan', v_h;
  END IF;
END $$;

CREATE TEMP TABLE m762_acl ON COMMIT DROP AS
  SELECT oid::regclass::text AS rel, relacl::text AS acl FROM pg_class
   WHERE oid IN ('public.contacts'::regclass, 'public.deals'::regclass);
CREATE TEMP TABLE m762_cross ON COMMIT DROP AS
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) AS h, proacl::text AS acl
    FROM pg_proc WHERE oid = to_regprocedure('public.crossover_contact_ids(uuid)');

-- 1. The read helper: active memberships (731), un1t clients (732), Glofox
--    crossover members (758) and deal holders (this file), all at the
--    studios the Contacts resolver returns. Each inner (SELECT …)::uuid[]
--    is an InitPlan.
CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT coalesce(array_agg(DISTINCT x.contact_id), '{}'::uuid[])
    FROM (
      SELECT cm.contact_id
        FROM public.contact_memberships cm
       WHERE cm.status = 'active'
         AND cm.location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
      UNION
      SELECT uc.contact_id
        FROM public.un1t_clients uc
       WHERE uc.contact_id IS NOT NULL
         AND uc.location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
      UNION
      SELECT gx.contact_id
        FROM public.glofox_crossover_members gx
       WHERE gx.location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
      UNION
      SELECT d.contact_id
        FROM public.deals d
       WHERE d.contact_id IS NOT NULL
         AND d.location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
    ) x
$function$;

COMMENT ON FUNCTION private.auth_contact_membership_contact_ids() IS
  'UN1TDUAL.1 (mig 731) + UN1TDUAL.4 (mig 732) + GLOFOXSIBLING.1 (mig 758) + ORGCONTACTS.0 (mig 762): contact ids with an ACTIVE contact_memberships row, linked by a un1t_clients row (any un1t status), linked by a glofox_crossover_members row, or holding a deals row (any status), at a studio where the caller holds Contacts (private.auth_contact_read_location_ids(), so every tier of that resolver applies). Read by contacts_select as an InitPlan. tests/contacts-read-scope-migration-guard.test.js pins the body.';

-- CREATE OR REPLACE keeps the ACL; stated so the file means the same alone.
REVOKE ALL ON FUNCTION private.auth_contact_membership_contact_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.auth_contact_membership_contact_ids() TO authenticated, service_role;

-- 2. contacts_select and crossover_contact_ids: unchanged (see the self-check).

-- 3. Self-check: the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_qual text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))$q$;
  v_new_helper text := '65daa4835035bf30cad782fdd7bc6e4e';
  v_fn oid := to_regprocedure('private.auth_contact_membership_contact_ids()');
  v_read oid := to_regprocedure('private.auth_contact_read_location_ids()');
  v_cross oid := to_regprocedure('public.crossover_contact_ids(uuid)');
  v_found text;
BEGIN
  -- a. the helper: this file's body, DEFINER, STABLE, empty search_path,
  --    uuid[], owned by the migration role
  IF v_fn IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef AND provolatile = 's'
          AND prorettype = 'uuid[]'::regtype AND proconfig @> ARRAY['search_path=""']
          AND proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) = v_new_helper) THEN
    RAISE EXCEPTION 'mig 762: private.auth_contact_membership_contact_ids is not this file''s body, or not SECURITY DEFINER / STABLE / search_path '''' / uuid[] / owned by %', current_user;
  END IF;
  -- b. EXECUTE: authenticated and service_role only, on both helpers
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', v_read, 'EXECUTE')
     OR has_function_privilege('anon', v_read, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 762: EXECUTE on the contact read helpers must be authenticated + service_role only';
  END IF;
  -- c. exactly one policy, 731's, untouched
  SELECT string_agg(policyname || ' ' || permissive || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-')
                    || ' CHECK ' || coalesce(with_check, '-'), ' ; ')
    INTO v_found FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts';
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}'
                       AND with_check IS NULL AND qual = v_qual) THEN
    RAISE EXCEPTION 'mig 762: contacts_select is not mig 731''s policy; found: %', v_found;
  END IF;
  -- d. contacts and deals: RLS and ACLs untouched
  IF NOT (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass) THEN
    RAISE EXCEPTION 'mig 762: contacts RLS changed';
  END IF;
  IF EXISTS (SELECT 1 FROM m762_acl a JOIN pg_class c ON c.oid = a.rel::regclass
              WHERE c.relacl::text IS DISTINCT FROM a.acl) THEN
    RAISE EXCEPTION 'mig 762: the contacts or deals ACL changed; this file must not touch their privileges';
  END IF;
  -- e. crossover_contact_ids: body and ACL untouched
  IF v_cross IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_proc p, m762_cross m WHERE p.oid = v_cross
          AND md5(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) = m.h
          AND p.proacl::text IS NOT DISTINCT FROM m.acl) THEN
    RAISE EXCEPTION 'mig 762: public.crossover_contact_ids changed; this file must not touch it';
  END IF;
  -- f. the helper runs: with no signed-in user it returns no contact
  IF private.auth_contact_membership_contact_ids() IS DISTINCT FROM '{}'::uuid[] THEN
    RAISE EXCEPTION 'mig 762: the read helper returned contacts with no signed-in user';
  END IF;

  RAISE NOTICE 'mig 762: contacts_select also admits a studio''s deal holders to staff holding Contacts there; policy and crossover_contact_ids unchanged.';
END $$;

COMMIT;
