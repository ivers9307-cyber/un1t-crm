-- 466_device_tokens_permission_and_nudge.sql
-- STAFF-DEV.1 — device visibility.
--
-- 1. geofence_permission / _at: what the OS reports for background
--    location on this device. NULL = never reported (client below
--    2.2.0, or pre-STAFF-DEV JS). NULL must render as "—", never as
--    "denied" — absence of data is not a denial.
-- 2. last_update_nudge_at: server-side throttle for the
--    nudge-to-update push (one per device per 24h).

ALTER TABLE public.device_tokens
  ADD COLUMN IF NOT EXISTS geofence_permission text,
  ADD COLUMN IF NOT EXISTS geofence_permission_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_update_nudge_at timestamptz;

ALTER TABLE public.device_tokens
  DROP CONSTRAINT IF EXISTS device_tokens_geofence_permission_check;
ALTER TABLE public.device_tokens
  ADD CONSTRAINT device_tokens_geofence_permission_check
  CHECK (geofence_permission IS NULL OR geofence_permission IN
    ('always', 'when_in_use', 'denied', 'undetermined'));

COMMENT ON COLUMN public.device_tokens.geofence_permission IS
  'STAFF-DEV (mig 466): OS background-location status last reported by this device. NULL = never reported; render as unknown, not denied.';
COMMENT ON COLUMN public.device_tokens.last_update_nudge_at IS
  'STAFF-DEV (mig 466): last time an update-nudge push was sent to this device. 24h throttle.';
