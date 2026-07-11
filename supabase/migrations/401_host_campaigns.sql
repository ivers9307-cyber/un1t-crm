-- HOST-EMAIL.3 — host email campaigns + per-recipient send queue.
create table if not exists host_campaigns (
  id              uuid primary key default gen_random_uuid(),
  host_id         uuid not null references event_hosts(id) on delete cascade,
  subject         text not null,
  body_html       text not null,
  status          text not null default 'draft' check (status in ('draft','sending','sent','failed')),
  recipient_count int,
  sent_count      int not null default 0,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
alter table host_campaigns enable row level security;
create index if not exists idx_host_campaigns_host on host_campaigns (host_id);

create table if not exists host_campaign_sends (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references host_campaigns(id) on delete cascade,
  contact_id  uuid not null references contacts(id) on delete cascade,
  email       text not null,
  status      text not null default 'pending' check (status in ('pending','claimed','sent','failed')),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  unique (campaign_id, contact_id)
);
alter table host_campaign_sends enable row level security;
create index if not exists idx_host_campaign_sends_pending on host_campaign_sends (campaign_id) where status = 'pending';

-- Cron runs on a 2-min schedule (*/2 in vercel.json); 300s is a deliberately
-- looser staleness allowance so one skipped/slow tick doesn't page (NOT NULL column).
insert into cron_heartbeats (name, expected_interval_seconds) values ('send-host-campaigns', 300)
on conflict (name) do nothing;

comment on table host_campaigns is 'HOST-EMAIL.3 — host marketing campaigns; recipients resolve at send time (consent + per-host suppression). Service-role only.';
comment on table host_campaign_sends is 'HOST-EMAIL.3 — per-recipient claim-before-send queue drained by /api/cron/send-host-campaigns.';
