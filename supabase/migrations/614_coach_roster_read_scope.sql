-- 614 — COACHSCOPE.1: a coach's browser/mobile client reads what the coach
-- screens show, and no more.
--
-- THE FINDING (measured against prod, 17 Sep, read-only, SET LOCAL role
-- authenticated + a real JWT sub)
-- ─────────────────────────────────────────────────────────────────────
-- D1 (Richard's call) says a coach never sees a DRAFT shift. The routes
-- honour it (blocks / shifts filter to published for non-managers) but the
-- RLS underneath did not:
--
--   * plain `staff` at Stillorgan (no manager role anywhere) could read
--     902 shift_blocks, 276 of them on no/unpublished roster, 796
--     shift_assignments (643 of them colleagues'), and all 76 rosters rows
--     WITH their budget columns. "shift_blocks readable in-location" /
--     "shift_assignments readable" / "rosters readable in-location" were
--     membership-only: any role at the location, any roster status.
--   * a `head_coach` at Hatch who is plain `staff` at Stillorgan could read
--     every Stillorgan swap request and all 10 Stillorgan generated_reports
--     (staff hours / staff COST reports) plus the scheduled report — because
--     shift_swap_requests_* and the two reports policies call
--     private.auth_is_admin_or_head_coach(), which reads the GLOBAL
--     profiles.role, not the role at the row's location (same class mig 600
--     fixed for leave, allowances and templates).
--
-- THE FIX
-- ───────
--   shift_blocks      SELECT: manager at the block's location, OR member of
--                     the location AND the block's roster is published.
--   shift_assignments SELECT: manager at the block's location, OR block's
--                     roster is published AND (member of the location OR the
--                     row is the caller's own). A coach's OWN draft
--                     assignment is hidden too — D1 covers "you are rostered"
--                     as much as "who else is".
--   rosters           SELECT: manager at the location, OR member AND status
--                     in (published, superseded). A draft roster row is a
--                     manager's working document and carries the budget
--                     projection.
--   shift_swap_requests  per-location manager (auth_is_manager_at) instead of
--                     the global role; requester/target keep their own rows;
--                     INSERT additionally requires membership of the row's
--                     location. TO authenticated (was TO public).
--   generated_reports / scheduled_reports  the two `FOR ALL TO public`
--                     global-role policies become per-command policies on
--                     auth_is_manager_at(location_id).
--
-- NOT CHANGED, on purpose
--   * INSERT/UPDATE/DELETE on shift_blocks / shift_assignments / rosters —
--     already auth_is_manager_at (mig 320/605).
--   * roster_change_log — already auth_is_manager_at (read only).
--   * Column-level exposure of a PUBLISHED roster's budget to a coach's
--     browser client. RLS cannot hide columns and a column GRANT would need a
--     table-level REVOKE (mig 153b lesson). No browser reader of those
--     columns exists; the one route that serves them (GET
--     /api/schedule/rosters) now strips them for non-managers. Left as a
--     named follow-up rather than done blind.
--
-- CONSUMERS CHECKED (every RLS-bound reader of these tables)
--   * shared/dashboard-data.js fetchPersonalDashboardData (mobile Today /
--     Personal): own assignments !inner shift_blocks, rosters(status) embed,
--     filtered publishedOnly:true — every row it keeps stays visible.
--     Its two shift_swap_requests reads are requester_id / target_id = self.
--   * shared/dashboard-data.js fetchStudioDashboardData (mobile Studio tab,
--     manager/head-coach surface): swaps eq(location_id) — a manager at that
--     location still reads all of them.
--   * Everything else (blocks / shifts / swaps / rosters / reports routes,
--     the approvals provider, web dashboards, fetchTodayOps,
--     fetchUnstaffedBlocksThisWeek) runs on the service-role client and is
--     untouched by RLS.
--   * No realtime subscription on any of these tables.
--
-- SHAPE RULES (CLAUDE.md): PERMISSIVE only; one policy per (table, command);
-- never FOR ALL; `(SELECT auth.uid())`; TO authenticated.
--
-- The visibility predicates live in SECURITY DEFINER helpers so the
-- shift_assignments -> shift_blocks -> rosters chain is evaluated once, by the
-- same rule, without stacking three tables' RLS inside each other.
--
-- PRE-APPLY CHECK (read-only). The DROP names below were read out of
-- pg_policies on prod on 17 Sep; if any differ, fix the DROP first — a stale
-- DROP leaves the old permissive policy beside the new one and RLS ORs them.
--
--   SELECT tablename, policyname, cmd FROM pg_policies
--    WHERE schemaname = 'public'
--      AND tablename IN ('shift_blocks','shift_assignments','rosters',
--                        'shift_swap_requests','generated_reports','scheduled_reports')
--    ORDER BY 1, 3, 2;
--
-- POST-APPLY CHECK: rerun the query above — exactly one policy per
-- (table, command); then `get_advisors` (security + performance) expecting no
-- new warning; then as a staff JWT:
--   SELECT count(*) FROM shift_blocks b LEFT JOIN rosters r ON r.id = b.roster_id
--    WHERE r.status IS DISTINCT FROM 'published';           -- expect 0

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.auth_can_read_shift_block(
  p_location_id uuid,
  p_roster_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.auth_is_manager_at(p_location_id)
  OR (
    private.auth_is_in_location(p_location_id)
    AND EXISTS (
      SELECT 1 FROM public.rosters r
      WHERE r.id = p_roster_id
        AND r.status = 'published'
    )
  )
$$;

CREATE OR REPLACE FUNCTION private.auth_can_read_shift_assignment(
  p_block_id uuid,
  p_profile_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.shift_blocks b
    WHERE b.id = p_block_id
      AND (
        private.auth_is_manager_at(b.location_id)
        OR (
          EXISTS (
            SELECT 1 FROM public.rosters r
            WHERE r.id = b.roster_id
              AND r.status = 'published'
          )
          AND (
            private.auth_is_in_location(b.location_id)
            OR p_profile_id = (SELECT auth.uid())
          )
        )
      )
  )
$$;

REVOKE ALL ON FUNCTION private.auth_can_read_shift_block(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.auth_can_read_shift_assignment(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.auth_can_read_shift_block(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.auth_can_read_shift_assignment(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- shift_blocks — SELECT
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "shift_blocks readable in-location" ON public.shift_blocks;
DROP POLICY IF EXISTS "shift_blocks_select" ON public.shift_blocks;
CREATE POLICY "shift_blocks_select" ON public.shift_blocks
  FOR SELECT TO authenticated
  USING (private.auth_can_read_shift_block(location_id, roster_id));

-- ---------------------------------------------------------------------------
-- shift_assignments — SELECT
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "shift_assignments readable" ON public.shift_assignments;
DROP POLICY IF EXISTS "shift_assignments_select" ON public.shift_assignments;
CREATE POLICY "shift_assignments_select" ON public.shift_assignments
  FOR SELECT TO authenticated
  USING (private.auth_can_read_shift_assignment(block_id, profile_id));

-- ---------------------------------------------------------------------------
-- rosters — SELECT
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "rosters readable in-location" ON public.rosters;
DROP POLICY IF EXISTS "rosters_select" ON public.rosters;
CREATE POLICY "rosters_select" ON public.rosters
  FOR SELECT TO authenticated
  USING (
    private.auth_is_manager_at(location_id)
    OR (
      private.auth_is_in_location(location_id)
      AND status IN ('published', 'superseded')
    )
  );

-- ---------------------------------------------------------------------------
-- shift_swap_requests — role at the ROW's location, not the global role
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "shift_swap_requests_select" ON public.shift_swap_requests;
DROP POLICY IF EXISTS "shift_swap_requests_insert" ON public.shift_swap_requests;
DROP POLICY IF EXISTS "shift_swap_requests_update" ON public.shift_swap_requests;
DROP POLICY IF EXISTS "shift_swap_requests_delete" ON public.shift_swap_requests;

CREATE POLICY "shift_swap_requests_select" ON public.shift_swap_requests
  FOR SELECT TO authenticated
  USING (
    private.auth_is_manager_at(location_id)
    OR requester_id = (SELECT auth.uid())
    OR target_id = (SELECT auth.uid())
  );

CREATE POLICY "shift_swap_requests_insert" ON public.shift_swap_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    private.auth_is_manager_at(location_id)
    OR (
      requester_id = (SELECT auth.uid())
      AND private.auth_is_in_location(location_id)
    )
  );

CREATE POLICY "shift_swap_requests_update" ON public.shift_swap_requests
  FOR UPDATE TO authenticated
  USING (private.auth_is_manager_at(location_id))
  WITH CHECK (private.auth_is_manager_at(location_id));

CREATE POLICY "shift_swap_requests_delete" ON public.shift_swap_requests
  FOR DELETE TO authenticated
  USING (private.auth_is_manager_at(location_id));

-- ---------------------------------------------------------------------------
-- generated_reports / scheduled_reports — FOR ALL global role → per-command,
-- per-location
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can view generated reports" ON public.generated_reports;
DROP POLICY IF EXISTS "generated_reports_select" ON public.generated_reports;
DROP POLICY IF EXISTS "generated_reports_ins" ON public.generated_reports;
DROP POLICY IF EXISTS "generated_reports_upd" ON public.generated_reports;
DROP POLICY IF EXISTS "generated_reports_del" ON public.generated_reports;

CREATE POLICY "generated_reports_select" ON public.generated_reports
  FOR SELECT TO authenticated
  USING (private.auth_is_manager_at(location_id));
CREATE POLICY "generated_reports_ins" ON public.generated_reports
  FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_manager_at(location_id));
CREATE POLICY "generated_reports_upd" ON public.generated_reports
  FOR UPDATE TO authenticated
  USING (private.auth_is_manager_at(location_id))
  WITH CHECK (private.auth_is_manager_at(location_id));
CREATE POLICY "generated_reports_del" ON public.generated_reports
  FOR DELETE TO authenticated
  USING (private.auth_is_manager_at(location_id));

DROP POLICY IF EXISTS "Admins can manage scheduled reports" ON public.scheduled_reports;
DROP POLICY IF EXISTS "scheduled_reports_select" ON public.scheduled_reports;
DROP POLICY IF EXISTS "scheduled_reports_ins" ON public.scheduled_reports;
DROP POLICY IF EXISTS "scheduled_reports_upd" ON public.scheduled_reports;
DROP POLICY IF EXISTS "scheduled_reports_del" ON public.scheduled_reports;

CREATE POLICY "scheduled_reports_select" ON public.scheduled_reports
  FOR SELECT TO authenticated
  USING (private.auth_is_manager_at(location_id));
CREATE POLICY "scheduled_reports_ins" ON public.scheduled_reports
  FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_manager_at(location_id));
CREATE POLICY "scheduled_reports_upd" ON public.scheduled_reports
  FOR UPDATE TO authenticated
  USING (private.auth_is_manager_at(location_id))
  WITH CHECK (private.auth_is_manager_at(location_id));
CREATE POLICY "scheduled_reports_del" ON public.scheduled_reports
  FOR DELETE TO authenticated
  USING (private.auth_is_manager_at(location_id));

COMMIT;
