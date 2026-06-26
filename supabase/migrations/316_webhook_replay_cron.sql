-- 316_webhook_replay_cron.sql
-- Seed the cron_heartbeats row for the webhook-replay cron (P1-12 Phase 2).
-- Runs every 5 minutes (*/5 in vercel.json); grace = 10 min (2 ticks) before
-- the cron_health view / /api/cron/health-check flags it stale.
-- Columns are integer seconds (see mig 053): expected_interval_seconds is
-- NOT NULL, grace_seconds defaults to 60 but we set 600 explicitly.

insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds)
values ('webhook-replay', 300, 600)
on conflict (name) do nothing;
