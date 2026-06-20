-- 300: Heartbeat row for the daily challenge-events cron (start/end/target announcements).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('run-challenge-events', 86400, 7200, 'Daily 08:00 UTC — challenge start / end-winner / collective-target push announcements.')
ON CONFLICT (name) DO NOTHING;
