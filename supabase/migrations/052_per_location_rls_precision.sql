-- ============================================================
-- 052: Tighten RLS for per-location precision (Phase 2)
--
-- Now that profile_locations.role exists (mig 051) and the new
-- per-location helpers (auth_is_owner_at, auth_is_admin_at,
-- auth_is_manager_at) are available, the policies that currently
-- use the global helpers (`get_user_role`, `auth_is_owner`,
-- `auth_is_owner_or_manager`) need to switch to per-location
-- semantics.
--
-- Without this, an owner-at-Hatch could (via direct DB access on the
-- authenticated channel) modify pipeline_stages, webhook_subscriptions,
-- or locations rows belonging to Stillorgan. Currently dormant
-- because every API route uses service_role, but defence-in-depth.
--
-- Policies adjusted:
--   pipeline_stages_admin_write       — admin-at-this-location
--   webhook_subscriptions_admin_select — admin-at-this-location
--   webhook_subscriptions_owner_write  — owner-at-this-location
--   profile_locations "Owners can manage location assignments"
--                                      — owner-at-target-location
--   locations "Owners and masters can manage locations"
--                                      — master OR owner-at-THIS-location
--   profiles "Admins can manage profiles"
--                                      — master only
--                                        (per-location ownership of a
--                                        user-level row doesn't have a
--                                        clean RLS expression; API
--                                        routes enforce per-location
--                                        authorization via service role)
-- ============================================================

BEGIN;

-- pipeline_stages — admin at THIS row's location
DROP POLICY IF EXISTS pipeline_stages_admin_write ON public.pipeline_stages;
CREATE POLICY pipeline_stages_admin_write
  ON public.pipeline_stages FOR ALL
  TO authenticated
  USING (private.auth_is_admin_at(location_id))
  WITH CHECK (private.auth_is_admin_at(location_id));

-- webhook_subscriptions — admin read / owner write at THIS row's location
DROP POLICY IF EXISTS webhook_subscriptions_admin_select ON public.webhook_subscriptions;
CREATE POLICY webhook_subscriptions_admin_select
  ON public.webhook_subscriptions FOR SELECT
  TO authenticated
  USING (private.auth_is_admin_at(location_id));

DROP POLICY IF EXISTS webhook_subscriptions_owner_write ON public.webhook_subscriptions;
CREATE POLICY webhook_subscriptions_owner_write
  ON public.webhook_subscriptions FOR ALL
  TO authenticated
  USING (private.auth_is_owner_at(location_id))
  WITH CHECK (private.auth_is_owner_at(location_id));

-- profile_locations — owner at target location
DROP POLICY IF EXISTS "Owners can manage location assignments" ON public.profile_locations;
CREATE POLICY "Owners can manage location assignments"
  ON public.profile_locations FOR ALL
  TO authenticated
  USING (private.auth_is_owner_at(location_id))
  WITH CHECK (private.auth_is_owner_at(location_id));

-- locations — master OR owner at THIS location. Inserts (new
-- locations) effectively master-only because no one is "owner-at-
-- a-location-that-doesn't-exist-yet".
DROP POLICY IF EXISTS "Owners and masters can manage locations" ON public.locations;
CREATE POLICY "Owners and masters can manage locations"
  ON public.locations FOR ALL
  TO authenticated
  USING (
    private.auth_is_master()
    OR private.auth_is_owner_at(id)
  )
  WITH CHECK (
    private.auth_is_master()
    OR private.auth_is_owner_at(id)
  );

-- profiles — master only at the RLS layer. API enforces per-
-- location ownership for non-master callers (a user-level row
-- doesn't have a clean per-location RLS expression).
DROP POLICY IF EXISTS "Admins can manage profiles" ON public.profiles;
CREATE POLICY "Admins can manage profiles"
  ON public.profiles FOR ALL
  TO authenticated
  USING (private.auth_is_master())
  WITH CHECK (private.auth_is_master());

COMMIT;
