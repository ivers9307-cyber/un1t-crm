-- Broaden the "Owners can manage locations" RLS policy to include
-- master too. Without this, masters' UPDATEs on the locations table
-- silently affect 0 rows (RLS hides the policy check failure) and
-- the client gets back "Cannot coerce the result to a single JSON
-- object" from .single().
--
-- The existing private.auth_is_in_location() helper was updated in
-- mig 033 to short-circuit for master, but the locations table has
-- a SEPARATE policy that hard-checks role='owner' — that policy
-- never went through auth_is_in_location, so the master bridge
-- never reached it.

DROP POLICY IF EXISTS "Owners can manage locations" ON locations;

CREATE POLICY "Owners and masters can manage locations" ON locations
  FOR ALL
  USING (
    private.auth_is_master()
    OR private.get_user_role(auth.uid()) = 'owner'
  )
  WITH CHECK (
    private.auth_is_master()
    OR private.get_user_role(auth.uid()) = 'owner'
  );

COMMENT ON POLICY "Owners and masters can manage locations" ON locations IS
  'Both roles can SELECT/INSERT/UPDATE/DELETE locations. Application-layer gates additionally restrict the master-only operations (creating new locations, editing UniFi config) — see /api/locations/* and the mig 034 trigger.';
