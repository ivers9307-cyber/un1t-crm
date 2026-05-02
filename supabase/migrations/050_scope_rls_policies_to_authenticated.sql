-- ============================================================
-- 050: Scope RLS policies back to authenticated
--
-- Migration 048 recreated policies via DROP + CREATE POLICY
-- without an explicit `TO authenticated` clause, which defaulted
-- them to PUBLIC. PUBLIC expands to 5 roles (anon, authenticated,
-- authenticator, dashboard_user, supabase_privileged_role) and
-- the Supabase perf advisor counts the multiple_permissive_policies
-- lint once per role — so dropping back to PUBLIC quietly inflated
-- those lints from 36 to 64.
--
-- Semantically, this is a tightening: anon's `auth.uid()` returns
-- NULL so every policy already rejected anon access, and the
-- service_role bypasses RLS entirely. Tightening to `authenticated`
-- is a no-op for behaviour but cuts advisor noise and saves the
-- planner from evaluating the policy quals against roles that
-- can never satisfy them.
-- ============================================================

BEGIN;

ALTER POLICY "Users can view own profile"          ON public.profiles TO authenticated;
ALTER POLICY "Users can update own profile"        ON public.profiles TO authenticated;
ALTER POLICY "Admins can view all profiles"        ON public.profiles TO authenticated;
ALTER POLICY "Admins can manage profiles"          ON public.profiles TO authenticated;

ALTER POLICY "Users can view own location assignments" ON public.profile_locations TO authenticated;
ALTER POLICY "Owners can manage location assignments"  ON public.profile_locations TO authenticated;

ALTER POLICY "Users can view assigned locations"   ON public.locations TO authenticated;
ALTER POLICY "Owners and masters can manage locations" ON public.locations TO authenticated;

ALTER POLICY "Owners can manage company settings"  ON public.company_settings TO authenticated;

ALTER POLICY "Admins can view generated reports"   ON public.generated_reports TO authenticated;

ALTER POLICY "Admins can manage scheduled reports" ON public.scheduled_reports TO authenticated;

ALTER POLICY "Users can view own notifications"    ON public.schedule_notifications TO authenticated;

ALTER POLICY "Staff can view own shifts"           ON public.shifts TO authenticated;
ALTER POLICY "Managers can view all shifts"        ON public.shifts TO authenticated;
ALTER POLICY "Managers can manage shifts"          ON public.shifts TO authenticated;

ALTER POLICY "Managers can manage shift templates" ON public.shift_templates TO authenticated;

ALTER POLICY "Staff can view own swap requests"    ON public.shift_swap_requests TO authenticated;
ALTER POLICY "Staff can create swap requests"      ON public.shift_swap_requests TO authenticated;
ALTER POLICY "Managers can view all swap requests" ON public.shift_swap_requests TO authenticated;
ALTER POLICY "Managers can manage swap requests"   ON public.shift_swap_requests TO authenticated;

ALTER POLICY "Staff can view own time off"         ON public.time_off_requests TO authenticated;
ALTER POLICY "Staff can create own time off"       ON public.time_off_requests TO authenticated;
ALTER POLICY "Staff can cancel own pending time off" ON public.time_off_requests TO authenticated;
ALTER POLICY "Admins can view all time off"        ON public.time_off_requests TO authenticated;
ALTER POLICY "Admins can manage time off"          ON public.time_off_requests TO authenticated;

ALTER POLICY "Staff can view own allowances"       ON public.staff_allowances TO authenticated;
ALTER POLICY "Admins can view all allowances"      ON public.staff_allowances TO authenticated;
ALTER POLICY "Admins can manage allowances"        ON public.staff_allowances TO authenticated;

ALTER POLICY impersonation_log_select              ON public.impersonation_log TO authenticated;

COMMIT;
