-- HOST-METRICS.1 — per-send outcomes for host campaign email.
--
-- WHY. A sent host email showed "120/124 sent" and nothing else: no Postmark
-- message id, no delivery/open/click, no reason for the 4 that failed. Host
-- sends write no email_sends row (they are not CRM sends), and until
-- HOST-CONSENT.1 their Postmark events were dropped. Outcomes now live on the
-- queue row itself. `status` stays the QUEUE state; the displayed outcome is
-- derived in code by precedence (failed > bounced > complained > unsubscribed
-- > clicked > opened > delivered > sent) so a late Delivery never regresses an
-- Open. No denormalised counters: host_campaign_stats() counts the rows.

alter table host_campaign_sends
  add column if not exists postmark_message_id text,
  add column if not exists delivered_at    timestamptz,
  add column if not exists opened_at       timestamptz,
  add column if not exists open_count      integer not null default 0,
  add column if not exists clicked_at      timestamptz,
  add column if not exists click_count     integer not null default 0,
  add column if not exists bounced_at      timestamptz,
  add column if not exists bounce_type     text,
  add column if not exists complained_at   timestamptz,
  add column if not exists unsubscribed_at timestamptz,
  add column if not exists failed_reason   text;

alter table host_campaign_sends drop constraint if exists host_campaign_sends_bounce_type_check;
alter table host_campaign_sends add constraint host_campaign_sends_bounce_type_check
  check (bounce_type is null or bounce_type in ('hard', 'soft', 'transient'));

create index if not exists idx_host_campaign_sends_message
  on host_campaign_sends (postmark_message_id) where postmark_message_id is not null;

-- Stats per campaign for one host, same precedence as the code's outcome.
create or replace function public.host_campaign_stats(p_host_id uuid)
returns table (
  campaign_id uuid, queued bigint, sent bigint, delivered bigint, opened bigint,
  clicked bigint, bounced bigint, complained bigint, unsubscribed bigint, failed bigint
)
language sql
security invoker
set search_path = public
as $$
  select
    s.campaign_id,
    count(*) filter (where s.status in ('pending','claimed'))                                   as queued,
    count(*) filter (where s.status = 'sent')                                                    as sent,
    count(*) filter (where s.status = 'sent' and s.delivered_at is not null
                       and s.bounced_at is null and s.complained_at is null)                    as delivered,
    count(*) filter (where s.status = 'sent' and s.opened_at is not null
                       and s.bounced_at is null and s.complained_at is null)                    as opened,
    count(*) filter (where s.status = 'sent' and s.clicked_at is not null
                       and s.bounced_at is null and s.complained_at is null)                    as clicked,
    count(*) filter (where s.bounced_at is not null)                                             as bounced,
    count(*) filter (where s.complained_at is not null)                                          as complained,
    count(*) filter (where s.unsubscribed_at is not null)                                        as unsubscribed,
    count(*) filter (where s.status = 'failed')                                                  as failed
  from host_campaign_sends s
  join host_campaigns c on c.id = s.campaign_id
  where c.host_id = p_host_id
  group by s.campaign_id
$$;
revoke all on function public.host_campaign_stats(uuid) from public, anon, authenticated;
grant execute on function public.host_campaign_stats(uuid) to service_role;

-- Atomic counter bump for open_count / click_count (mirrors mig 157's
-- increment_campaign_metric: allowlisted field, format(%I)).
create or replace function public.bump_host_send_counter(p_send_id uuid, p_field text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_field not in ('open_count', 'click_count') then
    raise exception 'bump_host_send_counter: invalid p_field %', p_field;
  end if;
  execute format('update public.host_campaign_sends set %1$I = %1$I + 1 where id = $1', p_field) using p_send_id;
end;
$$;
revoke all on function public.bump_host_send_counter(uuid, text) from public, anon, authenticated;
grant execute on function public.bump_host_send_counter(uuid, text) to service_role;

comment on column host_campaign_sends.failed_reason is
  'HOST-METRICS.1 — no_host_consent | host_unsubscribed | mailbox_blocked | no_email | send_error | stale_claim';
