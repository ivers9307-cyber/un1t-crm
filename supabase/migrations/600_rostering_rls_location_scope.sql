-- ROSTER-FIX.2 — leave, allowances and templates were role-scoped GLOBALLY:
-- `private.auth_is_admin_or_head_coach()` / `auth_is_owner_or_manager()` read
-- `profiles.role`, not the row's location, so a manager at one studio could
-- read (and update) every studio's rows straight from the browser client.
-- Routes use service-role and already fence in code (ROSTER-FIX.2b/2c);
-- this makes the browser-side fence match.
--
-- Shape rules (memory `rls-restrictive-for-all-kills-select`, CLAUDE.md):
--   * PERMISSIVE only — never RESTRICTIVE.
--   * per-command — never FOR ALL (it covers SELECT and folds the read policy
--     away, which fails silently as an empty set).
--   * ONE permissive policy per (table, command); `auth.uid()` wrapped in
--     `(SELECT auth.uid())` for per-query eval (advisor `auth_rls_initplan`).
--   * `private.auth_is_manager_at(uuid)` and `private.auth_is_in_location(uuid)`
--     both already return true for a master (mig 051), so masters keep
--     estate-wide access without a special case. Both live in the `private`
--     schema, NOT `public`.
--
-- PRE-APPLY CHECKS (run read-only BEFORE applying; the DROP names below were
-- read out of migs 010/048/320 and must match what is actually on the box):
--
--   SELECT tablename, policyname, cmd, permissive
--     FROM pg_policies
--    WHERE tablename IN ('time_off_requests','staff_allowances','shift_templates')
--    ORDER BY 1,2;
--     Expected (net of migs 010, 011, 048, 050, 109, 320):
--       shift_templates      "Authenticated can view shift templates" SELECT
--       shift_templates      shift_templates_ins / _upd / _del
--       staff_allowances     staff_allowances_select / _ins / _upd / _del
--       time_off_requests    "Staff can create own time off"  INSERT
--       time_off_requests    time_off_requests_select / time_off_requests_update
--     Every one PERMISSIVE. If a name differs, fix the DROP here first — a
--     stale DROP leaves the OLD global policy in place beside the new one and
--     RLS ORs permissive policies, so the leak simply survives.
--
--   SELECT count(*) FROM public.shift_templates st
--    WHERE NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = st.location_id);
--     Expected 0 — a template with a null/dangling location_id becomes
--     invisible to every browser caller under the new SELECT policy.
--
--   SELECT count(*) FROM public.staff_allowances sa
--    WHERE NOT EXISTS (SELECT 1 FROM public.profile_locations pl
--                       WHERE pl.profile_id = sa.profile_id);
--     Expected 0 — an allowance for a profile with no location link would be
--     readable only by the profile themselves after this migration.
--
--   SELECT count(*) FROM public.time_off_requests t
--    WHERE NOT EXISTS (SELECT 1 FROM public.profile_locations pl WHERE pl.profile_id = t.profile_id);
--   -- expect 0; if not, link those profiles before applying
--     Not cosmetic: `update_holiday_allowance` (mig 011, re-created in mig 021)
--     is a plain SECURITY INVOKER trigger, so its
--     `INSERT INTO public.staff_allowances … ON CONFLICT` runs as the person
--     clicking Approve and is judged by `staff_allowances_ins` below — which
--     requires a `profile_locations` row for the REQUESTER. A profile with no
--     location link therefore fails that WITH CHECK, and because a trigger
--     error aborts its statement the whole approval UPDATE rolls back on the
--     BROWSER path. (The /api approval route is service-role and unaffected,
--     which is exactly why this would only show up in an operator's face.)
--
-- AFTER APPLYING: `get_advisors` (type=security) — expect no NEW warning —
-- then `npm run test:cross-tenant`.

BEGIN;

-- ---------------------------------------------------------------------------
-- time_off_requests — own rows, or manager at the ROW's location.
-- INSERT ("Staff can create own time off", mig 048) is already own-row and
-- stays exactly as it is.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "time_off_requests_select" ON public.time_off_requests;
CREATE POLICY "time_off_requests_select" ON public.time_off_requests
  FOR SELECT TO authenticated
  USING (
    profile_id = (SELECT auth.uid())
    OR private.auth_is_manager_at(location_id)
  );

DROP POLICY IF EXISTS "time_off_requests_update" ON public.time_off_requests;
CREATE POLICY "time_off_requests_update" ON public.time_off_requests
  FOR UPDATE TO authenticated
  USING (
    private.auth_is_manager_at(location_id)
    OR (profile_id = (SELECT auth.uid()) AND status = 'pending'::text)
  )
  WITH CHECK (
    private.auth_is_manager_at(location_id)
    OR status = 'cancelled'::text
  );

-- ---------------------------------------------------------------------------
-- staff_allowances — no location column, so scope through profile_locations:
-- in scope when the caller manages ANY location the target profile belongs to.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "staff_allowances_select" ON public.staff_allowances;
DROP POLICY IF EXISTS "staff_allowances_ins" ON public.staff_allowances;
DROP POLICY IF EXISTS "staff_allowances_upd" ON public.staff_allowances;
DROP POLICY IF EXISTS "staff_allowances_del" ON public.staff_allowances;

CREATE POLICY "staff_allowances_select" ON public.staff_allowances
  FOR SELECT TO authenticated
  USING (
    profile_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = staff_allowances.profile_id
        AND private.auth_is_manager_at(pl.location_id)
    )
  );

CREATE POLICY "staff_allowances_ins" ON public.staff_allowances
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = staff_allowances.profile_id
        AND private.auth_is_manager_at(pl.location_id)
    )
  );

CREATE POLICY "staff_allowances_upd" ON public.staff_allowances
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = staff_allowances.profile_id
        AND private.auth_is_manager_at(pl.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = staff_allowances.profile_id
        AND private.auth_is_manager_at(pl.location_id)
    )
  );

CREATE POLICY "staff_allowances_del" ON public.staff_allowances
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = staff_allowances.profile_id
        AND private.auth_is_manager_at(pl.location_id)
    )
  );

-- ---------------------------------------------------------------------------
-- shift_templates — the SELECT policy was `USING (true)` for every
-- authenticated user (mig 010), i.e. every studio's shift pattern readable by
-- anyone with a login. Scope reads to the caller's locations and writes to a
-- manager AT that location.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated can view shift templates" ON public.shift_templates;
DROP POLICY IF EXISTS "shift_templates_select" ON public.shift_templates;
DROP POLICY IF EXISTS "shift_templates_ins" ON public.shift_templates;
DROP POLICY IF EXISTS "shift_templates_upd" ON public.shift_templates;
DROP POLICY IF EXISTS "shift_templates_del" ON public.shift_templates;

CREATE POLICY "shift_templates_select" ON public.shift_templates
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

CREATE POLICY "shift_templates_ins" ON public.shift_templates
  FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_manager_at(location_id));

CREATE POLICY "shift_templates_upd" ON public.shift_templates
  FOR UPDATE TO authenticated
  USING (private.auth_is_manager_at(location_id))
  WITH CHECK (private.auth_is_manager_at(location_id));

CREATE POLICY "shift_templates_del" ON public.shift_templates
  FOR DELETE TO authenticated
  USING (private.auth_is_manager_at(location_id));

COMMIT;
