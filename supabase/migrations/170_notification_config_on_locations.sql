-- NOTIF.3 — per-location notification config.
--
-- JSONB blob on locations holds the operator-configurable knobs for
-- the send-push-reminders cron and (in future) other notification
-- categories. Shape is documented in src/lib/notification-config.js;
-- every field is optional and falls back to a per-category default
-- when missing, so existing locations work without backfill.
--
-- Current schema (v1):
--   {
--     "categories": {
--       "tasks":    { "lead_times_minutes": [60, 1440] },
--       "bookings": { "lead_times_minutes": [60, 1440],
--                     "notify_roles": ["owner","manager","head_coach"] }
--     }
--   }
--
-- A CHECK constraint enforces it's a JSON object (or NULL); deeper
-- validation lives in the API endpoint (zod) because Postgres JSONB
-- checks are painful and the surface is operator-only.

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS notification_config JSONB;

ALTER TABLE public.locations
  DROP CONSTRAINT IF EXISTS locations_notification_config_is_object;

ALTER TABLE public.locations
  ADD CONSTRAINT locations_notification_config_is_object
  CHECK (notification_config IS NULL OR jsonb_typeof(notification_config) = 'object');

COMMENT ON COLUMN public.locations.notification_config IS
  'NOTIF.3 — operator-tunable knobs for push notifications. NULL = use defaults from src/lib/notification-config.js. Lead times in minutes; recognised categories: tasks, bookings.';

-- Relax the lead_time_minutes CHECK on push_reminder_sends. Mig 169
-- pinned it to IN (60, 1440) because those were the only two lead
-- times the cron used. NOTIF.3 makes lead times configurable per
-- location and per category, so the constraint now needs to be a
-- range check matching LEAD_TIME_MIN_MINUTES / LEAD_TIME_MAX_MINUTES
-- in src/lib/notification-config.js (5 min … 7 days).

ALTER TABLE public.push_reminder_sends
  DROP CONSTRAINT IF EXISTS push_reminder_sends_lead_time_minutes_check;

ALTER TABLE public.push_reminder_sends
  ADD CONSTRAINT push_reminder_sends_lead_time_minutes_check
  CHECK (lead_time_minutes BETWEEN 5 AND 10080);
