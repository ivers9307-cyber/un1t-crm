-- 758 — GLOFOXSIBLING.1: a Stillorgan Glofox member whose one CRM contact
-- lives at another studio of the same organisation (Hatch Street) is linked,
-- not dropped, and is readable by staff who hold Contacts at the Glofox studio.
--
-- Proven by tests/migration-758-glofox-crossover-members.test.js (PGlite; the
-- real 690, 691, 699, 731 and 732 files first, then this one).
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- contacts_email_org_unique (mig 712; mig 008's global index before it) holds
-- one contact per email per ORGANISATION, while every Glofox lookup is scoped
-- to the studio's LOCATION. A Glofox member at Stillorgan whose email already
-- belongs to a Hatch contact missed the lookup, the sync tried to INSERT a
-- Stillorgan contact, the insert hit the unique index, and the member never
-- reached the CRM: the webhook marked the event contact_not_found and the
-- nightly sync counted the failure as a 'create'. 14 people in 90 days, all
-- genuine Hatch clients (12 un1t.online clients, 6 with an active Hatch
-- membership) who also hold a Stillorgan Glofox account. Moving their contact
-- to Stillorgan would take it from Hatch. The decision (Richard, 19 Oct 2026):
-- attach the Glofox account to the existing contact, as the un1t.online sync
-- does in the other direction (mig 732), with full visibility at the Glofox
-- studio.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   1. public.glofox_crossover_members: one row per (Glofox studio, Glofox
--      member id) whose contact lives at another studio. Written only by the
--      service-role Glofox sync (src/lib/glofox-crossover.js). RLS on, no
--      policy, no client privilege: the same shape as un1t_clients (726).
--   2. private.auth_contact_membership_contact_ids() keeps its name,
--      signature and ACL (CREATE OR REPLACE) and gains a third UNION branch:
--      contacts linked by a glofox_crossover_members row at a studio in
--      private.auth_contact_read_location_ids(), called in the
--      (SELECT …)::uuid[] InitPlan form like 731's and 732's branches, so
--      every tier of that resolver applies. The helper is DEFINER, so it reads
--      the closed table; signed-in sessions still cannot.
--   3. contacts_select is NOT altered (731's membership branch already reads
--      the helper). The self-check asserts its USING is still 731's.
--   4. public.crossover_contact_ids(loc) (251, 731, 732; service role only)
--      also returns contacts linked by a glofox_crossover_members row at loc
--      whose contact row lives elsewhere.
--
-- WHO CHANGES: staff holding Contacts at a Glofox studio gain that studio's
-- Glofox members whose contact lives at a sibling studio. Nobody loses a row.
-- Members unchanged (own row only).
--
-- Guard: tests/contacts-read-scope-migration-guard.test.js accepts exactly
-- 731's, 732's and this file's helper body and fails any other.
-- APPLY: before the app code that depends on it merges, then get_advisors
-- (security). The code tolerates the table being absent (the link write is
-- logged, never fatal), but the visibility only exists once this is applied.
-- ROLLBACK (forward migration): sections 1 and 3 of mig 732, verbatim (the
--   CREATE OR REPLACE of private.auth_contact_membership_contact_ids() with
--   its REVOKE / GRANT, and of public.crossover_contact_ids(uuid) with its
--   REVOKE / GRANT). The table may stay: with neither function reading it, it
--   grants nothing. (tests/migration-758-glofox-crossover-members.test.js
--   runs this record.)
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
  -- normalised md5 (comments and whitespace removed): mig 732's bodies, or,
  -- on a re-run, this file's.
  v_old_helper text := '1746a3d246350da442317c60b031f198';
  v_new_helper text := '7cd4abc90399d971eb0c7f347dd63da4';
  v_old_cross text := '2405785fc7747bfd34dd08a9fe7f20af';
  v_new_cross text := 'b9489caf0954b06c3102d802133013e8';
  v_h text;
  v_fn oid := to_regprocedure('private.auth_contact_read_location_ids()');
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}'
                       AND with_check IS NULL AND qual = v_qual) THEN
    RAISE EXCEPTION 'mig 758: public.contacts does not have exactly the mig 731 contacts_select policy; re-plan (found: %)',
      (SELECT string_agg(policyname || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-'), ' ; ')
         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts');
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass) THEN
    RAISE EXCEPTION 'mig 758: row level security is off on public.contacts';
  END IF;
  IF v_fn IS NULL OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef AND prorettype = 'uuid[]'::regtype) THEN
    RAISE EXCEPTION 'mig 758: private.auth_contact_read_location_ids() is missing or not a SECURITY DEFINER uuid[] resolver; apply 690/699 first';
  END IF;
  -- both functions are replaced whole, so a hand edit on prod aborts this file
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_h
    FROM pg_proc WHERE oid = to_regprocedure('private.auth_contact_membership_contact_ids()');
  IF v_h IS NULL OR v_h NOT IN (v_old_helper, v_new_helper) THEN
    RAISE EXCEPTION 'mig 758: private.auth_contact_membership_contact_ids() is not the mig 732 body (normalised md5 %); re-plan', v_h;
  END IF;
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_h
    FROM pg_proc WHERE oid = to_regprocedure('public.crossover_contact_ids(uuid)');
  IF v_h IS NULL OR v_h NOT IN (v_old_cross, v_new_cross) THEN
    RAISE EXCEPTION 'mig 758: public.crossover_contact_ids(uuid) is not the mig 732 body (normalised md5 %); re-plan', v_h;
  END IF;
