-- 685 — MEMBERWRITESWEEP.1g: no browser or phone session reads or writes
-- tv_displays, tv_templates or tv_content; anon holds nothing on the three.
-- Every read and write is server code on the service role.
--
-- APPLY ONLY AFTER the adoption gate (plan Task 1g-0): 1f (#1917) moved the
-- web TV admin and the phone's TV screen onto session routes and published
-- an OTA (EAS Update run for merge 92ddd798 green, 2 Oct 2026 ~00:12 UTC).
-- Edge logs must show no non-service_role /rest/v1/tv_* request for 72 h
-- (earliest ~5 Oct 2026 07:00 UTC), or 7 days after the publish (DECISION 5).
-- A phone still on a pre-1f bundle (no OTA taken, or a 2.3.x binary) reads
-- the three tables directly; after this file its TV screen fails with a
-- permission error until it takes the update.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 2 Oct 2026). Behaviour is
-- proven ahead of apply by tests/migration-685-tv-tables-client-closed.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C101, seen planning C94: its F2)
-- ===========================================================================
-- tv_displays and tv_templates each carry one FOR ALL policy TO authenticated
-- whose only test is studio membership (private.auth_is_in_location
-- (location_id)), and tv_content one FOR ALL policy through its TV
-- (EXISTS ... tv_displays d ... auth_is_in_location(d.location_id)). The web
-- /tv-displays page, the phone's TV screen and the upload route all require
-- the `tv_displays` permission at the studio, but until 1f the web admin and
-- the phone wrote the tables straight from the client, so the policy was the
-- only fence, and it admits every member of the studio. Any plain staff
-- member (and reception), with or without `tv_displays`, could from their
-- own login:
--   * put ANY URL on any TV at the studio (an upsert on tv_content: the
--     cast page renders it in the gym), with a forged pushed_by, or clear it;
--   * read every TV's cast token, the secret the public cast URL
--     (/tv/cast/<token>, /api/public/tv/<token>/content) is built from;
--   * register, re-rotate or delete TVs, and create, rewrite or delete the
--     studio's templates.
--
-- VERIFIED LIVE (2 Oct 2026, BEFORE this migration; mig 677 already applied):
-- relacl {postgres=arwdDxtm/postgres,authenticated=arwd/postgres,
-- service_role=arwdDxtm/postgres} on all three (no anon), no column ACLs, RLS
-- on (not forced), owner postgres, in no publication (no realtime), no
-- trigger, no dependent view, exactly the three policies above (text pinned
-- by the pre-check below). No policy on another table names any of the
-- three; no function body names them (so no trigger elsewhere writes them).
-- FKs: tv_content.tv_display_id -> tv_displays ON DELETE CASCADE; both
-- location_id -> locations CASCADE; pushed_by / created_by -> profiles SET
-- NULL; FK actions run as the table owner. 1 TV, 1 template, 0 content rows.
-- A real plain staff login at Stillorgan (auth_is_master() false) reads
-- 1 / 1 / 0, and EXPLAIN UPDATE public.tv_content plans with only the policy
-- as its filter. Edge logs: 7 non-service_role requests in the 7 days to
-- 1f's merge (one phone session, 27 Sep, GETs only); none in the 24 h to
-- 2 Oct 2026 ~07:30 UTC.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   Code first, in 1f (#1917, merged, OTA published): every web and phone
--   read and write moved to session routes that check `tv_displays` (web or
--   mobile key) at the TV's or template's own studio, validate the push and
--   stamp pushed_by / created_by from the session:
--   /api/admin/tv-displays (GET, POST), /api/admin/tv-displays/[id] (PATCH,
--   DELETE), /api/admin/tv-displays/[id]/content (PUT, DELETE),
--   /api/admin/tv-templates (GET, POST), /api/admin/tv-templates/[id] (GET,
--   PUT, DELETE). 1g (this PR) deletes the phone's old-server fallback
--   (mobile/lib/tv-api-legacy.js), the last client file naming the tables.
--
--   Then this file: REVOKE ALL on the three from anon, authenticated and
--   PUBLIC (the writes, the reads, and TRUNCATE, REFERENCES, TRIGGER,
--   MAINTAIN where they are still held). Drop the three policies. End state:
--   no client privilege, RLS on, no policy (a client read or write is 42501).
--
--   tv_content closes with tv_displays: its policy reads tv_displays AS THE
--   CALLER, so revoking tv_displays alone would turn every signed-in read of
--   tv_content into a 42501 (check 5 below refuses to finish while any policy
--   outside this file still names one of the three).
--
--   Writers after 1f, all service_role, unchanged: the session routes above,
--   /api/hyrox/sessions/[id]/push and src/lib/hyrox/publish-runner.js.
--   Readers: /api/public/tv/[token]/content, /api/public/tv-live/[token],
--   the /tv-displays page's server load, and the routes above. The
--   tv-content Storage bucket is untouched (its public read stays; its
--   writes closed in 671).
--
-- CONSUMERS CHECKED (un1t-crm incl. mobile/, shared/, desktop/ and
-- supabase/functions; champ-app; un1t-sentinel; champ-bridge; un1t-platform;
-- un1t-pi): after this PR no client file reads, writes, embeds or subscribes
-- to any of the three, and no other repo names them.
--
-- Guard: tests/member-write-sweep-guard.test.js (registry rows, mig 685,
-- rollback 'g'; and mobile/lib/tv-api-legacy.js may not exist beside this
-- file).
-- APPLY: per docs/superpowers/plans/2026-09-27-followups/
-- C101-MEMBERWRITESWEEP.1.md, Tasks 1g-0 and 1g-5 (the adoption gate,
-- pre/post probes and the rollback, POST-677 form).
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Pre-check: a policy this file drops must be exactly the one it was written
-- against (on a re-run it is already gone, which passes). Whitespace is
-- folded so the deparser's line breaks do not matter.
DO $$
DECLARE
  v_expected text[][] := ARRAY[
    ARRAY['tv_displays', 'tv_displays_location_scoped', 'private.auth_is_in_location(location_id)'],
    ARRAY['tv_templates', 'tv_templates_location_scoped', 'private.auth_is_in_location(location_id)'],
    ARRAY['tv_content', 'tv_content_location_scoped',
          '(EXISTS ( SELECT 1 FROM tv_displays d WHERE ((d.id = tv_content.tv_display_id) AND private.auth_is_in_location(d.location_id))))']
  ];
  v_i int;
BEGIN
  FOR v_i IN 1 .. array_length(v_expected, 1) LOOP
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = v_expected[v_i][1] AND policyname = v_expected[v_i][2])
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = v_expected[v_i][1] AND policyname = v_expected[v_i][2]
                 AND cmd = 'ALL' AND permissive = 'PERMISSIVE' AND roles::text = '{authenticated}'
                 AND regexp_replace(qual, '\s+', ' ', 'g') = v_expected[v_i][3]
                 AND regexp_replace(with_check, '\s+', ' ', 'g') = v_expected[v_i][3]) THEN
      RAISE EXCEPTION 'mig 685: public.%.% is not the policy this file was written against',
        v_expected[v_i][1], v_expected[v_i][2];
    END IF;
  END LOOP;
