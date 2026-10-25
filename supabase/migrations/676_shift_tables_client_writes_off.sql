-- 676 — SHIFTCLIENTWRITE.1: no browser or phone session writes
-- public.shift_blocks or public.shift_assignments. Reads are unchanged: mig
-- 646's column SELECT grants and the two SELECT policies stay exactly as
-- they are.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-676-shift-tables-client-writes-off.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C82, found planning C15: its open question 2)
-- ===========================================================================
-- Mig 646 moved SELECT on both tables to a column allow-list and on purpose
-- left the writes alone; mig 668 took anon, PUBLIC and authenticated's
-- TRUNCATE/REFERENCES/TRIGGER/MAINTAIN off and also left the writes alone.
-- So authenticated still holds table-level INSERT, UPDATE and DELETE, behind
-- six mig-320 policies:
--   shift_blocks_ins/_upd/_del       auth_is_master() OR auth_is_manager_at(location_id)
--   shift_assignments_ins/_upd/_del  auth_is_master() OR the block's studio
--                                    passes auth_is_manager_at
-- auth_is_manager_at = owner, manager or head_coach AT that studio (active,
-- not deleted), or master. So an owner, manager or head coach can, from
-- their own login, past every /api/schedule check:
--   * write ANY column of ANY assignment at their studio, their OWN included:
--     start/end_time_override (the paid window), arrived_at and
--     arrival_source (in app code only the geofence check-in route writes
--     those), partial_reason, status, profile_id (re-assign a shift to anyone,
--     a person from another studio or a tombstone included);
--   * insert, move, re-roster or delete blocks: roster_id (attach a draft
--     block to a published roster: coaches see it, nobody is told),
--     block_date/start/end, min/max coaches (capacity is enforced only in
--     the routes); a DELETE cascades away every assignment on the block;
-- and none of it writes roster_change_log, sends the coach's push, runs the
-- overlap refusal, the published-roster rules, the active-membership filter
-- (CLAUDE.md, tombstones) or the audit the routes do.
-- They can no longer even READ back arrived_at, partial_reason or notes
-- (mig 646), but they can overwrite them.
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration):
--   relacl (both) {postgres=arwdDxtm/postgres,authenticated=awd/postgres,
--   service_role=arwdDxtm/postgres}; column ACLs = mig 646's list exactly
--   ({authenticated=r/postgres} on 8 shift_blocks and 7 shift_assignments
--   columns, nothing else). has_table_privilege: authenticated INSERT,
--   UPDATE, DELETE true, everything else false; anon and PUBLIC nothing.
--   RLS on, not forced; owner postgres; in no publication; no view depends
--   on them; no policy on another table reads them. Admitted by the write
--   policies: 6 people (1 master; 2 owners, 1 manager, 3 head coaches at
--   their studios). As a real head coach (rolled back, no id printed): 966
--   of 967 blocks and 872 of 873 assignments pass the write policy, 107 of
--   them their own; EXPLAIN of an UPDATE setting arrived_at/arrival_source/
--   end_time_override, an INSERT and a block DELETE all plan (the policy is
--   the only filter). A plain staff login: 0 rows admitted (privilege held).
--   Edge logs, two 24 h windows to 30 Sep 10:00Z and the hour after: every
--   POST/PATCH/DELETE on the two tables was service_role; the only client
--   requests were the phone's authenticated GETs (shift_assignments with
--   the shift_blocks embed; the own-swaps list's nested embed).
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   authenticated: REVOKE INSERT, UPDATE, DELETE (and TRUNCATE, REFERENCES,
--     TRIGGER, MAINTAIN again, a no-op after 668). NEVER a table-level
--     REVOKE SELECT or REVOKE ALL from authenticated: that also revokes
--     SELECT on every column and wipes mig 646's grants (the phone's Today
--     tab 42501s). A table-level REVOKE of INSERT/UPDATE/REFERENCES also
--     takes those privileges off every column, so no column-level write can
--     survive it; column SELECT is untouched.
--   anon, PUBLIC: REVOKE ALL (a no-op after 668, named so the end state is
--     this file's claim).
--   Drop the six write policies. Keep shift_blocks_select and
--   shift_assignments_select byte-for-byte. RLS stays on.
--   Table and column COMMENTs are left as they are.
--   End state: authenticated holds exactly mig 646's column SELECT list and
--   nothing else; service_role everything.
--
--   Every writer is service_role: /api/schedule/blocks*, /assignments/[id],
--   /blocks/bulk-assign, /shifts/copy-week|copy-month, /templates/[id],
--   /rosters*, /swaps (the approve_* RPCs), /offers (claim_shift_offer),
--   /api/attendance/geofence-checkin, tombstone_staff_profile, and
--   src/lib/roster-*.js / shift-*.js. The
--   triggers (update_updated_at, shift_assignments_warn_overlap) are INVOKER
--   and fire for service_role as before. FK actions (profiles/locations ->
--   the two tables, shift_blocks -> shift_assignments/shift_offers) run as
--   the table owner.
--
-- CONSUMERS CHECKED (un1t-crm origin/main ef13a840 incl. mobile/, shared/,
-- desktop/, supabase/functions, scripts and the history of every
-- mobile/shared/desktop file on any branch; champ-app, champ-bridge,
-- un1t-platform, un1t-sentinel, un1t-pi, un1t-finance-agent: no reference):
--   no browser, createAuthClient, anon-key, phone or other-repo code WRITES
--   either table, and none ever did. The only client READERS are
--   shared/dashboard-data.js (phone Today and Personal tabs), which read
--   granted columns only and keep working unchanged. Neither table is in a
--   realtime publication.
--
-- Guard: tests/shift-client-writes-guard.test.js.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C82-SHIFTCLIENTWRITE.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on tables every /api/schedule route,
-- the geofence check-in and the phone's Today tab read. Abort after 5 s
-- rather than queue behind them. Nothing is half-applied: re-run.
SET LOCAL lock_timeout = '5s';

-- What this file promises not to change, as this session renders it.
-- Every column's ACL, verbatim (mig 646's SELECT grants live here).
CREATE TEMP TABLE mig676_column_acl ON COMMIT DROP AS
  SELECT a.attrelid::regclass::text AS tbl, a.attname::text AS col, a.attacl::text AS acl
    FROM pg_attribute a
   WHERE a.attrelid IN ('public.shift_blocks'::regclass, 'public.shift_assignments'::regclass)
     AND a.attnum > 0 AND NOT a.attisdropped;
