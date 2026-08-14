-- 547: ATTR-3 — cron_heartbeats seed for /api/cron/attribution-health.
--
-- The attribution canary + weekly metric cron (nightly 21:45 UTC — after the
-- last Dublin class either side of DST; see vercel.json). The route stamps
-- this heartbeat on clean runs; stampHeartbeat() is UPDATE-only, so without
-- this row the stamp matches 0 rows and the health check never notices the
-- canary itself going quiet — the watcher would be unwatched, which is the
-- exact failure shape (silent no-op) the 2026-08-14 attribution audit was
-- about.
--
-- expected_interval = 1 day; grace = 26h (one missed nightly tick plus DST
-- wobble tolerated before the health check flags it stale).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES
  ('attribution-health', 86400, 93600,
   'ATTR-3 — nightly attribution canary (registered strap worn in class but owner got no session -> ops alert) + Sunday weekly attribution scorecard (attributed sessions vs the 10/week freeze target). Nightly 21:45 UTC. Canary is base-rate-safe: fires only on a broken promise, never on an empty room or unregistered straps.')
ON CONFLICT (name) DO NOTHING;
