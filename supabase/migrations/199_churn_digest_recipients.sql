-- 199_churn_digest_recipients.sql
--
-- RADAR-DIGEST.1 — weekly churn-radar email digest.
--
-- locations.churn_digest_recipients holds the operator-managed list
-- of email addresses that receive the Monday radar digest (current
-- numbers, week-over-week change, recent-weeks trend). An empty array
-- means the digest is off for that location — the default.
--
-- Edited from the churn radar page (/api/churn-radar/digest-settings);
-- read by the /api/cron/churn-radar-digest cron.

begin;

alter table public.locations
  add column if not exists churn_digest_recipients text[] not null default '{}';

comment on column public.locations.churn_digest_recipients is
  'Email addresses that receive the weekly churn-radar digest. Empty = off. RADAR-DIGEST.1.';

-- Seed the cron heartbeat row. stampHeartbeat() is UPDATE-only, so
-- the row must pre-exist (same pattern as mig 174 / 198). Weekly
-- cadence: 7-day interval, 2-day grace for a missed Monday run.
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
values
  ('churn-radar-digest', 604800, 172800,
   'RADAR-DIGEST.1 — weekly (Mon 07:00 UTC) churn-radar email digest to each location''s configured recipients. 2-day grace covers a missed Monday run.')
on conflict (name) do nothing;

commit;
