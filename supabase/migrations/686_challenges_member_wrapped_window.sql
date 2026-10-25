-- 686 — CHALLENGEWRAPPED.1: a member reads their studio's challenges until
-- 14 days after the end date (Europe/Dublin), so Challenge Wrapped can show.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-686-challenges-member-wrapped-window.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C96, found planning C83 ANYMEMBERWRITE.1, F1)
-- ===========================================================================
-- challenges_read (mig 320) lets a member (a signed-in customer whose
-- contact is at the challenge's studio) read a challenge only while
--   ends_on >= (now() AT TIME ZONE 'utc')::date
-- i.e. until the end date has passed. The phone's Challenge Wrapped (the
-- Compete screen's "See your Challenge Wrapped" entry and the
-- /wrapped/challenge/[id] story) reads an ENDED flagship challenge with the
-- member's own session, so for a member it has never shown anything.
-- DECIDED (Richard, 30 Sep 2026): members see ended challenges and their
-- Wrapped for 14 days after the end date.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration):
--   public.challenges: RLS on (not forced); one policy, challenges_read,
--   PERMISSIVE SELECT TO public, USING exactly the 30 Sep text pinned in the
--   self-check below; no WITH CHECK. relacl postgres + service_role
--   arwdDxtm, authenticated r (SELECT only, since mig 672), anon nothing
--   (migs 672/677); no column ACL; no trigger, publication, dependent view or
--   function body names the table; no other policy reads it.
--   1 challenge (not flagship, ended 88 days ago); a plain member at its
--   studio reads 0 challenges today (rolled-back probe).
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   ALTER POLICY challenges_read: the member branch becomes
--     ends_on >= (now() AT TIME ZONE 'Europe/Dublin')::date - 14
--   so a member reads a challenge through the 14th Dublin day after its end
--   date and not after (ends_on = today - 14 is the last one shown). That
--   is the window the phone already applies on its side
--   (shared/challenge-wrapped.js endedRecentlyFlagship, days = 14). The day
--   is now the Europe/Dublin day (business dates are Dublin), not UTC; the
--   new condition admits a superset of the old one at every instant, so no
--   member loses a challenge they read today.
--   The master and studio-member (staff) branches, the roles (public), the
--   command, the name and every privilege are unchanged; ALTER POLICY
--   rewrites only USING. anon still holds no privilege on the table, so
--   "TO public" still means signed-in sessions only.
--
-- READERS (origin/main 32cd8033; champ-app 828ce00):
--   member session: mobile/app/(member)/challenges.jsx FinishedFlagshipWrapped
--   (flagship, ended within 14 days, the member took part) and
--   mobile/app/(member)/wrapped/challenge/[id].jsx (one row by id);
--   champ-app src/lib/load-challenges.js (skips phase 'ended', so the extra
--   rows are dropped there). Staff and routes are unchanged (service role).
--
-- Guard: tests/any-member-write-tables-guard.test.js (no client write on
-- challenges; a SELECT policy is allowed).
--
-- APPLY: after this PR merges, per
-- docs/superpowers/plans/2026-09-27-followups/C96-CHALLENGEWRAPPED.1.md
-- (Task 4: pre/post probes and the rollback record).
-- ===========================================================================

BEGIN;

-- ALTER POLICY takes ACCESS EXCLUSIVE on public.challenges, which the
-- challenge cron and the Compete loaders read. Abort after 5 s rather than
-- queue them behind this file; re-run later.
SET LOCAL lock_timeout = '5s';
-- pg_policies prints a table without its schema only when the schema is on
-- the search_path; pinned so the self-check's text comparison holds
-- whatever path the applying session has.
SET LOCAL search_path = public;

-- The policy as it stands, so the self-check can prove where it started.
CREATE TEMP TABLE mig686_before ON COMMIT DROP AS
  SELECT policyname::text AS policyname, permissive, cmd, roles::text AS roles, qual, with_check
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'challenges';

