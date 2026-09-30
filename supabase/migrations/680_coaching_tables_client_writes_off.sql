-- 680 — MEMBERWRITESWEEP.1a: no browser or phone session writes the five
-- coaching tables; members read only their OWN kudos, goals and InBody scans;
-- consultations and consultation_photos are closed to every client session;
-- anon holds nothing on the five.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026). Behaviour is
-- proven ahead of apply by tests/migration-680-coaching-tables-client-writes-off.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C101, seen planning C94: its F2)
-- ===========================================================================
-- coach_kudos, coaching_goals, inbody_scans, consultation_photos: INSERT,
-- UPDATE and DELETE policies TO authenticated whose only test is
-- private.auth_is_in_location(location_id) (any studio membership, any role),
-- and a SELECT policy TO public that ORs that with the member's own contact.
-- consultations: one FOR ALL policy with the same membership test.
-- Every table kept Supabase's default privileges (anon and authenticated
-- arwdDxtm). The routes need the 'consultations' permission at the
-- contact's studio (off for staff and reception); InBody is written only by
-- the Pi ingest. So any plain staff member could read every member's
-- body-composition scans, goals, consultations and photo records at their
-- studio and rewrite or delete them from their own login.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration): default relacl, no column
-- ACLs, RLS on, in no publication, no trigger, no view, no client-executable
-- function names them, no other policy reads them. A real plain staff login
-- at Stillorgan reads 3 InBody scans, 2 goals, 1 consultation; a real member
-- with coaching rows reads 2 goals and 3 scans, every one their own (the
-- post-apply probe must match). Edge logs, 25 to 30 Sep: no client request
-- on the five.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE writes and TRUNCATE, REFERENCES, TRIGGER, MAINTAIN from anon,
--   authenticated, PUBLIC on the five; everything from anon and PUBLIC; and
--   everything from authenticated on consultation_photos and consultations.
--   Drop the 17 policies. On the three member-read tables, a new
--   <table>_read_own FOR SELECT TO authenticated USING (contact_id =
--   private.auth_contact_id()): the old policy's member branch, verbatim, so
--   a member reads exactly the rows they read before (auth_is_in_location is
--   always false for a member: no profile). End state: coach_kudos,
--   coaching_goals, inbody_scans authenticated=r with one own-row SELECT
--   policy; consultation_photos and consultations no client privilege, RLS
--   on, no policy.
--
--   Writers, all service_role, unchanged: /api/contacts/[id]/kudos*,
--   /goals*, /consultations*, /consultation-photos* (the 'consultations'
--   permission), /api/consultations/me and /api/consultation-photos/me (the
--   member hub), src/lib/inbody-ingest.js (the Pi), contact-merge, and
--   champ-app's /api/kudos/seen (its service client, pinned to the caller's
--   own contact).
--
-- CONSUMERS CHECKED (un1t-crm 0963807a, re-run at 788a4cd1, incl. mobile/ and shared/ history;
-- champ-app 828ce00 incl. history; champ-bridge, un1t-platform,
-- un1t-sentinel, un1t-pi): no client writes any of the five. Client reads,
-- unchanged for members: the phone's member Home and Kudos screens
-- (coach_kudos), the Coaching hub (coaching_goals, inbody_scans), InBody
-- detail, Challenge Wrapped and the transformation card (inbody_scans).
--
-- Guard: tests/member-write-sweep-guard.test.js.
-- APPLY: after this PR merges, per docs/superpowers/plans/2026-09-27-followups/
-- C101-MEMBERWRITESWEEP.1.md, Task 1a-6 (pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Pre-check: a read policy this file replaces must be exactly the one it was
-- written against (on a re-run it is already gone, which passes).
DO $$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['coach_kudos', 'coaching_goals', 'inbody_scans'] LOOP
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl
                 AND policyname = v_tbl || '_read')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl
                 AND policyname = v_tbl || '_read' AND cmd = 'SELECT' AND permissive = 'PERMISSIVE'
                 AND roles::text = '{public}'
                 AND qual = '(private.auth_is_in_location(location_id) OR (contact_id = private.auth_contact_id()))'
                 AND with_check IS NULL) THEN
      RAISE EXCEPTION 'mig 680: public.%.%_read is not the policy this file was written against', v_tbl, v_tbl;
    END IF;
  END LOOP;
END $$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.coach_kudos, public.coaching_goals, public.inbody_scans,
     public.consultation_photos, public.consultations
  FROM anon, authenticated, PUBLIC;
REVOKE ALL
  ON public.coach_kudos, public.coaching_goals, public.inbody_scans,
     public.consultation_photos, public.consultations
  FROM anon, PUBLIC;
REVOKE ALL ON public.consultation_photos, public.consultations FROM authenticated;

