-- 618 — RLSSCOPE.2: the two things COACHSCOPE.1 (mig 614) named and left.
--
-- NOT APPLIED YET. Everything under "VERIFIED LIVE" below describes the state
-- of prod BEFORE this file runs; it is the evidence for the fix, not proof the
-- fix landed. Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-618-coach-budget-and-role-scope.test.js), which boots a
-- real Postgres, installs the CURRENT prod policies + grants, demonstrates the
-- leak, runs this file verbatim and asserts the close.
--
-- ===========================================================================
-- FINDING 1 — a coach's browser/phone can read a published roster's budget
-- ===========================================================================
-- Mig 614 narrowed `rosters` SELECT to published/superseded for a plain member
-- and GET /api/schedule/rosters strips the money fields for a non-manager, but
-- RLS filters ROWS, not COLUMNS: a coach holding a published roster's row also
-- holds `projected_contractor_eur`, `budget_at_publish_eur`,
-- `over_budget_approval_by`, `over_budget_approval_at` and the manager's
-- `notes` — one hand-written PostgREST call away, with no route in between.
--
-- VERIFIED LIVE (read-only, Supabase MCP, 17 Sep, BEFORE this migration):
--
--   information_schema.table_privileges  → rosters SELECT granted to
--   `authenticated` AND `anon`.
--   information_schema.column_privileges → all 19 columns readable by both,
--   budget columns included.
--   has_column_privilege('authenticated','public.rosters',
--                        'projected_contractor_eur','SELECT') = true
--   (has_*_privilege is used deliberately: it follows role inheritance, which
--   the information_schema views do not.)
--
-- THE FIX — table-level REVOKE + column-level GRANT.
--
--   Column-level REVOKE alone is a no-op while a table-level GRANT exists
--   (mig 153, re-measured in the replay test: after
--   `REVOKE SELECT (projected_contractor_eur) … FROM authenticated` the column
--   is still readable AND still listed in column_privileges). The table-level
--   REVOKE is the only thing that makes a column grant bind — mig 153b's
--   lesson, applied a second time.
--
-- WHY NO `rosters_public` VIEW. The obvious shape — REVOKE the table, expose a
-- narrow view — does not work here, and measurably so. CLAUDE.md requires
-- `WITH (security_invoker = on)` on every view, and a security_invoker view
-- checks privileges on its BASE TABLE as the invoking user. Measured in the
-- replay test: with the column grants in place `SELECT * FROM rosters_public`
-- succeeds; drop the base-table column grants and the same select fails with
-- `permission denied for table rosters`. So the view hides nothing the column
-- grant does not already hide, and would add a second name, a second grant and
-- a reader-repointing exercise for zero security. The column grant is the
-- whole mechanism; the view is omitted on purpose.
--
-- THE EMBED. `shared/dashboard-data.js` fetchDashboardShifts selects
--   shift_blocks!inner ( …, roster_id, rosters:roster_id ( status ), … )
-- and is the ONLY reader of `rosters` bound by these grants (see CONSUMERS).
-- PostgREST resolves that embed as a join on `rosters.id` projecting
-- `rosters.status` — both columns stay granted, so it is unaffected. Proven in
-- the replay test against both the lateral-subquery and the LEFT JOIN shapes.
-- `count(*)` also still works (it requires no column privilege at all).
--
-- What a coach's client can still read on rosters after this migration:
--   id, location_id, period_start, period_end, status
-- and nothing else. `id` is the embed's join key; `status` is its payload;
-- location_id/period_start/period_end are a roster's non-sensitive identity,
-- granted so a coach-facing "which roster is this shift on" read never needs
-- another migration. Everything withheld is either money
-- (projected_contractor_eur, budget_at_publish_eur), an approval trail
-- (over_budget_approval_by/at, published_by, created_by, superseded_by) or a
-- manager's working text (notes).
--
-- `anon` is revoked outright and granted nothing: `rosters_select` is
-- `TO authenticated`, so anon reads zero rows today and needs no column.
--
-- CONSUMERS CHECKED (every reader of `rosters`, and every `rosters:` embed in
-- the repo — grep "from('rosters')" and "rosters:" over src/ shared/ mobile/):
--   * shared/dashboard-data.js:104 fetchDashboardShifts — the embed above.
--     RLS/GRANT-bound when called from mobile (mobile/lib/dashboard-api.js
--     passes the anon-key client); reads `status` only. UNAFFECTED.
--   * shared/dashboard-data.js:340 fetchPendingRosterApprovalsCount — called
--     ONLY from src/app/dashboard/today/page.js with createServerClient()
--     (service_role). Not grant-bound. Selects `id` anyway, which stays
--     granted, so it would survive either way.
--   * src/app/(team)/schedule/approvals/page.js:42 — server page,
--     createServerClient(). Not grant-bound.
--   * Every other site — src/app/api/schedule/rosters/*, .../blocks/*,
--     .../assignments/*, .../swaps/*, .../templates/*, src/lib/roster.js,
--     roster-write.js, roster-publish.js, roster-read.js,
--     roster-change-notify.js, time-off-leave.js,
--     src/lib/approvals/providers/rosters.js — all service_role, which
--     bypasses column and table GRANTs exactly as it bypasses RLS.
--   * No browser-client (createBrowserClient) reader of rosters exists; none
--     of the components in that list touches the schedule.
--   * No realtime subscription on rosters (grep postgres_changes).
--   * mobile/ references to "rosters" are the approvals route map and a
--     notification deep-link — strings, not queries.
--
-- ===========================================================================
-- FINDING 2a — strap_assignments checks the GLOBAL role
-- ===========================================================================
-- The mig 320 policies call `private.auth_is_admin_or_head_coach()`, which
-- reads `profiles.role` — the estate-wide role — so a head_coach at Hatch
-- reads and writes Stillorgan's strap pairings. Same class mig 600 fixed for
-- leave/allowances/templates and mig 614 for swaps and reports; these four
-- were missed because `strap_assignments` carries no `location_id` of its own.
--
-- Its location is its bridge's: strap_assignments.ble_bridge_id →
-- ble_bridges.location_id. So the per-location helper needs the bridge, and
-- `private.auth_is_manager_at_bridge(uuid)` below resolves it once, in a
-- SECURITY DEFINER, the same way mig 614's helpers do.
--
-- Note what the SELECT policy already said: its third branch
-- (`EXISTS bridge at a location I am in`) ALREADY gives every member of the
-- bridge's location a read. The global-role branch therefore contributed
-- exactly one thing — a cross-location read for a global admin/head_coach —
-- and that is what goes. Reads for a member at the bridge's location, and for
-- the strap's own contact, are unchanged.
--
-- The write policies were global-role only, so they gain a location test.
-- `auth_is_admin_or_head_coach()` checks role IN (owner, manager, head_coach)
-- and does NOT include 'master'; `auth_is_manager_at()` starts with
-- `auth_is_master()`, so master gains the estate-wide write it should have had.
--
-- TO public → TO authenticated, matching mig 614 and CLAUDE.md. Behaviour-
-- preserving for anon: with auth.uid() NULL every branch of every policy is
-- false or NULL today (auth_contact_id() returns no row, auth_is_master() and
-- the profile_locations EXISTS are false), so anon reads and writes nothing
-- before this migration and nothing after it.
--
-- CONSUMERS CHECKED: every strap_assignments query in the repo is in
-- src/lib/bridge-samples.js (2), src/lib/live-class.js (2) — reached only from
-- /api/bridge/* and /api/live/*, all createServerClient() — so RLS binds no
-- live reader today. champ-app has no reference to the table; champ-bridge
-- talks to /api/bridge/*, never to Postgres. This is a class fix, not an
-- outage fix.
--
-- ===========================================================================
-- FINDING 2b — profiles_select also checks the global role. LEFT ALONE.
-- ===========================================================================
-- `profiles_select` (mig 320) is
--   auth_is_master() OR id = auth.uid() OR private.auth_can_view_all_profiles()
-- and that last helper (mig 105) reads the estate-wide `profiles.role`, so on
-- its face any global owner/manager/head_coach reads EVERY profile in the
-- estate — annual_salary, hourly_rate, contracted_hours_per_week and all.
--
-- It is not narrowed here, for two reasons, the first of which is decisive.
--
-- 1. IT IS UNREACHABLE. VERIFIED LIVE (17 Sep, before this migration):
--      has_table_privilege('authenticated','public.profiles','SELECT') = false
--      has_table_privilege('anon',         'public.profiles','SELECT') = false
--      has_column_privilege(... ,'full_name','SELECT')    = false  (both roles)
--      has_column_privilege(... ,'annual_salary','SELECT')= false  (both roles)
--      information_schema.column_privileges → ZERO rows for profiles /
--      authenticated / anon.
--    mig 153b's table-level REVOKE still stands, and there is no view over
--    profiles to route around it (checked pg_class/pg_rewrite: no view or
--    matview in `public` depends on profiles). A policy on a table the role
--    cannot select from never evaluates — the query fails at permission
--    checking first. So the CLAUDE.md invariant holds: the authenticated role
--    has no grant on profiles. The REVOKE is strictly stronger than any
--    narrowing of this policy could be, and it is already in place.
--
-- 2. NARROWING IT NOW WOULD PRE-COMMIT THE WRONG SHAPE. The natural narrowing
--    — master OR own row OR manager at a location the target profile shares —
--    is a guess about a reader set that does not exist. The only plausible
--    reason anyone re-grants SELECT on profiles is to let a mobile client
--    embed a colleague's `full_name` (shared/dashboard-data.js
--    fetchStudioDashboardData already tries: `profiles!profile_id(full_name)`
--    and `requester:profiles!requester_id(full_name)`), and under that
--    narrowing a plain coach still could not read a colleague's name — so the
--    "fix" would break the exact case the re-grant was for. The decision
--    belongs to whoever re-grants, with the column grant they choose.
--
-- The DO block at the end therefore only RAISES A NOTICE if a SELECT grant on
-- profiles has reappeared. It deliberately does not fail: a re-grant may be a
-- considered decision, and a migration that refuses to apply because of one is
-- a landmine. If you see that notice, narrowing profiles_select becomes real
-- work and this comment is your starting point.
--
-- ===========================================================================
-- LOCKOUT REVIEW (the question this migration could get fatally wrong)
-- ===========================================================================
-- * Does `TO public` → `TO authenticated` on strap_assignments shut the
--   service-role routes out? NO. VERIFIED LIVE: pg_roles.rolbypassrls is TRUE
--   for `service_role` and for `postgres` (the tables' owner), and neither
--   strap_assignments nor rosters has FORCE ROW LEVEL SECURITY
--   (relforcerowsecurity = false). RLS never applies to /api/bridge/* or
--   /api/live/*, so no policy scoped to `authenticated` can reach them. Mig
--   614 made the same conversion on shift_swap_requests and the two report
--   tables and is live.
-- * Does the REVOKE break an RLS-bound WRITE of rosters? There is none (every
--   writer is service_role), and it would not anyway: all four rosters
--   policies reference only `location_id` and `status`, both still granted,
--   and INSERT/UPDATE/DELETE grants are untouched — only SELECT is revoked.
-- * Does it break a coach's schedule screens? Those are served by
--   /api/schedule/* (service_role). The one grant-bound path is the mobile
--   dashboard embed, covered above and in the replay test.
--
-- ===========================================================================
-- POST-APPLY CHECKS (run all four)
-- ===========================================================================
-- 1. The grant is what we think it is — column_privileges, never this file:
--      SELECT grantee, column_name FROM information_schema.column_privileges
--       WHERE table_schema='public' AND table_name='rosters'
--         AND privilege_type='SELECT' AND grantee IN ('authenticated','anon')
--       ORDER BY 1,2;
--    EXPECT exactly five rows, all grantee='authenticated':
--      id, location_id, period_end, period_start, status
--    and NO anon rows.
-- 2. Inheritance-aware spot check (the information_schema views miss it):
--      SELECT has_column_privilege('authenticated','public.rosters',
--                                  'projected_contractor_eur','SELECT'),
--             has_column_privilege('authenticated','public.rosters',
--                                  'budget_at_publish_eur','SELECT'),
--             has_column_privilege('authenticated','public.rosters',
--                                  'status','SELECT');
--    EXPECT false, false, true.
-- 3. One permissive policy per (table, command), no FOR ALL:
--      SELECT tablename, cmd, count(*) FROM pg_policies
--       WHERE schemaname='public' AND tablename='strap_assignments'
--       GROUP BY 1,2 ORDER BY 1,2;
--    EXPECT four rows, count 1 each, none with cmd='ALL'.
-- 4. `get_advisors` (security AND performance) — expect no NEW warning. The
--    two pre-existing SECURITY DEFINER WARNs are unrelated (see
--    advisor-rls-permissive-consolidation).
-- Then smoke the mobile Today tab as a plain coach: shifts still list, each
-- row still shows as published. That read is the embed in CONSUMERS above.

BEGIN;

-- ---------------------------------------------------------------------------
-- FINDING 1 — rosters: table-level REVOKE, then a column-level GRANT.
-- Order matters. The GRANT only binds because the table-level SELECT is gone
-- (mig 153 → 153b).
-- ---------------------------------------------------------------------------
REVOKE SELECT ON public.rosters FROM authenticated;
REVOKE SELECT ON public.rosters FROM anon;

GRANT SELECT (id, location_id, period_start, period_end, status)
  ON public.rosters TO authenticated;

COMMENT ON COLUMN public.rosters.projected_contractor_eur IS
  'Manager-only (mig 618): no SELECT grant for authenticated/anon. Serve via a service-role route, and name your columns on any read that crosses into a client component.';
COMMENT ON COLUMN public.rosters.budget_at_publish_eur IS
  'Manager-only (mig 618): no SELECT grant for authenticated/anon. Serve via a service-role route, and name your columns on any read that crosses into a client component.';

-- ---------------------------------------------------------------------------
-- FINDING 2a — strap_assignments: the role at the BRIDGE's location.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.auth_is_manager_at_bridge(p_ble_bridge_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.ble_bridges b
    WHERE b.id = p_ble_bridge_id
      AND private.auth_is_manager_at(b.location_id)
  )
$$;

REVOKE ALL ON FUNCTION private.auth_is_manager_at_bridge(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.auth_is_manager_at_bridge(uuid) TO authenticated;

DROP POLICY IF EXISTS "strap_assignments_read" ON public.strap_assignments;
DROP POLICY IF EXISTS "strap_assignments_ins" ON public.strap_assignments;
DROP POLICY IF EXISTS "strap_assignments_upd" ON public.strap_assignments;
DROP POLICY IF EXISTS "strap_assignments_del" ON public.strap_assignments;

-- Read: a manager at the bridge's location, the strap's own contact, or any
-- member of the bridge's location (that third branch is mig 320's, unchanged —
-- it is what makes the pairing screen work for the coach running the class).
CREATE POLICY "strap_assignments_read" ON public.strap_assignments
  FOR SELECT TO authenticated
  USING (
    private.auth_is_manager_at_bridge(ble_bridge_id)
    OR contact_id = private.auth_contact_id()
    OR EXISTS (
      SELECT 1 FROM public.ble_bridges b
      WHERE b.id = strap_assignments.ble_bridge_id
        AND private.auth_is_in_location(b.location_id)
    )
  );

CREATE POLICY "strap_assignments_ins" ON public.strap_assignments
  FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_manager_at_bridge(ble_bridge_id));

CREATE POLICY "strap_assignments_upd" ON public.strap_assignments
  FOR UPDATE TO authenticated
  USING (private.auth_is_manager_at_bridge(ble_bridge_id))
  WITH CHECK (private.auth_is_manager_at_bridge(ble_bridge_id));

CREATE POLICY "strap_assignments_del" ON public.strap_assignments
  FOR DELETE TO authenticated
  USING (private.auth_is_manager_at_bridge(ble_bridge_id));

-- ---------------------------------------------------------------------------
-- Self-checks. The grant assertion reads column_privileges, never this file's
-- own text (mig 153's lesson: the migration said REVOKE and the catalog said
-- otherwise). The profiles check is a NOTICE on purpose — see FINDING 2b.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  leaked text;
  granted text;
  anon_cols int;
  profiles_grants int;
BEGIN
  SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO leaked
  FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'rosters'
    AND privilege_type = 'SELECT' AND grantee IN ('authenticated', 'anon')
    AND column_name NOT IN ('id', 'location_id', 'period_start', 'period_end', 'status');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'RLSSCOPE.2: rosters still readable by authenticated/anon on: %', leaked;
  END IF;

  SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO granted
  FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'rosters'
    AND privilege_type = 'SELECT' AND grantee = 'authenticated';
  IF granted IS DISTINCT FROM 'id, location_id, period_end, period_start, status' THEN
    RAISE EXCEPTION 'RLSSCOPE.2: unexpected rosters column grant for authenticated: %', coalesce(granted, '(none)');
  END IF;

  SELECT count(*) INTO anon_cols
  FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'rosters'
    AND privilege_type = 'SELECT' AND grantee = 'anon';
  IF anon_cols > 0 THEN
    RAISE EXCEPTION 'RLSSCOPE.2: anon still holds % SELECT column grant(s) on rosters', anon_cols;
  END IF;

  -- Inheritance-aware — information_schema does not follow role membership.
  -- Review finding: the catalog query above filters on the two role NAMES, so
  -- a PUBLIC or inherited grant would slip past it for every withheld column.
  -- The budget pair carried that cover; `notes` and the approver stand for the
  -- rest, so no withheld column rests on the catalog query alone.
  IF has_column_privilege('authenticated', 'public.rosters', 'projected_contractor_eur', 'SELECT')
     OR has_column_privilege('authenticated', 'public.rosters', 'budget_at_publish_eur', 'SELECT')
     OR has_column_privilege('authenticated', 'public.rosters', 'notes', 'SELECT')
     OR has_column_privilege('authenticated', 'public.rosters', 'over_budget_approval_by', 'SELECT') THEN
    RAISE EXCEPTION 'RLSSCOPE.2: a withheld column is still reachable by authenticated (role inheritance?)';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.rosters', 'status', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.rosters', 'id', 'SELECT') THEN
    RAISE EXCEPTION 'RLSSCOPE.2: the dashboard embed (rosters.id/status) lost its grant';
  END IF;

  SELECT count(*) INTO profiles_grants
  FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'profiles'
    AND privilege_type = 'SELECT' AND grantee IN ('authenticated', 'anon');
  IF profiles_grants > 0 THEN
    RAISE NOTICE 'RLSSCOPE.2: SELECT on public.profiles has been re-granted to authenticated/anon (% column grant(s)). profiles_select still checks the GLOBAL role via private.auth_can_view_all_profiles() and is now reachable — narrow it. See mig 618 FINDING 2b.', profiles_grants;
  END IF;

  RAISE NOTICE 'RLSSCOPE.2 mig 618: rosters budget columns revoked from authenticated + anon; strap_assignments scoped to the role at the bridge''s location.';
END $$;

COMMIT;
