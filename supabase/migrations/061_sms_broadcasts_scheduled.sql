-- 061 — sms_broadcasts: add 'scheduled' state + cron heartbeat seed
--
-- Phase 2.5 of the SMS rollout. Mig 060's broadcast state machine
-- was: draft -> sending -> sent (or draft -> cancelled). 'sending'
-- is set by the synchronous send route, which means a broadcast
-- with a future scheduled_at had no terminal-pre-send state to
-- park in.
--
-- This migration:
--   1. Extends sms_broadcasts.status to allow 'scheduled'.
--      Transitions: draft -> scheduled (user picks a future time),
--      scheduled -> sending (cron picks it up at scheduled_at),
--      scheduled -> draft (user un-schedules), scheduled -> cancelled
--      (user cancels). Editing a scheduled broadcast requires
--      un-scheduling first — same lock as the existing 'sent' check.
--   2. Adds a cron_heartbeats row for run-sms-broadcasts so the
--      existing /api/cron/health-check route flags it stale if the
--      cron stops running.

alter table sms_broadcasts drop constraint if exists sms_broadcasts_status_check;
alter table sms_broadcasts add constraint sms_broadcasts_status_check
  check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled'));

-- Update the partial index so it covers 'scheduled' too — the cron's
-- pull query is `where status = 'scheduled' and scheduled_at <= now()`,
-- and we want that to be a fast index scan.
drop index if exists sms_broadcasts_status_idx;
create index sms_broadcasts_status_idx on sms_broadcasts (status, scheduled_at)
  where status in ('draft', 'scheduled', 'sending');

-- Cron heartbeat row — the cron route stamps this on success; the
-- cron_health view (mig 053) flags is_stale if last_ok_at falls
-- outside expected_interval_seconds + grace_seconds. 300+300 = 5min
-- expected, 5min grace.
insert into cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at, notes)
values (
  'run-sms-broadcasts',
  300,
  300,
  now(),
  'SMS broadcasts scheduler — picks up sms_broadcasts where status=scheduled AND scheduled_at <= now() (mig 061).'
)
on conflict (name) do update set
  expected_interval_seconds = excluded.expected_interval_seconds,
  grace_seconds = excluded.grace_seconds;
