-- 513 — GAPS-P2: the campaign outcome report.
--
-- WHY THIS EXISTS
-- ───────────────
-- Klaviyo can tell an operator a campaign got a 24% open rate. Only this
-- system can tell them it produced five bookings, because no external ESP has
-- the Glofox data. Every table, key and index this needs already existed —
-- nobody had written the query. With 16 campaigns sent and one active
-- sequence, the binding constraint on this gym's email marketing is not
-- capability; it is that the operator has no evidence any of it works.
--
-- ATTRIBUTION MODEL, and its deliberate limits
-- ────────────────────────────────────────────
-- Attribution runs through CLICKERS, not recipients: a click is an action, a
-- delivery is not. Each clicker's window opens at their FIRST click on this
-- campaign and runs p_window_days.
--
-- The non-opener cohort is returned alongside, always. Without a control this
-- is a correlation dressed as a result, and an operator will make budget
-- decisions on it. Non-openers are the honest control here: same audience,
-- same send, no engagement — so the difference between the two rates is the
-- closest thing to a campaign effect this data can support.
--
-- RECURRING MEMBERSHIP REVENUE IS DELIBERATELY ABSENT. It was measured at
-- €0-10 per campaign: UN1T's revenue is monthly direct debit, which does not
-- correlate with an email click. A windowed figure would simply relabel
-- whatever debits happened to land that week as "campaign revenue". Money here
-- is only ever DISCRETE purchases (offer_purchases, race_payments) — things a
-- person buys BECAUSE of an email. Omitting the number we cannot stand behind
-- is the feature, not a gap in it.
--
-- class_bookings.created_at is SYNC time, not booking time (rows are assembled
-- by per-member Glofox fetches), so it cannot carry a causal window. We use
-- starts_at: "clicked, then attended a class within the window". That is a
-- weaker causal claim than a booking timestamp would be, and the UI says so.
--
-- glofox_invoices is excluded entirely. It is stale for computing money owed
-- (a standing invariant) and its per-attempt id churn makes it the wrong
-- source for attribution too.

create or replace function public.campaign_outcome_stats(
  p_campaign_id uuid,
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
  with clickers as (
    -- One row per contact who clicked, with their first click as the window origin.
    select cl.contact_id, min(cl.clicked_at) as t0
      from public.campaign_link_clicks cl
     where cl.campaign_id = p_campaign_id
       and cl.contact_id is not null
     group by cl.contact_id
  ),
  non_openers as (
    -- The control: sent, never opened. Window opens at their send time.
    select cr.contact_id, cr.sent_at as t0
      from public.campaign_recipients cr
     where cr.campaign_id = p_campaign_id
       and cr.contact_id is not null
       and cr.opened_at is null
       and cr.sent_at is not null
       and cr.status in ('sent', 'delivered')
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

comment on function public.campaign_outcome_stats(uuid, int) is
  'GAPS-P2 (mig 513) — campaign outcomes attributed through CLICKERS, with the sent-but-never-opened cohort returned alongside as a control. Window opens at each contact''s first click (or send time for the control) and runs p_window_days. Counts event registrations, class attendances and DISCRETE purchases only: recurring membership revenue is deliberately excluded because monthly direct debit does not correlate with a click, so a windowed figure would relabel unrelated debits as campaign revenue. class_bookings uses starts_at because created_at is Glofox SYNC time, not booking time. service_role only.';

revoke execute on function public.campaign_outcome_stats(uuid, int) from public, anon, authenticated;
grant  execute on function public.campaign_outcome_stats(uuid, int) to service_role;
