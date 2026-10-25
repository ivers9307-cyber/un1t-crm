-- 765 — ORGCONTACTS.2: contacts_select reads contact_studios, one branch for
-- every relationship (docs/superpowers/specs/2026-10-20-org-shared-contacts-
-- whatsapp-design.md §2.2, decision 2); the studio_contacts view for the lists.
--
-- Proven by tests/migration-765-contacts-read-by-contact-studios.test.js
-- (PGlite; the real 690, 691, 699, 731, 732, 758, 762 and 764 files first).
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- Since mig 731 the helper behind contacts_select has grown a UNION branch per
-- side channel (active memberships, un1t clients, Glofox crossovers, deals):
-- four definitions of "at this studio", none of them the one the lists, the
-- contact page or the phone used. Mig 764 made contact_studios THE answer.
-- Richard's decision 2 (20 Oct 2026): visibility is any relationship, lapsed
-- too. Any contact_studios row, active or ended, makes the person visible to
-- staff holding Contacts at that studio; kind and status matter only to Mia,
-- routing and pricing.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   1. private.auth_contact_studio_contact_ids(): the contacts with ANY
--      contact_studios row at a studio in private.auth_contact_read_location_ids()
--      (the Contacts resolver: switch + bundle, master, override, templates,
--      role default, org-admin tier). DEFINER (the table is closed), STABLE,
--      search_path '', authenticated + service_role EXECUTE.
--   2. contacts_select: the Contacts-at-the-contact's-studio branch (690), the
--      member's own row, and the new helper as an InitPlan.
--   3. private.auth_contact_membership_contact_ids() (731/732/758/762) becomes a
--      one-line delegate to the new helper, DEPRECATED, so any cached plan or
--      hand query keeps working until mig 768 drops it.
--   4. public.crossover_contact_ids(loc) reads contact_studios (a row at loc
--      whose contact's primary studio is elsewhere), DEPRECATED, dropped in 768.
--   5. public.studio_contacts: contacts JOIN contact_studios, security_invoker,
--      service_role only. The web list and search read it instead of building
--      an id.in() URL from the RPC (the 100-id cap and the 414 go away).
--      studio_is_crossover = the contact's primary studio is not this one (a
--      display fact, not an access path).
--
-- WHO CHANGES: staff holding Contacts at a studio gain every contact with an
-- ENDED relationship there (a lapsed un1t client, a closed deal, a Glofox
-- ex-member linked here, a preferences row whose list they left) and every
-- contact whose PRIMARY studio it is (unchanged). Nobody loses a row: every
-- branch of 762's helper is a contact_studios row by mig 764's backfill.
-- Members unchanged (own row only).
--
-- Guard: tests/contacts-read-scope-migration-guard.test.js accepts exactly
-- this helper body, the delegate body for the old helper, and this policy.
-- APPLY: before the ORGCONTACTS.2 code merges (the code reads the view), then
-- get_advisors (security). ALTER POLICY takes ACCESS EXCLUSIVE on contacts for
-- an instant; lock_timeout 5s bounds the wait.
-- ROLLBACK (forward migration): mig 762's CREATE OR REPLACE of
--   private.auth_contact_membership_contact_ids() with its REVOKE / GRANT;
--   mig 731's ALTER POLICY contacts_select (its USING, verbatim); mig 758's
--   CREATE OR REPLACE of public.crossover_contact_ids(uuid) with its REVOKE /
--   GRANT; DROP VIEW public.studio_contacts; DROP FUNCTION
--   private.auth_contact_studio_contact_ids(). The test runs this record.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public;

-- 0. Pre-checks.
DO $$
DECLARE
  v_qual_731 text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))$q$;
  v_qual_765 text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_studio_contact_ids() AS auth_contact_studio_contact_ids)::uuid[])))$q$;
  v_old_helper text := '65daa4835035bf30cad782fdd7bc6e4e';   -- 762's body
  v_delegate text := '8bc82349c4385c345d30f37f9599634b';                        -- this file's delegate body
  v_h text;
  v_fn oid := to_regprocedure('private.auth_contact_read_location_ids()');
BEGIN
  IF to_regclass('public.contact_studios') IS NULL THEN
    RAISE EXCEPTION 'mig 765: public.contact_studios is missing; apply mig 764 first';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}'
                       AND with_check IS NULL AND qual IN (v_qual_731, v_qual_765)) THEN
    RAISE EXCEPTION 'mig 765: public.contacts does not have exactly the mig 731 (or this file''s) contacts_select policy; re-plan (found: %)',
      (SELECT string_agg(policyname || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-'), ' ; ')
         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts');
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass) THEN
    RAISE EXCEPTION 'mig 765: row level security is off on public.contacts';
  END IF;
  IF v_fn IS NULL OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef AND prorettype = 'uuid[]'::regtype) THEN
    RAISE EXCEPTION 'mig 765: private.auth_contact_read_location_ids() is missing or not a SECURITY DEFINER uuid[] resolver; apply 690/699 first';
  END IF;
  SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) INTO v_h
    FROM pg_proc WHERE oid = to_regprocedure('private.auth_contact_membership_contact_ids()');
  IF v_h IS NULL OR v_h NOT IN (v_old_helper, v_delegate) THEN
    RAISE EXCEPTION 'mig 765: private.auth_contact_membership_contact_ids() is not the mig 762 body (normalised md5 %); re-plan', v_h;
  END IF;
