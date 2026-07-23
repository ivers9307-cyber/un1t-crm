-- 441: HYROX-TC.3 — heartbeats for the two Hyrox crons (publish + rolling expand).
-- publish-hyrox-board runs every 5 min (300s) + 10 min grace; the board goes up
-- ~15 min before a HYROX class and reverts to idle after. expand-hyrox-weeks runs
-- daily (86400s) + 12h grace, keeping ~2 weeks of sessions expanded ahead of now.
-- Names MUST match the stampHeartbeat() calls in the cron routes exactly.

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
VALUES ('publish-hyrox-board', 300, 600, NOW())
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
VALUES ('expand-hyrox-weeks', 86400, 43200, NOW())
ON CONFLICT (name) DO NOTHING;
