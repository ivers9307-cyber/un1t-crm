-- 303: win-back nudge — allow type='winback' in the engagement-nudge log + cron heartbeat.
ALTER TABLE public.customer_engagement_nudges DROP CONSTRAINT IF EXISTS customer_engagement_nudges_type_check;
ALTER TABLE public.customer_engagement_nudges ADD CONSTRAINT customer_engagement_nudges_type_check
  CHECK (type IN ('streak_at_risk','goal_complete','tier_up','reaction','winback'));

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('notify-winback', 86400, 7200, 'Daily 10:00 UTC — win-back push to members with declining HR attendance.')
ON CONFLICT (name) DO NOTHING;