END $$;

CREATE TEMP TABLE m758_acl ON COMMIT DROP AS
  SELECT oid::regclass::text AS rel, relacl::text AS acl FROM pg_class
   WHERE oid IN ('public.contacts'::regclass, 'public.un1t_clients'::regclass);

-- 1. The link table. Service role only (mig 677's default for a new relation,
--    stated so the file means the same on a database whose defaults differ).
CREATE TABLE IF NOT EXISTS public.glofox_crossover_members (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id      uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  glofox_member_id text        NOT NULL CHECK (length(btrim(glofox_member_id)) > 0),
  contact_id       uuid        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, glofox_member_id)
);
CREATE INDEX IF NOT EXISTS glofox_crossover_members_location_contact
  ON public.glofox_crossover_members (location_id, contact_id);
CREATE INDEX IF NOT EXISTS glofox_crossover_members_contact
  ON public.glofox_crossover_members (contact_id);

ALTER TABLE public.glofox_crossover_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.glofox_crossover_members FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.glofox_crossover_members TO service_role;

COMMENT ON TABLE public.glofox_crossover_members IS
  'GLOFOXSIBLING.1 (mig 758): a Glofox member of this studio whose CRM contact lives at another studio of the same organisation (one contact per email per organisation, mig 712). Written only by the service-role Glofox sync (src/lib/glofox-crossover.js). Read by private.auth_contact_membership_contact_ids() and public.crossover_contact_ids(uuid) so staff holding Contacts here can read the contact. RLS on, no policy, no client privilege.';

-- 2. The read helper: active memberships (731), un1t clients (732), and
--    Glofox crossover members (this file), all at the studios the Contacts
--    resolver returns. Each inner (SELECT …)::uuid[] is an InitPlan.
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
    ) x
$function$;

COMMENT ON FUNCTION private.auth_contact_membership_contact_ids() IS
  'UN1TDUAL.1 (mig 731) + UN1TDUAL.4 (mig 732) + GLOFOXSIBLING.1 (mig 758): contact ids with an ACTIVE contact_memberships row, linked by a un1t_clients row (any un1t status), or linked by a glofox_crossover_members row, at a studio where the caller holds Contacts (private.auth_contact_read_location_ids(), so every tier of that resolver applies). Read by contacts_select as an InitPlan. tests/contacts-read-scope-migration-guard.test.js pins the body.';

REVOKE ALL ON FUNCTION private.auth_contact_membership_contact_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.auth_contact_membership_contact_ids() TO authenticated, service_role;

-- 3. contacts_select: unchanged (see the self-check).

