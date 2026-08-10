-- 517 — GAPS-P7: list growth and deliverability, month by month.
--
-- WHY THIS EXISTS
-- ───────────────
-- The email list has been shrinking and nothing in the product showed it.
-- GAPS-P5 shipped a list-health page, but it is a SNAPSHOT — how many people
-- can be emailed today — and a snapshot cannot show a slope. Send-side
-- deliverability had the same hole: bounce rate has run 0.73% to 1.25% all
-- year against a 2% warning band, on ONE sending domain, with no month-on-month
-- view. Nobody would notice a reputation slide until mail stopped arriving.
--
-- ⚠️ NOT EVERY consent_log OPT-OUT IS A DEPARTURE. This is the whole design.
-- Measured live 2026-08-10, consent_log holds 5,749 email_marketing opt_out
-- rows since 2026-05-01, by source:
--
--     bulk_import                    3,963   all on 2026-05-13
--     auto_classpass_backfill        1,533   all on 2026-05-13
--     auto_classpass                    82   ongoing
--     postmark_one_click_unsubscribe    56   ongoing
--     event_form                        38   ongoing
--     one_click_unsubscribe             27   ongoing
--     postmark_suppression_backfill     23   all on 2026-05-13
--     postmark_hard_bounce              18   ongoing
--     admin_panel                        4   ongoing
--     booking_form                       2   ongoing
--     leadcap1_scope_correction          2   2026-08-06
--     postmark_spam_complaint            1   2026-08-05
--
-- 5,519 of those landed on ONE DAY as a data migration. The first cut of this
-- function summed the column blind and reported roughly 5,536 departures for
-- 2026-05 and a net near -5,534 — an import rendered as a catastrophic list
-- collapse, on the one number this feature exists to make trustworthy.
--
-- A blocklist of the three backfills was rejected: the next import would
-- reappear in the headline silently, which is exactly how this got in. Instead
-- the four category memberships arrive as PARAMETERS from
-- src/lib/consent-sources.js, which is the single definition. This function
-- holds NO copy of the vocabulary. The arrays default to empty, so a caller
-- that forgets them classifies everything as UNKNOWN — loudly wrong on screen
-- rather than quietly wrong in the headline. Anything in no array is counted
-- as unknown and returned with its source name, never folded into a category.
--
-- WHAT MOVES THE NET: voluntary + deliverability. Not bulk (a migration is not
-- a departure). Not policy — the auto_classpass trigger (mig 512) fires on a
-- Glofox membership transition into classpass_payg, has no counterpart on the
-- way out so it only ever ratchets downward, and inserts UNCONDITIONALLY
-- rather than on a flip, so one person churning in and out of ClassPass writes
-- several rows while leaving the list once. Full reasoning, including why that
-- hides nothing, is in NET_LIST_CHANGE_CATEGORIES in consent-sources.js.
-- Policy, bulk and unknown are all returned per month and rendered beside the
-- net, so the composition is on screen even though it is out of the headline.
--
-- ⚠️ ROWS ARE NOT PEOPLE for every source. applyMarketingPreferences[Bulk]
-- writes a row only when the flag actually CHANGED, so its rows are true
-- transitions; the trigger and the backfills write unconditionally. That is a
-- second, independent reason the excluded categories are excluded — counting
-- their rows as people would overstate the loss even if they were departures.
--
-- Precedent: mig 488 already had to hand-exclude leadcap1_scope_correction
-- from a genuine-opt-out query. Same trap, same column, solved once locally
-- where the next query could not see it.
--
-- WHY IN POSTGRES
-- ───────────────
--   1. The 1,000-row select cap. June alone carries 9,739 recipient rows, and
--      May carries 5,536 consent rows. Counting them in the route returns the
--      first 1,000 and reports a confident, wrong number with no error.
--   2. campaign_recipients carries NO location_id. It comes off the campaign,
--      so the tenant filter is a JOIN. Through a PostgREST embed that silently
--      breaks head:true counts (CLASSIFY.1).
--
-- WHAT COUNTS AS WHAT, ON THE SEND SIDE
-- ─────────────────────────────────────
-- SENDS are CAMPAIGN sends only: campaign_recipients rows with a sent_at.
-- campaign-sender stamps sent_at only when Postmark accepts the message, so a
-- retried or failed recipient is correctly absent. SEQUENCE AND TRANSACTIONAL
-- EMAIL ARE NOT HERE AT ALL — they live in email_sends and never touch
-- campaign_recipients. The surface labels the column "campaign sends" for that
-- reason: the growth half above covers unsubscribes from ALL email while this
-- half covers campaigns, and a column labelled plain "sends" would be claiming
-- something it is not counting.
--
-- CAMPAIGNS is distinct campaign_id among those sends, so a campaign whose
-- send spans midnight on the 1st appears in both months, and an automatic
-- resend to non-openers (mig 506) counts as its own campaign because it IS its
-- own campaigns row. A/B variants share one campaign_id (mig 398) and do not
-- double count.
--
-- Send-time REJECTIONS (Postmark 300 invalid / 406 inactive) are deliberately
-- absent from every month: campaign-sender writes status='bounced' and
-- bounce_type='rejected' WITHOUT a sent_at, so there is no instant to assign
-- them to, and counting them as bounces while they are not in the denominator
-- would inflate the rate. They stay visible, all-time, in
-- email_bounce_type_summary (mig 515).
--
-- OPENS are opened_at, which is pixel-based: provider-side prefetching (Apple
-- Mail Privacy Protection and similar) opens a share of mail nobody read. The
-- open rate is a direction of travel, not a number to judge against a line,
-- and the surface carries no band for it.
--
-- CONSENT SCOPING. consent_log.location_id (mig 487) is nullable and is NOT
-- written by applyMarketingPreferencesBulk, which is the path every webhook
-- unsubscribe takes. Filtering on it alone would report close to zero
-- departures for every location. The scope is therefore
-- coalesce(consent_log.location_id, contacts.location_id).
--
-- The channel filter is 'email_marketing' exactly, matching what
-- marketing-consent.js writes. SMS and WhatsApp consent live in the same table
-- under different channels and are a different list.
--
-- ACTION VOCABULARY. opt_in / opt_out only. Mig 516 unified the column and
-- added a CHECK, so the legacy opted_in / opted_out spellings cannot come
-- back; reintroducing them here would re-open the trap mig 488 worked around.
--
-- MONTHS ARE EUROPE/DUBLIN, matching the rest of the repo (migs 420, 421,
-- 448). A send at 00:30 Dublin on 1 June is a June send; bucketing it in UTC
-- would file it under May for half the year and not the other half.
--
-- EMPTY MONTHS ARE RETURNED. The grid is generated first and the aggregates
-- are left-joined onto it, so a month with departures and no campaigns still
-- appears. A missing month reads as a month where nothing happened, and the
-- point here is that departures keep happening between sends.
--
-- NO NEW INDEXES. consent_log is ~14k rows and campaign_recipients is in the
-- tens of thousands; a sequential scan behind a page an operator opens
-- occasionally is cheaper than an index every send has to maintain. Revisit if
-- either table grows an order of magnitude.

