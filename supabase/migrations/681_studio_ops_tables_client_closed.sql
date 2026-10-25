-- 681 — MEMBERWRITESWEEP.1b: no browser or phone session reads or writes
-- presentations, presentation_slides, orders, location_automations,
-- location_holidays, person_groups, person_group_members or
-- person_link_suggestions; anon holds nothing on the eight. Every read and
-- write is server code on the service role.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026). Behaviour is
-- proven ahead of apply by tests/migration-681-studio-ops-tables-client-closed.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C101, seen planning C94: its F2)
-- ===========================================================================
-- Each of the eight carries one FOR ALL policy TO authenticated whose only
-- test is studio membership: private.auth_is_in_location(location_id) (any
-- role at the studio), orders' with auth_is_master() OR'd in, and the child
-- person_group_members through its group (EXISTS ... person_groups g ...
-- auth_is_in_location(g.location_id)). The routes are narrower:
--   orders                   /api/orders* needs MANAGER_ROLES and the
--                            'orders' permission at the order's studio;
--   location_automations     /api/automations/[key] needs MANAGER_ROLES;
--   location_holidays        /api/locations/[id]/holidays* needs MANAGER_ROLES;
--   presentations, slides    /api/presentations* need 'presentations';
--   person_groups, members,  /api/contacts/duplicates/[id] and the person-link
--   person_link_suggestions  routes need 'contact_linking' (off for staff).
-- So any plain staff member could, from their own login, read 222 orders at
-- Stillorgan and flip one to refunded, toggle the studio's automations,
-- insert or delete holidays, rewrite presentations, and read or rewrite
-- 918 person groups and 1,303 duplicate-link suggestions.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration; mig 677 already applied):
-- relacl {postgres=arwdDxtm/postgres,authenticated=arwd/postgres,
-- service_role=arwdDxtm/postgres} on all eight (no anon), no column ACLs,
-- RLS on (not forced), owner postgres, in no publication, exactly the eight
-- policies above. Triggers: orders_touch_updated_at, trg_sync_group_primary_flags
-- (person_groups), trg_sync_contact_person_group (person_group_members); none
-- depends on a client privilege. No policy on another table names any of
-- the eight. Functions naming them: public.bump_presentation_version
-- (INVOKER, service_role only) and private.sync_contact_person_group (the
-- DEFINER trigger function; a function returning trigger cannot be called
-- directly, and anon has no USAGE on private). A real plain staff login at
-- Stillorgan (auth_is_master() false) reads 222 orders, 918 person groups,
-- 2,079 group members, 1,303 suggestions, 5 presentations, 29 slides, 3
-- automations, 0 holidays, and EXPLAIN UPDATE public.orders plans with only
-- the policy as its filter. Edge logs, 28 Sep 18:00 to 30 Sep (two 24 h
-- windows, embeds included): every request to the eight is service_role;
-- none from a client.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE ALL on the eight from anon, authenticated and PUBLIC (the writes,
--   the reads, and TRUNCATE, REFERENCES, TRIGGER, MAINTAIN where they are
--   still held). Drop the eight policies. End state: no client privilege,
--   RLS on, no policy (a client read or write is 42501).
--
--   The child closes with its parent: pgm_loc reads person_groups AS THE
--   CALLER, so revoking person_groups alone would turn every signed-in read
--   of person_group_members into a 42501 (check 5 below refuses to finish
--   while any policy outside this file still names one of the eight).
--
--   Writers and readers, all service_role, unchanged: /api/orders*,
--   /api/automations/[key], the class-climate, bathroom-climate and
--   glofox-lead-provisioning runners, /api/locations/[id]/holidays*,
--   src/lib/time-off-leave.js, /api/presentations*,
--   /api/public/presentations/[token]/state, src/lib/person-links.js,
--   person-detect, person-aggregate, person-accounts, churn-radar-data,
--   contact-merge, /api/contacts/duplicates/[id], and the server pages
--   /orders/[id], /automations, /settings/holidays, /presentations/[id],
--   /presentations/[id]/present and /contacts (createServerClient).
--   un1t-sentinel reads orders with its service key.
--
-- CONSUMERS CHECKED (un1t-crm 32cd8033 incl. mobile/, shared/, desktop/ and
-- their git history; champ-app origin/main; un1t-sentinel): no client file
-- reads, writes, embeds or subscribes to any of the eight, and no src/lib
-- module that touches them is imported by a client component.
--
-- Guard: tests/member-write-sweep-guard.test.js (registry rows, mig 681).
-- APPLY: after this PR merges, per docs/superpowers/plans/2026-09-27-followups/
-- C101-MEMBERWRITESWEEP.1.md, Task 1b-5 (pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

REVOKE ALL
  ON public.presentations, public.presentation_slides, public.orders,
     public.location_automations, public.location_holidays,
     public.person_groups, public.person_group_members, public.person_link_suggestions
  FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS presentations_location_scoped ON public.presentations;
DROP POLICY IF EXISTS presentation_slides_location_scoped ON public.presentation_slides;
DROP POLICY IF EXISTS orders_location_scoped ON public.orders;
DROP POLICY IF EXISTS location_automations_loc ON public.location_automations;
DROP POLICY IF EXISTS location_holidays_location_scoped ON public.location_holidays;
DROP POLICY IF EXISTS pgm_loc ON public.person_group_members;
DROP POLICY IF EXISTS person_groups_loc ON public.person_groups;
DROP POLICY IF EXISTS pls_loc ON public.person_link_suggestions;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Every
-- listed table has no client privilege at all, no policy, RLS on and
-- service_role DML; and no policy elsewhere reads one of them as the caller.
-- Any failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['presentations', 'presentation_slides', 'orders', 'location_automations',
                           'location_holidays', 'person_groups', 'person_group_members', 'person_link_suggestions'];
  v_tbl text;
  v_rel text;
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
BEGIN
  FOREACH v_tbl IN ARRAY v_tables LOOP
    v_rel := 'public.' || v_tbl;

    -- 0. RLS on.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
      RAISE EXCEPTION 'mig 681: row level security is off on %', v_rel;
    END IF;

    -- 1. information_schema, table and column level, any grantor.
    SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
      INTO v_extra
      FROM (
        SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl AND grantee IN ('anon', 'authenticated', 'PUBLIC')
        UNION ALL
        SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl AND grantee IN ('anon', 'authenticated', 'PUBLIC')
      ) g;
    IF v_extra IS NOT NULL THEN
      RAISE EXCEPTION 'mig 681: client roles still hold privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The real catalog (role membership, PUBLIC), one privilege per call;
    --    MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 681: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 681: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. The server still reads and writes.
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 681: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 4. No policy left.
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_policies
      FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl;
    IF v_policies IS NOT NULL THEN
      RAISE EXCEPTION 'mig 681: % should have no policy left: %', v_rel, v_policies;
    END IF;
  END LOOP;

  -- 5. No policy on another table reads a closed table as the caller (it
  --    would raise 42501 for every signed-in read of that table).
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') INTO v_policies
    FROM pg_policies
   WHERE NOT (schemaname = 'public' AND tablename = ANY (v_tables))
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ ('\m(' || array_to_string(v_tables, '|') || ')\M');
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 681: policies on other tables still read a closed table as the caller: %', v_policies;
  END IF;

  RAISE NOTICE 'mig 681: presentations, presentation_slides, orders, location_automations, location_holidays, person_groups, person_group_members, person_link_suggestions have no client privilege and no policy; every read and write is service_role.';
END $$;

COMMIT;
