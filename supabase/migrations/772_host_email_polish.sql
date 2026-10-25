-- HOST-EMAILS.2 — host email polish: reminder audience, link clicks, delete guard.
--
-- Numbering: written as 594 and APPLIED TO PROD AS 594 on 7 Sep 2026
-- (schema_migrations 20260907115636 '594_host_email_polish'), but 594 is
-- main's 594_pipelines_table.sql, so the file is 772 here. Every statement is
-- idempotent (if not exists / or replace / drop-then-add), so replaying it on
-- prod changes nothing but the client REVOKE at the end, which 594 predated:
-- the table was made before mig 677 closed the default, so authenticated
-- still holds SELECT/INSERT/UPDATE/DELETE on it (RLS on with no policy keeps
-- every row out, but a grant nothing needs is still a grant).
--
-- 1. audience_kind 'non_openers' + audience_campaign_id: a reminder draft whose
--    audience is "delivered but never opened nor clicked" on a parent campaign,
--    resolved at SEND time (src/lib/host-campaign-email.js resolveHostRecipients).
-- 2. host_campaign_clicks: one row per link click (webhook Click and the
--    Postmark backfill), so the report can show clicks per URL. Unique on
--    (send_id, url, clicked_at) makes both writers idempotent.
-- 3. host_campaigns_block_sent_delete: mirrors mig 523 for CRM campaigns. A
--    sent/sending campaign and its host_campaign_sends are the record of what
--    went out; only draft/scheduled rows may be deleted.

alter table host_campaigns drop constraint if exists host_campaigns_audience_kind_check;
alter table host_campaigns add constraint host_campaigns_audience_kind_check
  check (audience_kind in ('all', 'event', 'mailing_list', 'non_openers'));

alter table host_campaigns
  add column if not exists audience_campaign_id uuid references host_campaigns(id) on delete set null;
comment on column host_campaigns.audience_campaign_id is
  'HOST-EMAILS.2: for audience_kind = non_openers, the parent campaign whose delivered-but-unopened recipients this draft targets.';

create table if not exists host_campaign_clicks (
  id                  uuid primary key default gen_random_uuid(),
  host_id             uuid not null references event_hosts(id) on delete cascade,
  campaign_id         uuid not null references host_campaigns(id) on delete cascade,
  send_id             uuid not null references host_campaign_sends(id) on delete cascade,
  contact_id          uuid references contacts(id) on delete set null,
  url                 text not null,
  clicked_at          timestamptz not null,
  postmark_message_id text,
  created_at          timestamptz not null default now()
);
create unique index if not exists host_campaign_clicks_dedupe on host_campaign_clicks (send_id, url, clicked_at);
create index if not exists idx_host_campaign_clicks_campaign_url on host_campaign_clicks (campaign_id, url);
create index if not exists idx_host_campaign_clicks_contact on host_campaign_clicks (contact_id);
alter table host_campaign_clicks enable row level security;
-- Service role only: the Postmark webhook and the backfill write it, the
-- report route reads it. No client reads or writes it (mig 677 house style).
revoke all on public.host_campaign_clicks from anon, authenticated;
comment on table host_campaign_clicks is
  'HOST-EMAILS.2: one row per tracked-link click on a host campaign email (webhook Click + Postmark backfill). Service role only; no policies.';

create or replace function public.host_campaigns_block_sent_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status in ('draft', 'scheduled') then
    return old;
  end if;
  raise exception
    'Host campaign % is % and cannot be deleted. Its send rows and clicks are the record of what was actually sent.',
    old.id, coalesce(old.status, 'in an unknown state')
    using errcode = 'check_violation';
end;
$$;
drop trigger if exists host_campaigns_block_sent_delete on host_campaigns;
create trigger host_campaigns_block_sent_delete
  before delete on host_campaigns
  for each row
  execute function public.host_campaigns_block_sent_delete();
