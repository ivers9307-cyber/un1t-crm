-- 521 — REPORT-SOT: one source per displayed number.
--
-- Two functions, one migration, because they close the same hole from two
-- ends: a reporting surface that reads a number from a place that is not the
-- record of what happened.
--
-- ════════════════════════════════════════════════════════════════════════
-- PART 1 — email_sends_monthly_stats: non-campaign email gets a deliverability view
-- ════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS. list_health_monthly_stats (mig 517) reads
-- campaign_recipients, so it covers CAMPAIGN email and nothing else. Its own
-- comment says so, and the surface labels the column "campaign sends" for
-- exactly that reason. Sequence, transactional and inbox-reply mail lives in
-- email_sends and has no deliverability view at all — so a reputation problem
-- that starts there is invisible on the one page built to catch reputation
-- problems. All of it leaves on the same sending domain.
--
-- ⚠️ THE VOLUME IS TINY, AND THAT IS THE POINT. Measured live 2026-08-10:
--
--     source_type      rows    bounces  opens  complaints  span
--     campaign        19,095       217  7,786           1  2026-05-13 .. 2026-08-09
--     transactional      111         3     90           0  2026-06-17 .. 2026-08-10
--     inbox_reply          1         0      0           0  2026-08-07
--
-- There are ZERO 'sequence' rows: that source_type value does not occur,
-- because the estate has one active sequence. So non-campaign volume is 111
-- emails and 3 bounces, against the 500-send minimum denominator
-- src/lib/list-health-trend.js already enforces. A rate-based panel would
-- read "Not enough sends" in every month it could ever draw — an empty chart
-- implying data exists when it does not.
--
-- This function therefore ships the PLUMBING and the surface shows COUNTS.
-- The threshold logic is not duplicated: src/lib/email-source-trend.js reuses
-- readRate / MIN_RATE_SENDS from list-health-trend.js, so the moment a month
-- crosses the floor the same component prints the rate and its band with no
-- second code path and no manual switch.
--
-- WHY IN POSTGRES. The 1,000-row select cap. email_sends carries 19,207 rows;
-- counting them in the page would return the first 1,000 and report a
-- confident, wrong number with no error. Same reason as mig 517.
--
-- WHAT COUNTS AS WHAT
--   * SENDS are email_sends rows with a sent_at. The column defaults to now()
--     and every live row carries one, so in practice this is "every row" — the
--     filter is there so a future writer that inserts a row before handing the
--     message to Postmark cannot silently inflate the denominator.
--   * BOUNCES key on bounce_type, NOT bounced_at. Established by migs 515 and
--     518: a bounce recorded by the sender went years without a timestamp, and
--     518 deliberately left 19 rows NULL rather than invent one. Keying on the
--     type is what stops a missing timestamp hiding a bounce.
--   * OPENS are opened_at, which is pixel-based, and since EMAIL-NOTRACK.1
--     (2026-08-07) TrackOpens is OFF for every non-broadcast stream. So the
--     transactional open rate is not comparable to a campaign open rate and
--     the surface says so rather than putting them in one column.
--   * COMPLAINTS are complained_at.
--
-- SOURCE TYPES ARE NORMALISED, NEVER MAPPED HERE. lower/btrim, blank becomes
-- 'unrecorded'. The operator-facing label lives in one place in JS; a
-- source_type this function has never seen is returned by name and rendered by
-- name rather than dropped. Same posture as unknown_sources in mig 517.
--
-- TENANT SCOPE is coalesce(email_sends.location_id, contacts.location_id).
-- The column is populated on every live row (19,206/19,206 per the CONSENTLOC.1
-- note in postmark-webhook-processor.js), but it is NULLABLE, and a row that
-- lost it would otherwise vanish from every location rather than appear in the
-- contact's own. Mig 517 scopes consent_log the same way for the same reason.
--
-- MONTHS ARE EUROPE/DUBLIN and EMPTY MONTHS ARE RETURNED: the month grid is
-- crossed with the source types actually observed in the window and the
-- aggregates are left-joined onto it, so a source that went quiet reads as
-- quiet rather than disappearing. The surface drops the empty rows from the
-- table and states how many months in the window carried nothing, which is a
-- display decision, not a data one.
--
-- NO NEW INDEXES. idx_email_sends_sent_at and idx_email_sends_location exist
-- (mig 005) and the table is ~19k rows behind a page an operator opens
-- occasionally. Revisit at an order of magnitude.

