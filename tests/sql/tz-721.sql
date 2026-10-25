-- tests/sql/tz-721.sql — TZ.15 verify script for mig 721 (zone-aware SQL
-- functions and the challenges_read policy). For the ORCHESTRATOR, via the
-- Supabase MCP execute_sql on iyvtbjjxdggiadzwwvdj. Not run by vitest.
--
-- ORDER: section A once, BEFORE applying 721. Section B BEFORE and again
-- AFTER applying (close together, so roster/send data has not moved): every
-- fingerprint must be identical. Section C AFTER. Nothing here changes data:
-- B3 is a BEGIN … ROLLBACK (the MCP rolls back a BEGIN with no COMMIT).

-- ═══ A. Dump before rewrite (BEFORE applying) ══════════════════════════════
-- A1. The live definitions 721 replaces. Compare each with the LATEST
--     migration that defines it (448, 517, 521, 622, 641). 721's own
--     pre-check aborts the whole file if a normalised md5 is not the
--     migration body; this shows WHICH and why.
select p.oid::regprocedure as fn,
       md5(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) as normalised_md5,
       p.prosecdef, p.provolatile, p.proconfig, p.proacl, pg_get_userbyid(p.proowner) as owner
  from pg_proc p
 where p.oid in ('public.hyrox_coaches_on_shift(uuid, timestamptz, timestamptz)'::regprocedure,
                 'public.list_health_monthly_stats(uuid, integer, text[], text[], text[], text[])'::regprocedure,
                 'public.email_sends_monthly_stats(uuid, integer)'::regprocedure,
                 'public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean)'::regprocedure,
                 'public.claim_shift_offer(uuid, uuid)'::regprocedure)
 order by 1;
-- expected normalised_md5 (the migration bodies):
--   hyrox_coaches_on_shift     405075898077e294156d52198d010f74  (448)
--   list_health_monthly_stats  9ed620d8ffbe655c64067b262285f3d7  (517)
--   email_sends_monthly_stats  7ea1b0386c4c74864fa0639c0b926f71  (521)
--   tombstone_staff_profile    a36ced7bc08b1c3b462bc4f3b4e6f27d  (622)
--   claim_shift_offer          b48b91379d8546c4b9713fffa2da9efc  (641)
-- all five prosecdef = false; proacl = postgres + service_role only.

select pg_get_functiondef('public.hyrox_coaches_on_shift(uuid, timestamptz, timestamptz)'::regprocedure);
select pg_get_functiondef('public.list_health_monthly_stats(uuid, integer, text[], text[], text[], text[])'::regprocedure);
select pg_get_functiondef('public.email_sends_monthly_stats(uuid, integer)'::regprocedure);
select pg_get_functiondef('public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean)'::regprocedure);
select pg_get_functiondef('public.claim_shift_offer(uuid, uuid)'::regprocedure);

