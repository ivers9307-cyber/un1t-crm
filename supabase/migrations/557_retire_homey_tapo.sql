-- SONOS.15 — retire the Homey path now that studio music runs on the Sonos
-- Control API.
--
-- SHIP ORDER: apply ONLY after the deploy that removes /api/cron/
-- homey-reconcile and adds /api/cron/sonos-reconcile. The health check 503s
-- on any stale cron_heartbeats row, so seeding sonos-reconcile before its
-- cron ships would page immediately, and leaving homey-reconcile behind
-- after its cron is gone would page forever.
--
-- What the Homey held, measured 2026-08-20 before removal: 50 tapo_devices
-- rows, ZERO with a schedule (schedule_mode = 'none' across the board), and
-- 46 unreachable since 2026-08-10. Nothing automated depended on it.

-- 1. The new cron's heartbeat. last_ok_at seeded to now() so the first tick
--    has a budget to land in rather than starting stale.
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'sonos-reconcile',
  now(),
  60,
  900,
  'SONOS.15 — per-minute Sonos schedule application. Dormant (skipped:true) until SONOS_* env vars are set; still stamps.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- 2. The old cron is gone; its heartbeat must go with it or it alerts forever.
DELETE FROM public.cron_heartbeats WHERE name = 'homey-reconcile';

-- 3. The device registry. Its only reader and writer were the routes and the
--    cron deleted in SONOS.14.
DROP TABLE IF EXISTS public.tapo_devices;
