-- 732 — UN1TDUAL.4: a contact is readable at a studio whose un1t.online
-- account lists them as a client (a public.un1t_clients row at that studio
-- linked to the contact), active member or not, by staff who hold Contacts at
-- that studio. And the contacts list's crossover RPC counts those clients as
-- crossovers.
--
-- APPLIED to prod 2026-10-17 (before merge; self-check passed). Proven by
-- tests/migration-732-contacts-read-by-studio-client.test.js (PGlite; the
-- real 690, 691, 699 and 731 files first, then this one).
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- Mig 731 made a contact readable at a studio where they hold an ACTIVE
-- contact_memberships row. At Hatch Street that opened 10 of the 52 people
-- the studio's un1t.online account lists as clients whose one contact row
-- lives at Stillorgan. The other 42 are lapsed or never-bought clients, and
-- they still get Hatch marketing (39 of the 52 already had a Hatch
-- preference row), so Hatch staff were mailing people they could not open.
-- The decision (Richard, 17 Oct 2026, after #2079): staff visibility matches
-- the studio's reach, so a un1t_clients row at a studio makes its linked
-- contact readable there, whatever the client's un1t status, to exactly the
-- people who can read that studio's contacts.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   1. private.auth_contact_membership_contact_ids() keeps its name,
--      signature and ACL (CREATE OR REPLACE) and gains a UNION branch: the
--      contact ids linked by a un1t_clients row at any studio in
--      private.auth_contact_read_location_ids(). Each branch CALLS that
--      resolver (never copies it) in the (SELECT …)::uuid[] InitPlan form, so
--      every tier 690/699 apply (studio switch, bundle, master, per-user
--      override, role templates, role defaults, org admin, active
--      non-deleted profiles) applies to the client branch too. un1t_clients
--      has RLS on, no policy and no client privilege (726); this DEFINER
--      helper reads it, signed-in sessions still cannot. Any un1t status
--      counts (active, inactive, blocked, ...); a row whose contact_id is
--      NULL (unmatched) grants nothing. It reads the live row, so a relink or
--      merge by the un1t sync moves the visibility with it.
--   2. contacts_select is NOT altered: its membership branch already reads
--      this helper as an InitPlan (731). The self-check asserts its USING is
--      still exactly 731's.
--   3. public.crossover_contact_ids(loc) (mig 251, widened by 731, service
--      role only): also returns contacts linked by a un1t_clients row at loc
--      whose contact row lives elsewhere (UNION, so distinct). EXECUTE stays
--      service_role only.
--
-- WHO CHANGES: staff holding Contacts at a studio gain that studio's un1t
-- clients whose contact row lives at another studio. Nobody loses a row.
-- Members are unchanged (own row only). Child tables whose staff branch reads
-- contacts as the caller widen with it, for those contacts only.
--
-- Guard: tests/contacts-read-scope-migration-guard.test.js accepts exactly
-- 731's and this file's helper body (both branches restricted to the Contacts
-- resolver's studios) and fails any other.
-- APPLY: before the app code that depends on it merges (controller), then
-- get_advisors (security).
-- ROLLBACK (forward migration): sections 1 and 3 of mig 731, verbatim, i.e.
--   the CREATE OR REPLACE of private.auth_contact_membership_contact_ids()
--   with its REVOKE / GRANT, and the CREATE OR REPLACE of
--   public.crossover_contact_ids(uuid) with its REVOKE / GRANT.
--   contacts_select needs nothing (this file never touched it).
-- (tests/migration-732-contacts-read-by-studio-client.test.js runs this record.)
-- ===========================================================================

BEGIN;

-- Nothing here takes a lock on public.contacts, but a re-definition waits on
-- any session holding the functions; fail after 5 s rather than queue.
SET LOCAL lock_timeout = '5s';
-- pg_policies prints qual relative to the search_path; pinned so the
-- self-check's text comparison holds whatever path the applying session has.
SET LOCAL search_path = public;

-- 0. Pre-checks.
DO $$
DECLARE
  -- 731's USING; this file leaves it alone.
  v_qual text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))$q$;
  -- normalised md5 (comments and whitespace removed): mig 731's bodies, or,
  -- on a re-run, this file's.
  v_old_helper text := 'e71c67259c144a3baf7788d041e722cb';
  v_new_helper text := '1746a3d246350da442317c60b031f198';
  v_old_cross text := '5e05a258fd9a91b4be4c969034e4c232';
  v_new_cross text := '2405785fc7747bfd34dd08a9fe7f20af';
  v_h text;
  v_fn oid := to_regprocedure('private.auth_contact_read_location_ids()');
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}'
                       AND with_check IS NULL AND qual = v_qual) THEN
    RAISE EXCEPTION 'mig 732: public.contacts does not have exactly the mig 731 contacts_select policy; re-plan (found: %)',
      (SELECT string_agg(policyname || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-'), ' ; ')
         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts');
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass) THEN
    RAISE EXCEPTION 'mig 732: row level security is off on public.contacts';
  END IF;
  -- the Contacts resolver this file calls (690, 699)
  IF v_fn IS NULL OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef AND prorettype = 'uuid[]'::regtype) THEN
    RAISE EXCEPTION 'mig 732: private.auth_contact_read_location_ids() is missing or not a SECURITY DEFINER uuid[] resolver; apply 690/699 first';
  END IF;
  -- un1t_clients (726): the columns read, and still closed to clients
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'un1t_clients'
        AND column_name IN ('contact_id', 'location_id')) <> 2 THEN
    RAISE EXCEPTION 'mig 732: public.un1t_clients is missing or lacks contact_id / location_id; apply 726 first';
  END IF;
  -- has_any_column_privilege also catches a column-level grant, which
  -- has_table_privilege does not see
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.un1t_clients'::regclass)
     OR has_any_column_privilege('anon', 'public.un1t_clients', 'SELECT')
     OR has_any_column_privilege('authenticated', 'public.un1t_clients', 'SELECT') THEN
    RAISE EXCEPTION 'mig 732: un1t_clients is readable by a client or has RLS off (726 closed it); find out why first';
  END IF;
  -- both functions are replaced whole, so a hand edit on prod aborts this file
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_h
    FROM pg_proc WHERE oid = to_regprocedure('private.auth_contact_membership_contact_ids()');
  IF v_h IS NULL OR v_h NOT IN (v_old_helper, v_new_helper) THEN
    RAISE EXCEPTION 'mig 732: private.auth_contact_membership_contact_ids() is not the mig 731 body (normalised md5 %); re-plan', v_h;
  END IF;
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_h
    FROM pg_proc WHERE oid = to_regprocedure('public.crossover_contact_ids(uuid)');
  IF v_h IS NULL OR v_h NOT IN (v_old_cross, v_new_cross) THEN
    RAISE EXCEPTION 'mig 732: public.crossover_contact_ids(uuid) is not the mig 731 body (normalised md5 %); re-plan', v_h;
  END IF;