END $$;

CREATE TEMP TABLE m765_acl ON COMMIT DROP AS
  SELECT oid::regclass::text AS rel, relacl::text AS acl FROM pg_class
   WHERE oid IN ('public.contacts'::regclass, 'public.contact_studios'::regclass);

-- 1. The read helper: every contact with ANY contact_studios row at a studio
--    where the caller holds Contacts. One InitPlan.
CREATE OR REPLACE FUNCTION private.auth_contact_studio_contact_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT coalesce(array_agg(DISTINCT cs.contact_id), '{}'::uuid[])
    FROM public.contact_studios cs
   WHERE cs.location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
$function$;

COMMENT ON FUNCTION private.auth_contact_studio_contact_ids() IS
  'ORGCONTACTS.2 (mig 765): contact ids with ANY contact_studios row (active or ended: decision 2) at a studio where the caller holds Contacts (private.auth_contact_read_location_ids(), so every tier of that resolver applies). Read by contacts_select as an InitPlan. tests/contacts-read-scope-migration-guard.test.js pins the body.';

REVOKE ALL ON FUNCTION private.auth_contact_studio_contact_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.auth_contact_studio_contact_ids() TO authenticated, service_role;

-- 2. The policy: 690's branch, the member's own row, the new helper.
ALTER POLICY contacts_select ON public.contacts USING (
  location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
  OR user_id = (SELECT auth.uid())
  OR id = ANY ((SELECT private.auth_contact_studio_contact_ids())::uuid[])
);

-- 3. The old helper delegates (DEPRECATED; dropped in mig 768).
CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT private.auth_contact_studio_contact_ids()
$function$;

COMMENT ON FUNCTION private.auth_contact_membership_contact_ids() IS
  'DEPRECATED (mig 765): a delegate to private.auth_contact_studio_contact_ids(), kept so a cached plan or a hand query keeps working; dropped in mig 768. Nothing new may read it.';

REVOKE ALL ON FUNCTION private.auth_contact_membership_contact_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.auth_contact_membership_contact_ids() TO authenticated, service_role;

-- 4. The crossover RPC reads the relationship table (DEPRECATED; dropped in 768).
CREATE OR REPLACE FUNCTION public.crossover_contact_ids(loc uuid)
RETURNS TABLE (contact_id uuid)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT DISTINCT cs.contact_id
    FROM public.contact_studios cs
    JOIN public.contacts c ON c.id = cs.contact_id
   WHERE cs.location_id = loc
     AND c.location_id IS DISTINCT FROM loc
$function$;

COMMENT ON FUNCTION public.crossover_contact_ids(uuid) IS
  'DEPRECATED (mig 765): contacts with a contact_studios row at loc whose primary studio is elsewhere. The web list reads public.studio_contacts instead; the phone directory route reads it until mig 768 drops this. Service role only.';

REVOKE ALL ON FUNCTION public.crossover_contact_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crossover_contact_ids(uuid) TO service_role;

-- 5. The view the lists read. security_invoker, service_role only: a
--    service-role page filters it on studio_location_id and never ships the
--    relationship columns to a client session.
CREATE OR REPLACE VIEW public.studio_contacts WITH (security_invoker = on) AS
SELECT c.*,
       cs.location_id      AS studio_location_id,
       cs.kind             AS studio_kind,
       cs.status           AS studio_status,
       cs.source           AS studio_source,
       cs.stage_slug       AS studio_stage_slug,
       cs.first_seen_at    AS studio_first_seen_at,
       cs.last_seen_at     AS studio_last_seen_at,
       (c.location_id IS DISTINCT FROM cs.location_id) AS studio_is_crossover
  FROM public.contacts c
  JOIN public.contact_studios cs ON cs.contact_id = c.id;

REVOKE ALL ON public.studio_contacts FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.studio_contacts TO service_role;

COMMENT ON VIEW public.studio_contacts IS
  'ORGCONTACTS.2 (mig 765): contacts joined to their contact_studios rows, one row per relationship; the web list and search filter it on studio_location_id. studio_is_crossover = the primary studio is not this one (display only). security_invoker, service role only.';

