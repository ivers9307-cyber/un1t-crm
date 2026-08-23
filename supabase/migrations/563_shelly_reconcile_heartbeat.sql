-- SHELLY.10 — heartbeat for /api/cron/shelly-reconcile.
--
-- SHIP ORDER: apply ONLY after the deploy that adds the cron. The health
-- check 503s on any stale cron_heartbeats row, so seeding this before the
-- route ships pages immediately (mig 561 header). Until it is applied the
-- live cron logs "stamp matched 0 rows" once a minute — harmless, and the
-- reminder that this file is still pending.
--
-- 60 + 840 = the same 900s budget as sonos-reconcile (mig 561 / 471): the
-- tick cannot commit until cloud round trips return.
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'shelly-reconcile',
  now(),
  60,
  840,
  'SHELLY.10 — per-minute Shelly Cloud state refresh + schedule/override application. Dormant (zero shelly_connections rows) until an owner pastes a key; still stamps.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;
