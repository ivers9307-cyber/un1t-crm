-- 672 — ANYMEMBERWRITE.1: no browser or phone session writes
-- public.challenges, public.contact_segments or public.car_notes; no client
-- session reads car_notes; anon holds nothing on any of the three.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-672-challenges-segments-car-notes-client-writes-off.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C83, seen in passing planning C15)
-- ===========================================================================
-- All three tables kept Supabase's default table privileges (anon and
-- authenticated: arwdDxtm, from postgres) and write policies TO public whose
-- only test is studio membership (auth_is_master() OR
-- auth_is_in_location(location_id)), not role and not permission:
--   challenges:       challenges_ins / challenges_upd / challenges_del (mig 320)
--   contact_segments: contact_segments_insert / _update / _delete (mig 043)
--   car_notes:        car_notes_insert / car_notes_delete (mig 047)
-- The routes are tighter: /api/challenges* needs manager+ AND the
-- 'challenges' permission at the challenge's studio; /api/cars/[id]/notes*
-- needs the per-user 'car_processing' permission at the car's studio (off by
-- default, owners included) and never lets a caller choose kind='system'.
-- /api/contacts/segments* admits any studio member (same people as the
-- policy) but validates the filter and never writes memberships_initialized_at.
-- So any plain staff member could, from their own login:
--   create a challenge that starts today (the 08:00 cron pushes "New
--   challenge: <name>" to every app-linked member of the studio and the public
--   TV board shows it), re-arm a sent announcement (announced_* back to NULL),
--   edit or delete the running challenge;
--   stamp memberships_initialized_at on a segment wired to a segment_added
--   sequence before its first sync (the sync then treats the whole current
--   membership as new and enrols all of it), or rewrite, rename, delete a
--   segment without the route's filter validation;
--   forge a kind='system' car note, attach a note to another studio's car,
--   delete notes, and READ every note of their studio, including the system
--   notes that carry the tokenised deposit link.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration):
--   relacl on all three {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--   authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}; no
--   column ACLs; RLS on, not forced; in no publication; no trigger; no view
--   depends on them; no function body names them. EXPLAIN UPDATE / DELETE as
--   a plain staff member plans on challenges, contact_segments and car_notes
--   (the privilege check passes; the policy is the only filter). Edge logs
--   (two 24 h windows): every request on the three was service_role.
--   anon reaches no row: its reads fail on a helper it cannot execute.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN
--   (PG 17's m) from anon, authenticated, PUBLIC on the three tables, and
--   every remaining privilege from anon and PUBLIC, and from authenticated on
--   car_notes. Drop the eight write policies and car_notes_select.
--   challenges_read (members read their studio's running challenges in the
--   phone and the champ-app web) and contact_segments_select are NOT touched;
--   the self-check compares each with a copy captured at the top of the file.
--   End state: challenges and contact_segments authenticated=r with their one
--   SELECT policy; car_notes no client privilege, RLS on with no policy.
--
--   Every writer is service_role: /api/challenges*, the challenge-events
--   cron (announced_* claims), /api/contacts/segments*, the segment-sync cron
--   (memberships_initialized_at), /api/cars/[id]/notes* and
--   /api/cars/[id]/issue-deposit-link (system note). FK actions (cascades
--   from locations, cars; SET NULL from profiles; contact_segment_memberships
--   cascade) run as the table owner.
--
-- CONSUMERS CHECKED (un1t-crm origin/main 4aa6df68 incl. mobile/ and shared/
-- history; champ-app 828ce00 incl. history; champ-bridge, un1t-platform,
-- un1t-sentinel, un1t-pi, un1t-finance-agent): no browser, createAuthClient,
-- phone or other-repo code writes any of the three, and nothing but a route
-- reads car_notes or contact_segments. Client reads, unchanged: the phone's
-- member Compete screen and Challenge Wrapped (challenges), champ-app's
-- member challenge loaders (challenges, member session).
--
-- Guard: tests/any-member-write-tables-guard.test.js.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C83-ANYMEMBERWRITE.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on tables the challenge cron, the
-- segment sync and the car routes write. Abort after 5 s rather than queue
-- behind them. Nothing is half-applied: re-run later.
SET LOCAL lock_timeout = '5s';

-- The two read policies this file keeps, as the catalog holds them now, so
-- the self-check can prove nothing below changed them.
CREATE TEMP TABLE mig672_kept_read ON COMMIT DROP AS
  SELECT tablename::text AS tablename, policyname::text AS policyname,
         permissive, cmd, roles::text AS roles, qual, with_check
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (tablename, policyname) IN (
       ('challenges', 'challenges_read'),
       ('contact_segments', 'contact_segments_select'));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.challenges, public.contact_segments, public.car_notes
  FROM anon, authenticated, PUBLIC;
REVOKE ALL
  ON public.challenges, public.contact_segments, public.car_notes
  FROM anon, PUBLIC;
REVOKE ALL ON public.car_notes FROM authenticated;

DROP POLICY IF EXISTS challenges_ins ON public.challenges;
DROP POLICY IF EXISTS challenges_upd ON public.challenges;
DROP POLICY IF EXISTS challenges_del ON public.challenges;

DROP POLICY IF EXISTS contact_segments_insert ON public.contact_segments;
DROP POLICY IF EXISTS contact_segments_update ON public.contact_segments;
DROP POLICY IF EXISTS contact_segments_delete ON public.contact_segments;

DROP POLICY IF EXISTS car_notes_insert ON public.car_notes;
DROP POLICY IF EXISTS car_notes_delete ON public.car_notes;
DROP POLICY IF EXISTS car_notes_select ON public.car_notes;

COMMENT ON TABLE public.car_notes IS
  'Car timeline notes (mig 047). Service role only (ANYMEMBERWRITE.1, mig 672): no client privilege, RLS on with no policy. System notes carry the tokenised deposit link. Read and write through /api/cars/[id]/notes*, which need car_processing at the car''s studio.';

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['challenges', 'contact_segments', 'car_notes'];
  v_keeps  text[] := ARRAY['challenges_read', 'contact_segments_select', NULL];
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
    v_reads := v_keep IS NOT NULL;   -- authenticated keeps SELECT only where a read policy is kept
    v_rel := 'public.' || v_tbl;

    -- 0. RLS still on (car_notes relies on RLS-with-no-policy as well).
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
      RAISE EXCEPTION 'mig 672: row level security is off on %', v_rel;
    END IF;

    -- 1. anon/PUBLIC: nothing at all; authenticated: SELECT only on the two
    --    kept tables, nothing on car_notes. Table and column level, any grantor.
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
      RAISE EXCEPTION 'mig 672: client roles still hold privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The same question asked of the real catalog (role membership,
    --    PUBLIC), one privilege per call. MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF NOT (v_reads AND v_role = 'authenticated' AND v_priv = 'SELECT')
           AND has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 672: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. No column-level privilege through any path (authenticated's
    --    table-level SELECT on the two kept tables covers every column).
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF NOT (v_reads AND v_role = 'authenticated' AND v_priv = 'SELECT')
           AND has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 672: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 4. Signed-in reads unchanged where kept; the server still reads and writes.
    IF v_reads AND NOT has_table_privilege('authenticated', v_rel, 'SELECT') THEN
      RAISE EXCEPTION 'mig 672: authenticated lost SELECT on %', v_rel;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 672: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 5. No write policy left; exactly the kept SELECT policy (or none).
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname)
      INTO v_policies
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_tbl
       AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');
    IF v_policies IS NOT NULL THEN
      RAISE EXCEPTION 'mig 672: write policies remain on %: %', v_rel, v_policies;
    END IF;
    IF NOT v_reads THEN
      SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname)
        INTO v_policies
        FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl;
      IF v_policies IS NOT NULL THEN
        RAISE EXCEPTION 'mig 672: % should have no policy left: %', v_rel, v_policies;
      END IF;
    ELSIF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl) <> 1
          OR NOT EXISTS (SELECT 1 FROM pg_policies
                          WHERE schemaname = 'public' AND tablename = v_tbl
                            AND policyname = v_keep AND cmd = 'SELECT' AND permissive = 'PERMISSIVE') THEN
      RAISE EXCEPTION 'mig 672: % should keep exactly one policy, % FOR SELECT', v_rel, v_keep;
    END IF;

    -- 6. The kept SELECT policy is the one captured at the top, unchanged:
    --    same roles, same USING (so the phone's and champ-app's reads return
    --    the same rows).
    IF v_reads AND NOT EXISTS (
         SELECT 1 FROM pg_policies p
           JOIN mig672_kept_read k ON k.tablename = p.tablename AND k.policyname = p.policyname
          WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.policyname = v_keep
            AND p.permissive = k.permissive AND p.cmd = k.cmd AND p.roles::text = k.roles
            AND p.qual IS NOT DISTINCT FROM k.qual
            AND p.with_check IS NOT DISTINCT FROM k.with_check) THEN
      RAISE EXCEPTION 'mig 672: % is not the policy it was before this file (it must read exactly the same rows)', v_keep;
    END IF;
  END LOOP;

  RAISE NOTICE 'mig 672: challenges and contact_segments are read-only for authenticated (their one SELECT policy unchanged), car_notes has no client privilege and no policy, anon holds nothing; every write is service_role.';
END $$;

COMMIT;