create or replace function public.email_sends_monthly_stats(
  p_location_id uuid,
  p_months int default 12
)
returns table (
  month          date,
  source_type    text,
  sends          bigint,
  bounces        bigint,
  hard_bounces   bigint,
  complaints     bigint,
  opens          bigint,
  bounce_rate    numeric,
  complaint_rate numeric,
  open_rate      numeric
)
language sql
stable
-- SECURITY INVOKER, mirroring migs 513/515/517: the only caller is the
-- service-role client, which bypasses RLS anyway, so DEFINER buys nothing
-- while turning a future accidental grant to `authenticated` into a
-- cross-tenant read. The function takes a bare location uuid and does NO
-- access check of its own — the caller runs assertLocationAccess first.
security invoker
set search_path = public
as $$
  with span as (
    select date_trunc('month', (now() at time zone 'Europe/Dublin'))::date as last_month,
           -- Clamped, not trusted. The parameter reaches this from a page.
           greatest(1, least(coalesce(p_months, 12), 36)) as n
  ),
  grid as (
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
    -- column against a Dublin-local date without this files the first hour of
    -- every month in the wrong one.
    select (min(g.month)::timestamp at time zone 'Europe/Dublin') as from_ts from grid g
  ),
  scoped as (
    select date_trunc('month', (es.sent_at at time zone 'Europe/Dublin'))::date as month,
           coalesce(nullif(btrim(lower(es.source_type)), ''), 'unrecorded')     as source_type,
           es.bounce_type,
           es.complained_at,
           es.opened_at
      from public.email_sends es
      left join public.contacts ct on ct.id = es.contact_id
     where coalesce(es.location_id, ct.location_id) = p_location_id
       and es.sent_at is not null
       and es.sent_at >= (select b.from_ts from bounds b)
  ),
  source_types as (
    select distinct s.source_type from scoped s
  ),
  agg as (
    select s.month,
           s.source_type,
           count(*)                                                          as sends,
           count(*) filter (where s.bounce_type is not null)                 as bounces,
           -- lower/btrim, matching migs 515 and 517: the column is free text
           -- written by two different code paths.
           count(*) filter (where btrim(lower(s.bounce_type)) = 'hard')      as hard_bounces,
           count(*) filter (where s.complained_at is not null)               as complaints,
           count(*) filter (where s.opened_at is not null)                   as opens
      from scoped s
     group by s.month, s.source_type
  )
  select
    g.month,
    st.source_type,
    coalesce(a.sends, 0)::bigint,
    coalesce(a.bounces, 0)::bigint,
    coalesce(a.hard_bounces, 0)::bigint,
    coalesce(a.complaints, 0)::bigint,
    coalesce(a.opens, 0)::bigint,
    -- NULL, not 0, when nothing was sent. A zero bounce rate on zero sends is
    -- a claim about deliverability that no send was made to support.
    case when coalesce(a.sends, 0) > 0 then round(a.bounces::numeric    / a.sends, 6) end,
    case when coalesce(a.sends, 0) > 0 then round(a.complaints::numeric / a.sends, 6) end,
    case when coalesce(a.sends, 0) > 0 then round(a.opens::numeric      / a.sends, 6) end
  from grid g
  cross join source_types st
  left join agg a on a.month = g.month and a.source_type = st.source_type
  order by st.source_type, g.month;
$$;

comment on function public.email_sends_monthly_stats(uuid, int) is
  'REPORT-SOT (mig 521) — monthly deliverability for email_sends at one location, broken down by source_type, bucketed in Europe/Dublin. This is the NON-CAMPAIGN counterpart to list_health_monthly_stats (mig 517), which reads campaign_recipients and covers campaigns only. Sends are rows with a sent_at; bounces key on bounce_type not bounced_at (migs 515/518 — a missing timestamp must not hide a bounce); opens are pixel-based and TrackOpens is off for non-broadcast streams, so a transactional open rate is not comparable to a campaign one. Source types are normalised (lower/btrim, blank becomes unrecorded) and returned by name — the operator-facing labels live in src/lib/email-source-trend.js and this function holds no copy. Live volume is 111 non-campaign sends against a 500-send minimum denominator, so the surface shows COUNTS and switches to rates automatically when a month crosses the floor. Rates are NULL when the month had no sends. service_role only.';

revoke execute on function public.email_sends_monthly_stats(uuid, int)
  from public, anon, authenticated;
grant execute on function public.email_sends_monthly_stats(uuid, int)
  to service_role;


