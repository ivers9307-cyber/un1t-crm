-- 721 — TZ.15: the SQL functions and the challenges policy read each studio's
-- own timezone (SaaS timezone wave; plan
-- docs/superpowers/plans/2026-10-11-saas-timezone-wave.md, Task TZ.15 and
-- its Appendix A rows).
--
-- NOT APPLIED YET when this file was written. The orchestrator applies it via
-- the Supabase MCP BEFORE the PR merges, after dumping the live definitions
-- (the PR body has the SQL). Proven ahead of apply by
-- tests/migration-721-zone-aware-sql-functions.test.js (PGlite, the REAL
-- predecessor bodies from 448/517/521/622/641/686 replayed, then this file).
--
-- RULE (TZ.15). A function or policy that turns an instant into a studio's
-- date or wall clock reads that studio's locations.timezone. Every UN1T
-- studio is Europe/Dublin (Q1, 11 Oct), so each expression below evaluates
-- to exactly what it did before there; the PGlite replay proves it.
--
-- WHAT CHANGES
--   1. hyrox_coaches_on_shift (448): the class instant is read on the
--      studio's wall clock (p_location's zone), not Dublin's.
--   2. list_health_monthly_stats (517), email_sends_monthly_stats (521):
--      months are the studio's calendar months (p_location_id's zone).
--   3. tombstone_staff_profile (622): ONLY the "has this shift started?"
--      test. Each shift is judged on its own block's studio clock from the
--      one p_now instant (removed_shifts, kept_today_shifts and its reason).
--      Bans, PII stripping, swaps and the still-ahead pending-leave test
--      (v_today, the Europe/Dublin date) are untouched.
--   4. claim_shift_offer (641): the claimant-overlap check (step 6). Two
--      shifts in the same zone compare exactly as before; shifts in
--      different zones compare as instants.
--   5. challenges_read (686): a member reads an ended challenge until 14
--      days after ends_on on the STUDIO's calendar, not Dublin's.
--   6. Comments: the four billing functions (D5 = B) and the column
--      comments of the wall-clock settings columns.
--
-- WHAT DOES NOT CHANGE (decisions taken 11 Oct)
--   * D5 = B: wallet_apply (420), rollup_usage_for_day,
--     org_ai_spend_month_cents, org_email_sends_month (421) stay on
--     Europe/Dublin, the PLATFORM billing calendar. Their bodies are not
--     touched; each gets a COMMENT naming D5. (TZ.11b / mig 722 dropped.)
--   * locations.timezone keeps DEFAULT 'Europe/Dublin' (mig 719);
--     whatsapp_broadcasts.send_window_tz keeps its default (a drip's zone is
--     written explicitly from the studio since TZ.4; a blast never reads it).
--
-- WHY THE FUNCTIONS READ THE ZONE INLINE, NOT THROUGH private.location_tz.
-- All five rewritten functions are SECURITY INVOKER and service_role is
-- their only caller. service_role holds NO USAGE on schema private (mig 622
-- step 9 and mig 678's census both found it live; nothing since grants it),
-- and an INVOKER body resolves a schema-qualified name as its caller, so a
-- call to private.location_tz() there would fail at run time with "permission
-- denied for schema private". Each body therefore reads
--   COALESCE((SELECT l.timezone FROM public.locations l WHERE l.id = <loc>), 'Europe/Dublin')
-- which is private.location_tz's own expression (mig 719), fallback
-- included. The POLICY does call private.location_tz: a stored policy
-- expression references the function by OID (no schema check), its caller
-- is authenticated (which holds USAGE on private since mig 022 and EXECUTE
-- on location_tz since 719), and location_tz is SECURITY DEFINER, so a
-- member who cannot see the locations row still gets the studio's real zone.
--
-- DUMP BEFORE REWRITE. Every CREATE OR REPLACE keeps the signature, return
-- type, volatility, SECURITY mode, search_path, owner and ACL (CREATE OR
-- REPLACE keeps the OID and the ACL; DROP + CREATE would reset it). Each
-- body replaced is pinned by its normalised md5 (comments and whitespace
-- removed, the 691/699 form): if prod's body is not the migration body this
-- file was written against, the pre-check aborts the whole file and nothing
-- applies. A re-run (this file's bodies already live) passes.
--
-- The REVOKE EXECUTE … FROM PUBLIC, anon, authenticated statements are
-- no-ops on prod (667 / the creating migrations closed all five already);
-- they state the EXECUTE decision tests/function-execute-guard.test.js
-- requires of a file that creates a public function, and the self-check
-- proves every ACL is unchanged.
--
-- ROLLBACK (by hand): the CREATE OR REPLACE statements of 448, 517 (the
-- list_health_monthly_stats one only, not its DROP), 521 (part 1), 622 (the
-- tombstone function) and 641 (the function), verbatim; then 686's ALTER
-- POLICY. Comments need no rollback.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- pg_policies prints a table without its schema only when the schema is on
-- the search_path (the 686 lesson): pinned so the policy text checks hold.
SET LOCAL search_path = public;

-- 0. What the five functions are now, so the self-check can prove nothing
--    but the body moved.
CREATE TEMP TABLE m721_before ON COMMIT DROP AS
  SELECT p.oid, p.oid::regprocedure::text AS fn, coalesce(p.proacl::text, '-') AS acl, p.prosecdef, p.provolatile,
         coalesce(p.proconfig::text, '-') AS cfg, p.proowner, p.prolang,
         pg_get_function_result(p.oid) AS result, pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p
   WHERE p.oid IN (to_regprocedure('public.hyrox_coaches_on_shift(uuid, timestamptz, timestamptz)'),
                   to_regprocedure('public.list_health_monthly_stats(uuid, integer, text[], text[], text[], text[])'),
                   to_regprocedure('public.email_sends_monthly_stats(uuid, integer)'),
                   to_regprocedure('public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean)'),
                   to_regprocedure('public.claim_shift_offer(uuid, uuid)'));

DO $$
DECLARE
  v_bad text;
  v_n int;
BEGIN
  -- a. the zone helper TZ.2 shipped (mig 719) exists and is what this file assumes.
  IF to_regprocedure('private.location_tz(uuid)') IS NULL THEN
    RAISE EXCEPTION 'mig 721: private.location_tz(uuid) is missing; apply mig 719 first';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('private.location_tz(uuid)'))
     OR NOT has_function_privilege('authenticated', 'private.location_tz(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 721: private.location_tz must be SECURITY DEFINER and executable by authenticated (mig 719)';
  END IF;
  -- b. the five bodies this file replaces: the migration bodies (prod), or
  --    this file's own (a re-run). Anything else is a hand edit: re-plan.
  SELECT count(*) INTO v_n FROM m721_before;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'mig 721: expected the 5 functions it rewrites, found %; re-plan', v_n;
  END IF;
  SELECT string_agg(x.f || ' (normalised md5 ' || coalesce(h.h, 'missing') || ')', ', ') INTO v_bad
    FROM (VALUES
      ('public.hyrox_coaches_on_shift(uuid, timestamptz, timestamptz)', '405075898077e294156d52198d010f74', '0c101c2cd24d1b68f522da5cb0004a94'),
      ('public.list_health_monthly_stats(uuid, integer, text[], text[], text[], text[])', '9ed620d8ffbe655c64067b262285f3d7', 'c51e1d4cd96a45ed8786730c7219e34c'),
      ('public.email_sends_monthly_stats(uuid, integer)', '7ea1b0386c4c74864fa0639c0b926f71', '289bd723647cbfff7f1f03a73308bac5'),
      ('public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean)', 'a36ced7bc08b1c3b462bc4f3b4e6f27d', '6bafa95cb80fe3e3d0c7e94b1ec16e21'),
      ('public.claim_shift_offer(uuid, uuid)', 'b48b91379d8546c4b9713fffa2da9efc', 'f23b7ebd8e86b09792169c68c07ebb0c')) AS x(f, old_h, new_h)
    LEFT JOIN LATERAL (
      SELECT md5(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) AS h
        FROM pg_proc p WHERE p.oid = to_regprocedure(x.f)) h ON true
   WHERE h.h IS NULL OR h.h NOT IN (x.old_h, x.new_h);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 721: not the body this file was written against: %; dump it (pg_get_functiondef) and re-plan', v_bad;
  END IF;
  -- c. challenges_read is 686's policy (or this file's, on a re-run) and the only one.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'challenges') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'challenges' AND policyname = 'challenges_read'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}' AND with_check IS NULL
                       AND qual IN ($q$(( SELECT private.auth_is_master() AS auth_is_master) OR private.auth_is_in_location(location_id) OR ((ends_on >= (((now() AT TIME ZONE 'Europe/Dublin'::text))::date - 14)) AND (EXISTS ( SELECT 1
   FROM contacts c
  WHERE ((c.id = ( SELECT private.auth_contact_id() AS auth_contact_id)) AND (c.location_id = challenges.location_id))))))$q$, $q$(( SELECT private.auth_is_master() AS auth_is_master) OR private.auth_is_in_location(location_id) OR ((ends_on >= (((now() AT TIME ZONE ( SELECT private.location_tz(mc.location_id) AS location_tz
   FROM contacts mc
  WHERE (mc.id = ( SELECT private.auth_contact_id() AS auth_contact_id)))))::date - 14)) AND (EXISTS ( SELECT 1
   FROM contacts c
  WHERE ((c.id = ( SELECT private.auth_contact_id() AS auth_contact_id)) AND (c.location_id = challenges.location_id))))))$q$)) THEN
    RAISE EXCEPTION 'mig 721: public.challenges did not start with exactly mig 686''s challenges_read; re-plan';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. hyrox_coaches_on_shift (448): shift_blocks times are wall clock in the
