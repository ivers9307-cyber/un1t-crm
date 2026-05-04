-- ============================================================
-- 093: rename `door_unlock` → `studio_management` (cross-platform)
--
-- Was: profiles.permissions.mobile.door_unlock (mobile-only key)
-- Now: profiles.permissions.studio_management
--      profile_locations.permissions.studio_management
--      (top-level on the JSONB blob, same shape as dashboard_* —
--       a single toggle drives both web and mobile gates)
--
-- Source of truth: shared/permissions.js (mig 093 comment block).
-- This migration only updates already-stored values so existing
-- staff who had `door_unlock=true` keep the equivalent capability
-- under the new name, and `false` overrides aren't dropped.
--
-- Resolution rule:
--   - If the row has a value at permissions.mobile.door_unlock,
--     copy it to permissions.studio_management AND remove the
--     old key.
--   - If the row has neither, do nothing — fall through to role
--     default at runtime.
--
-- Idempotent: running it twice on a row that's already been
-- migrated is a no-op (the .mobile.door_unlock path won't exist
-- after the first run).
-- ============================================================

BEGIN;

-- profile_locations: per-location override (mig 058)
UPDATE profile_locations
SET permissions = jsonb_set(
      permissions,
      '{studio_management}',
      permissions #> '{mobile,door_unlock}',
      true
    ) #- '{mobile,door_unlock}'
WHERE permissions #> '{mobile,door_unlock}' IS NOT NULL;

-- profiles: legacy column (kept on disk per mig 058 rollback rule).
-- Same shape — copy then strip.
UPDATE profiles
SET permissions = jsonb_set(
      permissions,
      '{studio_management}',
      permissions #> '{mobile,door_unlock}',
      true
    ) #- '{mobile,door_unlock}'
WHERE permissions #> '{mobile,door_unlock}' IS NOT NULL;

COMMIT;
