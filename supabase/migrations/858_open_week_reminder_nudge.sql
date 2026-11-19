-- OPENWEEK.7 (mig 858): open week class reminders claim one
-- customer_engagement_nudges row per booking (type open_week_reminder, dedup
-- key cb:<class_bookings.id>), so each class is reminded once
-- (src/lib/open-week-reminder-send.js). Every earlier type is kept (mig 357).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.customer_engagement_nudges DROP CONSTRAINT IF EXISTS customer_engagement_nudges_type_check;
ALTER TABLE public.customer_engagement_nudges
  ADD CONSTRAINT customer_engagement_nudges_type_check
  CHECK (type IN ('streak_at_risk', 'goal_complete', 'tier_up', 'reaction', 'winback', 'class_reminder', 'onboarding_pace', 'open_week_reminder'));

COMMIT;
