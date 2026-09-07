-- HOST-SCHEDULE.1 — scheduled send for host campaigns.
--
-- WHY. A host writes on their own time and wants the send to land at a
-- chosen hour. The sweeper cron (/api/cron/send-host-campaigns, every 2
-- min) already exists, so scheduling is one more status plus a fire time.
--
-- status flow:  draft -> scheduled -> sending -> sent
--                 ^         |
--                 +---------+  (host cancels, or a fire-time gate refuses:
--                               schedule_error carries the reason)
--
-- scheduled_for is UTC; the portal converts to/from Europe/Dublin.
-- schedule_error is set ONLY by the sweeper when a gate refused at fire
-- time and is cleared by the next successful schedule. Vocabulary (fixed
-- in code, src/lib/host-schedule-time.js): sender_not_verified | no_stream
-- | daily_cap | no_recipients | launch_failed.

alter table host_campaigns drop constraint if exists host_campaigns_status_check;
alter table host_campaigns add constraint host_campaigns_status_check
  check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed'));

alter table host_campaigns
  add column if not exists scheduled_for  timestamptz,
  add column if not exists schedule_error text;

comment on column host_campaigns.scheduled_for  is 'HOST-SCHEDULE.1: UTC instant the sweeper launches this campaign; kept after firing so the report can show it.';
comment on column host_campaigns.schedule_error is 'HOST-SCHEDULE.1: why the last scheduled fire went back to draft (sender_not_verified | no_stream | daily_cap | no_recipients | launch_failed); null once rescheduled.';

-- The sweeper's due pick: status = scheduled and scheduled_for <= now().
create index if not exists idx_host_campaigns_due
  on host_campaigns (scheduled_for) where status = 'scheduled';
