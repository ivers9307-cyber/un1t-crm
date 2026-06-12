-- KNOWLEDGE-IMPORT.2 — heartbeat row for the weekly Glofox class-
-- knowledge sync cron (Mondays 06:00 UTC, vercel.json). Weekly
-- interval + a generous day of grace.
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
VALUES ('sync-class-knowledge', 604800, 86400, NOW())
ON CONFLICT (name) DO NOTHING;
