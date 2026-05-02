-- 075 — Per-booking reminder override (Calendly tier 3).
--
-- Reminders are configured per-event-type today. If a customer
-- asks "please don't remind me about my booking, I know about
-- it" the operator's options are:
--   1. Disable reminders for the event_type → affects every
--      future booking under that type (wrong)
--   2. Tell the customer to opt out of all administrative
--      emails / SMS → kills cancellation + receipt messages too
--      (also wrong)
--   3. Manually mark the booking somehow so the runner skips it
--
-- This adds a boolean for option 3. operator-only flag, false
-- by default. The runner short-circuits before consent /
-- channel checks when it's true and stamps reminder_sent_at so
-- the booking falls out of the partial index immediately.
--
-- No customer-side path yet (would need a token-issued "manage
-- your booking" page like the unsubscribe one). If that becomes
-- a recurring ask, slot it as tier 4.

alter table public.bookings
  add column if not exists skip_reminder boolean not null default false;

comment on column public.bookings.skip_reminder is
  'Per-booking reminder override (mig 075). When true, the cron-driven event-reminders runner skips this booking and stamps reminder_sent_at. Operator-set; intended for "customer asked us not to remind them about this specific booking" cases.';
