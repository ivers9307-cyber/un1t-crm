-- ============================================================
-- 024: Door access per location
--
-- Migration 019 added unifi_door_access (boolean) and unifi_user_id
-- (text) to the profiles table — one row per staff member, regardless
-- of how many locations they work at. That worked while staff were
-- assigned to a single studio, but doesn't scale: a staffer covering
-- both UN1T Stillorgan and UN1T Hatch Street has a different UniFi
-- instance per studio (each location holds its own
-- locations.settings.unifi blob), so they need independent toggles
-- and independent unifi_user_ids per studio.
--
-- New model: door access lives on profile_locations (the existing
-- profile↔location junction). Each row gets unifi_door_access
-- (boolean, default false) and unifi_user_id (text, nullable). The
-- staff form renders one toggle per assigned location.
--
-- Migration strategy: copy the existing per-profile values onto the
-- profile's default location row (profile_locations.is_default = true)
-- so anyone who had door access enabled keeps it after this runs.
-- The legacy columns on profiles are kept (for now) as a denormalised
-- "door access on at least one location" flag — server-side route
-- recomputes them after every save. Future migration can drop them
-- once the codebase has fully moved over.
-- ============================================================

ALTER TABLE profile_locations
  ADD COLUMN IF NOT EXISTS unifi_door_access BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS unifi_user_id     TEXT,
  ADD COLUMN IF NOT EXISTS unifi_synced_at   TIMESTAMPTZ;

COMMENT ON COLUMN profile_locations.unifi_door_access IS
  'When true, this profile has UniFi door access enabled at this location. '
  'Server-side, the API route writes a per-location UniFi sync (find-or-create '
  'user, assign role policy) when this toggles to true and a revoke when it '
  'toggles to false. Each location has its own UniFi instance (config in '
  'locations.settings.unifi) so each row needs its own bit.';

COMMENT ON COLUMN profile_locations.unifi_user_id IS
  'Identity ID returned by THIS LOCATION''s UniFi Access API for the staff '
  'member. Set on first sync and persists across toggling so re-enabling '
  'skips the lookup. Different locations have different UniFi instances and '
  'therefore different IDs for the same staff member.';

-- Backfill: copy the legacy profile-level state onto the default
-- location row only. Non-default rows stay false until the user
-- explicitly toggles them in the new UI.
UPDATE profile_locations pl
SET unifi_door_access = p.unifi_door_access,
    unifi_user_id     = p.unifi_user_id
FROM profiles p
WHERE pl.profile_id = p.id
  AND pl.is_default = true
  AND p.unifi_door_access = true;

-- Index for the "is anyone here door-enabled?" query the dashboard
-- might run later, plus the per-staff lookups the API route does.
CREATE INDEX IF NOT EXISTS idx_profile_locations_unifi_enabled
  ON profile_locations(location_id)
  WHERE unifi_door_access = true;
