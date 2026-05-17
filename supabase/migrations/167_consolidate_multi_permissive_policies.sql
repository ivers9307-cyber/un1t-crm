-- ============================================================
-- 167: PERF.4 — Consolidate multiple_permissive_policies WARN flags
-- ============================================================
--
-- All 13 perf-advisor multiple_permissive_policies cases were
-- legitimate "customer can see own data" + "staff can see customer
-- data at their location" pairs, or master-or-owner pairs. Postgres
-- evaluates BOTH on every query — replacing with a single permissive
-- policy that OR's the conditions is functionally identical and
-- roughly halves the per-query RLS cost.
--
-- Policy NAMES kept descriptive of the union ("contact_devices_read"
-- rather than "Customers or staff can read devices") so a future
-- operator reading pg_policies sees the per-cmd shape rather than
-- the role split.
--
-- Tables touched:
--   contact_achievements         (SELECT: 2 → 1)
--   contact_devices              (SELECT/INSERT/UPDATE/DELETE: 2 → 1 each)
--   contact_external_integrations (SELECT: 2 → 1)
--   heart_rate_sessions          (SELECT: 2 → 1)
--   strap_assignments            (SELECT: 2 → 1)
--   shifts                       (SELECT: drop redundant Managers-view-all;
--                                  Managers-manage ALL already covers SELECT)
--   contracts                    (SELECT: 3 → 1, ALL: 2 → 1)
--   contract_templates           (ALL: 2 → 1)
--   profiles                     (SELECT: drop separate Admins-view + Users-view-own
--                                  → one combined; Admins-manage ALL stays)
--
-- service_role bypasses RLS so none of this affects cron / webhook /
-- submit endpoints.

BEGIN;

-- contact_achievements
DROP POLICY IF EXISTS "Customers read own achievements" ON public.contact_achievements;
DROP POLICY IF EXISTS "Staff read achievements at their locations" ON public.contact_achievements;
CREATE POLICY "contact_achievements_read" ON public.contact_achievements
  FOR SELECT
  USING (
    contact_id = private.auth_contact_id()
    OR private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_achievements.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

-- contact_devices (4 verbs)
DROP POLICY IF EXISTS "Customers can view own devices" ON public.contact_devices;
DROP POLICY IF EXISTS "Staff can view devices at their locations" ON public.contact_devices;
CREATE POLICY "contact_devices_read" ON public.contact_devices
  FOR SELECT
  USING (
    contact_id = private.auth_contact_id()
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_devices.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

DROP POLICY IF EXISTS "Customers can add own devices" ON public.contact_devices;
DROP POLICY IF EXISTS "Staff can add devices for contacts at their locations" ON public.contact_devices;
CREATE POLICY "contact_devices_insert" ON public.contact_devices
  FOR INSERT
  WITH CHECK (
    contact_id = private.auth_contact_id()
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_devices.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

DROP POLICY IF EXISTS "Customers can update own devices" ON public.contact_devices;
DROP POLICY IF EXISTS "Staff can update devices for contacts at their locations" ON public.contact_devices;
CREATE POLICY "contact_devices_update" ON public.contact_devices
  FOR UPDATE
  USING (
    contact_id = private.auth_contact_id()
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_devices.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  )
  WITH CHECK (
    contact_id = private.auth_contact_id()
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_devices.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

DROP POLICY IF EXISTS "Customers can delete own devices" ON public.contact_devices;
DROP POLICY IF EXISTS "Staff can delete devices for contacts at their locations" ON public.contact_devices;
CREATE POLICY "contact_devices_delete" ON public.contact_devices
  FOR DELETE
  USING (
    contact_id = private.auth_contact_id()
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_devices.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

-- contact_external_integrations
DROP POLICY IF EXISTS "Customers read own integrations" ON public.contact_external_integrations;
DROP POLICY IF EXISTS "Staff read integrations at their locations" ON public.contact_external_integrations;
CREATE POLICY "contact_external_integrations_read" ON public.contact_external_integrations
  FOR SELECT
  USING (
    contact_id = private.auth_contact_id()
    OR private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_external_integrations.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

-- heart_rate_sessions
DROP POLICY IF EXISTS "Customers can view own sessions" ON public.heart_rate_sessions;
DROP POLICY IF EXISTS "Staff can view sessions at their locations" ON public.heart_rate_sessions;
CREATE POLICY "heart_rate_sessions_read" ON public.heart_rate_sessions
  FOR SELECT
  USING (
    contact_id = private.auth_contact_id()
    OR private.auth_is_in_location(location_id)
  );

-- strap_assignments
DROP POLICY IF EXISTS "Customers can view own strap assignments" ON public.strap_assignments;
DROP POLICY IF EXISTS "Staff can view strap assignments" ON public.strap_assignments;
CREATE POLICY "strap_assignments_read" ON public.strap_assignments
  FOR SELECT
  USING (
    contact_id = private.auth_contact_id()
    OR EXISTS (
      SELECT 1 FROM public.ble_bridges b
      WHERE b.id = strap_assignments.ble_bridge_id
        AND private.auth_is_in_location(b.location_id)
    )
  );

-- shifts — drop redundant manager-view-all (Managers-manage ALL covers it)
DROP POLICY IF EXISTS "Managers can view all shifts" ON public.shifts;

-- contracts SELECT
DROP POLICY IF EXISTS "Master reads all contracts" ON public.contracts;
DROP POLICY IF EXISTS "Owner reads org contracts" ON public.contracts;
DROP POLICY IF EXISTS "Recipient reads own contracts" ON public.contracts;
CREATE POLICY "contracts_read" ON public.contracts
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR profile_id = (SELECT auth.uid())
    OR organization_id IN (
      SELECT l.organization_id
      FROM public.profile_locations pl
      JOIN public.locations l ON l.id = pl.location_id
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.role = 'owner'
    )
  );

-- contracts ALL
DROP POLICY IF EXISTS "Master writes contracts" ON public.contracts;
DROP POLICY IF EXISTS "Owner writes org contracts" ON public.contracts;
CREATE POLICY "contracts_write" ON public.contracts
  FOR ALL TO authenticated
  USING (
    private.auth_is_master()
    OR organization_id IN (
      SELECT l.organization_id
      FROM public.profile_locations pl
      JOIN public.locations l ON l.id = pl.location_id
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.role = 'owner'
    )
  )
  WITH CHECK (
    private.auth_is_master()
    OR organization_id IN (
      SELECT l.organization_id
      FROM public.profile_locations pl
      JOIN public.locations l ON l.id = pl.location_id
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.role = 'owner'
    )
  );

-- contract_templates ALL
DROP POLICY IF EXISTS "Master manages all templates" ON public.contract_templates;
DROP POLICY IF EXISTS "Owner manages org templates" ON public.contract_templates;
CREATE POLICY "contract_templates_write" ON public.contract_templates
  FOR ALL TO authenticated
  USING (
    private.auth_is_master()
    OR organization_id IN (
      SELECT l.organization_id
      FROM public.profile_locations pl
      JOIN public.locations l ON l.id = pl.location_id
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.role = 'owner'
    )
  )
  WITH CHECK (
    private.auth_is_master()
    OR organization_id IN (
      SELECT l.organization_id
      FROM public.profile_locations pl
      JOIN public.locations l ON l.id = pl.location_id
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.role = 'owner'
    )
  );

-- profiles SELECT
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "profiles_read" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR private.auth_can_view_all_profiles()
  );

COMMIT;
