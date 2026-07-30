-- 463_geofence_attendance.sql
-- GEO-ATT.1 — passive staff attendance via mobile geofencing.
--
-- 1. staff_attendance_events.source gains 'geofence' (third auto
--    pipeline besides unifi_access / protect; manual stays).
--    The CHECK was written inline in mig 120 so Postgres auto-named
--    it staff_attendance_events_source_check (precedent: mig 120's
--    webhook_events_provider_check recreate, cited by mig 122).
-- 2. profile_locations.geofence_exempt — per-assignment opt-out.
--    Exempt staff are never permission-gated in the mobile app and
--    never stamped by geofence (phoneless staff, contractors, the
--    Apple review account, GDPR objections).
--
-- Location-level config (enabled/lat/lng/radius/gate_copy) lives in
-- locations.settings.geofence (JSONB) — no DDL needed for it.

BEGIN;
ALTER TABLE public.staff_attendance_events
  DROP CONSTRAINT IF EXISTS staff_attendance_events_source_check;
ALTER TABLE public.staff_attendance_events
  ADD CONSTRAINT staff_attendance_events_source_check
  CHECK (source IN ('unifi_access', 'protect', 'manual', 'geofence'));
COMMIT;

ALTER TABLE public.profile_locations
  ADD COLUMN IF NOT EXISTS geofence_exempt boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profile_locations.geofence_exempt IS
  'GEO-ATT (mig 463): true = this staff member is excluded from mobile geofence attendance at this location — never permission-gated, never auto-stamped by source=geofence.';
