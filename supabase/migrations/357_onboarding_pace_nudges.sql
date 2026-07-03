-- 357: PULSE-90 — first-90-days pace push nudges.
--
-- A new cron (notify-onboarding-pace) pushes a purely motivational nudge to
-- new members who are falling behind the 9-classes-in-6-weeks pace. Two DB
-- changes it depends on:
--
--   1. Allow an 'onboarding_pace' nudge type on customer_engagement_nudges so
--      the cron can dedup at most one push per (contact, journey-week) the same
--      idempotent way the streak / win-back / class-reminder nudges already do —
--      the dedup_key is '<contact_id>:wk<week_index>'. The authoritative current
--      CHECK (mig 323) is the 6-value list below; we only ADD 'onboarding_pace'.
--
--   2. Register the cron with cron_heartbeats so cron_health / Sentinel can see
--      it. stampHeartbeat() UPDATEs by name and warns on 0 rows, so the row must
--      exist before the cron first runs.

ALTER TABLE public.customer_engagement_nudges
  DROP CONSTRAINT IF EXISTS customer_engagement_nudges_type_check;
ALTER TABLE public.customer_engagement_nudges
  ADD CONSTRAINT customer_engagement_nudges_type_check
  CHECK (type IN ('streak_at_risk','goal_complete','tier_up','reaction','winback','class_reminder','onboarding_pace'));

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'notify-onboarding-pace',
  86400,
  7200,
  'Daily ~10:30 UTC — motivational first-90-days pace nudge to new members behind the 9-in-6-weeks track. 2h grace.'
)
ON CONFLICT (name) DO NOTHING;