END $$;

CREATE TEMP TABLE m732_acl ON COMMIT DROP AS
  SELECT oid::regclass::text AS rel, relacl::text AS acl FROM pg_class
   WHERE oid IN ('public.contacts'::regclass, 'public.un1t_clients'::regclass);

-- 1. The read helper: active memberships (731) plus un1t clients, both at the
--    studios the Contacts resolver returns. Each inner (SELECT …)::uuid[] is
--    an InitPlan.
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
    ) x
$function$;

COMMENT ON FUNCTION private.auth_contact_membership_contact_ids() IS
  'UN1TDUAL.1 (mig 731) + UN1TDUAL.4 (mig 732): contact ids with an ACTIVE contact_memberships row, or linked by a un1t_clients row (any un1t status), at a studio where the caller holds Contacts (private.auth_contact_read_location_ids(), so every tier of that resolver applies). Read by contacts_select as an InitPlan. tests/contacts-read-scope-migration-guard.test.js pins the body.';

-- CREATE OR REPLACE keeps the ACL; stated so the file means the same alone.
REVOKE ALL ON FUNCTION private.auth_contact_membership_contact_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.auth_contact_membership_contact_ids() TO authenticated, service_role;

-- 2. contacts_select: unchanged (see the self-check).

-- 3. The crossover RPC (mig 251, 731): deal holders, active members and un1t
--    clients here whose contact row lives at another studio.
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
$function$;

