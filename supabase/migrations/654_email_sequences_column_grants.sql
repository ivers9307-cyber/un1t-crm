-- 654 — PROFILESPREAD.1b: email_sequences' webhook credentials leave client
-- reach, and no signed-in session can write a sequence, step or enrolment.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 29 Sep 2026).
-- It is the evidence for the fix, not proof the fix landed. Behaviour is
-- proven ahead of apply by a PGlite replay
-- (tests/migration-654-email-sequences-column-grants.test.js), which also
-- runs the PROBE and ROLLBACK blocks below.
--
-- ===========================================================================
-- THE FINDING
-- ===========================================================================
-- email_sequences, sequence_steps and sequence_enrollments carry Supabase's
-- default table-level ALL for anon + authenticated, and one PERMISSIVE FOR ALL
-- TO authenticated policy each admitting any member of the studio
-- (email_sequences_location_scoped; sequence_steps_via_sequence;
-- sequence_enrollments_via_sequence). So a plain staff member's own JWT plus
-- one hand-written PostgREST call reads email_sequences.webhook_token /
-- webhook_secret and can UPDATE / INSERT / DELETE sequences (status, graph,
-- from_email: activate one that emails customers), steps (email bodies) and
-- enrolments (enrol or exit any contact), bypassing every route check.
--
-- VERIFIED LIVE (29 Sep, BEFORE this migration):
--   relacl on all three: anon=arwdDxtm, authenticated=arwdDxtm,
--   service_role=arwdDxtm (grantor postgres). No column ACLs. RLS on.
--   email_sequences: 29 columns, classified below. webhook_token 0 values,
--   webhook_secret 0 values, 0 sequences with trigger_type = 'webhook'
--   (latent). Both webhook columns carry a mig 131 COMMENT, left untouched.
--   The PROBE below as the earliest plain staff member at a studio with
--   sequences: 6 sequences / 43 steps / 2,604 enrolments readable;
--   UPDATE on email_sequences and sequence_steps, INSERT on
--   sequence_enrollments and SELECT on webhook_secret all true.
--   Not in any publication (realtime). No view depends on them. No function
--   in any schema names them (pg_proc.prosrc). Triggers: email_sequences /
--   sequence_steps _updated_at → update_updated_at() (INVOKER, row-local).
--   Policies on OTHER tables that read email_sequences as the caller: only
--   the two child policies, and they read s.id and s.location_id.
--   FKs into them: sequence_steps / sequence_enrollments.sequence_id
--   (CASCADE), email_sends.sequence_id / sequence_step_id and
--   locations.dunning_sequence_id (SET NULL). RI actions run as the table
--   owner and need no client grant.
--   private.auth_is_in_location: SECURITY DEFINER, EXECUTE for authenticated
--   only; anon has no USAGE on schema private.
--
-- ===========================================================================
-- THE FIX — table-level REVOKE ALL, then grants (allow-lists)
-- ===========================================================================
-- A column-level REVOKE alone is a NO-OP while a table-level grant exists
-- (mig 153 → 153b). The table-level REVOKE is what makes a column grant bind.
--   A. email_sequences: SELECT on 27 columns (all but webhook_token,
--      webhook_secret) to authenticated. id + location_id MUST stay: the child
--      policies read them as the caller, or every client read of a child
--      table fails 42501. No write. anon: nothing.
--   B. sequence_steps, sequence_enrollments (plan C41 DECISIONS 2, default
--      yes): table-level SELECT to authenticated (no secret column; reads
--      unchanged, still RLS-scoped). No write. anon: nothing.
-- It is an allow-list: a column added to email_sequences later is invisible
-- to clients until a migration grants it (or says it is withheld);
-- tests/sequence-column-grants-guard.test.js enforces that, fails a later
-- table-level client grant on email_sequences or client write grant on the
-- children, and fails client code that reads a withheld column or writes any
-- of the three tables.
--
-- A GRANT is per ROLE, not per person: owners and masters lose the same
-- direct access. Every surface that shows or edits these rows is a
-- service-role route or page, which bypasses grants as it bypasses RLS. The
-- flow builder still shows the webhook URL and secret to the operator
-- (automations/[id]/page.js, service role), by design.
--
-- NOT CHANGED: policies, triggers, the private.* helpers, service_role, the
-- mig 131 column comments.
--
-- ===========================================================================
-- CONSUMERS CHECKED (origin/main at #1828, 29 Sep)
-- ===========================================================================
--   * browser: no 'use client' / createBrowserClient file calls .from() on
--     the three tables. ContactDrawer.jsx, ContactNextRail.jsx and
--     AutomationPerformance.jsx only render fields of rows handed to them by
--     service-role routes/pages. The four createAuthClient() (cookie session)
--     users only call auth.getUser() and read profiles / host_users.
--   * every reader and writer is service role: src/app/api/sequences/**,
--     src/lib/sequences/*, dunning, churn-radar, contact-merge,
--     agent/account-tools, frequency-cap, email-hub-stats, the automations
--     and contact pages, webhooks/sequence/[token], and two backfill scripts
--     (SUPABASE_SERVICE_ROLE_KEY).
--   * phone: mobile/ and shared/ never name the tables, and never have (git
--     log -G). No OTA needed.
--   * champ-app, un1t-platform, champ-bridge (origin/main and working
--     trees): never name the tables.
--
-- ===========================================================================
-- APPLY: AFTER the PR merges, the same day (plan C41 Task 1b-5). Nothing in
-- the deploy depends on it. Before and after, run the PROBE (one call, rolled
-- back, counts and booleans only; never a webhook value or sequence content).
-- Expected before: 6 / 43 / 2604 / true / true / true / true.
-- Expected after:  6 / 43 / 2604 / false / false / false / false (same reads).
--
-- PROBE:
--   begin;
--   select set_config('request.jwt.claims', json_build_object('sub',
--     (select p.id from public.profiles p join public.profile_locations pl on pl.profile_id = p.id
--       where pl.role = 'staff' and p.role = 'staff' and p.active is not false and p.deleted_at is null
--         and pl.location_id in (select location_id from public.email_sequences)
--       order by p.created_at limit 1),
--     'role', 'authenticated')::text, true);
--   set local role authenticated;
--   select (select count(id) from public.email_sequences)::int as sequences,
--          (select count(*) from public.sequence_steps)::int as steps,
--          (select count(*) from public.sequence_enrollments)::int as enrolments,
--          has_table_privilege('public.email_sequences', 'UPDATE') as seq_update,
--          has_table_privilege('public.sequence_steps', 'UPDATE') as steps_update,
--          has_table_privilege('public.sequence_enrollments', 'INSERT') as enr_insert,
--          has_column_privilege('public.email_sequences', 'webhook_secret', 'SELECT') as reads_secret;
--   rollback;
--
-- POST-CHECK (catalog): email_sequences relacl holds no anon/authenticated
-- item and authenticated's column_privileges are the 27 SELECT columns; the
-- children's relacl holds authenticated=r only and no anon item:
--   select c.relname, c.relacl::text,
--     (select string_agg(column_name::text, ',' order by column_name)
--        from information_schema.column_privileges p
--       where p.table_schema = 'public' and p.table_name = c.relname
--         and p.grantee = 'authenticated') as auth_cols
--   from pg_class c where c.relnamespace = 'public'::regnamespace
--     and c.relname in ('email_sequences', 'sequence_steps', 'sequence_enrollments');
-- Then get_advisors (security, performance): no new WARN or ERROR.
--
-- ROLLBACK: forward-only, so a NEW migration named
-- <NNN>_profilespread1b_rollback.sql (the guard allow-lists exactly that
-- name; see tests/sequence-column-grants-guard.test.js). It RE-OPENS the
-- webhook secrets and the write hole: use it only if a real client reader or
-- writer breaks (prefer granting that reader's columns in a new migration).
-- No column lists, so it cannot drift if a later migration grants another
-- column; the table-level REVOKE also strips every column ACL. One
-- transaction; no data is touched:
--   BEGIN;
--   REVOKE ALL ON public.email_sequences, public.sequence_steps, public.sequence_enrollments
--     FROM authenticated, anon;
--   GRANT ALL ON public.email_sequences, public.sequence_steps, public.sequence_enrollments
--     TO anon, authenticated;
--   COMMIT;
-- That restores the 29 Sep relacl item for item (arwdDxtm for both roles,
-- no column ACLs); the replay proves it.
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Never wait indefinitely for a lock on these tables (the sequence cron
-- writes them every few minutes). After 5s the file fails whole, nothing
-- changes, and it is re-run.

-- ── A. email_sequences ──────────────────────────────────────────────────
-- Order matters: a column GRANT binds only once the table-level grant is gone.
REVOKE ALL ON public.email_sequences FROM authenticated, anon;

GRANT SELECT (id, location_id, name, description, trigger_type, trigger_config, audience_filter, active,
              total_enrolled, total_completed, total_exited, created_by, created_at, updated_at, status,
              goal_config, send_window, re_enrolment_cooldown_days, graph, draft_graph, graph_version,
              from_email, from_name, reply_to, audience_seeded_at, audience_seeded_by, audience_seed_count)
  ON public.email_sequences TO authenticated;

-- ── B. sequence_steps, sequence_enrollments (plan C41 DECISIONS 2) ──────
REVOKE ALL ON public.sequence_steps, public.sequence_enrollments FROM authenticated, anon;
GRANT SELECT ON public.sequence_steps, public.sequence_enrollments TO authenticated;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back. has_table_privilege /
-- has_any_column_privilege with a comma list are true if ANY privilege is
-- held, so every privilege is checked in its own call.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  granted  text[] := ARRAY['id','location_id','name','description','trigger_type','trigger_config',
                           'audience_filter','active','total_enrolled','total_completed','total_exited',
                           'created_by','created_at','updated_at','status','goal_config','send_window',
                           're_enrolment_cooldown_days','graph','draft_graph','graph_version','from_email',
                           'from_name','reply_to','audience_seeded_at','audience_seeded_by','audience_seed_count'];
  withheld text[] := ARRAY['webhook_token','webhook_secret'];
  unknown_cols text;
  actual   text;
  expected text;
  col  text;
  priv text;
  r    text;
  t    text;
BEGIN
  -- 0. service_role (every /api route, server page and cron) keeps full DML
  --    on all three. REVOKE here names only the client roles, but a
  --    pre-existing gap would break every sequence route.
  FOREACH t IN ARRAY ARRAY['public.email_sequences', 'public.sequence_steps', 'public.sequence_enrollments'] LOOP
    FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', t, priv) THEN
        RAISE EXCEPTION 'PROFILESPREAD.1b: service_role lacks % on %', priv, t;
      END IF;
    END LOOP;
  END LOOP;

  -- A1. Every email_sequences column is classified. A column this file does
  --     not know (added on prod since 29 Sep) would be silently withheld;
  --     stop and classify it instead.
  SELECT string_agg(a.attname::text, ', ' ORDER BY a.attname) INTO unknown_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.email_sequences'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname::text <> ALL (granted || withheld);
  IF unknown_cols IS NOT NULL THEN
    RAISE EXCEPTION 'PROFILESPREAD.1b: public.email_sequences has column(s) this migration does not classify: %', unknown_cols;
  END IF;

  -- A2. No table-level privilege of any kind for either client role
  --     (inheritance-aware, any grantor).
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.email_sequences', priv) THEN
        RAISE EXCEPTION 'PROFILESPREAD.1b: table-level % on public.email_sequences survived for % — a column grant would not bind', priv, r;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
              WHERE table_schema = 'public' AND table_name = 'email_sequences' AND grantee = 'PUBLIC') THEN
    RAISE EXCEPTION 'PROFILESPREAD.1b: PUBLIC holds a table-level privilege on public.email_sequences';
  END IF;

  -- A3. authenticated's SELECT column list is exact; no other column
  --     privilege for any client role or PUBLIC.
  SELECT string_agg(column_name::text, ', ' ORDER BY column_name) INTO actual
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'email_sequences'
     AND grantee = 'authenticated' AND privilege_type = 'SELECT';
  SELECT string_agg(c, ', ' ORDER BY c) INTO expected FROM unnest(granted) AS c;
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'PROFILESPREAD.1b: email_sequences SELECT for authenticated is [%], expected [%]', coalesce(actual, '(none)'), expected;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
              WHERE table_schema = 'public' AND table_name = 'email_sequences'
                AND (grantee IN ('anon', 'PUBLIC') OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'))) THEN
    RAISE EXCEPTION 'PROFILESPREAD.1b: a non-SELECT or anon/PUBLIC column privilege exists on public.email_sequences';
  END IF;

  -- A4. Inheritance-aware (information_schema filters on role NAMES only).
  FOREACH col IN ARRAY withheld LOOP
    IF has_column_privilege('authenticated', 'public.email_sequences', col, 'SELECT')
       OR has_column_privilege('anon', 'public.email_sequences', col, 'SELECT') THEN
      RAISE EXCEPTION 'PROFILESPREAD.1b: withheld column email_sequences.% is still readable by a client role', col;
    END IF;
  END LOOP;
  FOREACH col IN ARRAY granted LOOP
    IF NOT has_column_privilege('authenticated', 'public.email_sequences', col, 'SELECT') THEN
      RAISE EXCEPTION 'PROFILESPREAD.1b: granted column email_sequences.% is not readable by authenticated', col;
    END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    FOREACH priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege(r, 'public.email_sequences', priv) THEN
        RAISE EXCEPTION 'PROFILESPREAD.1b: % holds column-level % on public.email_sequences', r, priv;
      END IF;
    END LOOP;
  END LOOP;
  IF has_any_column_privilege('anon', 'public.email_sequences', 'SELECT') THEN
    RAISE EXCEPTION 'PROFILESPREAD.1b: anon can still read public.email_sequences';
  END IF;

  -- B. The children: authenticated reads (unchanged), no client writes,
  --    anon nothing.
  FOREACH t IN ARRAY ARRAY['public.sequence_steps', 'public.sequence_enrollments'] LOOP
    IF NOT has_table_privilege('authenticated', t, 'SELECT') THEN
      RAISE EXCEPTION 'PROFILESPREAD.1b: authenticated lost SELECT on % (the reads must not change)', t;
    END IF;
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      FOREACH priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(r, t, priv) THEN
          RAISE EXCEPTION 'PROFILESPREAD.1b: % still holds % on %', r, priv, t;
        END IF;
      END LOOP;
      FOREACH priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(r, t, priv) THEN
          RAISE EXCEPTION 'PROFILESPREAD.1b: % holds column-level % on %', r, priv, t;
        END IF;
      END LOOP;
    END LOOP;
    IF has_any_column_privilege('anon', t, 'SELECT') THEN
      RAISE EXCEPTION 'PROFILESPREAD.1b: anon can still read %', t;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.table_privileges
                WHERE table_schema = 'public' AND table_name = split_part(t, '.', 2) AND grantee = 'PUBLIC') THEN
      RAISE EXCEPTION 'PROFILESPREAD.1b: PUBLIC holds a privilege on %', t;
    END IF;
  END LOOP;

  RAISE NOTICE 'PROFILESPREAD.1b mig 654: email_sequences SELECT column-granted (webhook_* withheld); sequence tables closed to client writes; anon holds none.';
END $$;

COMMIT;