END $$;

REVOKE ALL
  ON public.tv_displays, public.tv_templates, public.tv_content
  FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS tv_content_location_scoped ON public.tv_content;
DROP POLICY IF EXISTS tv_templates_location_scoped ON public.tv_templates;
DROP POLICY IF EXISTS tv_displays_location_scoped ON public.tv_displays;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Every
-- listed table has no client privilege at all, no policy, RLS on and
-- service_role DML; and no policy elsewhere reads one of them as the caller.
-- Any failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['tv_displays', 'tv_templates', 'tv_content'];
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
      RAISE EXCEPTION 'mig 685: row level security is off on %', v_rel;
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
      RAISE EXCEPTION 'mig 685: client roles still hold privileges on %: %', v_rel, v_extra;
    END IF;

    -- 2. The real catalog (role membership, PUBLIC), one privilege per call;
    --    MAINTAIN is not in information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 685: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 685: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. The server still reads and writes.
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 685: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 4. No policy left.
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_policies
      FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl;
    IF v_policies IS NOT NULL THEN
      RAISE EXCEPTION 'mig 685: % should have no policy left: %', v_rel, v_policies;
    END IF;
  END LOOP;

  -- 5. No policy on another table reads a closed table as the caller (it
  --    would raise 42501 for every signed-in read of that table).
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') INTO v_policies
    FROM pg_policies
   WHERE NOT (schemaname = 'public' AND tablename = ANY (v_tables))
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ ('\m(' || array_to_string(v_tables, '|') || ')\M');
  IF v_policies IS NOT NULL THEN
    RAISE EXCEPTION 'mig 685: policies on other tables still read a closed table as the caller: %', v_policies;
  END IF;

  RAISE NOTICE 'mig 685: tv_displays, tv_templates, tv_content have no client privilege and no policy; every read and write is service_role.';
END $$;

COMMIT;