-- The two read rules.
CREATE TEMP TABLE mig676_read_rule ON COMMIT DROP AS
  SELECT tablename::text AS tablename, policyname::text AS policyname, permissive, roles, qual, with_check
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (tablename, policyname) IN (('shift_blocks', 'shift_blocks_select'),
                                     ('shift_assignments', 'shift_assignments_select'))
     AND cmd = 'SELECT';

REVOKE ALL ON public.shift_blocks, public.shift_assignments FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.shift_blocks, public.shift_assignments FROM authenticated;

DROP POLICY IF EXISTS shift_blocks_ins ON public.shift_blocks;
DROP POLICY IF EXISTS shift_blocks_upd ON public.shift_blocks;
DROP POLICY IF EXISTS shift_blocks_del ON public.shift_blocks;
DROP POLICY IF EXISTS shift_assignments_ins ON public.shift_assignments;
DROP POLICY IF EXISTS shift_assignments_upd ON public.shift_assignments;
DROP POLICY IF EXISTS shift_assignments_del ON public.shift_assignments;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back. has_table_privilege and
-- has_any_column_privilege are asked one role and one privilege per call
-- (a comma list is true when ANY is held). MAINTAIN is Postgres 17's `m`;
-- information_schema does not show it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_all_privs text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
  v_col_privs text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
  spec   record;
  v_rel  text;
  v_role text;
  v_priv text;
  v_col  text;
  v_diff text;
  v_pols text;