-- The first draft of this function took (uuid, int) and summed the consent
-- column blind. Changing the argument list makes CREATE OR REPLACE mint a
-- second OVERLOAD rather than replace it, so the broken version would keep
-- answering any two-argument call. It was never applied to production, but
-- dropping it is one line and removes the possibility entirely — including in
-- any scratch database where the first draft was tried.
drop function if exists public.list_health_monthly_stats(uuid, int);

create or replace function public.list_health_monthly_stats(
  p_location_id uuid,
  p_months int default 12,
  -- The consent-source categories, from src/lib/consent-sources.js. Empty by
  -- default ON PURPOSE: a caller that omits them gets everything in
  -- consent_unknown, which the surface renders as an unclassified bucket.
  -- Silence is what this parameterisation exists to prevent.
  p_voluntary_sources      text[] default '{}',
  p_deliverability_sources text[] default '{}',
  p_policy_sources         text[] default '{}',
  p_bulk_sources           text[] default '{}'
)
returns table (
  month           date,

  -- Send side (campaigns only).
  campaigns       bigint,
  sends           bigint,
  bounces         bigint,
  hard_bounces    bigint,
  complaints      bigint,
  opens           bigint,
  bounce_rate     numeric,
  complaint_rate  numeric,
  open_rate       numeric,

  -- Growth side. The _counted columns are the only ones in net_list_change;
  -- the rest are returned so the surface can show the composition.
  opt_ins_counted      bigint,
  opt_ins_bulk         bigint,
  unsubscribes_counted bigint,
  unsub_voluntary      bigint,
  unsub_deliverability bigint,
  unsub_policy         bigint,
  unsub_bulk           bigint,
  consent_unknown      bigint,
  unknown_sources      text[],

  net_list_change bigint
)
language sql
stable
-- SECURITY INVOKER, mirroring campaign_outcome_stats (513) and
-- email_bounce_type_summary (515): the only caller is the service-role client,
-- which bypasses RLS anyway, so DEFINER buys nothing while turning a future
-- accidental grant to `authenticated` into a cross-tenant read. The function
-- takes a bare location uuid and does NO access check of its own — the caller
-- runs assertLocationAccess first.
security invoker
set search_path = public
as $$
  with span as (
    select date_trunc('month', (now() at time zone 'Europe/Dublin'))::date as last_month,
           -- Clamped, not trusted. The parameter reaches this from a page.
           greatest(1, least(coalesce(p_months, 12), 36)) as n
  ),
  grid as (
    -- Explicit column alias and explicit casts. A bare `generate_series(...) g`
    -- leaves `g` meaning both the alias and its single column, and the OUT
    -- parameter names of this function are in scope in its body — neither is
    -- worth leaving to resolution rules in a query that decides what an
    -- operator believes about their list.
    select gs.ts::date as month
      from span sp,
           generate_series(
             (sp.last_month - make_interval(months => sp.n - 1))::timestamp,
             sp.last_month::timestamp,
             interval '1 month'
           ) as gs(ts)
  ),
  bounds as (
    -- The window start as a real instant: Dublin midnight on the first day of
    -- the earliest month, converted back to UTC. Comparing a timestamptz
    -- column against a Dublin-local date without this is the bug that files
    -- the first hour of every month in the wrong one.
    select (min(g.month)::timestamp at time zone 'Europe/Dublin') as from_ts from grid g
  ),
  send_months as (
    select date_trunc('month', (r.sent_at at time zone 'Europe/Dublin'))::date as month,
           count(distinct r.campaign_id)                                as campaigns,
           count(*)                                                     as sends,
           count(*) filter (where r.bounce_type is not null)            as bounces,
           -- lower/btrim, matching email_bounce_type_summary (mig 515): the
           -- column is free text written by two different code paths.
           count(*) filter (where btrim(lower(r.bounce_type)) = 'hard')  as hard_bounces,
           count(*) filter (where r.complained_at is not null)           as complaints,
           count(*) filter (where r.opened_at is not null)               as opens
      from public.campaign_recipients r
      join public.campaigns c on c.id = r.campaign_id
     where c.location_id = p_location_id
       and r.sent_at is not null
       and r.sent_at >= (select b.from_ts from bounds b)
     group by 1
  ),
  consent_raw as (
    -- One row per consent event, bucketed, with the source normalised the same
    -- way as bounce_type: the column is free text written by a dozen call
    -- sites and one Postgres trigger. A blank source becomes 'unrecorded',
    -- which is in no category array and therefore lands in unknown — visible,
    -- which is the point.
    select date_trunc('month', (cl.created_at at time zone 'Europe/Dublin'))::date as month,
           cl.action,
           coalesce(nullif(btrim(lower(cl.source)), ''), 'unrecorded') as source
      from public.consent_log cl
      join public.contacts ct on ct.id = cl.contact_id
     where coalesce(cl.location_id, ct.location_id) = p_location_id
       and cl.channel = 'email_marketing'
       and cl.created_at is not null
       and cl.created_at >= (select b.from_ts from bounds b)
  ),
  consent_rows as (
    -- Categorised against the arrays the caller passed. Order matters only in
    -- that a source listed twice would take the first match; consent-sources.js
    -- asserts each source appears in exactly one array.
    select cr.month,
           cr.action,
           cr.source,
           case
             when cr.source = any(coalesce(p_voluntary_sources,      '{}')) then 'voluntary'
             when cr.source = any(coalesce(p_deliverability_sources, '{}')) then 'deliverability'
             when cr.source = any(coalesce(p_policy_sources,         '{}')) then 'policy'
             when cr.source = any(coalesce(p_bulk_sources,           '{}')) then 'bulk'
             else 'unknown'
           end as category
      from consent_raw cr
  ),
  consent_months as (
    select cr.month,
           -- SAME category set on both sides of the net, deliberately: an
           -- opt-in from a bulk migration is not somebody joining, for exactly
           -- the reason a bulk opt-out is not somebody leaving, and the import
           -- writes in both directions. (No policy source opts anybody IN --
           -- the mig 512 trigger only ever writes opt_out -- so the symmetry
           -- costs nothing today and stays correct if that ever changes.)
           count(*) filter (where cr.action = 'opt_in'  and cr.category in ('voluntary', 'deliverability')) as opt_ins_counted,
           count(*) filter (where cr.action = 'opt_in'  and cr.category = 'bulk')                           as opt_ins_bulk,
           count(*) filter (where cr.action = 'opt_out' and cr.category in ('voluntary', 'deliverability')) as unsubscribes_counted,
           count(*) filter (where cr.action = 'opt_out' and cr.category = 'voluntary')                                as unsub_voluntary,
           count(*) filter (where cr.action = 'opt_out' and cr.category = 'deliverability')                           as unsub_deliverability,
           count(*) filter (where cr.action = 'opt_out' and cr.category = 'policy')                                   as unsub_policy,
           count(*) filter (where cr.action = 'opt_out' and cr.category = 'bulk')                                     as unsub_bulk,
           count(*) filter (where cr.category = 'unknown')                                                            as consent_unknown,
           -- Named, not just counted. "3 rows from a source nobody has
           -- classified" is not actionable; "3 rows from glofox_sync_2027" is.
           array_agg(distinct cr.source) filter (where cr.category = 'unknown')                                       as unknown_sources
      from consent_rows cr
     group by cr.month
  )
  select
    g.month,
    coalesce(s.campaigns, 0)::bigint,
    coalesce(s.sends, 0)::bigint,
    coalesce(s.bounces, 0)::bigint,
    coalesce(s.hard_bounces, 0)::bigint,
    coalesce(s.complaints, 0)::bigint,
    coalesce(s.opens, 0)::bigint,
    -- NULL, not 0, when nothing was sent. A zero bounce rate on zero sends is
    -- a claim about deliverability that no send was made to support.
    case when coalesce(s.sends, 0) > 0 then round(s.bounces::numeric    / s.sends, 6) end,
    case when coalesce(s.sends, 0) > 0 then round(s.complaints::numeric / s.sends, 6) end,
    case when coalesce(s.sends, 0) > 0 then round(s.opens::numeric      / s.sends, 6) end,
    coalesce(cm.opt_ins_counted, 0)::bigint,
    coalesce(cm.opt_ins_bulk, 0)::bigint,
    coalesce(cm.unsubscribes_counted, 0)::bigint,
    coalesce(cm.unsub_voluntary, 0)::bigint,
    coalesce(cm.unsub_deliverability, 0)::bigint,
    coalesce(cm.unsub_policy, 0)::bigint,
    coalesce(cm.unsub_bulk, 0)::bigint,
    coalesce(cm.consent_unknown, 0)::bigint,
    coalesce(cm.unknown_sources, '{}')::text[],
    (coalesce(cm.opt_ins_counted, 0) - coalesce(cm.unsubscribes_counted, 0))::bigint
  from grid g
  left join send_months    s  on s.month  = g.month
  left join consent_months cm on cm.month = g.month
  order by g.month;