-- ════════════════════════════════════════════════════════════════════════
-- PART 2 — campaign_recipient_stats: the displayed campaign figures get one source
-- ════════════════════════════════════════════════════════════════════════
--
-- THE PROBLEM. campaigns.total_* and campaign_recipients disagree about the
-- same campaign, and the surfaces read the counters. Measured live 2026-08-10
-- across the 14 sent campaigns, the counters are wrong in a consistent
-- direction on the number that matters most for reputation:
--
--     campaign                    total_bounced   recipients bounced
--     Hatch Street Announcement              14                   54
--     Email 12 Jun 22:50                      5                   42
--     Email 12 Jun 23:18                      0                   40
--     Train for FREE (5 Aug)                  4                   41
--     Email 8 Aug 21:11                       2                   21
--     Summer sale recovery (9 Aug)            4                   27
--
-- The counters are computed by recalculate_campaign_stats (mig 157) from
-- email_sends. A SEND-TIME REJECTION (Postmark 300 invalid / 406 inactive)
-- never gets an email_sends row at all — campaign-sender writes it straight
-- onto campaign_recipients as status='bounced', bounce_type='rejected'. So
-- every rejection is invisible to the counter and visible on the recipient
-- row. campaign_recipients is the record of what happened to each intended
-- recipient; the counters are a rollup of a partial view of it.
--
-- ⚠️ THE STORED COUNTERS ARE NOT BEING REPAIRED. Explicit product decision:
-- leave the history on disk, fix what is displayed. Nothing here writes.
-- recalculate_campaign_stats and increment_campaign_metric are untouched and
-- still run — the counters remain the cheap mid-send progress signal that
-- CampaignEditor's progress bar polls through the RLS-bound browser client,
-- where an rpc would need a service-role route it does not have.
--
-- WHY NOT REUSE recalculate_campaign_stats. It is an UPDATE. Calling it from a
-- read path would rewrite the stored history this decision exists to preserve,
-- and it reads email_sends, which is the source being moved away from. No
-- existing function aggregates campaign_recipients per campaign, so this is a
-- new READ-ONLY one.
--
-- ARRAY ARGUMENT, ON PURPOSE. /communications/sent lists up to 100 campaigns.
-- One call per campaign is 100 round trips on a page render; six count-only
-- selects per campaign is 600. One call takes the ids.
--
-- WHAT COUNTS AS WHAT
--   * recipients — every row. The intended audience, including anything queued
--     and never dispatched.
--   * sent — sent_at is not null. Same definition as mig 517, so the campaign
--     page and the list-health table cannot disagree about a send.
--   * delivered — delivered_at is not null.
--   * opened / clicked — opened_at / clicked_at.
--   * bounced — bounce_type is not null (migs 515/518, as above). This INCLUDES
--     send-time rejections, which carry no sent_at, so bounced can exceed what
--     a naive reading of sent would predict. That is the honest count: the
--     address failed.
--   * complained / unsubscribed — complained_at / unsubscribed_at.
--   * failed — status = 'failed' (mig 392, attempt cap exhausted). Distinct
--     from bounced: nothing was refused, the send never completed.
--
-- NO ACCESS CHECK HERE. Takes bare campaign uuids and does no tenant filtering
-- of its own; every caller resolves the campaigns through a location-scoped
-- query first (assertLocationAccess on the detail page, location_id equality on
-- the sends list). service_role only, so /rest/v1/rpc cannot be used to probe a
-- campaign id.
--
-- NO NEW INDEXES. idx_campaign_recipients_campaign (mig 005) serves the whole
-- query; the table is in the tens of thousands of rows.

create or replace function public.campaign_recipient_stats(p_campaign_ids uuid[])
returns table (
  campaign_id  uuid,
  recipients   bigint,
  sent         bigint,
  delivered    bigint,
  opened       bigint,
  clicked      bigint,
  bounced      bigint,
  complained   bigint,
  unsubscribed bigint,
  failed       bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    r.campaign_id,
    count(*)::bigint,
    count(*) filter (where r.sent_at         is not null)::bigint,
    count(*) filter (where r.delivered_at    is not null)::bigint,
    count(*) filter (where r.opened_at       is not null)::bigint,
    count(*) filter (where r.clicked_at      is not null)::bigint,
    count(*) filter (where r.bounce_type     is not null)::bigint,
    count(*) filter (where r.complained_at   is not null)::bigint,
    count(*) filter (where r.unsubscribed_at is not null)::bigint,
    count(*) filter (where r.status = 'failed')::bigint
  from public.campaign_recipients r
  where r.campaign_id = any(coalesce(p_campaign_ids, '{}'::uuid[]))
  group by r.campaign_id;
$$;

comment on function public.campaign_recipient_stats(uuid[]) is
  'REPORT-SOT (mig 521) — per-campaign engagement counted from campaign_recipients, the record of what happened to each intended recipient. READ ONLY. This is the single source for every DISPLAYED campaign figure; campaigns.total_* stays written and stays on disk as the mid-send progress signal, and its history is deliberately NOT repaired. The counters come from email_sends (recalculate_campaign_stats, mig 157), which never sees a send-time rejection because campaign-sender writes those straight onto campaign_recipients — live that is 40 bounces reported as 0 on one June campaign. Bounces key on bounce_type not bounced_at (migs 515/518). Takes an array so a 100-row sends list is one call. No tenant filter of its own: callers resolve campaigns through a location-scoped query first. service_role only.';

revoke execute on function public.campaign_recipient_stats(uuid[])
  from public, anon, authenticated;
grant execute on function public.campaign_recipient_stats(uuid[])
  to service_role;