DROP POLICY IF EXISTS coach_kudos_ins ON public.coach_kudos;
DROP POLICY IF EXISTS coach_kudos_upd ON public.coach_kudos;
DROP POLICY IF EXISTS coach_kudos_del ON public.coach_kudos;
DROP POLICY IF EXISTS coach_kudos_read ON public.coach_kudos;
DROP POLICY IF EXISTS coaching_goals_ins ON public.coaching_goals;
DROP POLICY IF EXISTS coaching_goals_upd ON public.coaching_goals;
DROP POLICY IF EXISTS coaching_goals_del ON public.coaching_goals;
DROP POLICY IF EXISTS coaching_goals_read ON public.coaching_goals;
DROP POLICY IF EXISTS inbody_scans_ins ON public.inbody_scans;
DROP POLICY IF EXISTS inbody_scans_upd ON public.inbody_scans;
DROP POLICY IF EXISTS inbody_scans_del ON public.inbody_scans;
DROP POLICY IF EXISTS inbody_scans_read ON public.inbody_scans;
DROP POLICY IF EXISTS consultation_photos_ins ON public.consultation_photos;
DROP POLICY IF EXISTS consultation_photos_upd ON public.consultation_photos;
DROP POLICY IF EXISTS consultation_photos_del ON public.consultation_photos;
DROP POLICY IF EXISTS consultation_photos_read ON public.consultation_photos;
DROP POLICY IF EXISTS consultations_loc ON public.consultations;

-- Members keep reading their own rows (the old policy's member branch, verbatim).
DROP POLICY IF EXISTS coach_kudos_read_own ON public.coach_kudos;
CREATE POLICY coach_kudos_read_own ON public.coach_kudos
  FOR SELECT TO authenticated USING (contact_id = private.auth_contact_id());
DROP POLICY IF EXISTS coaching_goals_read_own ON public.coaching_goals;
CREATE POLICY coaching_goals_read_own ON public.coaching_goals
  FOR SELECT TO authenticated USING (contact_id = private.auth_contact_id());
DROP POLICY IF EXISTS inbody_scans_read_own ON public.inbody_scans;
CREATE POLICY inbody_scans_read_own ON public.inbody_scans
  FOR SELECT TO authenticated USING (contact_id = private.auth_contact_id());

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['coach_kudos', 'coaching_goals', 'inbody_scans', 'consultation_photos', 'consultations'];
  v_keeps  text[] := ARRAY['coach_kudos_read_own', 'coaching_goals_read_own', 'inbody_scans_read_own', NULL, NULL];
  v_closed text[] := ARRAY['consultation_photos', 'consultations'];
  v_tbl text;
  v_keep text;
  v_reads boolean;
  v_rel text;
  v_extra text;
  v_policies text;
  v_role text;
  v_priv text;
BEGIN
  FOR i IN 1 .. array_length(v_tables, 1) LOOP
    v_tbl := v_tables[i];
    v_keep := v_keeps[i];
    v_reads := v_keep IS NOT NULL;
    v_rel := 'public.' || v_tbl;

    -- 0. RLS on.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
      RAISE EXCEPTION 'mig 680: row level security is off on %', v_rel;
    END IF;

    -- 1. information_schema, table and column level, any grantor: anon and
    --    PUBLIC nothing; authenticated SELECT only where an own-row read is kept.
    SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
      INTO v_extra
      FROM (
        SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl
           AND (grantee IN ('anon', 'PUBLIC')
                OR (grantee = 'authenticated' AND (NOT v_reads OR privilege_type <> 'SELECT')))
        UNION ALL
        SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = v_tbl
           AND (grantee IN ('anon', 'PUBLIC')
                OR (grantee = 'authenticated' AND (NOT v_reads OR privilege_type <> 'SELECT')))
      ) g;
    IF v_extra IS NOT NULL THEN
      RAISE EXCEPTION 'mig 680: client roles still hold privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The real catalog (role membership, PUBLIC), one privilege per call;
    --    MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF NOT (v_reads AND v_role = 'authenticated' AND v_priv = 'SELECT')
           AND has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 680: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF NOT (v_reads AND v_role = 'authenticated' AND v_priv = 'SELECT')
           AND has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 680: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. The server still reads and writes; members still read.
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 680: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;
    IF v_reads AND NOT has_table_privilege('authenticated', v_rel, 'SELECT') THEN
      RAISE EXCEPTION 'mig 680: authenticated lost SELECT on % (members read it)', v_rel;
    END IF;

    -- 4. Policies: none on a closed table; exactly the own-row read elsewhere.
    IF NOT v_reads THEN
      SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_policies
        FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl;
      IF v_policies IS NOT NULL THEN
        RAISE EXCEPTION 'mig 680: % should have no policy left: %', v_rel, v_policies;
      END IF;
    ELSIF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl) <> 1
          OR NOT EXISTS (SELECT 1 FROM pg_policies
                          WHERE schemaname = 'public' AND tablename = v_tbl AND policyname = v_keep
                            AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND roles::text = '{authenticated}'
                            AND qual = '(contact_id = private.auth_contact_id())' AND with_check IS NULL) THEN
      RAISE EXCEPTION 'mig 680: % should keep exactly one policy, % FOR SELECT TO authenticated USING (contact_id = private.auth_contact_id())', v_rel, v_keep;
    END IF;
  END LOOP;

  -- 5. No policy on another table reads a closed table as the caller (it
  --    would raise 42501 for every signed-in read of that table).
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') INTO v_policies
    FROM pg_policies
   WHERE NOT (schemaname = 'public' AND tablename = ANY (v_closed))
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ ('\m(' || array_to_string(v_closed, '|') || ')\M');
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 680: policies on other tables still read a closed table as the caller: %', v_policies;
  END IF;

  RAISE NOTICE 'mig 680: coach_kudos, coaching_goals, inbody_scans are own-row read-only for authenticated; consultation_photos and consultations have no client privilege and no policy; anon holds nothing; every write is service_role.';
END $$;

COMMIT;
