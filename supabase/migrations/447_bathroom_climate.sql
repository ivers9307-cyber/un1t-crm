-- 447: BATHROOM-CLIMATE.1 — heartbeat for the bathroom-climate cron.
-- No schema change: the automation's config rides the existing
-- location_automations (unique location_id+automation_key) row, and
-- fires log to the existing automation_fire_log.
-- bathroom-climate: every 5 min (300s) + 10 min grace (mirrors the
-- class-climate row from mig 284).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
VALUES ('bathroom-climate', 300, 600, NOW())
ON CONFLICT (name) DO NOTHING;