-- A2. The policy 721 rewrites (expect mig 686's text, the one policy on the table).
select policyname, permissive, cmd, roles, qual, with_check from pg_policies
 where schemaname = 'public' and tablename = 'challenges';

-- A3. Why the functions read the zone inline: expect usage_private = false
--     (service_role cannot resolve private.* by name from an INVOKER body),
--     authenticated true, location_tz executable by authenticated + service_role.
select has_schema_privilege('service_role', 'private', 'USAGE') as service_role_usage_private,
       has_schema_privilege('authenticated', 'private', 'USAGE') as authenticated_usage_private,
       has_function_privilege('authenticated', 'private.location_tz(uuid)', 'EXECUTE') as authd_exec_location_tz,
       has_function_privilege('service_role', 'private.location_tz(uuid)', 'EXECUTE') as svc_exec_location_tz;

-- A4. Every studio is Europe/Dublin (so claim_shift_offer's same-zone branch,
--     which is 641's comparison verbatim, is the only one that can run).
select timezone, count(*) from public.locations group by 1;

-- ═══ B. Fingerprints (BEFORE and AFTER; must be identical) ════════════════
-- B1. Monthly stats, every location, 36 months.
select l.name,
       md5(coalesce((select json_agg(t)::text from public.list_health_monthly_stats(l.id, 36,
             '{admin_panel,one_click_unsubscribe,postmark_one_click_unsubscribe,event_form,booking_form}',
             '{postmark_hard_bounce,postmark_spam_complaint}', '{auto_classpass}',
             '{bulk_import,auto_classpass_backfill,postmark_suppression_backfill}') t), '')) as list_health,
       md5(coalesce((select json_agg(t)::text from public.email_sends_monthly_stats(l.id, 36) t), '')) as email_sends
  from public.locations l order by l.name;

-- B2. Hyrox coaches on shift, every location, every 30 min from 4 Oct to
--     1 Nov 2026 (spans the 25 Oct EU clock change), 1-hour windows.
select l.name,
       md5(string_agg(h.ts::text || '=' || coalesce((select string_agg(c.profile_id::text, ',' order by c.profile_id)
             from public.hyrox_coaches_on_shift(l.id, h.ts, h.ts + interval '1 hour') c), ''), '|' order by h.ts)) as hyrox
  from public.locations l
 cross join generate_series('2026-10-04T00:00:00Z'::timestamptz, '2026-11-01T00:00:00Z'::timestamptz, interval '30 minutes') h(ts)
 group by l.name order by l.name;

-- B3. Tombstone dry runs (write function; dry_run = true RETURNS before any
--     write, but it takes a row lock, so run inside BEGIN … ROLLBACK). Every
--     deactivated, undeleted profile, at instants around now and the 25 Oct
--     clock change. Only an md5 leaves the database (the summary names people).
begin;
select count(*) as profiles,
       md5(string_agg(public.tombstone_staff_profile(p.id, m.id, ts, true)::text, '|' order by p.id, ts)) as tombstone
  from public.profiles p
 cross join (select id from public.profiles where role = 'master' and active and deleted_at is null order by id limit 1) m
 cross join unnest(array['2026-10-11T05:30:00Z', '2026-10-11T17:30:00Z', '2026-10-24T23:30:00Z',
                         '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', '2026-11-01T12:00:00Z']::timestamptz[]) ts
 where p.active is false and p.deleted_at is null and p.id <> m.id;
rollback;

-- B4. challenges_read's member window: rows whose verdict differs between the
--     studio-zone window and the Dublin window. Must be 0 (all studios Dublin).
select count(*) as window_mismatches from public.challenges c
 where (c.ends_on >= ((now() at time zone private.location_tz(c.location_id))::date - 14)) <>
       (c.ends_on >= ((now() at time zone 'Europe/Dublin')::date - 14));

-- ═══ C. After applying ═════════════════════════════════════════════════════
-- C1. Bodies are 721's, nothing else moved (compare with A1's row; only
--     normalised_md5 changes): expected 0c101c2c… (448), c51e1d4c… (517),
--     289bd723… (521), 6bafa95c… (622), f23b7ebd… (641).
--     (re-run A1)
-- C2. The policy: one PERMISSIVE SELECT TO public; the member window reads
--     private.location_tz of the member's contact's studio; no 'Europe/Dublin'.
--     (re-run A2)
-- C3. Functions still converting AT TIME ZONE 'Europe/Dublin': exactly the D5
--     billing four + tombstone_staff_profile (its pending-leave date only).
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'private') and p.prokind = 'f'
   and p.prosrc ~* 'at\s+time\s+zone\s+''europe/dublin''' order by 1, 2;
-- C4. D5 comments and the column comments.
select p.proname, obj_description(p.oid, 'pg_proc') from pg_proc p
 where p.proname in ('wallet_apply', 'rollup_usage_for_day', 'org_ai_spend_month_cents', 'org_email_sends_month');
select c.relname, a.attname, col_description(c.oid, a.attnum) from pg_attribute a join pg_class c on c.oid = a.attrelid
 where (c.relname, a.attname) in (('email_sequences', 'send_window'), ('company_settings', 'send_quiet_hours_start'),
                                  ('company_settings', 'send_quiet_hours_end'), ('whatsapp_broadcasts', 'send_window_tz'));
-- C5. Then: get_advisors(type = 'security'), and re-run section B.
