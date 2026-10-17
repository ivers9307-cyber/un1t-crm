-- 733 — UN1TBOOK.1: class_bookings.source_platform — which platform a
-- booking row came from — plus a CHECK tying the platform to its id
-- namespace, and campaign_outcome_stats counting CANCELLED correctly.
--
-- APPLY ORDER. Applied to prod by the controller BEFORE merge, and so before
-- the code that filters on it deploys: send-class-booking-reminders and
-- credit-attendance will filter .eq('source_platform', 'glofox'), and a
-- PostgREST filter on a column that does not exist fails the WHOLE query
-- (Stillorgan's class reminders would stop). The column default keeps every
-- existing writer (the Glofox member sync) working unchanged before and after.
--
-- WHY. class_bookings (mig 288) is the per-class booking roster. Only Glofox
-- filled it. Hatch Street runs on un1t.online (UN1TSYNC.1, mig 726), and its
-- bookings are now projected into the same table (twin of mig 730 on
-- class_occurrences), so the scorecard, the live-class roster and the
-- campaign report see Hatch visits. The CRM's customer messaging must NOT see
-- them: un1t.online sends its own reminders and owns its own credits, so the
-- reminder and crediting crons read only source_platform = 'glofox'.
--
-- VALUES. 'glofox' (every existing row, via the column default) and
-- 'un1t_online'. A third platform is a new migration by design.
--
-- ID NAMESPACE. A un1t_online row carries glofox_booking_id = 'un1t:' ||
-- un1t_bookings.un1t_id and glofox_event_id = 'un1t:' || un1t_bookings.event_id
-- (the same prefix mig 730 gives class_occurrences.glofox_event_id). The
-- prefix cannot collide with a Glofox 24-hex id, which matters because several
-- readers look glofox_event_id up with no location filter. The namespace
-- CHECK makes it structural in both directions: a un1t: id on a row that
-- forgot source_platform (so defaulted to 'glofox', and would be reminded and
-- credited) is REFUSED, and so is a un1t_online row without the prefix on
-- either id. Both ids are NOT NULL (mig 288), so the CHECK never sees NULL.
-- Added NOT VALID then validated in this file: prod had 10,553 rows and none
-- with a un1t: id on 17 Oct 2026, so the scan is short and passes.
--
-- CAMPAIGN STATS. campaign_outcome_stats (mig 513) excluded
-- `b.status is distinct from 'cancelled'`, lower case, while class_bookings
-- statuses are upper case (Glofox's BOOKED / WAITING, and the projection's
-- CANCELLED): a cancelled booking would have counted as an attendance. The
-- body below is mig 513's verbatim except that one filter, now
-- upper(coalesce(b.status, '')) <> 'CANCELLED' (a NULL status still counts,
-- as before). CREATE OR REPLACE keeps the ACL and the comment; the EXECUTE
-- decision is restated anyway (FNEXECSWEEP.1, mig 667).
--
-- COMMENTS. Besides the new column, this file refreshes the comments that
-- went stale with the projection: class_bookings (mig 288, Glofox-only),
-- un1t_bookings (mig 726), and class_occurrences.source_platform and
-- un1t_events (mig 730, which said un1t_online classes had no
-- class_bookings rows).
--
-- GRANT. None. class_bookings is NOT column-granted: authenticated holds
-- table-level SELECT (with INSERT/UPDATE/DELETE, kept by mig 677) and RLS has
-- only the location-scoped SELECT policy of mig 288, so the new column is
-- readable by the phone and browser the moment it exists, a select naming it
-- cannot fail whole, and no client can write it. anon holds nothing.
--
-- One transaction with a 5s lock_timeout (ADD COLUMN … NOT NULL DEFAULT is
-- metadata-only but takes ACCESS EXCLUSIVE on a table the webhooks and crons
-- write). Re-runnable. The self-check reads the catalog, never this file's
-- text, and aborts the whole file.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.class_bookings
  ADD COLUMN IF NOT EXISTS source_platform text NOT NULL DEFAULT 'glofox'
    CONSTRAINT class_bookings_source_platform_check CHECK (source_platform IN ('glofox', 'un1t_online'));

ALTER TABLE public.class_bookings DROP CONSTRAINT IF EXISTS class_bookings_source_namespace_check;
ALTER TABLE public.class_bookings
  ADD CONSTRAINT class_bookings_source_namespace_check CHECK (
    (source_platform = 'un1t_online') = (glofox_booking_id LIKE 'un1t:%')
    AND (source_platform = 'un1t_online') = (glofox_event_id LIKE 'un1t:%')
  ) NOT VALID;
ALTER TABLE public.class_bookings VALIDATE CONSTRAINT class_bookings_source_namespace_check;

COMMENT ON COLUMN public.class_bookings.source_platform IS
  'UN1TBOOK.1 (mig 733) — glofox | un1t_online. Where the booking was projected from. un1t_online rows carry glofox_booking_id = ''un1t:'' || un1t_bookings.un1t_id and glofox_event_id = ''un1t:'' || un1t_bookings.event_id, and class_bookings_source_namespace_check refuses any row whose platform and id prefix disagree. The CRM never reminds or credits un1t_online rows: send-class-booking-reminders and credit-attendance filter source_platform = ''glofox''.';

-- Refresh mig 726's table comment, which said the projection was not written.
COMMENT ON TABLE public.un1t_bookings IS
  'UN1TSYNC.1 (mig 726) / UN1TBOOK.1 (mig 733): un1t.online bookings, without guest details. Projected into class_bookings with source_platform = ''un1t_online'', glofox_booking_id = ''un1t:'' || un1t_id and glofox_event_id = ''un1t:'' || event_id; the CRM never reminds or credits those rows. Service role only; the sync upserts and never deletes.';

-- Refresh mig 288's table comment, which described a Glofox-only roster.
COMMENT ON TABLE public.class_bookings IS
  'HR-CLASS-ALLOC.2 (mig 288) / UN1TBOOK.1 (mig 733): per-event booking roster from Glofox (assembled from per-member /2.0/bookings fetches) and un1t.online (projected by the un1t.online sync), distinguished by source_platform. Drives the booked tag, the coach roster panel and the scorecard''s no-show and attended visits. The CRM reminds and credits only source_platform = ''glofox'' rows.';

-- Refresh mig 730's column and table comments, which said un1t_online
-- classes had no class_bookings rows (they do from this migration on).
COMMENT ON COLUMN public.class_occurrences.source_platform IS
  'UN1TCLASS.1 (mig 730) / UN1TBOOK.1 (mig 733) — glofox | un1t_online. Where the occurrence was projected from. un1t_online rows carry glofox_event_id = ''un1t:'' || un1t_events.un1t_id (the prefix cannot collide with a Glofox 24-hex id). Their bookings are projected into class_bookings (source_platform = ''un1t_online'', same un1t: event id), so no-show and attended come from those rows; the CRM never reminds or credits them.';

COMMENT ON TABLE public.un1t_events IS
  'UN1TSYNC.1 (mig 726) / UN1TCLASS.1 (mig 730) / UN1TBOOK.1 (mig 733): un1t.online classes and events, projected into class_occurrences with source_platform = ''un1t_online'' and glofox_event_id = ''un1t:'' || un1t_id; their bookings are projected into class_bookings with the same event id. Service role only; the sync upserts and never deletes.';

-- mig 513's function, verbatim except the class_bookings status filter.
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
   and upper(coalesce(b.status, '')) <> 'CANCELLED'
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

revoke execute on function public.campaign_outcome_stats(uuid, int) from public, anon, authenticated;
grant  execute on function public.campaign_outcome_stats(uuid, int) to service_role;

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text (mig 153's lesson).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  col record;
  chk text;
  ns record;
  fn record;
BEGIN
  SELECT is_nullable, column_default, data_type INTO col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'class_bookings' AND column_name = 'source_platform';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UN1TBOOK.1: class_bookings.source_platform does not exist';
  END IF;
  IF col.data_type <> 'text' OR col.is_nullable <> 'NO' THEN
    RAISE EXCEPTION 'UN1TBOOK.1: source_platform must be text NOT NULL (got % / nullable=%)', col.data_type, col.is_nullable;
  END IF;
  IF col.column_default IS NULL OR col.column_default NOT LIKE '''glofox''%' THEN
    RAISE EXCEPTION 'UN1TBOOK.1: source_platform default must be ''glofox'' (got %)', col.column_default;
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO chk
    FROM pg_constraint c
   WHERE c.conrelid = 'public.class_bookings'::regclass
     AND c.conname = 'class_bookings_source_platform_check';
  IF chk IS NULL OR chk NOT LIKE '%glofox%' OR chk NOT LIKE '%un1t_online%' THEN
    RAISE EXCEPTION 'UN1TBOOK.1: the source_platform CHECK is missing or does not admit both values (got %)', chk;
  END IF;

  SELECT pg_get_constraintdef(c.oid) AS def, c.convalidated INTO ns
    FROM pg_constraint c
   WHERE c.conrelid = 'public.class_bookings'::regclass
     AND c.conname = 'class_bookings_source_namespace_check';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UN1TBOOK.1: class_bookings_source_namespace_check does not exist';
  END IF;
  IF NOT ns.convalidated THEN
    RAISE EXCEPTION 'UN1TBOOK.1: class_bookings_source_namespace_check is NOT VALID';
  END IF;
  IF ns.def NOT LIKE '%glofox_booking_id%un1t:%%' OR ns.def NOT LIKE '%glofox_event_id%un1t:%%' THEN
    RAISE EXCEPTION 'UN1TBOOK.1: the namespace CHECK must test the un1t: prefix on both ids (got %)', ns.def;
  END IF;

  -- Readable by the phone with no grant line: table-level SELECT must still be there.
  IF NOT has_table_privilege('authenticated', 'public.class_bookings', 'SELECT') THEN
    RAISE EXCEPTION 'UN1TBOOK.1: authenticated lost table-level SELECT on class_bookings';
  END IF;
  IF has_column_privilege('anon', 'public.class_bookings', 'source_platform', 'SELECT') THEN
    RAISE EXCEPTION 'UN1TBOOK.1: anon can read class_bookings.source_platform';
  END IF;
  -- authenticated keeps a table-level INSERT/UPDATE/DELETE (mig 677 kept it),
  -- so the real write barrier is RLS: on, with only the SELECT policy. A
  -- write policy here would let a signed-in session write a row as
  -- 'glofox' and get it reminded and credited.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.class_bookings'::regclass) THEN
    RAISE EXCEPTION 'UN1TBOOK.1: RLS is off on class_bookings';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.class_bookings'::regclass
       AND polcmd IN ('a', 'w', 'd', '*')
  ) THEN
    RAISE EXCEPTION 'UN1TBOOK.1: class_bookings has a write (INSERT/UPDATE/DELETE/ALL) policy; it must be service-role-write only';
  END IF;

  SELECT p.prosrc, p.prosecdef INTO fn
    FROM pg_proc p
   WHERE p.oid = 'public.campaign_outcome_stats(uuid, integer)'::regprocedure;
  IF fn.prosecdef THEN
    RAISE EXCEPTION 'UN1TBOOK.1: campaign_outcome_stats must stay SECURITY INVOKER';
  END IF;
  IF position('upper(coalesce(b.status, '''')) <> ''CANCELLED''' IN fn.prosrc) = 0
     OR fn.prosrc ILIKE '%is distinct from ''cancelled''%' THEN
    RAISE EXCEPTION 'UN1TBOOK.1: campaign_outcome_stats does not carry the CANCELLED filter';
  END IF;
  IF has_function_privilege('anon', 'public.campaign_outcome_stats(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.campaign_outcome_stats(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'UN1TBOOK.1: a client role can execute campaign_outcome_stats; it is service_role only';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.campaign_outcome_stats(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'UN1TBOOK.1: service_role cannot execute campaign_outcome_stats';
  END IF;
  RAISE NOTICE 'UN1TBOOK.1 mig 733: class_bookings.source_platform + namespace CHECK added; campaign_outcome_stats counts CANCELLED correctly.';
END $$;

COMMIT;
