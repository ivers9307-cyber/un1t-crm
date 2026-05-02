-- ============================================================
-- 048: Perf — RLS auth.uid() InitPlan rewrite + cleanups
--
-- Four classes of fix, all forward-only and semantics-preserving:
--
-- 1. Postgres re-evaluates `auth.<fn>()` once per row when
--    called bare. Wrapping as `(SELECT auth.<fn>())` lets the
--    planner evaluate it once per query as an InitPlan. At
--    9-row scale this is invisible; at 100k rows it costs
--    measurable wall time on every authenticated query.
--    Rewriting the 23 affected policies here.
--
-- 2. The `Users can view assigned locations` policy had
--    `pl.location_id = pl.id` (typo). Should match the outer
--    `locations.id`. Currently dormant because every API route
--    uses service_role (which bypasses RLS) — but it would
--    silently break any future direct-from-client query against
--    `locations` from a Supabase JS user-JWT context.
--
-- 3. Drop the duplicate `sequence_enrollments_status_idx`
--    index — identical to `idx_enrollments_status`.
--
-- 4. Pin `search_path` on `private.bump_xero_refresh_ts` so the
--    function isn't vulnerable to schema-resolution shenanigans.
--
-- All policy CHANGES preserve original semantics — DROP +
-- CREATE with identical role/qual logic, just InitPlan-friendly.
-- ============================================================

BEGIN;

-- profiles
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
CREATE POLICY "Admins can view all profiles"
  ON public.profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role = ANY (ARRAY['owner','manager','head_coach'])
    )
  );

DROP POLICY IF EXISTS "Admins can manage profiles" ON public.profiles;
CREATE POLICY "Admins can manage profiles"
  ON public.profiles FOR ALL
  USING (private.get_user_role((SELECT auth.uid())) = 'owner');

-- profile_locations
DROP POLICY IF EXISTS "Users can view own location assignments" ON public.profile_locations;
CREATE POLICY "Users can view own location assignments"
  ON public.profile_locations FOR SELECT
  USING (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Owners can manage location assignments" ON public.profile_locations;
CREATE POLICY "Owners can manage location assignments"
  ON public.profile_locations FOR ALL
  USING (private.get_user_role((SELECT auth.uid())) = 'owner');

-- locations (also fixes pl.location_id = pl.id bug)
DROP POLICY IF EXISTS "Users can view assigned locations" ON public.locations;
CREATE POLICY "Users can view assigned locations"
  ON public.locations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.location_id = locations.id
        AND pl.profile_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Owners and masters can manage locations" ON public.locations;
CREATE POLICY "Owners and masters can manage locations"
  ON public.locations FOR ALL
  USING (
    private.auth_is_master()
    OR private.get_user_role((SELECT auth.uid())) = 'owner'
  )
  WITH CHECK (
    private.auth_is_master()
    OR private.get_user_role((SELECT auth.uid())) = 'owner'
  );

-- company_settings
DROP POLICY IF EXISTS "Owners can manage company settings" ON public.company_settings;
CREATE POLICY "Owners can manage company settings"
  ON public.company_settings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'owner'
    )
  );

-- generated_reports
DROP POLICY IF EXISTS "Admins can view generated reports" ON public.generated_reports;
CREATE POLICY "Admins can view generated reports"
  ON public.generated_reports FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = ANY (ARRAY['owner','manager','head_coach'])
    )
  );

-- scheduled_reports
DROP POLICY IF EXISTS "Admins can manage scheduled reports" ON public.scheduled_reports;
CREATE POLICY "Admins can manage scheduled reports"
  ON public.scheduled_reports FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = ANY (ARRAY['owner','manager','head_coach'])
    )
  );

-- schedule_notifications
DROP POLICY IF EXISTS "Users can view own notifications" ON public.schedule_notifications;
CREATE POLICY "Users can view own notifications"
  ON public.schedule_notifications FOR SELECT
  USING (profile_id = (SELECT auth.uid()));

-- shifts
DROP POLICY IF EXISTS "Staff can view own shifts" ON public.shifts;
CREATE POLICY "Staff can view own shifts"
  ON public.shifts FOR SELECT
  USING (
    profile_id = (SELECT auth.uid())
    OR (
      published = true
      AND EXISTS (
        SELECT 1 FROM public.profile_locations pl
        WHERE pl.profile_id = (SELECT auth.uid())
          AND pl.location_id = shifts.location_id
      )
    )
  );