BEGIN
  -- 0. The before-snapshots are real (an empty list compares equal to an
  --    empty list and proves nothing; mig 668's lesson).
  IF (SELECT count(*) FROM mig676_column_acl WHERE acl IS NOT NULL) < 15 THEN
    RAISE EXCEPTION 'mig 676: mig 646''s column grants are missing before this file ran (found % column ACLs, expected 15); apply 646 first or restore them', (SELECT count(*) FROM mig676_column_acl WHERE acl IS NOT NULL);
  END IF;
  IF (SELECT count(*) FROM mig676_read_rule) <> 2 THEN
    RAISE EXCEPTION 'mig 676: shift_blocks_select / shift_assignments_select not both present before this file ran';
  END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      ('shift_blocks',
       ARRAY['id','location_id','template_id','block_date','start_time','end_time','roster_id','briefing'],
       ARRAY['notes','min_coaches','max_coaches','created_by','created_at','updated_at']),
      ('shift_assignments',
       ARRAY['id','block_id','profile_id','status','assigned_at','start_time_override','end_time_override'],
       ARRAY['notes','partial_reason','arrived_at','arrival_source','assigned_by','updated_at'])
    ) AS v(tbl, granted, withheld)
  LOOP
    v_rel := 'public.' || spec.tbl;

    -- 1. RLS still on; the server keeps full DML.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
      RAISE EXCEPTION 'mig 676: row level security is off on %', v_rel;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 676: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 2. No client role holds any table-level privilege (any grantor, role
    --    membership and PUBLIC included). SELECT too: 646's reads are
    --    column-level only.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      FOREACH v_priv IN ARRAY v_all_privs LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 676: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;

    -- 3. No column-level privilege for anon or PUBLIC; for authenticated,
    --    no column-level write or REFERENCES.
    FOREACH v_role IN ARRAY ARRAY['anon', 'public'] LOOP
      FOREACH v_priv IN ARRAY v_col_privs LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 676: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege('authenticated', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 676: authenticated still holds column-level % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 4. The reads: exactly mig 646's allow-list, nothing withheld reopened.
    FOREACH v_col IN ARRAY spec.granted LOOP
      IF NOT has_column_privilege('authenticated', v_rel, v_col, 'SELECT') THEN
        RAISE EXCEPTION 'mig 676: granted column %.% is no longer readable by authenticated (mig 646 wiped)', spec.tbl, v_col;
      END IF;
    END LOOP;
    FOREACH v_col IN ARRAY spec.withheld LOOP
      IF has_column_privilege('authenticated', v_rel, v_col, 'SELECT') THEN
        RAISE EXCEPTION 'mig 676: withheld column %.% is readable by authenticated', spec.tbl, v_col;
      END IF;
    END LOOP;

    -- 5. Exactly one policy left: the SELECT policy, unchanged.
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_pols
      FROM pg_policies WHERE schemaname = 'public' AND tablename = spec.tbl;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = spec.tbl) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policies p JOIN mig676_read_rule k
                         ON k.tablename = p.tablename AND k.policyname = p.policyname
                        AND k.permissive = p.permissive AND k.roles = p.roles
                        AND k.qual IS NOT DISTINCT FROM p.qual AND k.with_check IS NOT DISTINCT FROM p.with_check
                      WHERE p.schemaname = 'public' AND p.tablename = spec.tbl AND p.cmd = 'SELECT') THEN
      RAISE EXCEPTION 'mig 676: % should keep exactly its unchanged SELECT policy, has: %', v_rel, coalesce(v_pols, '(none)');
    END IF;
  END LOOP;

  -- 6. Every column ACL is byte-identical to what it was before this file.
  SELECT string_agg(coalesce(b.tbl, a.tbl) || '.' || coalesce(b.col, a.col)
                    || ' [' || coalesce(b.acl, 'NULL') || ' -> ' || coalesce(a.acl, 'NULL') || ']', ', ')
    INTO v_diff
    FROM mig676_column_acl b
    FULL JOIN (SELECT at.attrelid::regclass::text AS tbl, at.attname::text AS col, at.attacl::text AS acl
                 FROM pg_attribute at
                WHERE at.attrelid IN ('public.shift_blocks'::regclass, 'public.shift_assignments'::regclass)
                  AND at.attnum > 0 AND NOT at.attisdropped) a
      ON a.tbl = b.tbl AND a.col = b.col
   WHERE a.acl IS DISTINCT FROM b.acl OR a.col IS NULL OR b.col IS NULL;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'mig 676: column ACLs changed (mig 646''s SELECT grants must be byte-identical): %', v_diff;
  END IF;

  RAISE NOTICE 'mig 676: shift_blocks / shift_assignments: no client write; authenticated keeps exactly mig 646''s column SELECT; one SELECT policy each, unchanged.';
END $$;

COMMIT;
