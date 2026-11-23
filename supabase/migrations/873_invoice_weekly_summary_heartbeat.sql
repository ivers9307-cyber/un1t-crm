-- 873 — INVWEEKLY.1: heartbeat row for the weekly invoices email.
--
-- /api/cron/invoice-weekly-summary runs hourly and acts once a week, at
-- Monday 08:00 in each studio's own zone (the daily-slot gate). It stamps on
-- the tick that takes a slot, so the row keeps a weekly clock: 604800 s
-- expected, with a day of grace, the same as receipt-coverage-weekly.
--
-- DML only. Safe to apply before or after the deploy: last_ok_at starts at
-- now(), so the row cannot page before the first Monday has had its chance.

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'invoice-weekly-summary', now(), 604800, 86400,
  'INVWEEKLY.1 (mig 873): the weekly invoices email, Monday 08:00 studio time (hourly schedule, one slot per studio per week). Sent only when invoices are waiting, to masters and bookkeepers at the studio. 604800 + 86400: one missed Monday pages.'
)
ON CONFLICT (name) DO NOTHING;
