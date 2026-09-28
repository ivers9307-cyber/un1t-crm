-- 646 — NOTESGRANT.1: a coach's own Supabase session reads a shift the way
-- the API serves a shift to a coach, and no more.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 28 Sep 2026);
-- it is the evidence for the fix, not proof the fix landed. Behaviour is
-- proven ahead of apply by a PGlite replay
-- (tests/migration-646-shift-notes-column-grants.test.js).
--
-- ===========================================================================
-- THE FINDING
-- ===========================================================================
-- Mig 614 scoped the ROWS of shift_blocks / shift_assignments a coach's
-- client may read (published rosters at their studios, plus their own rows).
-- RLS cannot hide COLUMNS, and both tables still carry Supabase's default
-- table-level SELECT for `authenticated` AND `anon`. So a plain coach, with
-- their own JWT and one hand-written PostgREST call, reads everything the API
-- deliberately strips from a coach (ROSTER-FIX.2 slimBlockForCoach,
-- COACHSCOPE.1 slimShiftRowForCoach, COACHNOTES.1 #1780, ARRIVALSHOW.1):
--   shift_blocks.notes                 a manager's working note
--   shift_blocks.min_coaches/max_coaches  capacity (a manager fact)
--   shift_assignments.notes            a manager's note about a person
--   shift_assignments.partial_reason   why a person's hours were cut
--   shift_assignments.arrived_at / arrival_source   colleagues' arrival stamps
--   plus who created/assigned and when.
--
-- VERIFIED LIVE (28 Sep, BEFORE this migration):
--   relacl on both tables: anon=arwdDxtm, authenticated=arwdDxtm (table-level
--   SELECT for both). No column ACLs (pg_attribute.attacl all NULL). No
--   PUBLIC grant.
--   has_column_privilege('authenticated', …, 'notes'|'partial_reason',
--   'SELECT') = true on both tables, and for anon too.
--   As a plain `staff` coach at Stillorgan (SET LOCAL ROLE authenticated +
--   their JWT sub): 660 blocks visible, `SELECT id, notes` succeeds on all 660;
--   694 colleagues' assignment rows readable WITH notes, partial_reason,
--   arrived_at, arrival_source; `SELECT *` succeeds (830 rows). Of those
--   colleague rows, 1 carries a non-null partial_reason and 59-69 (by coach)
--   an arrival stamp. shift_blocks.notes: 0 of 934 non-null; shift_assignments.notes:
--   0 of 872 non-null (so the notes half is latent; the other half is not).
--   Neither table is in the supabase_realtime publication. No view depends on
--   either table. pg_graphql is not installed.
--
-- ===========================================================================
-- THE FIX — table-level REVOKE, then a column-level GRANT (allow-list)
-- ===========================================================================
-- Column-level REVOKE alone is a NO-OP while the table-level GRANT exists
-- (mig 153 → 153b; re-measured in the replay test). The table-level REVOKE is
-- what makes a column grant bind.
--
-- The grant is an ALLOW-LIST equal to what the API already serves a coach
-- (slimBlockForCoach / slimShiftRowForCoach), plus `shift_assignments.block_id`
-- (the join key every phone embed of shift_blocks rides on):
--
--   shift_blocks       id, location_id, template_id, block_date, start_time,
--                      end_time, roster_id, briefing
--   shift_assignments  id, block_id, profile_id, status, assigned_at,
--                      start_time_override, end_time_override
--
-- Withheld (no SELECT for authenticated or anon):
--   shift_blocks       notes, min_coaches, max_coaches, created_by,
--                      created_at, updated_at
--   shift_assignments  notes, partial_reason, arrived_at, arrival_source,
--                      assigned_by, updated_at
--
-- A GRANT is per ROLE, not per person: managers and master are
-- `authenticated` too, and lose the same direct reads. Nothing of theirs
-- reads these columns from a browser or phone; every manager surface is a
-- service-role /api route, which bypasses grants exactly as it bypasses RLS.
--
-- `anon` is revoked outright and granted nothing: every policy on both
-- tables is TO authenticated, so anon reads zero rows today.
--
-- A column ADDED to either table later is invisible to authenticated until a
-- migration grants it (or says it is withheld).
-- tests/shift-column-grants-guard.test.js fails a migration that adds one
-- without doing either, and fails a phone/shared select that names an
-- ungranted column (PostgREST refuses the WHOLE select with 42501).
--
-- NOT CHANGED, on purpose: INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES /
-- TRIGGER grants (every writer is service_role; the write policies are
-- manager-at-location and reference only granted columns), the policies,
-- and the private.auth_can_read_* helpers (SECURITY DEFINER, so the grant
-- does not bind them).
--
-- ===========================================================================
-- CONSUMERS CHECKED (origin/main ac27b26e, 28 Sep; re-checked on 0d04a0a6)
-- ===========================================================================
-- Grant-bound readers = code that queries with the anon-key client under a
-- user's session. There is no web one: no browser-client (createBrowserClient)
-- file names either table; ScheduleCalendar / MyRequests / useDraftRosters
-- read /api/schedule/* payloads. The phone's are all in shared/dashboard-data.js
-- (mobile/lib/dashboard-api.js passes mobile's supabase client):
--   * fetchDashboardShifts (via fetchPersonalDashboardData, the phone Today /
--     Personal tab): shift_assignments id, profile_id, start_time_override,
--     end_time_override, status; filter profile_id; embed shift_blocks!inner
--     (id, block_date, start_time, end_time, briefing, location_id, roster_id,
--     + rosters/shift_templates/locations embeds → roster_id, template_id,
--     location_id); filters shift_blocks.block_date / .location_id. Join key
--     shift_assignments.block_id. ALL GRANTED.
--   * fetchPersonalDashboardData swap list: shift_swap_requests →
--     shift_assignments!requester_shift_id (id) → shift_blocks!block_id
--     (block_date, start_time, end_time, shift_templates → template_id).
--     ALL GRANTED.
--   * fetchUnstaffedBlocksThisWeek and fetchTodayOps read these tables too, but
--     are called only server-side (fetchTodayOps from /api/dashboard/business
--     and dashboard/business/page.js with createServerClient();
--     fetchUnstaffedBlocksThisWeek has no caller). Their columns (id,
--     location_id, block_date, roster_id, shift_assignments.profile_id/status)
--     are granted anyway.
--   * Every phone bundle since RETIRE-SHIFTS-MIRROR.2 (2 Jun): 24 versions of
--     shared/dashboard-data.js, 117 selects on these tables — none names a
--     withheld column or `*`. mobile/ never calls .from() on either table.
--   * Functions: hyrox_coaches_on_shift (SECURITY INVOKER, EXECUTE to
--     authenticated + anon; called only by the service-role Hyrox runner) and
--     the shift_assignments_warn_overlap trigger read only granted columns.
--     The approve_*_shift_swap / claim_shift_offer / tombstone functions are
--     not executable by authenticated or anon.
--   * No RLS policy on another table references a withheld column.
--   * champ-app, champ-bridge, un1t-platform, un1t-sentinel: no reference to
--     either table. No supabase/functions reference.
--   * No realtime subscription on either table (neither is published).
--
-- ===========================================================================
-- APPLY: AFTER the PR merges (no code depends on it). Pre-/post-probes and the
-- rollback are in docs/superpowers/plans/2026-09-27-followups/C8-NOTESGRANT.1.md
-- (Task 5). ROLLBACK (only if a reader breaks), as a new forward migration:
--   REVOKE SELECT (id, location_id, template_id, block_date, start_time,
--     end_time, roster_id, briefing) ON public.shift_blocks FROM authenticated;
--   REVOKE SELECT (id, block_id, profile_id, status, assigned_at,
--     start_time_override, end_time_override) ON public.shift_assignments
--     FROM authenticated;
--   GRANT SELECT ON public.shift_blocks, public.shift_assignments
--     TO authenticated, anon;
-- ===========================================================================

BEGIN;

-- Order matters: the column GRANT binds only once the table SELECT is gone.
REVOKE SELECT ON public.shift_blocks FROM authenticated, anon;
REVOKE SELECT ON public.shift_assignments FROM authenticated, anon;

-- Belt and braces: no column ACL exists today, but a stray one on a withheld
-- column would survive the table-level REVOKE.
REVOKE SELECT (notes, min_coaches, max_coaches, created_by, created_at, updated_at)
  ON public.shift_blocks FROM authenticated, anon;
REVOKE SELECT (notes, partial_reason, arrived_at, arrival_source, assigned_by, updated_at)
  ON public.shift_assignments FROM authenticated, anon;

GRANT SELECT (id, location_id, template_id, block_date, start_time, end_time, roster_id, briefing)
  ON public.shift_blocks TO authenticated;
GRANT SELECT (id, block_id, profile_id, status, assigned_at, start_time_override, end_time_override)
  ON public.shift_assignments TO authenticated;

COMMENT ON COLUMN public.shift_blocks.notes IS
  'Manager-only working note (NOTESGRANT.1, mig 646): no SELECT grant for authenticated/anon. Coach-facing block text is briefing. Serve via a service-role route and name your columns on any read that reaches a client component.';
COMMENT ON COLUMN public.shift_assignments.notes IS
  'Manager-only (NOTESGRANT.1, mig 646): no SELECT grant for authenticated/anon. A coach sees their own note only through GET /api/schedule/shifts.';
COMMENT ON COLUMN public.shift_assignments.partial_reason IS
  'Manager-only (NOTESGRANT.1, mig 646): no SELECT grant for authenticated/anon.';

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson). Any
-- failure raises and the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  spec record;
  actual text;
  expected text;
  unknown_cols text;
  col text;
BEGIN
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
    -- 1. Every column of the table is classified. A column this file does not
    --    know (added on prod since 28 Sep) would be silently withheld from the
    --    phone; stop and classify it instead.
    SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO unknown_cols
      FROM pg_attribute a
     WHERE a.attrelid = ('public.' || spec.tbl)::regclass
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname <> ALL (spec.granted || spec.withheld);
    IF unknown_cols IS NOT NULL THEN
      RAISE EXCEPTION 'NOTESGRANT.1: public.% has column(s) this migration does not classify: %', spec.tbl, unknown_cols;
    END IF;

    -- 2. No table-level SELECT left for either client role.
    IF has_table_privilege('authenticated', 'public.' || spec.tbl, 'SELECT')
       OR has_table_privilege('anon', 'public.' || spec.tbl, 'SELECT') THEN
      RAISE EXCEPTION 'NOTESGRANT.1: table-level SELECT on public.% survived — a column grant would not bind', spec.tbl;
    END IF;

    -- 3. authenticated holds exactly the allow-list (column_privileges lists
    --    only real column grants once the table grant is gone).
    SELECT string_agg(column_name::text, ', ' ORDER BY column_name) INTO actual
      FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND table_name = spec.tbl
       AND privilege_type = 'SELECT' AND grantee = 'authenticated';
    SELECT string_agg(c, ', ' ORDER BY c) INTO expected FROM unnest(spec.granted) AS c;
    IF actual IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'NOTESGRANT.1: public.% SELECT grant for authenticated is [%], expected [%]', spec.tbl, coalesce(actual, '(none)'), expected;
    END IF;

    -- 4. anon and PUBLIC hold no column at all.
    IF EXISTS (SELECT 1 FROM information_schema.column_privileges
                WHERE table_schema = 'public' AND table_name = spec.tbl
                  AND privilege_type = 'SELECT' AND grantee IN ('anon', 'PUBLIC')) THEN
      RAISE EXCEPTION 'NOTESGRANT.1: anon or PUBLIC still holds a SELECT column grant on public.%', spec.tbl;
    END IF;

    -- 5. Inheritance-aware (information_schema filters on role NAMES only).
    FOREACH col IN ARRAY spec.withheld LOOP
      IF has_column_privilege('authenticated', 'public.' || spec.tbl, col, 'SELECT')
         OR has_column_privilege('anon', 'public.' || spec.tbl, col, 'SELECT') THEN
        RAISE EXCEPTION 'NOTESGRANT.1: withheld column %.% is still readable by a client role', spec.tbl, col;
      END IF;
    END LOOP;
    FOREACH col IN ARRAY spec.granted LOOP
      IF NOT has_column_privilege('authenticated', 'public.' || spec.tbl, col, 'SELECT') THEN
        RAISE EXCEPTION 'NOTESGRANT.1: granted column %.% is not readable by authenticated', spec.tbl, col;
      END IF;
    END LOOP;

    -- 6. The writes this file promises not to touch.
    IF NOT (has_table_privilege('authenticated', 'public.' || spec.tbl, 'INSERT')
            AND has_table_privilege('authenticated', 'public.' || spec.tbl, 'UPDATE')
            AND has_table_privilege('authenticated', 'public.' || spec.tbl, 'DELETE')) THEN
      RAISE EXCEPTION 'NOTESGRANT.1: a write grant on public.% changed', spec.tbl;
    END IF;
  END LOOP;

  RAISE NOTICE 'NOTESGRANT.1 mig 646: shift_blocks / shift_assignments SELECT is column-granted to authenticated (coach projection); anon holds none.';
END $$;

COMMIT;