ALTER POLICY challenges_read ON public.challenges USING (
  (SELECT private.auth_is_master())
  OR private.auth_is_in_location(location_id)
  OR ((ends_on >= ((now() AT TIME ZONE 'Europe/Dublin')::date - 14))
      AND EXISTS (SELECT 1 FROM public.contacts c
                   WHERE c.id = (SELECT private.auth_contact_id())
                     AND c.location_id = challenges.location_id))
);

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  -- pg_policies.qual as prod renders it on 30 Sep 2026 (before) and as
  -- PostgreSQL 17 renders this file's expression (after). The new window
  -- fragment was checked on prod (17.6) without DDL: EXPLAIN (VERBOSE) of a
  -- filter holding both windows printed the old one exactly as pg_policies
  -- does, ((now() AT TIME ZONE 'utc'::text))::date, and the new one as
  -- (((now() AT TIME ZONE 'Europe/Dublin'::text))::date - 14); PGlite 17.5
  -- prints the same.
  v_old text := $q$(( SELECT private.auth_is_master() AS auth_is_master) OR private.auth_is_in_location(location_id) OR ((ends_on >= ((now() AT TIME ZONE 'utc'::text))::date) AND (EXISTS ( SELECT 1
   FROM contacts c
  WHERE ((c.id = ( SELECT private.auth_contact_id() AS auth_contact_id)) AND (c.location_id = challenges.location_id))))))$q$;
  v_new text := $q$(( SELECT private.auth_is_master() AS auth_is_master) OR private.auth_is_in_location(location_id) OR ((ends_on >= (((now() AT TIME ZONE 'Europe/Dublin'::text))::date - 14)) AND (EXISTS ( SELECT 1
   FROM contacts c
  WHERE ((c.id = ( SELECT private.auth_contact_id() AS auth_contact_id)) AND (c.location_id = challenges.location_id))))))$q$;
  v_role text;
  v_priv text;
  v_extra text;
  v_n int;
BEGIN
  -- 0. It started from the 30 Sep policy (or from this file's, on a re-run).
  SELECT count(*) INTO v_n FROM mig686_before;
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM mig686_before
                              WHERE policyname = 'challenges_read' AND permissive = 'PERMISSIVE'
                                AND cmd = 'SELECT' AND roles = '{public}' AND with_check IS NULL
                                AND qual IN (v_old, v_new)) THEN
    RAISE EXCEPTION 'mig 686: public.challenges did not start with exactly the 30 Sep challenges_read policy; re-plan';
  END IF;

  -- 1. RLS on (the policy means nothing without it).
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.challenges'::regclass) THEN
    RAISE EXCEPTION 'mig 686: row level security is off on public.challenges';
  END IF;

  -- 2. Exactly one policy: challenges_read, PERMISSIVE SELECT TO public,
  --    the new USING, no WITH CHECK.
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'challenges';
  IF v_n <> 1 OR NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'challenges' AND policyname = 'challenges_read'
          AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}'
          AND qual = v_new AND with_check IS NULL) THEN
    RAISE EXCEPTION 'mig 686: public.challenges should keep exactly challenges_read FOR SELECT TO public with the 14-day Dublin member window; found %',
      (SELECT string_agg(policyname || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-'), ' ; ')
         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'challenges');
  END IF;

  -- 3. Privileges unchanged (migs 672/677): information_schema, any grantor,
  --    table and column level: anon and PUBLIC nothing, authenticated SELECT only.
  SELECT string_agg(DISTINCT grantee || ':' || privilege_type || ' (from ' || grantor || ')', ', ')
    INTO v_extra
    FROM (
      SELECT grantee, privilege_type, grantor FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND table_name = 'challenges'
         AND (grantee IN ('anon', 'PUBLIC') OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'))
      UNION ALL
      SELECT grantee, privilege_type, grantor FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'challenges'
         AND (grantee IN ('anon', 'PUBLIC') OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'))
    ) g;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'mig 686: client roles hold more than SELECT on public.challenges: %', v_extra;
  END IF;

  -- 4. The real catalog (role membership, PUBLIC), one privilege per call;
  --    MAINTAIN is not in information_schema.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF NOT (v_role = 'authenticated' AND v_priv = 'SELECT')
         AND has_table_privilege(v_role, 'public.challenges', v_priv) THEN
        RAISE EXCEPTION 'mig 686: % holds % on public.challenges', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT has_table_privilege('authenticated', 'public.challenges', 'SELECT') THEN
    RAISE EXCEPTION 'mig 686: authenticated lost SELECT on public.challenges (members and staff read it)';
  END IF;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.challenges', v_priv) THEN
      RAISE EXCEPTION 'mig 686: service_role lost % on public.challenges', v_priv;
    END IF;
  END LOOP;

  RAISE NOTICE 'mig 686: members read their studio''s challenges until 14 Dublin days after ends_on; staff, master and privileges unchanged.';
END $$;

COMMIT;
