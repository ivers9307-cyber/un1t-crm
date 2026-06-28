-- 323: P2-7 (Part A) — pre-class booking push reminders.
--
-- A new cron (send-class-booking-reminders) pushes a reminder to a member
-- ~30 min before a class they've booked (lead time configurable per location
-- via locations.notification_config.categories.class_reminder.lead_times_minutes).
-- Two DB changes it depends on:
--
--   1. Allow a 'class_reminder' nudge type on customer_engagement_nudges so the
--      cron can dedup one push per (contact, booking, lead-time) the same
--      idempotent way the streak / win-back nudges already do — the dedup_key
--      is '<class_booking_id>:<lead_minutes>'. The authoritative current CHECK
--      (mig 303) is the 5-value list below; we only ADD 'class_reminder'.
--
--   2. Register the cron with cron_heartbeats so cron_health / Sentinel can see
--      it. stampHeartbeat() UPDATEs by name and warns on 0 rows, so the row must
--      exist before the cron first runs.

ALTER TABLE public.customer_engagement_nudges
  DROP CONSTRAINT IF EXISTS customer_engagement_nudges_type_check;
ALTER TABLE public.customer_engagement_nudges
  ADD CONSTRAINT customer_engagement_nudges_type_check
  CHECK (type IN ('streak_at_risk','goal_complete','tier_up','reaction','winback','class_reminder'));

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'send-class-booking-reminders',
  300,
  300,
  'Every 5 min — pre-class push reminder to members with a booked Glofox class. 5-min grace.'
)
ON CONFLICT (name) DO NOTHING;
