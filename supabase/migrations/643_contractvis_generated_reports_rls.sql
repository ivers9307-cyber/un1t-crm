-- 643 — CONTRACTVIS.1: generated reports that carry pay rates or a colleague's
-- contracted hours are readable (and writable) from the BROWSER by owner /
-- manager / master at the report's studio only.
--
-- APPLY RIGHT AFTER THE CONTRACTVIS.1 CODE DEPLOYS. Order does not matter for
-- correctness (no app code reads or writes this table from the browser), but
-- after the deploy keeps one story: the app gate and the database gate land
-- together.
--
-- WHY
-- ───
-- Richard, 27 Sep: a colleague's contracted hours go to owner / manager /
-- master only, everywhere. The app layer now keeps `utilisation` (per-person
-- contracted hours and a percentage of them) from head coaches, as STAFFCOST.1
-- did for `staff_cost` (rates and cost): src/lib/report-access.js
-- RATE_REPORT_TYPES. But every route is service-role; the browser's client is
-- bound only by RLS, and mig 614 set every generated_reports policy to
-- private.auth_is_manager_at(location_id), which INCLUDES head_coach. With the
-- public anon key and their own session, a head coach could
-- `select * from generated_reports` and read both report types at their studio.
-- No app code reads or writes this table from the browser (only /api routes and
-- src/lib/report-generator.js, all service-role), so narrowing breaks nothing.
--
-- WHAT
-- ────
-- One permissive policy per command (CLAUDE.md), each:
--   auth_is_manager_at(location_id)
--   AND (report_type NOT IN ('staff_cost','utilisation') OR auth_is_admin_at(location_id))
-- auth_is_admin_at = master, or owner/manager at the location, active and not
-- tombstoned (mig 626). Keep the type list equal to RATE_REPORT_TYPES
-- (tests/migration-643-contractvis-generated-reports-rls.test.js pins it); a
-- new admin-only type needs a migration like this one.
--
-- Out of scope, on purpose: scheduled_reports (mig 614) still lets a head
-- coach's browser read staff_cost SCHEDULE rows. Those hold recipient
-- addresses, not figures.
--
-- ROLLBACK: re-create the four mig-614 policies (614_coach_roster_read_scope.sql
-- "generated_reports_*"), i.e. the same four with only
-- private.auth_is_manager_at(location_id).

BEGIN;

DROP POLICY IF EXISTS "generated_reports_select" ON public.generated_reports;
DROP POLICY IF EXISTS "generated_reports_ins" ON public.generated_reports;
DROP POLICY IF EXISTS "generated_reports_upd" ON public.generated_reports;
DROP POLICY IF EXISTS "generated_reports_del" ON public.generated_reports;

CREATE POLICY "generated_reports_select" ON public.generated_reports
  FOR SELECT TO authenticated
  USING (
    private.auth_is_manager_at(location_id)
    AND (report_type NOT IN ('staff_cost', 'utilisation') OR private.auth_is_admin_at(location_id))
  );
CREATE POLICY "generated_reports_ins" ON public.generated_reports
  FOR INSERT TO authenticated
  WITH CHECK (
    private.auth_is_manager_at(location_id)
    AND (report_type NOT IN ('staff_cost', 'utilisation') OR private.auth_is_admin_at(location_id))
  );
CREATE POLICY "generated_reports_upd" ON public.generated_reports
  FOR UPDATE TO authenticated
  USING (
    private.auth_is_manager_at(location_id)
    AND (report_type NOT IN ('staff_cost', 'utilisation') OR private.auth_is_admin_at(location_id))
  )
  WITH CHECK (
    private.auth_is_manager_at(location_id)
    AND (report_type NOT IN ('staff_cost', 'utilisation') OR private.auth_is_admin_at(location_id))
  );
CREATE POLICY "generated_reports_del" ON public.generated_reports
  FOR DELETE TO authenticated
  USING (
    private.auth_is_manager_at(location_id)
    AND (report_type NOT IN ('staff_cost', 'utilisation') OR private.auth_is_admin_at(location_id))
  );

-- Self-check (reads the POST-state; a failure aborts the whole file): the
-- table still has RLS on, exactly these four policies exist on it, every one
-- is permissive, and every one names auth_is_admin_at in each clause it has.
DO $$
DECLARE
  n_narrowed int;
  n_total int;
  rls_on boolean;
BEGIN
  SELECT c.relrowsecurity INTO rls_on
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relname = 'generated_reports';
  IF rls_on IS NOT TRUE THEN
    RAISE EXCEPTION 'CONTRACTVIS.1: RLS is not enabled on public.generated_reports';
  END IF;

  SELECT count(*) INTO n_total
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'generated_reports';

  SELECT count(*) INTO n_narrowed
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'generated_reports'
    AND policyname IN ('generated_reports_select', 'generated_reports_ins', 'generated_reports_upd', 'generated_reports_del')
    AND permissive = 'PERMISSIVE'
    AND (qual IS NULL OR qual LIKE '%auth_is_admin_at%')
    AND (with_check IS NULL OR with_check LIKE '%auth_is_admin_at%');

  IF n_narrowed <> 4 OR n_total <> 4 THEN
    RAISE EXCEPTION 'CONTRACTVIS.1: expected exactly 4 narrowed generated_reports policies, found % narrowed of % total', n_narrowed, n_total;
  END IF;
END $$;

COMMIT;
