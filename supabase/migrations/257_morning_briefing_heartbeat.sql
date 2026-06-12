-- BRIEFING.1 — heartbeat row for the daily morning-briefing cron
-- (/api/cron/morning-briefing, vercel.json "0 6 * * *"). The route
-- stamps this on every successful tick; /api/cron/health-check 503s
-- when it goes stale. Daily cadence → expected 86400s + 2h grace
-- (Vercel cron jitter + the sweep itself can take a few minutes).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
VALUES ('morning-briefing', 86400, 7200, NOW())
ON CONFLICT (name) DO NOTHING;
