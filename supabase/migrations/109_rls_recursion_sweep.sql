-- 109_rls_recursion_sweep.sql
--
-- RLS sweep — eliminate the `EXISTS (SELECT FROM profiles ...)`
-- pattern that caused the mig 105 recursion incident, and fix the
-- auth_rls_initplan perf bug on shift_assignments.
--
-- Background
-- ----------
-- 14 policies on 9 tables inline a profiles role-check via:
--   `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = …)`
-- That's the same pattern that caused infinite recursion when the
-- profiles table got an RLS policy referencing itself. Even with
-- the current profiles RLS fixed, the inline pattern is fragile —
-- any future change to profiles' policies has to consider all 14
-- of these. Worse, each row evaluation re-runs the subquery.
--
-- The fix is the pattern established by mig 105: hide the role
-- check inside a SECURITY DEFINER function that bypasses RLS to
-- read profiles directly. The function then becomes the single
-- source of truth for "is this user an X" checks, and policies
-- that delegate to it can never recurse into profiles.
--
-- All required helpers already exist in `private.` from mig 105
-- EXCEPT `auth_is_admin_or_head_coach()` — that's the most common
-- pattern in this batch (owner OR manager OR head_coach), so we
-- add it here.
--
-- This migration also fixes the single auth_rls_initplan issue
-- the advisor flagged: shift_assignments has `profile_id = auth.uid()`
-- (unwrapped) which causes auth.uid() to be re-evaluated per row.
-- The fix is the standard `(SELECT auth.uid())` wrap.
--
-- Why one migration, not 14
-- -------------------------
-- The deferred-items doc suggested one-policy-per-migration as a
-- conservative default. That's right when the new SQL is novel —
-- but here every refactor delegates to a pre-existing, battle-tested
-- helper from mig 105, and every rewrite is semantically identical
-- to the inline EXISTS (which is what the helper does internally).
-- The behavioural surface is zero. We bundle for atomicity: a
-- partially-applied half of this would leave RLS in an inconsistent
-- state that's harder to reason about than "all or nothing".
--
-- Each policy is dropped + recreated inside a single transaction.
-- Rollback is `BEGIN; DROP POLICY ...; CREATE POLICY <inline EXISTS>; COMMIT;`
-- per policy if any one breaks in production.

BEGIN;

-- ── 1. New helper: owner OR manager OR head_coach ────────────────
-- Mirrors the pattern used by the 10 inline-EXISTS policies below.
-- SECURITY DEFINER + STABLE so the planner can hoist the call
-- (this is the same shape as auth_is_owner_or_manager from mig 105).
CREATE OR REPLACE FUNCTION private.auth_is_admin_or_head_coach()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = ANY (ARRAY['owner', 'manager', 'head_coach'])
  );
$$;

REVOKE ALL ON FUNCTION private.auth_is_admin_or_head_coach() FROM public;
GRANT EXECUTE ON FUNCTION private.auth_is_admin_or_head_coach() TO authenticated, service_role;

-- ── 2. company_settings: owner-only manage ───────────────────────
DROP POLICY IF EXISTS "Owners can manage company settings" ON public.company_settings;
CREATE POLICY "Owners can manage company settings" ON public.company_settings
  FOR ALL TO public
  USING (private.auth_is_owner());

-- ── 3. generated_reports: admin/head_coach manage ────────────────
DROP POLICY IF EXISTS "Admins can view generated reports" ON public.generated_reports;
CREATE POLICY "Admins can view generated reports" ON public.generated_reports
  FOR ALL TO public
  USING (private.auth_is_admin_or_head_coach());

-- ── 4. locations: assigned-location SELECT ───────────────────────
-- The existing policy uses an inline subquery on profile_locations.
-- Replace with the existing helper (which is what mig 079 set up).
DROP POLICY IF EXISTS "Users can view assigned locations" ON public.locations;
CREATE POLICY "Users can view assigned locations" ON public.locations
  FOR SELECT TO public
  USING (private.auth_is_in_location(id));

-- ── 5. scheduled_reports: admin/head_coach manage ────────────────
DROP POLICY IF EXISTS "Admins can manage scheduled reports" ON public.scheduled_reports;
CREATE POLICY "Admins can manage scheduled reports" ON public.scheduled_reports
  FOR ALL TO public
  USING (private.auth_is_admin_or_head_coach());

