-- HOST-METRICS.1 — two corrections to mig 590, found in review.
-- 1. failed_reason vocabulary also includes 'no_administrative_consent'
--    (emailabilityReason returns it for UTILITY campaigns whose contact
--    never opted in to administrative mail; free-text column, no CHECK).
-- 2. host_campaign_stats(): bounced / complained / unsubscribed are now
--    status-guarded like delivered / opened / clicked, so a row the sweeper
--    reaped as 'failed' that later bounces counts once (failed), matching
--    deriveOutcome's precedence, and the tiles reconcile to the row count.
comment on column host_campaign_sends.failed_reason is
  'HOST-METRICS.1 — no_host_consent | host_unsubscribed | mailbox_blocked | no_email | no_administrative_consent | send_error | stale_claim';

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
    count(*) filter (where s.status = 'sent' and s.bounced_at is not null)                      as bounced,
    count(*) filter (where s.status = 'sent' and s.complained_at is not null
                       and s.bounced_at is null)                                                as complained,
    count(*) filter (where s.status = 'sent' and s.unsubscribed_at is not null
                       and s.bounced_at is null and s.complained_at is null)                    as unsubscribed,
    count(*) filter (where s.status = 'failed')                                                  as failed
  from host_campaign_sends s
  join host_campaigns c on c.id = s.campaign_id
  where c.host_id = p_host_id
  group by s.campaign_id
$$;
revoke all on function public.host_campaign_stats(uuid) from public, anon, authenticated;
grant execute on function public.host_campaign_stats(uuid) to service_role;