-- 6. Self-check: the catalog, never this file.
DO $$
DECLARE
  v_qual_765 text := $q$((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_studio_contact_ids() AS auth_contact_studio_contact_ids)::uuid[])))$q$;
  v_new_helper text := 'c4464ab057b9a175dc94037ced7e39b5';
  v_delegate text := '8bc82349c4385c345d30f37f9599634b';
  v_cross text := 'bc2fe2d317a3240b98862c34dbfbd5b7';
  v_fn oid := to_regprocedure('private.auth_contact_studio_contact_ids()');
  v_old oid := to_regprocedure('private.auth_contact_membership_contact_ids()');
  v_read oid := to_regprocedure('private.auth_contact_read_location_ids()');
  v_rpc oid := to_regprocedure('public.crossover_contact_ids(uuid)');
  v_found text;
BEGIN
  -- a. the new helper: this file's body, DEFINER, STABLE, empty search_path, uuid[], owned by the migration role
  IF v_fn IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef AND provolatile = 's'
          AND prorettype = 'uuid[]'::regtype AND proconfig @> ARRAY['search_path=""']
          AND proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) = v_new_helper) THEN
    RAISE EXCEPTION 'mig 765: private.auth_contact_studio_contact_ids is not this file''s body, or not SECURITY DEFINER / STABLE / search_path '''' / uuid[] / owned by %', current_user;
  END IF;
  -- b. the delegate
  IF v_old IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = v_old AND prosecdef AND provolatile = 's' AND proconfig @> ARRAY['search_path=""']
          AND md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) = v_delegate) THEN
    RAISE EXCEPTION 'mig 765: private.auth_contact_membership_contact_ids is not this file''s delegate body';
  END IF;
  -- c. EXECUTE: authenticated and service_role only, on all three helpers
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', v_old, 'EXECUTE') OR has_function_privilege('anon', v_old, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_read, 'EXECUTE') OR has_function_privilege('anon', v_read, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 765: EXECUTE on the contact read helpers must be authenticated + service_role only';
  END IF;
  -- d. exactly one policy, this file's
  SELECT string_agg(policyname || ' ' || permissive || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-')
                    || ' CHECK ' || coalesce(with_check, '-'), ' ; ')
    INTO v_found FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts';
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}'
                       AND with_check IS NULL AND qual = v_qual_765) THEN
    RAISE EXCEPTION 'mig 765: contacts_select is not this file''s policy; found: %', v_found;
  END IF;
  -- e. contacts and contact_studios: RLS and ACLs untouched
  IF NOT (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contact_studios'::regclass) THEN
    RAISE EXCEPTION 'mig 765: contacts or contact_studios RLS changed';
  END IF;
  IF EXISTS (SELECT 1 FROM m765_acl a JOIN pg_class c ON c.oid = a.rel::regclass WHERE c.relacl::text IS DISTINCT FROM a.acl) THEN
    RAISE EXCEPTION 'mig 765: the contacts or contact_studios ACL changed; this file must not touch their privileges';
  END IF;
  -- f. the RPC: this file's body, INVOKER, service_role only
  IF v_rpc IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = v_rpc AND NOT prosecdef AND provolatile = 's'
          AND md5(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) = v_cross) THEN
    RAISE EXCEPTION 'mig 765: public.crossover_contact_ids is not this file''s SECURITY INVOKER / STABLE body';
  END IF;
  IF has_function_privilege('authenticated', v_rpc, 'EXECUTE') OR has_function_privilege('anon', v_rpc, 'EXECUTE')
     OR has_function_privilege('public', v_rpc, 'EXECUTE') OR NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 765: EXECUTE on public.crossover_contact_ids must be service_role only';
  END IF;
  -- g. the view: security_invoker, closed to clients, readable by service_role
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.studio_contacts'::regclass AND c.relkind = 'v'
                   AND coalesce(array_to_string(c.reloptions, ','), '') ILIKE '%security_invoker=on%')
     OR has_table_privilege('anon', 'public.studio_contacts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.studio_contacts', 'SELECT')
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.studio_contacts'::regclass AND a.grantee = 0)
     OR NOT has_table_privilege('service_role', 'public.studio_contacts', 'SELECT') THEN
    RAISE EXCEPTION 'mig 765: public.studio_contacts must be security_invoker, closed to anon / authenticated / PUBLIC, and readable by service_role';
  END IF;
  -- h. the helpers run: with no signed-in user they return no contact
  IF private.auth_contact_studio_contact_ids() IS DISTINCT FROM '{}'::uuid[]
     OR private.auth_contact_membership_contact_ids() IS DISTINCT FROM '{}'::uuid[] THEN
    RAISE EXCEPTION 'mig 765: a read helper returned contacts with no signed-in user';
  END IF;

  RAISE NOTICE 'mig 765: contacts_select reads contact_studios (any relationship, decision 2); the old helper delegates; crossover_contact_ids and studio_contacts read the relationship table.';
END $$;

COMMIT;