-- ── 6. shift_swap_requests: admin/head_coach manage + view ───────
DROP POLICY IF EXISTS "Managers can manage swap requests" ON public.shift_swap_requests;
CREATE POLICY "Managers can manage swap requests" ON public.shift_swap_requests
  FOR ALL TO public
  USING (private.auth_is_admin_or_head_coach());

DROP POLICY IF EXISTS "Managers can view all swap requests" ON public.shift_swap_requests;
CREATE POLICY "Managers can view all swap requests" ON public.shift_swap_requests
  FOR SELECT TO public
  USING (private.auth_is_admin_or_head_coach());

-- ── 7. shift_templates: admin/head_coach manage ──────────────────
DROP POLICY IF EXISTS "Managers can manage shift templates" ON public.shift_templates;
CREATE POLICY "Managers can manage shift templates" ON public.shift_templates
  FOR ALL TO public
  USING (private.auth_is_admin_or_head_coach());

-- ── 8. shifts: admin/head_coach manage + view all + staff own ────
DROP POLICY IF EXISTS "Managers can manage shifts" ON public.shifts;
CREATE POLICY "Managers can manage shifts" ON public.shifts
  FOR ALL TO public
  USING (private.auth_is_admin_or_head_coach());

DROP POLICY IF EXISTS "Managers can view all shifts" ON public.shifts;
CREATE POLICY "Managers can view all shifts" ON public.shifts
  FOR SELECT TO public
  USING (private.auth_is_admin_or_head_coach());

-- "Staff can view own shifts" — own-row OR (published AND in-location).
-- Replace the EXISTS (FROM profile_locations …) with auth_is_in_location.
DROP POLICY IF EXISTS "Staff can view own shifts" ON public.shifts;
CREATE POLICY "Staff can view own shifts" ON public.shifts
  FOR SELECT TO public
  USING (
    profile_id = (SELECT auth.uid())
    OR (published = true AND private.auth_is_in_location(location_id))
  );

-- ── 9. staff_allowances: admin (owner/manager) manage, +head_coach view ──
-- "Admins can manage allowances" is owner+manager only; helper from mig 105.
DROP POLICY IF EXISTS "Admins can manage allowances" ON public.staff_allowances;
CREATE POLICY "Admins can manage allowances" ON public.staff_allowances
  FOR ALL TO public
  USING (private.auth_is_owner_or_manager());

-- "Admins can view all allowances" includes head_coach.
DROP POLICY IF EXISTS "Admins can view all allowances" ON public.staff_allowances;
CREATE POLICY "Admins can view all allowances" ON public.staff_allowances
  FOR SELECT TO public
  USING (private.auth_is_admin_or_head_coach());

-- ── 10. time_off_requests: admin/head_coach manage + view ────────
DROP POLICY IF EXISTS "Admins can manage time off" ON public.time_off_requests;
CREATE POLICY "Admins can manage time off" ON public.time_off_requests
  FOR UPDATE TO public
  USING (private.auth_is_admin_or_head_coach());

DROP POLICY IF EXISTS "Admins can view all time off" ON public.time_off_requests;
CREATE POLICY "Admins can view all time off" ON public.time_off_requests
  FOR SELECT TO public
  USING (private.auth_is_admin_or_head_coach());

-- ── 11. shift_assignments: fix auth_rls_initplan (audit advisor) ─
-- The existing policy has `profile_id = auth.uid()` which causes
-- auth.uid() to be re-evaluated per row. Wrap in (SELECT …) to
-- promote it to an InitPlan that runs once.
DROP POLICY IF EXISTS "shift_assignments readable" ON public.shift_assignments;
CREATE POLICY "shift_assignments readable" ON public.shift_assignments
  FOR SELECT TO public
  USING (
    private.auth_is_master()
    OR profile_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.shift_blocks b
      WHERE b.id = shift_assignments.block_id
        AND private.auth_is_in_location(b.location_id)
    )
  );

COMMIT;

-- Post-migration smoke tests can be run with:
--   SELECT private.auth_is_admin_or_head_coach();
--   SELECT private.auth_is_owner();
--   SELECT private.auth_is_in_location('<a-location-uuid>');
-- Each should return boolean without raising. The advisor pass should
-- show 0 unindexed_foreign_keys (mig 108) and 0 auth_rls_initplan
-- after this migration.