-- 4. The crossover RPC: deal holders, active members, un1t clients and Glofox
--    crossover members here whose contact row lives at another studio.
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
  UNION
  SELECT uc.contact_id
    FROM public.un1t_clients uc
    JOIN public.contacts c ON c.id = uc.contact_id
   WHERE uc.location_id = loc
     AND c.location_id IS DISTINCT FROM loc
  UNION
  SELECT gx.contact_id
    FROM public.glofox_crossover_members gx
    JOIN public.contacts c ON c.id = gx.contact_id
   WHERE gx.location_id = loc
     AND c.location_id IS DISTINCT FROM loc
$function$;

REVOKE ALL ON FUNCTION public.crossover_contact_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crossover_contact_ids(uuid) TO service_role;

-- 5. Self-check: the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_qual text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))$q$;
  v_new_helper text := '7cd4abc90399d971eb0c7f347dd63da4';
  v_new_cross text := 'b9489caf0954b06c3102d802133013e8';
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
    RAISE EXCEPTION 'mig 758: private.auth_contact_membership_contact_ids is not this file''s body, or not SECURITY DEFINER / STABLE / search_path '''' / uuid[] / owned by %', current_user;
  END IF;
  -- b. EXECUTE: authenticated and service_role only, on both helpers
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', v_read, 'EXECUTE')
     OR has_function_privilege('anon', v_read, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 758: EXECUTE on the contact read helpers must be authenticated + service_role only';
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
    RAISE EXCEPTION 'mig 758: contacts_select is not mig 731''s policy; found: %', v_found;
  END IF;
  -- d. the link table: RLS on, no policy, no client privilege (column-level
  --    too: has_table_privilege cannot see a column grant)
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.glofox_crossover_members'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'glofox_crossover_members')
     OR has_any_column_privilege('anon', 'public.glofox_crossover_members', 'SELECT')
     OR has_any_column_privilege('authenticated', 'public.glofox_crossover_members', 'SELECT')
     OR has_any_column_privilege('anon', 'public.glofox_crossover_members', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.glofox_crossover_members', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.glofox_crossover_members', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.glofox_crossover_members', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.glofox_crossover_members', 'INSERT') THEN
    RAISE EXCEPTION 'mig 758: glofox_crossover_members must have RLS on, no policy, and no client privilege';
  END IF;
  -- e. contacts and un1t_clients: RLS and ACLs untouched
  IF NOT (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.un1t_clients'::regclass) THEN
    RAISE EXCEPTION 'mig 758: contacts or un1t_clients RLS changed';
  END IF;
  IF EXISTS (SELECT 1 FROM m758_acl a JOIN pg_class c ON c.oid = a.rel::regclass
              WHERE c.relacl::text IS DISTINCT FROM a.acl) THEN
    RAISE EXCEPTION 'mig 758: the contacts or un1t_clients ACL changed; this file must not touch their privileges';
  END IF;
  -- f. crossover_contact_ids: this file's body, INVOKER, service_role only
  IF v_cross IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = v_cross AND NOT prosecdef AND provolatile = 's'
          AND md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) = v_new_cross) THEN
    RAISE EXCEPTION 'mig 758: public.crossover_contact_ids is not this file''s SECURITY INVOKER / STABLE body';
  END IF;
  IF has_function_privilege('authenticated', v_cross, 'EXECUTE')
     OR has_function_privilege('anon', v_cross, 'EXECUTE')
     OR has_function_privilege('public', v_cross, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_cross, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 758: EXECUTE on public.crossover_contact_ids must be service_role only';
  END IF;
  -- g. the helper runs: with no signed-in user it returns no contact
  IF private.auth_contact_membership_contact_ids() IS DISTINCT FROM '{}'::uuid[] THEN
    RAISE EXCEPTION 'mig 758: the read helper returned contacts with no signed-in user';
  END IF;

  RAISE NOTICE 'mig 758: glofox_crossover_members created (service role only); contacts_select also admits a Glofox studio''s crossover members to staff holding Contacts there; crossover_contact_ids counts them; policy unchanged.';
END $$;

COMMIT;