$$;

comment on function public.list_health_monthly_stats(uuid, int, text[], text[], text[], text[]) is
  'GAPS-P7 (mig 517) — monthly list growth and deliverability for one location, bucketed in Europe/Dublin. CONSENT SOURCES ARE CATEGORISED, NOT SUMMED: the four source arrays come from src/lib/consent-sources.js (this function holds no copy of the vocabulary) and default to empty, so a caller that omits them sees everything as consent_unknown rather than silently as churn. net_list_change = opt_ins_counted - unsubscribes_counted, which is voluntary + deliverability only. Bulk migrations (5,519 rows landed on 2026-05-13 alone) and the auto_classpass standing rule are excluded from the net and returned separately for display; an unmapped source is counted in consent_unknown and NAMED in unknown_sources. Send-side figures are CAMPAIGN sends only (campaign_recipients with a sent_at) — sequence and transactional email live in email_sends and are not counted here. Send-time rejections carry no sent_at and appear in no month (see email_bounce_type_summary, mig 515). Rates are NULL when the month had no sends; the minimum denominator for reporting one is in src/lib/list-health-trend.js. service_role only.';

revoke execute on function public.list_health_monthly_stats(uuid, int, text[], text[], text[], text[])
  from public, anon, authenticated;
grant execute on function public.list_health_monthly_stats(uuid, int, text[], text[], text[], text[])
  to service_role;
