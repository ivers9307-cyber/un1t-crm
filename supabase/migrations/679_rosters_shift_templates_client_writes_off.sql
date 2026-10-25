-- 679 — ROSTERCLIENTWRITE.1: no browser or phone session writes
-- public.rosters or public.shift_templates. Reads are unchanged: mig 618's
-- column SELECT grants on rosters, authenticated's table-level SELECT on
-- shift_templates, and the two SELECT policies stay exactly as they are.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 30 Sep 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-679-rosters-shift-templates-client-writes-off.test.js).
--
-- ===========================================================================
-- THE FINDING (follow-ups C110, found planning C82: its F1)
-- ===========================================================================
-- Mig 618 took SELECT off rosters and granted five columns back; it left the
-- writes alone. shift_templates still has Supabase's full default ACL. So:
--   rosters          anon=awdDxtm, authenticated=awdDxtm (+ 618's 5 column
--                    SELECTs), policies rosters_ins/_upd/_del:
--                    auth_is_master() OR auth_is_manager_at(location_id)
--   shift_templates  anon=arwdDxtm, authenticated=arwdDxtm, policies
--                    shift_templates_ins/_upd/_del: auth_is_manager_at(location_id)
-- auth_is_manager_at = owner, manager or head coach AT that studio (active,
-- not deleted), or master. So an owner, manager or head coach can, from
-- their own login, past every /api/schedule check:
--   * flip a draft (over-budget) roster to 'published' and stamp themselves
--     as the budget approver: the approve route admits only callers with
--     the approvals_rosters permission (owners by default, not managers or
--     head coaches), re-projects the budget, stands down the rosters it
--     replaces and tells the coaches; a direct UPDATE does none of it;
--   * set a published roster to 'superseded', or DELETE it (no publish
--     snapshot blocks it: 0 on prod; shift_blocks.roster_id goes NULL), which
--     hides that whole week from every coach (auth_can_read_shift_block
--     reads the roster's status), with no change log and no notice;
--   * rewrite any roster column, including the budget figures and approval
--     trail they are not allowed to READ (mig 618 withheld them);
--   * insert, edit or delete shift templates, skipping the route's
--     validation and its propagation rules (past blocks untouched, edited
--     blocks kept, published-week change log, the refusal to delete a
--     block with live coaches).
--
-- VERIFIED LIVE (30 Sep, BEFORE this migration):
--   relacl rosters {postgres=arwdDxtm/postgres,anon=awdDxtm/postgres,
--   authenticated=awdDxtm/postgres,service_role=arwdDxtm/postgres};
--   shift_templates {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--   authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}.
--   Column ACLs: exactly mig 618's {authenticated=r/postgres} on rosters'
--   id, location_id, period_start, period_end, status; none on
--   shift_templates. RLS on, not forced; owner postgres; in no publication;
--   no view depends on them; no policy on another table reads them. Admitted
--   by the write policies: 6 people (1 master; 2 owners, 1 manager, 3 head
--   coaches at their studios). As a real head coach and a real manager
--   (rolled back, no id printed): all 79 rosters (17 published) and 22 of 23
--   templates pass the write policies; EXPLAIN of an UPDATE setting a
--   roster's status to 'published' with the approver stamp, a roster
--   DELETE, a template INSERT and a template DELETE all plan (the policy is
--   the only filter). A plain staff login: 0 rows admitted, privilege held.
--   Edge logs 28 Sep 11:00Z -> 30 Sep 11:00Z: 0 POST/PATCH/DELETE on either
--   table by anyone; the only client requests naming them are the phone's
--   authenticated GETs of shift_assignments (embeds rosters(status) and
--   shift_templates(name, start_time, end_time)) and shift_swap_requests
--   (embeds shift_templates(name)); 0 anon, 0 without a JWT.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   authenticated: REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
--     TRIGGER, MAINTAIN on both. NEVER a table-level REVOKE SELECT or REVOKE
--     ALL from authenticated: on rosters that wipes mig 618's column grants
--     (the phone's Today tab 42501s on the rosters(status) embed); on
--     shift_templates it takes the table-level SELECT the phone's
--     shift_templates(name) embeds read. A table-level REVOKE of
--     INSERT/UPDATE/REFERENCES also takes those privileges off every column,
--     so no column-level write can survive it; column SELECT is untouched.
--   anon, PUBLIC: REVOKE ALL on both (anon reached no policy: every policy
--     is TO authenticated; 0 anon requests). C76 (mig 677) does the same
--     estate-wide; whichever runs second, this is a no-op for anon.
--   Drop the six write policies. Keep rosters_select and
--   shift_templates_select byte-for-byte. RLS stays on.
--   Table and column COMMENTs are left as they are.
--   End state: authenticated holds exactly mig 618's column SELECT list on
--   rosters and table-level SELECT on shift_templates, nothing else; anon
--   and PUBLIC nothing; service_role everything.
--
--   Every writer is service_role: POST /api/schedule/rosters (publish, via
--   src/lib/roster-publish.js), /rosters/[id]/approve, /rosters/[id]/reject,
--   /api/schedule/templates (POST), /templates/[id] (PUT/DELETE),
--   /templates/clone, the nightly /api/cron/extend-roster-horizon, and
--   tombstone_staff_profile. The trigger update_updated_at is INVOKER and
--   fires for service_role as before. FK actions (locations -> both,
--   rosters -> shift_blocks SET NULL, shift_templates -> shift_blocks
--   RESTRICT and the two CASCADE children) run as the table owner.
--
-- CONSUMERS CHECKED (un1t-crm origin/main 0963807a incl. mobile/, shared/,
-- desktop/, supabase/functions, scripts and the history of every
-- mobile/shared/desktop file on any branch; champ-app, champ-bridge,
-- un1t-platform, un1t-sentinel, un1t-pi, un1t-finance-agent: no reference):
--   no browser, createAuthClient, anon-key, phone or other-repo code WRITES
--   either table, and none ever did. The only client READERS are the two
--   phone embeds in shared/dashboard-data.js (fetchDashboardShifts:
--   rosters:roster_id(status) and shift_templates(name, start_time,
--   end_time); the own-swaps list: shift_templates(name)), which read
--   granted columns and keep working unchanged. Neither table is in a
--   realtime publication.
--
-- Guard: tests/roster-client-writes-guard.test.js.
--
-- APPLY: after this PR merges, same day, after the log check in
-- docs/superpowers/plans/2026-09-27-followups/C110-ROSTERCLIENTWRITE.1.md
-- (Task 5, which also holds the pre/post probes and the rollback).
-- ===========================================================================

BEGIN;

-- DROP POLICY takes ACCESS EXCLUSIVE on tables every /api/schedule route
-- and the phone's Today tab read (through the embeds). Abort after 5 s
-- rather than queue behind them. Nothing is half-applied: re-run.
SET LOCAL lock_timeout = '5s';

-- What this file promises not to change, as this session renders it.
-- Every column's ACL, verbatim (mig 618's SELECT grants live here).
CREATE TEMP TABLE mig679_column_acl ON COMMIT DROP AS
  SELECT a.attrelid::regclass::text AS tbl, a.attname::text AS col, a.attacl::text AS acl
    FROM pg_attribute a
   WHERE a.attrelid IN ('public.rosters'::regclass, 'public.shift_templates'::regclass)
     AND a.attnum > 0 AND NOT a.attisdropped;
-- The two read rules.
CREATE TEMP TABLE mig679_read_rule ON COMMIT DROP AS
  SELECT tablename::text AS tablename, policyname::text AS policyname, permissive, roles, qual, with_check
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (tablename, policyname) IN (('rosters', 'rosters_select'),
                                     ('shift_templates', 'shift_templates_select'))
     AND cmd = 'SELECT';

REVOKE ALL ON public.rosters, public.shift_templates FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.rosters, public.shift_templates FROM authenticated;

DROP POLICY IF EXISTS rosters_ins ON public.rosters;
DROP POLICY IF EXISTS rosters_upd ON public.rosters;
DROP POLICY IF EXISTS rosters_del ON public.rosters;
DROP POLICY IF EXISTS shift_templates_ins ON public.shift_templates;
DROP POLICY IF EXISTS shift_templates_upd ON public.shift_templates;
DROP POLICY IF EXISTS shift_templates_del ON public.shift_templates;

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
  IF (SELECT count(*) FROM mig679_column_acl WHERE acl IS NOT NULL) <> 5 THEN
    RAISE EXCEPTION 'mig 679: mig 618''s rosters column grants are not as expected before this file ran (found % column ACLs, expected 5); restore them first', (SELECT count(*) FROM mig679_column_acl WHERE acl IS NOT NULL);
  END IF;
  IF (SELECT count(*) FROM mig679_read_rule) <> 2 THEN
    RAISE EXCEPTION 'mig 679: rosters_select / shift_templates_select not both present before this file ran';
  END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      -- rosters: SELECT by column only (mig 618).
      ('rosters', NULL::text[],
       ARRAY['id','location_id','period_start','period_end','status'],
       ARRAY['published_by','published_at','over_budget_approval_by','over_budget_approval_at',
             'projected_contractor_eur','budget_at_publish_eur','notes','created_by','created_at',
             'updated_at','superseded_by','superseded_at','requested_period_start','requested_period_end']),
      -- shift_templates: table-level SELECT (every column).
      ('shift_templates', ARRAY['SELECT'], NULL::text[], NULL::text[])
    ) AS v(tbl, table_privs, granted, withheld)
  LOOP
    v_rel := 'public.' || spec.tbl;

    -- 1. RLS still on; the server keeps full DML.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass) THEN
      RAISE EXCEPTION 'mig 679: row level security is off on %', v_rel;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 679: service_role lost % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 2. Table-level privileges (any grantor, role membership and PUBLIC
    --    included): anon and PUBLIC none; authenticated exactly
    --    spec.table_privs (SELECT on shift_templates, nothing on rosters).
    FOREACH v_role IN ARRAY ARRAY['anon', 'public'] LOOP
      FOREACH v_priv IN ARRAY v_all_privs LOOP
        IF has_table_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 679: % still holds % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH v_priv IN ARRAY v_all_privs LOOP
      IF has_table_privilege('authenticated', v_rel, v_priv)
         AND NOT (v_priv = ANY (coalesce(spec.table_privs, ARRAY[]::text[]))) THEN
        RAISE EXCEPTION 'mig 679: authenticated still holds % on %', v_priv, v_rel;
      END IF;
      IF NOT has_table_privilege('authenticated', v_rel, v_priv)
         AND v_priv = ANY (coalesce(spec.table_privs, ARRAY[]::text[])) THEN
        RAISE EXCEPTION 'mig 679: authenticated lost % on % (the phone''s template embeds read it)', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 3. No column-level privilege for anon or PUBLIC; for authenticated,
    --    no column-level write or REFERENCES.
    FOREACH v_role IN ARRAY ARRAY['anon', 'public'] LOOP
      FOREACH v_priv IN ARRAY v_col_privs LOOP
        IF has_any_column_privilege(v_role, v_rel, v_priv) THEN
          RAISE EXCEPTION 'mig 679: % still holds column-level % on %', v_role, v_priv, v_rel;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege('authenticated', v_rel, v_priv) THEN
        RAISE EXCEPTION 'mig 679: authenticated still holds column-level % on %', v_priv, v_rel;
      END IF;
    END LOOP;

    -- 4. rosters' reads: exactly mig 618's allow-list, nothing withheld reopened.
    FOREACH v_col IN ARRAY coalesce(spec.granted, ARRAY[]::text[]) LOOP
      IF NOT has_column_privilege('authenticated', v_rel, v_col, 'SELECT') THEN
        RAISE EXCEPTION 'mig 679: granted column %.% is no longer readable by authenticated (mig 618 wiped)', spec.tbl, v_col;
      END IF;
    END LOOP;
    FOREACH v_col IN ARRAY coalesce(spec.withheld, ARRAY[]::text[]) LOOP
      IF has_column_privilege('authenticated', v_rel, v_col, 'SELECT') THEN
        RAISE EXCEPTION 'mig 679: withheld column %.% is readable by authenticated', spec.tbl, v_col;
      END IF;
    END LOOP;

    -- 5. Exactly one policy left: the SELECT policy, unchanged.
    SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_pols
      FROM pg_policies WHERE schemaname = 'public' AND tablename = spec.tbl;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = spec.tbl) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policies p JOIN mig679_read_rule k
                         ON k.tablename = p.tablename AND k.policyname = p.policyname
                        AND k.permissive = p.permissive AND k.roles = p.roles
                        AND k.qual IS NOT DISTINCT FROM p.qual AND k.with_check IS NOT DISTINCT FROM p.with_check
                      WHERE p.schemaname = 'public' AND p.tablename = spec.tbl AND p.cmd = 'SELECT') THEN
      RAISE EXCEPTION 'mig 679: % should keep exactly its unchanged SELECT policy, has: %', v_rel, coalesce(v_pols, '(none)');
    END IF;
  END LOOP;

  -- 6. Every column ACL is byte-identical to what it was before this file.
  SELECT string_agg(coalesce(b.tbl, a.tbl) || '.' || coalesce(b.col, a.col)
                    || ' [' || coalesce(b.acl, 'NULL') || ' -> ' || coalesce(a.acl, 'NULL') || ']', ', ')
    INTO v_diff
    FROM mig679_column_acl b
    FULL JOIN (SELECT at.attrelid::regclass::text AS tbl, at.attname::text AS col, at.attacl::text AS acl
                 FROM pg_attribute at
                WHERE at.attrelid IN ('public.rosters'::regclass, 'public.shift_templates'::regclass)
                  AND at.attnum > 0 AND NOT at.attisdropped) a
      ON a.tbl = b.tbl AND a.col = b.col
   WHERE a.acl IS DISTINCT FROM b.acl OR a.col IS NULL OR b.col IS NULL;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'mig 679: column ACLs changed (mig 618''s SELECT grants must be byte-identical): %', v_diff;
  END IF;

  RAISE NOTICE 'mig 679: rosters / shift_templates: no client write; authenticated keeps exactly mig 618''s column SELECT on rosters and table SELECT on shift_templates; one SELECT policy each, unchanged.';
END $$;

COMMIT;