DROP POLICY IF EXISTS "Managers can view all shifts" ON public.shifts;
CREATE POLICY "Managers can view all shifts"
  ON public.shifts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role = ANY (ARRAY['owner','manager','head_coach'])
    )
  );

DROP POLICY IF EXISTS "Managers can manage shifts" ON public.shifts;
CREATE POLICY "Managers can manage shifts"
  ON public.shifts FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role = ANY (ARRAY['owner','manager','head_coach'])
    )
  );

-- shift_templates
DROP POLICY IF EXISTS "Managers can manage shift templates" ON public.shift_templates;
CREATE POLICY "Managers can manage shift templates"
  ON public.shift_templates FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role = ANY (ARRAY['owner','manager','head_coach'])
    )
  );

-- shift_swap_requests
DROP POLICY IF EXISTS "Staff can view own swap requests" ON public.shift_swap_requests;
CREATE POLICY "Staff can view own swap requests"
  ON public.shift_swap_requests FOR SELECT
  USING (
    requester_id = (SELECT auth.uid())
    OR target_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "Staff can create swap requests" ON public.shift_swap_requests;
CREATE POLICY "Staff can create swap requests"
  ON public.shift_swap_requests FOR INSERT
  WITH CHECK (requester_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Managers can view all swap requests" ON public.shift_swap_requests;
CREATE POLICY "Managers can view all swap requests"
  ON public.shift_swap_requests FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role = ANY (ARRAY['owner','manager','head_coach'])
    )
  );

DROP POLICY IF EXISTS "Managers can manage swap requests" ON public.shift_swap_requests;
CREATE POLICY "Managers can manage swap requests"
  ON public.shift_swap_requests FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role = ANY (ARRAY['owner','manager','head_coach'])
    )
  );

-- time_off_requests
DROP POLICY IF EXISTS "Staff can view own time off" ON public.time_off_requests;
CREATE POLICY "Staff can view own time off"
  ON public.time_off_requests FOR SELECT
  USING (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff can create own time off" ON public.time_off_requests;
CREATE POLICY "Staff can create own time off"
  ON public.time_off_requests FOR INSERT
  WITH CHECK (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff can cancel own pending time off" ON public.time_off_requests;
CREATE POLICY "Staff can cancel own pending time off"
  ON public.time_off_requests FOR UPDATE
  USING (
    profile_id = (SELECT auth.uid())
    AND status = 'pending'
  )
  WITH CHECK (status = 'cancelled');

DROP POLICY IF EXISTS "Admins can view all time off" ON public.time_off_requests;
CREATE POLICY "Admins can view all time off"
  ON public.time_off_requests FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = ANY (ARRAY['owner','manager','head_coach'])
    )
  );

DROP POLICY IF EXISTS "Admins can manage time off" ON public.time_off_requests;
CREATE POLICY "Admins can manage time off"
  ON public.time_off_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = ANY (ARRAY['owner','manager','head_coach'])
    )
  );

-- staff_allowances
DROP POLICY IF EXISTS "Staff can view own allowances" ON public.staff_allowances;
CREATE POLICY "Staff can view own allowances"
  ON public.staff_allowances FOR SELECT
  USING (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Admins can view all allowances" ON public.staff_allowances;
CREATE POLICY "Admins can view all allowances"
  ON public.staff_allowances FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = ANY (ARRAY['owner','manager','head_coach'])
    )
  );

DROP POLICY IF EXISTS "Admins can manage allowances" ON public.staff_allowances;
CREATE POLICY "Admins can manage allowances"
  ON public.staff_allowances FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = ANY (ARRAY['owner','manager'])
    )
  );

-- impersonation_log
DROP POLICY IF EXISTS impersonation_log_select ON public.impersonation_log;
CREATE POLICY impersonation_log_select
  ON public.impersonation_log FOR SELECT
  USING (
    private.auth_is_master()
    OR target_user_id = (SELECT auth.uid())
  );

-- Drop duplicate index (sequence_enrollments has two identical indexes on `status`)
DROP INDEX IF EXISTS public.sequence_enrollments_status_idx;

-- Pin search_path on the trigger function
ALTER FUNCTION private.bump_xero_refresh_ts() SET search_path = '';

COMMIT;
