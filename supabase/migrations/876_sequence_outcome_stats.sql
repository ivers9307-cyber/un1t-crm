-- SEQOUTCOME.1 — what people did after an automation's emails, the automation
-- twin of campaign_outcome_stats (mig 513), with the same rules:
--   clicked     contacts who clicked any of this sequence's emails; each
--               contact's window opens at their FIRST click
--   not_opened  contacts sent at least one of this sequence's emails who
--               never opened or clicked any of them; window opens at their
--               first send. The control.
-- Counts event registrations, class attendances (class_bookings.starts_at:
-- created_at is Glofox sync time) and DISCRETE purchases inside the window.
-- Recurring membership revenue is excluded, as in mig 513. Since MACHINEOPEN.1
-- an Apple Mail privacy fetch is not an open, so the control holds those
-- readers too; clicks are the firmer signal. service_role only.

create or replace function public.sequence_outcome_stats(
  p_sequence_id uuid,
  p_window_days int default 7
)
returns table (
  cohort                text,
  contacts              bigint,
  event_registrations   bigint,
  class_attendances     bigint,
  purchases             bigint,
  purchase_cents        bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with sends as (
    select es.contact_id, es.sent_at, es.opened_at, es.clicked_at
      from public.email_sends es
     where es.sequence_id = p_sequence_id
       and es.contact_id is not null
       and es.sent_at is not null
  ),
  clickers as (
    select contact_id, min(clicked_at) as t0
      from sends
     where clicked_at is not null
     group by contact_id
  ),
  non_openers as (
    select contact_id, min(sent_at) as t0
      from sends
     group by contact_id
    having bool_and(opened_at is null and clicked_at is null)
  ),
  cohorts as (
    select 'clicked'::text as cohort, contact_id, t0 from clickers
    union all
    select 'not_opened'::text,        contact_id, t0 from non_openers
  )
  select
    c.cohort,
    count(distinct c.contact_id)::bigint as contacts,
    count(distinct r.contact_id)::bigint as event_registrations,
    count(distinct b.contact_id)::bigint as class_attendances,
    (count(distinct op.id) + count(distinct rp.id))::bigint as purchases,
    (coalesce(sum(distinct op.amount_cents), 0)
      + coalesce(sum(distinct rp.amount_cents), 0))::bigint as purchase_cents
  from cohorts c
  left join public.race_registrations r
    on r.contact_id = c.contact_id
   and r.status in ('pending_payment', 'confirmed')
   and r.created_at >= c.t0
   and r.created_at <  c.t0 + make_interval(days => p_window_days)
  left join public.class_bookings b
    on b.contact_id = c.contact_id
   and b.status is distinct from 'cancelled'
   and b.starts_at >= c.t0
   and b.starts_at <  c.t0 + make_interval(days => p_window_days)
  left join public.offer_purchases op
    on op.contact_id = c.contact_id
   and op.paid_at is not null
   and op.paid_at >= c.t0
   and op.paid_at <  c.t0 + make_interval(days => p_window_days)
  left join public.race_payments rp
    on rp.contact_id = c.contact_id
   and rp.status = 'paid'
   and rp.created_at >= c.t0
   and rp.created_at <  c.t0 + make_interval(days => p_window_days)
  group by c.cohort;
$$;

comment on function public.sequence_outcome_stats(uuid, int) is
  'SEQOUTCOME.1 (mig 876) — automation outcomes through clickers of any of the sequence''s emails, with the sent-but-never-opened-or-clicked cohort as a control. Same windows and counting rules as campaign_outcome_stats (mig 513). service_role only.';

revoke execute on function public.sequence_outcome_stats(uuid, int) from public, anon, authenticated;
grant  execute on function public.sequence_outcome_stats(uuid, int) to service_role;