-- Server-side only (the contacts page + search route, service-role client).
REVOKE ALL ON FUNCTION public.crossover_contact_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crossover_contact_ids(uuid) TO service_role;

-- 4. Self-check: the catalog, never this file (mig 153's lesson).
DO $$
DECLARE
  v_qual text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))$q$;
  v_new_helper text := '1746a3d246350da442317c60b031f198';
  v_new_cross text := '2405785fc7747bfd34dd08a9fe7f20af';
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
    RAISE EXCEPTION 'mig 732: private.auth_contact_membership_contact_ids is not this file''s body, or not SECURITY DEFINER / STABLE / search_path '''' / uuid[] / owned by %', current_user;
  END IF;
  -- b. EXECUTE: authenticated and service_role only, on both helpers
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', v_read, 'EXECUTE')
     OR has_function_privilege('anon', v_read, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 732: EXECUTE on the contact read helpers must be authenticated + service_role only';
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
    RAISE EXCEPTION 'mig 732: contacts_select is not mig 731''s policy; found: %', v_found;
  END IF;
  -- d. RLS on, not forced; the contacts and un1t_clients ACLs untouched; no
  --    client write on contacts, no anon read, no client read of un1t_clients
  IF NOT (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.un1t_clients'::regclass) THEN
    RAISE EXCEPTION 'mig 732: contacts or un1t_clients RLS changed';
  END IF;
  IF EXISTS (SELECT 1 FROM m732_acl a JOIN pg_class c ON c.oid = a.rel::regclass
              WHERE c.relacl::text IS DISTINCT FROM a.acl) THEN
    RAISE EXCEPTION 'mig 732: the contacts or un1t_clients ACL changed; this file must not touch privileges';
  END IF;
  IF has_table_privilege('anon', 'public.contacts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.contacts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.contacts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.contacts', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.contacts', 'SELECT')
     OR has_any_column_privilege('anon', 'public.un1t_clients', 'SELECT')
     OR has_any_column_privilege('authenticated', 'public.un1t_clients', 'SELECT') THEN
    RAISE EXCEPTION 'mig 732: contacts privileges are not 653/657''s, or a client can read un1t_clients';
  END IF;
  -- e. crossover_contact_ids: this file's body, INVOKER, service_role only
  IF v_cross IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = v_cross AND NOT prosecdef AND provolatile = 's'
          AND md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) = v_new_cross) THEN
    RAISE EXCEPTION 'mig 732: public.crossover_contact_ids is not this file''s SECURITY INVOKER / STABLE body';
  END IF;
  IF has_function_privilege('authenticated', v_cross, 'EXECUTE')
     OR has_function_privilege('anon', v_cross, 'EXECUTE')
     OR has_function_privilege('public', v_cross, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_cross, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 732: EXECUTE on public.crossover_contact_ids must be service_role only';
  END IF;
  -- f. the helper runs: with no signed-in user it returns no contact
  IF private.auth_contact_membership_contact_ids() IS DISTINCT FROM '{}'::uuid[] THEN
    RAISE EXCEPTION 'mig 732: the read helper returned contacts with no signed-in user';
  END IF;

  RAISE NOTICE 'mig 732: contacts_select also admits un1t.online clients of a studio where the caller holds Contacts; crossover_contact_ids counts them; policy and privileges unchanged.';
END $$;

COMMIT;