--    STUDIO's zone; the class window is read on that clock.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.hyrox_coaches_on_shift(
  p_location uuid, p_start timestamptz, p_end timestamptz
)
RETURNS TABLE(profile_id uuid)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  -- TZ.15 (mig 721): p_location's zone, read inline (this function runs as
  -- service_role, which holds no USAGE on schema private; same fallback as
  -- private.location_tz, mig 719).
  WITH studio_tz AS (
    SELECT COALESCE((SELECT l.timezone FROM public.locations l WHERE l.id = p_location), 'Europe/Dublin') AS tz
  )
  SELECT DISTINCT a.profile_id
  FROM public.shift_blocks b
  JOIN public.shift_assignments a
    ON a.block_id = b.id
   AND COALESCE(a.status, '') <> 'cancelled'
  CROSS JOIN studio_tz z
  WHERE b.location_id = p_location
    AND b.block_date = (p_start AT TIME ZONE z.tz)::date
    AND (b.block_date + COALESCE(a.start_time_override, b.start_time)) < (p_end   AT TIME ZONE z.tz)
    AND (b.block_date + COALESCE(a.end_time_override,   b.end_time))   > (p_start AT TIME ZONE z.tz);
$$;
REVOKE EXECUTE ON FUNCTION public.hyrox_coaches_on_shift(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. list_health_monthly_stats (517): the studio's calendar months.
-- ═══════════════════════════════════════════════════════════════════════════
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
  with studio_tz as (
    -- TZ.15 (mig 721): months are the STUDIO's calendar months, in its
    -- locations.timezone (Europe/Dublin for every UN1T studio, so unchanged
    -- there). Read inline, not through private.location_tz(): this function
    -- runs as its caller (service_role), which holds no USAGE on schema
    -- private. Same fallback as private.location_tz (mig 719).
    select coalesce((select l.timezone from public.locations l where l.id = p_location_id), 'Europe/Dublin') as tz
  ),
  span as (
    select date_trunc('month', (now() at time zone (select z.tz from studio_tz z)))::date as last_month,
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
    -- The window start as a real instant: the studio's midnight on the first
    -- day of the earliest month, converted back to UTC. Comparing a
    -- timestamptz column against a studio-local date without this is the bug
    -- that files the first hour of every month in the wrong one.
    select (min(g.month)::timestamp at time zone (select z.tz from studio_tz z)) as from_ts from grid g
  ),
  send_months as (
    select date_trunc('month', (r.sent_at at time zone (select z.tz from studio_tz z)))::date as month,
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
    select date_trunc('month', (cl.created_at at time zone (select z.tz from studio_tz z)))::date as month,
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
REVOKE EXECUTE ON FUNCTION public.list_health_monthly_stats(uuid, int, text[], text[], text[], text[]) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. email_sends_monthly_stats (521): the studio's calendar months.
-- ═══════════════════════════════════════════════════════════════════════════
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
  with studio_tz as (
    -- TZ.15 (mig 721): months are the STUDIO's calendar months, in its
    -- locations.timezone (Europe/Dublin for every UN1T studio, so unchanged
    -- there). Read inline, not through private.location_tz(): this function
    -- runs as its caller (service_role), which holds no USAGE on schema
    -- private. Same fallback as private.location_tz (mig 719).
    select coalesce((select l.timezone from public.locations l where l.id = p_location_id), 'Europe/Dublin') as tz
  ),
  span as (
    select date_trunc('month', (now() at time zone (select z.tz from studio_tz z)))::date as last_month,
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
    -- The window start as a real instant: the studio's midnight on the first
    -- day of the earliest month, converted back to UTC. Comparing a
    -- timestamptz column against a studio-local date without this files the
    -- first hour of every month in the wrong one.
    select (min(g.month)::timestamp at time zone (select z.tz from studio_tz z)) as from_ts from grid g
  ),
  scoped as (
    select date_trunc('month', (es.sent_at at time zone (select z.tz from studio_tz z)))::date as month,
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
REVOKE EXECUTE ON FUNCTION public.email_sends_monthly_stats(uuid, int) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. tombstone_staff_profile (622): ONLY "has this shift started?" changes.
--    Security-critical (bans, strips PII, removes only NOT-STARTED shifts):
--    every other statement is byte-for-byte mig 622's.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.tombstone_staff_profile(
  p_profile_id uuid,
  p_actor_id   uuid,
  p_now        timestamptz DEFAULT now(),
  p_dry_run    boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_profile public.profiles;
  v_today   date;
  v_remove  uuid[];
  v_shifts  jsonb;
  v_today_kept jsonb;
  v_swaps   jsonb;
  v_leave   jsonb;
  v_kept    jsonb;
  v_deleted jsonb := '{}'::jsonb;
  v_scrubbed jsonb;
  v_pl_res  text[];
  v_n       integer;
  v_now     timestamptz := now();
  v_note    constant text := 'Cancelled automatically: staff member permanently deleted';
  v_floor   constant text := 'staff';  -- least-privileged role; see the header
  -- Keys stripped from audit payloads, plus pin_* and *phone* by pattern.
  v_pii     constant text[] := ARRAY['email', 'avatar_url', 'email_signature', 'email_signature_rich',
                                     'unifi_user_id', 'unifi_door_ids', 'protect_face_id', 'mobile'];
BEGIN
  IF p_profile_id IS NULL OR p_actor_id IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'staff_bad_args: profile, actor and now are all required';
  END IF;
  -- ONE instant, p_now. TZ.15 (mig 721): each SHIFT is judged on its own
  -- studio's wall clock (w.wall below: p_now in the block's
  -- locations.timezone), the date and the time of day from that one value,
  -- so they agree across midnight and DST changes. Europe/Dublin studios read
  -- exactly what they read before. v_today is the Europe/Dublin date and is
  -- read ONLY by the still-ahead pending-leave test (steps 2 and 6), which
  -- TZ.15 leaves on the platform calendar.
  v_today := (p_now AT TIME ZONE 'Europe/Dublin')::date;
  IF p_profile_id = p_actor_id THEN
    RAISE EXCEPTION 'staff_self_delete: you cannot permanently delete your own account';
  END IF;

  -- 1. Lock the row and re-check the pre-flight inside the transaction.
  SELECT * INTO v_profile FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff_not_found: no profile %', p_profile_id;
  END IF;
  -- Already a tombstone: SAFE to call again. Say so and change nothing (a
  -- retry, a double click, or two masters at once must never re-run the
  -- removal against a later "now").
  IF v_profile.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('profile_id', p_profile_id, 'full_name', v_profile.full_name, 'dry_run', p_dry_run,
      'already_tombstoned', true, 'deleted_at', v_profile.deleted_at,
      'auth_disposition', v_profile.auth_disposition, 'auth_completed_at', v_profile.auth_completed_at,
      'removed_shifts', '[]'::jsonb, 'kept_today_shifts', '[]'::jsonb,
      'cancelled_swaps', '[]'::jsonb, 'cancelled_time_off', '[]'::jsonb,
      'role', jsonb_build_object('from', v_profile.deleted_role, 'to', v_profile.role),
      'deleted', '{}'::jsonb, 'kept', '{}'::jsonb);
  END IF;
  IF v_profile.active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'staff_still_active: deactivate the profile before deleting it';
  END IF;

  -- 2. What goes: assignments whose shift has NOT STARTED (any status). The id
  --    list is computed ONCE and drives the summary, the change log and the
  --    delete, so the three can never disagree. A NULL effective start cannot
  --    happen (shift_blocks.start_time is NOT NULL) but if it did the
  --    comparison is NULL: a shift dated today is then KEPT, one dated in the
  --    future is still removed.
  SELECT COALESCE(array_agg(a.id), ARRAY[]::uuid[])
    INTO v_remove
    FROM public.shift_assignments a
    JOIN public.shift_blocks b ON b.id = a.block_id
    -- TZ.15: the block's studio zone, read inline (this function runs as
    -- service_role, which holds no USAGE on schema private; same fallback as
    -- private.location_tz, mig 719).
    CROSS JOIN LATERAL (SELECT p_now AT TIME ZONE COALESCE(
      (SELECT lz.timezone FROM public.locations lz WHERE lz.id = b.location_id), 'Europe/Dublin') AS wall) w
   WHERE a.profile_id = p_profile_id
     AND (b.block_date > w.wall::date
          OR (b.block_date = w.wall::date AND COALESCE(a.start_time_override, b.start_time) > w.wall::time))
     -- ALREADY ARRIVED = HISTORY, whatever the clock says. A geofence arrival
     -- is matched up to 45 min BEFORE the start (GEOFENCE_EARLY_WINDOW_MS,
     -- src/lib/staff-attendance.js) and stamps arrived_at (mig 609); deleting
     -- that assignment would NULL staff_attendance_events.matched_assignment_id
     -- (mig 120:79) — a worked shift losing its attendance.
     AND a.arrived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.staff_attendance_events e WHERE e.matched_assignment_id = a.id);

  --    The summary shows LIVE ones, with the EFFECTIVE times the calendar shows.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'assignment_id', a.id, 'block_id', b.id, 'block_date', b.block_date,
           'start_time', COALESCE(a.start_time_override, b.start_time),
           'end_time',   COALESCE(a.end_time_override,   b.end_time),
           'template_name', t.name, 'location_id', b.location_id, 'location_name', l.name,
           'roster_status', r.status)
           ORDER BY b.block_date, COALESCE(a.start_time_override, b.start_time), a.id), '[]'::jsonb)
    INTO v_shifts
    FROM public.shift_assignments a
    JOIN public.shift_blocks b ON b.id = a.block_id
    LEFT JOIN public.rosters r ON r.id = b.roster_id
    LEFT JOIN public.shift_templates t ON t.id = b.template_id
    LEFT JOIN public.locations l ON l.id = b.location_id
   WHERE a.id = ANY (v_remove)
     AND a.status IS DISTINCT FROM 'cancelled';

  --    Kept although dated today or later: shifts that HAVE started (in
  --    progress, finished, or starting exactly now — reason 'started'), and
  --    not-started shifts the person has already arrived for (reason
  --    'arrived'). History. Reported so the dialog can say they are kept.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'reason', CASE WHEN b.block_date > w.wall::date
                            OR COALESCE(a.start_time_override, b.start_time) > w.wall::time
                          THEN 'arrived' ELSE 'started' END,
           'assignment_id', a.id, 'block_id', b.id, 'block_date', b.block_date,
           'start_time', COALESCE(a.start_time_override, b.start_time),
           'end_time',   COALESCE(a.end_time_override,   b.end_time),
           'template_name', t.name, 'location_id', b.location_id, 'location_name', l.name,
           'roster_status', r.status)
           ORDER BY b.block_date, COALESCE(a.start_time_override, b.start_time), a.id), '[]'::jsonb)
    INTO v_today_kept
    FROM public.shift_assignments a
    JOIN public.shift_blocks b ON b.id = a.block_id
    LEFT JOIN public.rosters r ON r.id = b.roster_id
    LEFT JOIN public.shift_templates t ON t.id = b.template_id
    LEFT JOIN public.locations l ON l.id = b.location_id
    -- TZ.15: the block's studio zone, read inline (this function runs as
    -- service_role, which holds no USAGE on schema private; same fallback as
    -- private.location_tz, mig 719).
    CROSS JOIN LATERAL (SELECT p_now AT TIME ZONE COALESCE(
      (SELECT lz.timezone FROM public.locations lz WHERE lz.id = b.location_id), 'Europe/Dublin') AS wall) w
   WHERE a.profile_id = p_profile_id
     AND b.block_date >= w.wall::date
     AND NOT (a.id = ANY (v_remove))
     AND a.status IS DISTINCT FROM 'cancelled';

  --    Open swaps are keyed on STATUS, not date: a pending swap can no longer
  --    happen whichever shift it names, so every open one is cancelled.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', s.id, 'location_id', s.location_id, 'requester_id', s.requester_id,
           'target_id', s.target_id, 'status', s.status) ORDER BY s.id), '[]'::jsonb)
    INTO v_swaps
    FROM public.shift_swap_requests s
   WHERE s.status IN ('pending', 'awaiting_approval')
     AND (s.requester_id = p_profile_id OR s.target_id = p_profile_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', o.id, 'type', o.type, 'start_date', o.start_date, 'end_date', o.end_date) ORDER BY o.start_date, o.id), '[]'::jsonb)
    INTO v_leave
    FROM public.time_off_requests o
   WHERE o.profile_id = p_profile_id AND o.status = 'pending' AND o.end_date >= v_today;

  -- 3. What stays — counted so the caller can PROVE history did not move.
  v_kept := jsonb_build_object(
    -- every assignment that is NOT being removed: before today, or today and started.
    'past_shifts', (SELECT count(*) FROM public.shift_assignments a
                     WHERE a.profile_id = p_profile_id AND NOT (a.id = ANY (v_remove))),
    'time_off_requests',      (SELECT count(*) FROM public.time_off_requests      WHERE profile_id = p_profile_id),
    'staff_allowances',       (SELECT count(*) FROM public.staff_allowances       WHERE profile_id = p_profile_id),
    'contractor_invoices',    (SELECT count(*) FROM public.contractor_invoices    WHERE contractor_id = p_profile_id),
    'schedule_notifications', (SELECT count(*) FROM public.schedule_notifications WHERE profile_id = p_profile_id));

  --    Scheduled reports that EMAIL this person (scheduled_reports
  --    .email_recipients, mig 012:40). v_profile.email is the address BEFORE
  --    step 8 scrambles it; matched case-insensitively.
  v_scrubbed := jsonb_build_object('scheduled_reports',
    (SELECT count(*) FROM public.scheduled_reports sr
      WHERE EXISTS (SELECT 1 FROM unnest(sr.email_recipients) r WHERE lower(r) = lower(v_profile.email))
         OR EXISTS (SELECT 1 FROM unnest(sr.confirmed_external_recipients) r WHERE lower(r) = lower(v_profile.email))));

  IF p_dry_run THEN
    RETURN jsonb_build_object('profile_id', p_profile_id, 'full_name', v_profile.full_name, 'dry_run', true,
      'removed_shifts', v_shifts, 'kept_today_shifts', v_today_kept,
      'cancelled_swaps', v_swaps, 'cancelled_time_off', v_leave,
      'role', jsonb_build_object('from', v_profile.role, 'to', v_floor),
      'scrubbed', v_scrubbed,
      'deleted', v_deleted, 'kept', v_kept);
  END IF;

  -- 4. Not-started shifts. One change-log row per PUBLISHED removal (draft edits
  --    are never logged — SCHEDULE-CHANGE-LOG.1). notified_at is stamped: the
  --    re-publish safety net re-notifies the coach of any unstamped row, and
  --    this coach is gone.
  INSERT INTO public.roster_change_log (location_id, block_id, block_date, actor_id, coach_id, action, details, notified_at)
  SELECT (x->>'location_id')::uuid, (x->>'block_id')::uuid, (x->>'block_date')::date,
         p_actor_id, p_profile_id, 'unassigned', jsonb_build_object('reason', 'staff_permanent_delete'), v_now
    FROM jsonb_array_elements(v_shifts) AS x
   WHERE x->>'roster_status' = 'published' AND (x->>'location_id') IS NOT NULL;

  --    Swap history survives this delete: both shift pointers on
  --    shift_swap_requests are ON DELETE SET NULL since mig 603.
  --    Deletes EXACTLY the ids computed in step 2 — never by date alone, so a
  --    started shift cannot be caught by this statement.
  DELETE FROM public.shift_assignments a
   WHERE a.id = ANY (v_remove) AND a.profile_id = p_profile_id;

  -- 5. Open swaps they are on either side of.
  UPDATE public.shift_swap_requests
     SET status = 'cancelled', reviewed_by = p_actor_id, reviewed_at = v_now, updated_at = v_now,
         review_note = CASE WHEN COALESCE(review_note, '') = '' THEN v_note ELSE review_note || ' · ' || v_note END
   WHERE status IN ('pending', 'awaiting_approval')
     AND (requester_id = p_profile_id OR target_id = p_profile_id);

  -- 6. Pending leave that is still ahead. pending -> cancelled never touches
  --    the allowance (the mig 011/616 trigger only reacts to 'approved').
  UPDATE public.time_off_requests
     SET status = 'cancelled', updated_at = v_now,
         review_note = CASE WHEN COALESCE(review_note, '') = '' THEN v_note ELSE review_note || ' · ' || v_note END
   WHERE profile_id = p_profile_id AND status = 'pending' AND end_date >= v_today;

  -- 7. Access rows and tokens. profile_locations ids are remembered first:
  --    the mig 191 audit trigger logs each delete under that resource name.
  SELECT COALESCE(array_agg('profile_locations/' || pl.id::text), ARRAY[]::text[])
    INTO v_pl_res FROM public.profile_locations pl WHERE pl.profile_id = p_profile_id;

  DELETE FROM public.profile_locations WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('profile_locations', v_n);
  DELETE FROM public.profile_organizations WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('profile_organizations', v_n);
  DELETE FROM public.device_tokens WHERE user_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('device_tokens', v_n);
  DELETE FROM public.widget_tokens WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('widget_tokens', v_n);
  DELETE FROM public.email_mailbox_access WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('email_mailbox_access', v_n);
  DELETE FROM public.mobile_bar_prefs WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('mobile_bar_prefs', v_n);

  -- 8. The tombstone. KEPT on purpose: full_name, employment_type,
  --    created_at, and the pay columns (+ the profile_compensation row, which
  --    is not touched) — staff_cost and the week-cost panels cost PAST shifts
  --    from the person's rate; clearing it would rewrite history as EUR 0.
  --    ROLE: remembered in deleted_role, then demoted to the floor. RLS reads
  --    profiles.role live, so this takes a deleted master's RLS powers away at
  --    once — for an unexpired access token, a login we kept, and a failed ban
  --    alike. (mig 080's guard_at_least_one_master sees master -> staff as a
  --    demotion and refuses it if no OTHER active master exists; the actor is
  --    one, so it passes — and if it ever does not, everything rolls back.)
  UPDATE public.profiles
     SET deleted_role = v_profile.role,
         role = v_floor,
         email = 'deleted+' || p_profile_id::text || '@deleted.invalid',
         avatar_url = NULL,
         permissions = '{}'::jsonb,
         two_factor_enabled = false,
         pin_hash = NULL, pin_set_at = NULL, pin_failed_count = 0, pin_locked_until = NULL,
         home_screen_path = '/dashboard',
         unifi_door_access = false, unifi_user_id = NULL,
         email_signature = NULL, email_signature_rich = NULL,
         deleted_at = v_now, deleted_by = p_actor_id, updated_at = v_now
   WHERE id = p_profile_id;

  -- 8b. Stop MAILING them. A scheduled report keeps sending to the address in
  --     email_recipients long after the profile's own email is scrambled. The
  --     address is removed (order kept) from both recipient lists; the
  --     schedule itself stays, even if that leaves it with nobody to mail.
  UPDATE public.scheduled_reports sr
     SET email_recipients = ARRAY(SELECT r FROM unnest(sr.email_recipients) WITH ORDINALITY AS u(r, ord)
                                   WHERE lower(r) IS DISTINCT FROM lower(v_profile.email) ORDER BY ord),
         confirmed_external_recipients = ARRAY(SELECT r FROM unnest(sr.confirmed_external_recipients) WITH ORDINALITY AS u(r, ord)
                                   WHERE lower(r) IS DISTINCT FROM lower(v_profile.email) ORDER BY ord),
         updated_at = v_now
   WHERE EXISTS (SELECT 1 FROM unnest(sr.email_recipients) r WHERE lower(r) = lower(v_profile.email))
      OR EXISTS (SELECT 1 FROM unnest(sr.confirmed_external_recipients) r WHERE lower(r) = lower(v_profile.email));

  -- 9. Redact what auditing captured. The mig 191 trigger has just written the
  --    OLD email / pin_hash / door ids into audit_events.details for the rows
  --    above; older rows carry "Name <email>" labels and sign-in emails. The
  --    rows stay (who did what, when) — the values go.
  --    ONLY the PII keys go — from the payload's top level and from its
  --    before/after objects (the mig 191 shape). These same rows hold the
  --    before/after of every PAY and role change, which is history the business
  --    keeps; the first cut of this step replaced the whole payload. Inline on
  --    purpose: service_role holds no USAGE on schema `private` by the
  --    migrations, so a helper there could fail at call time.
  UPDATE public.audit_events ae
     SET details = (
       SELECT COALESCE(jsonb_object_agg(e.key,
                CASE WHEN e.key IN ('before', 'after') AND jsonb_typeof(e.value) = 'object'
                     THEN (SELECT COALESCE(jsonb_object_agg(i.key, i.value), '{}'::jsonb)
                             FROM jsonb_each(e.value) AS i
                            WHERE NOT (i.key = ANY (v_pii) OR i.key LIKE 'pin\_%' OR i.key LIKE '%phone%'))
                     ELSE e.value END), '{}'::jsonb)
         FROM jsonb_each(ae.details) AS e
        WHERE NOT (e.key = ANY (v_pii) OR e.key LIKE 'pin\_%' OR e.key LIKE '%phone%'))
   WHERE ae.category = 'mutation' AND jsonb_typeof(ae.details) = 'object'
     AND (ae.target_resource = 'profiles/' || p_profile_id::text OR ae.target_resource = ANY (v_pl_res));
  UPDATE public.audit_events SET actor_label = v_profile.full_name
   WHERE actor_id = p_profile_id AND actor_label IS NOT NULL AND actor_label IS DISTINCT FROM v_profile.full_name;
  UPDATE public.audit_events SET target_label = v_profile.full_name
   WHERE target_profile_id = p_profile_id AND target_label IS NOT NULL AND target_label IS DISTINCT FROM v_profile.full_name;
  UPDATE public.audit_events SET details = details - 'email'
   WHERE category = 'auth' AND (actor_id = p_profile_id OR target_profile_id = p_profile_id) AND details ? 'email';

  RETURN jsonb_build_object('profile_id', p_profile_id, 'full_name', v_profile.full_name, 'dry_run', false,
    'removed_shifts', v_shifts, 'kept_today_shifts', v_today_kept,
    'cancelled_swaps', v_swaps, 'cancelled_time_off', v_leave,
    'role', jsonb_build_object('from', v_profile.role, 'to', v_floor),
    'scrubbed', v_scrubbed,
    'deleted', v_deleted, 'kept', v_kept);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. claim_shift_offer (641): the claimant-overlap check across studios.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.claim_shift_offer(p_offer_id uuid, p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_offer  public.shift_offers;
  v_block_id uuid;
  v_block  record;
  v_live   integer;
  v_target integer;
  v_assignment_id uuid;
  v_tz     text;
BEGIN
  IF p_offer_id IS NULL OR p_profile_id IS NULL THEN
    RAISE EXCEPTION 'offer_bad_request: an offer and a profile are required';
  END IF;

  -- 0. One claim per CLAIMANT at a time (review 5): the same coach tapping
  --    Claim on two overlapping offers at once must not win both, and each
  --    claim's overlap check (step 6) is only race-proof if the other is not
  --    inserting meanwhile. Taken FIRST, before any row lock, so the order is
  --    always claimant -> shift -> offer. Released at commit/rollback.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('claim_shift_offer:' || p_profile_id::text, 0));

  -- 1. Which shift? An UNLOCKED read: locking the offer here would take the
  --    offer before the shift, the order a cascading shift delete reverses.
  SELECT o.block_id INTO v_block_id FROM public.shift_offers o WHERE o.id = p_offer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_not_found: offer % does not exist', p_offer_id;
  END IF;

  -- 2. Lock the shift and read what the claim depends on.
  SELECT b.id, b.location_id, b.block_date, b.start_time, b.end_time, b.min_coaches, b.max_coaches,
         r.status AS roster_status,
         COALESCE(t.kind, 'class') AS kind
    INTO v_block
    FROM public.shift_blocks b
    LEFT JOIN public.rosters r ON r.id = b.roster_id
    LEFT JOIN public.shift_templates t ON t.id = b.template_id
   WHERE b.id = v_block_id
   FOR UPDATE OF b;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_not_found: the shift no longer exists';
  END IF;
  -- TZ.15 (mig 721): the offered shift's studio zone, read inline (this
  -- function runs as service_role, which holds no USAGE on schema private;
  -- same fallback as private.location_tz, mig 719).
  v_tz := COALESCE((SELECT l.timezone FROM public.locations l WHERE l.id = v_block.location_id), 'Europe/Dublin');

  -- 3. Lock the offer. This is where two claimers are serialised (both hold
  --    or wait on the shift first, so the order is the same for both).
  SELECT * INTO v_offer FROM public.shift_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND OR v_offer.block_id IS DISTINCT FROM v_block_id THEN
    RAISE EXCEPTION 'offer_not_found: offer % does not exist', p_offer_id;
  END IF;
  -- The same claimer's second tap (review 5): theirs, not "someone else's".
  IF v_offer.status = 'claimed' AND v_offer.claimed_by = p_profile_id THEN
    RAISE EXCEPTION 'offer_already_yours: the claimant already holds this offer';
  END IF;
  IF v_offer.status <> 'open' THEN
    RAISE EXCEPTION 'offer_not_open: offer is already %', v_offer.status;
  END IF;

  IF v_block.roster_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'offer_not_published: the shift is not on a published roster';
  END IF;

  -- 4. The claimant: an active, undeleted member of the offer's studio
  --    (mig 626's staff predicate: a NULL active still counts; mig 622: never
  --    a tombstone). Same rule as isRosterableProfile + membership.
  IF NOT EXISTS (
    SELECT 1
      FROM public.profile_locations pl
      JOIN public.profiles p ON p.id = pl.profile_id
     WHERE pl.profile_id = p_profile_id
       AND pl.location_id = v_offer.location_id
       AND p.active IS NOT FALSE
       AND p.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'offer_not_eligible: the claimant is not an active member of this studio';
  END IF;

  -- 5. Not already on it.
  IF EXISTS (
    SELECT 1 FROM public.shift_assignments a
     WHERE a.block_id = v_block.id AND a.profile_id = p_profile_id
       AND COALESCE(a.status, 'scheduled') <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'offer_already_on: the claimant is already on this shift';
  END IF;

  -- 6. Not already working then (review 5): a live assignment of the claimant
  --    on a PUBLISHED roster (a draft never refuses: review 4, the coach cannot
  --    see it), at ANY studio, the same day, whose effective window (its
  --    overrides, else its shift's times) overlaps the offered shift's window.
  --    Ends that only touch are not an overlap. The route asks CANDIDATES.1
  --    first; this is the half two concurrent claims cannot race past, under
  --    the claimant's advisory lock (step 0).
  --    TZ.15 (mig 721): shift times are wall clock in each shift's OWN studio
  --    zone. Two shifts in the same zone compare exactly as before (same
  --    date, wall-clock overlap). Shifts in different zones compare as
  --    instants, so the pre-filter is widened to +-2 days (any two zones'
  --    local dates meet within that; real offsets differ by at most 26 h).
  IF EXISTS (
    SELECT 1
      FROM public.shift_assignments a
      JOIN public.shift_blocks ob ON ob.id = a.block_id
      JOIN public.rosters orr ON orr.id = ob.roster_id
      CROSS JOIN LATERAL (SELECT COALESCE(
        (SELECT lz.timezone FROM public.locations lz WHERE lz.id = ob.location_id), 'Europe/Dublin') AS tz) oz
     WHERE a.profile_id = p_profile_id
       AND a.block_id <> v_block.id
       AND COALESCE(a.status, 'scheduled') <> 'cancelled'
       AND orr.status = 'published'
       AND ob.block_date BETWEEN v_block.block_date - 2 AND v_block.block_date + 2
       AND CASE WHEN oz.tz = v_tz THEN
                 ob.block_date = v_block.block_date
             AND COALESCE(a.start_time_override, ob.start_time) < v_block.end_time
             AND COALESCE(a.end_time_override, ob.end_time) > v_block.start_time
           ELSE
                 ((ob.block_date + COALESCE(a.start_time_override, ob.start_time)) AT TIME ZONE oz.tz)
               < ((v_block.block_date + v_block.end_time) AT TIME ZONE v_tz)
             AND ((ob.block_date + COALESCE(a.end_time_override, ob.end_time)) AT TIME ZONE oz.tz)
               > ((v_block.block_date + v_block.start_time) AT TIME ZONE v_tz)
           END
  ) THEN
    RAISE EXCEPTION 'claimant_overlap: the claimant is already on another shift at that time';
  END IF;

  -- 7. Still needed? Filled meanwhile closes the offer and RETURNS (a raise
  --    would roll the close back).
  SELECT count(*) INTO v_live
    FROM public.shift_assignments a
   WHERE a.block_id = v_block.id AND COALESCE(a.status, 'scheduled') <> 'cancelled';
  v_target := CASE WHEN v_block.kind = 'admin' THEN 1 ELSE GREATEST(COALESCE(v_block.min_coaches, 1), 1) END;
  IF v_live >= v_target OR v_live >= v_block.max_coaches THEN
    UPDATE public.shift_offers
       SET status = 'filled', closed_at = now(), notice_lease_until = NULL
     WHERE id = v_offer.id;
    RETURN jsonb_build_object('outcome', 'filled', 'offer_id', v_offer.id);
  END IF;

  -- 8. The claimant's cancelled tombstone would trip the (block, profile) key.
  DELETE FROM public.shift_assignments a
   WHERE a.block_id = v_block.id AND a.profile_id = p_profile_id AND a.status = 'cancelled';

  -- 9. Put them on the shift. assigned_by = the claimant: they did it.
  INSERT INTO public.shift_assignments (block_id, profile_id, status, assigned_by)
  VALUES (v_block.id, p_profile_id, 'scheduled', p_profile_id)
  RETURNING id INTO v_assignment_id;

  -- 10. Close the offer. The lease resets: the managers' "taken" notice is a
  --    new phase with its own attempts.
  UPDATE public.shift_offers
     SET status = 'claimed', claimed_by = p_profile_id, claimed_at = now(), closed_at = now(),
         claimed_assignment_id = v_assignment_id, notice_lease_until = NULL, notice_attempts = 0
   WHERE id = v_offer.id;

  RETURN jsonb_build_object(
    'outcome', 'claimed',
    'offer_id', v_offer.id,
    'assignment_id', v_assignment_id,
    'block_id', v_block.id,
    'block_date', to_char(v_block.block_date, 'YYYY-MM-DD'),
    'location_id', v_block.location_id
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_shift_offer(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. challenges_read (686): the member window is 14 days on the STUDIO's
--    calendar. ALTER POLICY rewrites only USING: name, command, roles,
--    PERMISSIVE and every privilege are unchanged, and it stays the table's
--    one policy.
--    The zone is an InitPlan (once per statement, not per row): it is the
--    zone of the signed-in member's OWN contact's studio. The member branch
--    admits a row only when that contact's location_id IS the challenge's
--    (the EXISTS below), so wherever the branch can be true this is exactly
--    private.location_tz(challenges.location_id); where it cannot, the zone
--    does not matter. A login with no contact gets NULL, and the branch is
--    false either way (the EXISTS fails), as before.
--    The phone's window (shared/challenge-wrapped.js endedRecentlyFlagship,
--    mig 686's pair) must use the challenge studio's zone too: TZ.13.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER POLICY challenges_read ON public.challenges USING (
  (SELECT private.auth_is_master())
  OR private.auth_is_in_location(location_id)
  OR ((ends_on >= ((now() AT TIME ZONE (SELECT private.location_tz(mc.location_id)
                                          FROM public.contacts mc
                                         WHERE mc.id = (SELECT private.auth_contact_id())))::date - 14))
      AND EXISTS (SELECT 1 FROM public.contacts c
                   WHERE c.id = (SELECT private.auth_contact_id())
                     AND c.location_id = challenges.location_id))
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Comments.
-- ═══════════════════════════════════════════════════════════════════════════
-- a. The rewritten functions' own comments said "Europe/Dublin"; rewritten in
--    place from the LIVE comment (only that phrase moves), so whatever else
--    prod's comment says is kept.
DO $$
DECLARE
  r record;
  v_old text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.list_health_monthly_stats(uuid, integer, text[], text[], text[], text[])',
       'bucketed in Europe/Dublin.', 'bucketed in the studio''s timezone (locations.timezone; TZ.15, mig 721).'),
      ('public.email_sends_monthly_stats(uuid, integer)',
       'bucketed in Europe/Dublin.', 'bucketed in the studio''s timezone (locations.timezone; TZ.15, mig 721).'),
      ('public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean)',
       '"Upcoming" = NOT STARTED on the Europe/Dublin wall clock of p_now;',
       '"Upcoming" = NOT STARTED at p_now on the wall clock of the shift''s own studio (locations.timezone; TZ.15, mig 721; still-ahead pending leave keeps the Europe/Dublin date);'))
    AS t(fn, old_phrase, new_phrase)
  LOOP
    v_old := obj_description(to_regprocedure(r.fn), 'pg_proc');
    IF v_old IS NOT NULL AND position(r.old_phrase IN v_old) > 0 THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', to_regprocedure(r.fn), replace(v_old, r.old_phrase, r.new_phrase));
    END IF;
  END LOOP;
END $$;

-- b. D5 = B: the billing calendar stays Europe/Dublin by decision. Appended
--    to the live comment (wallet_apply has one), once.
DO $$
DECLARE
  r record;
  v_old text;
  v_note constant text := 'D5 (TZ.15, mig 721): the platform billing calendar (Europe/Dublin) by decision, for every tenant; not the studio''s timezone.';
BEGIN
  FOR r IN SELECT unnest(ARRAY[
      'public.wallet_apply(uuid, text, integer, text, integer, integer, text, text, uuid)',
      'public.rollup_usage_for_day(date)',
      'public.org_ai_spend_month_cents(uuid, date)',
      'public.org_email_sends_month(uuid, date)']) AS fn
  LOOP
    IF to_regprocedure(r.fn) IS NULL THEN
      RAISE EXCEPTION 'mig 721: billing function % is missing; re-plan', r.fn;
    END IF;
    v_old := obj_description(to_regprocedure(r.fn), 'pg_proc');
    IF v_old IS NULL OR position('D5 (TZ.15' IN v_old) = 0 THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', to_regprocedure(r.fn), concat_ws(' ', v_old, v_note));
    END IF;
  END LOOP;
END $$;

-- c. Wall-clock settings columns: hours on the studio's clock since TZ.4.
COMMENT ON COLUMN public.email_sequences.send_window IS
  'Optional delivery window on the studio''s wall clock (locations.timezone; TZ.15, mig 721; mig 089 wrote Europe/Dublin). Schema: { start_hour, end_hour, skip_days }. Runner pushes message-step next_step_at forward to the next acceptable slot. Non-message steps (apply_tag, update_field, internal_task) ignore.';
COMMENT ON COLUMN public.company_settings.send_quiet_hours_start IS
  'GAPS-P4 (mig 514): first quiet hour, 0-23, on the studio''s wall clock (locations.timezone; TZ.15, mig 721). Default 21 - 21:00 and 22:00 carry the 1,173 late-night sends the feature exists for, while 20:00 (6,092 legitimate sends) stays outside the window on purpose.';
COMMENT ON COLUMN public.company_settings.send_quiet_hours_end IS
  'GAPS-P4 (mig 514): first NON-quiet hour, 0-23, on the studio''s wall clock (locations.timezone; TZ.15, mig 721). Default 8, just ahead of the 09:00-10:00 block that already carries 9,611 sends. start > end wraps past midnight.';
COMMENT ON COLUMN public.whatsapp_broadcasts.send_window_tz IS
  'WA-DRIP (mig 253): the IANA zone send_window_start/end are read in. Since TZ.4 POST /api/whatsapp/broadcasts writes a drip''s zone explicitly (the studio''s locations.timezone unless the caller names one); the Europe/Dublin DEFAULT only fills blast rows, which never read it (TZ.15, mig 721).';

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Self-check, from the catalog (never this file's text). Any failure
--    raises and the whole file rolls back.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_bad text;
  v_pinned text;
BEGIN
  -- a. Each function: same OID, signature, result, volatility, SECURITY
  --    mode, search_path, owner, language and ACL; this file's body.
  SELECT string_agg(b.fn, ', ') INTO v_bad
    FROM m721_before b
    LEFT JOIN pg_proc p ON p.oid = b.oid
   WHERE p.oid IS NULL
      OR coalesce(p.proacl::text, '-') IS DISTINCT FROM b.acl
      OR p.prosecdef IS DISTINCT FROM b.prosecdef
      OR p.provolatile IS DISTINCT FROM b.provolatile
      OR coalesce(p.proconfig::text, '-') IS DISTINCT FROM b.cfg
      OR p.proowner IS DISTINCT FROM b.proowner
      OR p.prolang IS DISTINCT FROM b.prolang
      OR pg_get_function_result(p.oid) IS DISTINCT FROM b.result
      OR pg_get_function_arguments(p.oid) IS DISTINCT FROM b.args;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 721: more than the body moved (ACL, signature, SECURITY, search_path, owner or language): %', v_bad;
  END IF;
  SELECT string_agg(x.f, ', ') INTO v_bad
    FROM (VALUES
      ('public.hyrox_coaches_on_shift(uuid, timestamptz, timestamptz)', '0c101c2cd24d1b68f522da5cb0004a94'),
      ('public.list_health_monthly_stats(uuid, integer, text[], text[], text[], text[])', 'c51e1d4cd96a45ed8786730c7219e34c'),
      ('public.email_sends_monthly_stats(uuid, integer)', '289bd723647cbfff7f1f03a73308bac5'),
      ('public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean)', '6bafa95cb80fe3e3d0c7e94b1ec16e21'),
      ('public.claim_shift_offer(uuid, uuid)', 'f23b7ebd8e86b09792169c68c07ebb0c')) AS x(f, h)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(x.f)
                      AND md5(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) = x.h);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 721: not this file''s body: %', v_bad;
  END IF;
  -- b. Server-only, as before: no client role executes any of the five.
  SELECT string_agg(b.fn || ' by ' || r, ', ') INTO v_bad
    FROM m721_before b CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'public']) AS r
   WHERE has_function_privilege(r, b.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 721: a client role executes %', v_bad;
  END IF;
  SELECT string_agg(b.fn, ', ') INTO v_bad FROM m721_before b WHERE NOT has_function_privilege('service_role', b.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 721: service_role lost EXECUTE on %', v_bad;
  END IF;
  -- c. The pinned-Dublin conversions left in public/private functions are
  --    exactly the D5 billing four plus tombstone's pending-leave date.
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname) INTO v_pinned
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
     AND p.prosrc ~* 'at\s+time\s+zone\s+''europe/dublin''';
  IF v_pinned IS DISTINCT FROM 'public.org_ai_spend_month_cents, public.org_email_sends_month, public.rollup_usage_for_day, public.tombstone_staff_profile, public.wallet_apply' THEN
    RAISE EXCEPTION 'mig 721: functions converting AT TIME ZONE ''Europe/Dublin'' should be the D5 four + tombstone''s leave date; found %', v_pinned;
  END IF;
  -- d. challenges_read: the one policy, PERMISSIVE SELECT TO public, the
  --    studio-zone window, no WITH CHECK; RLS on; no policy pins Dublin.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.challenges'::regclass) THEN
    RAISE EXCEPTION 'mig 721: row level security is off on public.challenges';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'challenges') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'challenges' AND policyname = 'challenges_read'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND roles::text = '{public}' AND with_check IS NULL
                       AND qual = $q$(( SELECT private.auth_is_master() AS auth_is_master) OR private.auth_is_in_location(location_id) OR ((ends_on >= (((now() AT TIME ZONE ( SELECT private.location_tz(mc.location_id) AS location_tz
   FROM contacts mc
  WHERE (mc.id = ( SELECT private.auth_contact_id() AS auth_contact_id)))))::date - 14)) AND (EXISTS ( SELECT 1
   FROM contacts c
  WHERE ((c.id = ( SELECT private.auth_contact_id() AS auth_contact_id)) AND (c.location_id = challenges.location_id))))))$q$) THEN
    RAISE EXCEPTION 'mig 721: challenges_read is not the one PERMISSIVE SELECT policy with the studio-zone window; found %',
      (SELECT string_agg(policyname || ' ' || cmd || ' ' || roles::text || ' USING ' || coalesce(qual, '-'), ' ; ')
         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'challenges');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE coalesce(qual, '') ILIKE '%Europe/Dublin%' OR coalesce(with_check, '') ILIKE '%Europe/Dublin%') THEN
    RAISE EXCEPTION 'mig 721: a policy still pins Europe/Dublin: %',
      (SELECT string_agg(tablename || '.' || policyname, ', ') FROM pg_policies
        WHERE coalesce(qual, '') ILIKE '%Europe/Dublin%' OR coalesce(with_check, '') ILIKE '%Europe/Dublin%');
  END IF;
  -- e. The table's privileges are untouched (686/672/677): authenticated
  --    SELECT only, anon and PUBLIC nothing.
  IF NOT has_table_privilege('authenticated', 'public.challenges', 'SELECT')
     OR has_table_privilege('authenticated', 'public.challenges', 'INSERT')
     OR has_table_privilege('authenticated', 'public.challenges', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.challenges', 'DELETE')
     OR has_table_privilege('anon', 'public.challenges', 'SELECT')
     OR has_table_privilege('public', 'public.challenges', 'SELECT') THEN
    RAISE EXCEPTION 'mig 721: public.challenges privileges moved (expected authenticated SELECT only)';
  END IF;
  -- f. The policy's zone helper is still callable by the policy's caller.
  IF NOT has_function_privilege('authenticated', 'private.location_tz(uuid)', 'EXECUTE')
     OR NOT has_schema_privilege('authenticated', 'private', 'USAGE') THEN
    RAISE EXCEPTION 'mig 721: authenticated cannot reach private.location_tz (challenges_read calls it)';
  END IF;
  RAISE NOTICE 'mig 721: 5 functions and challenges_read read the studio zone; ACLs unchanged; D5 billing four commented.';
END $$;

COMMIT;
