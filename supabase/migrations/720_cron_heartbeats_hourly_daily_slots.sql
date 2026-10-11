-- 720 — TZ.6 (SaaS timezone wave, D6 = B): the daily-slot gate.
--
-- WHY. Thirteen crons fired ONCE a day at a fixed UTC hour (or, for
-- receipt-coverage-weekly, at 07:00 + 08:00 UTC on Fridays to hit 08:00
-- Dublin) and acted for every studio at that instant. A studio in another
-- zone got its 10:00 UTC winback at 21:00 in Sydney. They now run HOURLY and
-- act for each location when its daily slot is due (src/lib/cron-daily-slot.js):
-- a Europe/Dublin location keeps the cron's legacy UTC hour (UN1T's sends land
-- at the same UTC instant as before, summer and winter), every other zone acts
-- at the target LOCAL hour.
--
-- WHAT.
--   (1) cron_daily_slot_claims: one row per (cron, location, LOCAL day). The
--       gate inserts it (ON CONFLICT DO NOTHING) before the cron acts for that
--       location, so an hourly schedule can never act twice for one location
--       on one local day (a DST fall-back day repeats a local hour; Vercel can
--       double-invoke). scope = the location id, or 'none' for rows with no
--       location (they run in DEFAULT_TZ, Europe/Dublin).
--   (2) A seed: a claim for every legacy slot that already passed TODAY, for
--       every Europe/Dublin location and 'none'. The old code (or the gate's
--       pre-720 fallback, below) already acted for those today; without the
--       seed the gate's catch-up window (two ticks after the slot hour, for an
--       UNCLAIMED slot) could repeat them on deploy day.
--   (3) The twelve heartbeat rows the converted crons stamp move to an hourly
--       clock: 3600 + 4800. Every tick stamps (a tick with no slot due is a
--       healthy quiet tick), so the gap between stamps is one hour + Vercel
--       jitter + run time (<= 300 s maxDuration). One missed tick (~7500 s)
--       never pages; two (~10800 s) do (stale at 8400 s = 2 h 20 min).
--       receipt-coverage-weekly is NOT re-sized: its row is stamped by
--       process-receipt-hunts' finalizer when the WEEKLY cycle completes,
--       never by the (now hourly) pull cron, so its weekly clock is still right.
--
-- APPLY RIGHT AFTER THE TZ.6 DEPLOY, NOT BEFORE (CLAUDE.md, heartbeats):
--   • the heartbeat half applied early pages: the old once-a-day code stamps
--     daily against a 2 h 20 min window;
--   • and apply it once the first top-of-hour AND half-past ticks after the
--     deploy have run, so every row has an hourly stamp. The pre-check below
--     refuses (nothing applied) if any row's last stamp is already older than
--     the new window, which would page the moment this lands.
--   • Avoid applying in the minutes around :00 and :30 (a slot tick may be
--     mid-claim while the seed runs).
--   Until it lands, the deployed gate finds no claim table: a Europe/Dublin
--   location then acts at its EXACT legacy hour with no claim (exactly the
--   pre-TZ.6 behaviour) and any other zone waits; the seed then marks those
--   slots claimed, so nothing repeats.
--
-- Service role only: no client grant (mig 677 default, stated explicitly), RLS
-- on with no policy. Only the cron routes (service role) read or write it.
--
-- ROLLBACK (forward-only repo: a NEW migration, never an edit here). Put the
-- vercel.json schedules back first, then restore each row's interval + grace
-- + notes to the LIVE values captured before this was applied (the PR's
-- pre-apply query; the seeding migrations are 303, 357, 296, 300, 384, 445,
-- 470, 257/282, 199, 360, 053/104, but judge the live row, not their text).
-- The claim table can stay (nothing else reads it).

create table if not exists public.cron_daily_slot_claims (
  cron_name   text        not null,
  scope       text        not null,
  slot_day    date        not null,
  location_id uuid        references public.locations(id) on delete cascade,
  zone        text        not null,
  claimed_at  timestamptz not null default now(),
  primary key (cron_name, scope, slot_day),
  check ((scope = 'none' and location_id is null) or (location_id is not null and scope = location_id::text))
);

comment on table public.cron_daily_slot_claims is
  'TZ.6 (mig 720): one row per (cron, location, local day) a converted daily cron acted for. Inserted by src/lib/cron-daily-slot.js before the cron acts; the primary key is the at-most-once guard for the hourly schedule. scope = location id, or ''none'' for rows with no location.';
comment on column public.cron_daily_slot_claims.slot_day is
  'The location''s LOCAL calendar day the slot belongs to (for a Europe/Dublin location on a legacy UTC hour this is also the UTC day).';

alter table public.cron_daily_slot_claims enable row level security;
revoke all on public.cron_daily_slot_claims from anon, authenticated;

-- (2) Seed: legacy slots already past today. Mirrors DAILY_SLOTS in
-- src/lib/cron-daily-slot.js (hour, minute from vercel.json, ISO weekday,
-- anchor). A legacy slot's day is the UTC day (= the Dublin day at every slot
-- hour); the local-anchored Friday slot's day is the Dublin day.
with slots(cron_name, slot_hour, slot_minute, weekday, anchor) as (values
  ('equipment-inspection-reminder', 6, 0, null::int, 'legacy'),
  ('morning-briefing', 6, 0, 1, 'legacy'),
  ('ad-report-email', 7, 0, null::int, 'legacy'),
  ('churn-radar-digest', 7, 0, 1, 'legacy'),
  ('run-scheduled-reports', 7, 0, null::int, 'legacy'),
  ('contract-reminders', 8, 0, null::int, 'legacy'),
  ('run-challenge-events', 8, 0, null::int, 'legacy'),
  ('receipt-coverage-weekly', 8, 0, 5, 'local'),
  ('event-reminders', 9, 0, null::int, 'legacy'),
  ('notify-winback', 10, 0, null::int, 'legacy'),
  ('notify-onboarding-pace', 10, 30, null::int, 'legacy'),
  ('notify-streak-at-risk', 11, 0, null::int, 'legacy'),
  ('equipment-inspection-sweep', 19, 0, null::int, 'legacy')
),
clock as (
  select (now() at time zone 'UTC') as utc_now, (now() at time zone 'Europe/Dublin') as dub_now
),
scopes as (
  select l.id::text as scope, l.id as location_id
    from public.locations l
   where coalesce(l.timezone, 'Europe/Dublin') = 'Europe/Dublin'
  union all
  select 'none', null::uuid
)
insert into public.cron_daily_slot_claims (cron_name, scope, slot_day, location_id, zone)
select s.cron_name,
       sc.scope,
       case when s.anchor = 'legacy' then c.utc_now::date else c.dub_now::date end,
       sc.location_id,
       'Europe/Dublin'
  from slots s
 cross join clock c
 cross join scopes sc
 where (s.anchor = 'legacy'
        and (s.weekday is null or extract(isodow from c.utc_now) = s.weekday)
        and c.utc_now::time >= make_time(s.slot_hour, s.slot_minute, 0))
    or (s.anchor = 'local'
        and extract(isodow from c.dub_now) = s.weekday
        and c.dub_now::time >= make_time(s.slot_hour, s.slot_minute, 0))
on conflict (cron_name, scope, slot_day) do nothing;

-- (3) Heartbeats. Pre-check first: a row whose last stamp is already older
-- than the NEW window would page the moment this lands (applied before the
-- deploy, or before the first hourly tick after it, or the cron is broken).
do $$
declare
  late text;
begin
  select string_agg(h.name || ' (last_ok_at ' || h.last_ok_at::text || ')', ', ' order by h.name) into late
    from public.cron_heartbeats h
   where h.name in ('notify-winback','notify-onboarding-pace','notify-streak-at-risk','run-challenge-events',
                    'event-reminders','contract-reminders','equipment-inspection-reminder','equipment-inspection-sweep',
                    'morning-briefing','churn-radar-digest','ad-report-email','run-scheduled-reports')
     and h.last_ok_at < now() - make_interval(secs => 3600 + 4800);
  if late is not null then
    raise exception 'mig 720: these heartbeats are older than the new 3600 + 4800 window and would page on landing: %. Apply after the TZ.6 deploy AND after its first :00 and :30 ticks have stamped; nothing was applied', late;
  end if;
end $$;

update public.cron_heartbeats h
   set expected_interval_seconds = v.interval_s,
       grace_seconds = v.grace_s,
       notes = v.notes
  from (values
    ('notify-winback', 3600, 4800, 'Win-back push (mig 303). TZ.6 (mig 720): Vercel cron 0 * * * *; acts per home location at its daily slot (Dublin: 10:00 UTC, as before; other zones 10:00 local). Every tick stamps. 3600 + 4800: one missed tick never pages.'),
    ('notify-onboarding-pace', 3600, 4800, 'First-90-days pace push (mig 357). TZ.6 (mig 720): Vercel cron 30 * * * *; acts per location at its daily slot (Dublin: 10:30 UTC, as before; other zones 10:30 local). Every tick stamps. 3600 + 4800: one missed tick never pages.'),
    ('notify-streak-at-risk', 3600, 4800, 'Streak-at-risk push (mig 296). TZ.6 (mig 720): Vercel cron 0 * * * *; acts per home location at its daily slot (Dublin: 11:00 UTC, as before; other zones 11:00 local). Every tick stamps unless a read failed. 3600 + 4800: one missed tick never pages.'),
    ('run-challenge-events', 3600, 4800, 'Challenge start/end/target pushes (mig 300). TZ.6 (mig 720): Vercel cron 0 * * * *; acts per challenge location at its daily slot (Dublin: 08:00 UTC, as before; other zones 08:00 local). Every tick stamps. 3600 + 4800: one missed tick never pages.'),
    ('event-reminders', 3600, 4800, 'Pre-event attendee reminders (mig 384). TZ.6 (mig 720): Vercel cron 0 * * * *; acts per event location at its daily slot (Dublin: 09:00 UTC, as before; other zones 09:00 local). Every tick stamps. 3600 + 4800: one missed tick never pages.'),
    ('contract-reminders', 3600, 4800, 'Unsigned-contract reminders (mig 445). TZ.6 (mig 720): Vercel cron 0 * * * *; acts per contract location at its daily slot (Dublin: 08:00 UTC, as before; other zones 08:00 local). The roster-runway and qualification-digest arms still run only on the 08:00 UTC tick (their own rows, unchanged). Every tick stamps. 3600 + 4800: one missed tick never pages.'),
    ('equipment-inspection-reminder', 3600, 4800, 'Equipment inspections-due push (mig 470). TZ.6 (mig 720): Vercel cron 0 * * * *; acts per location at its daily slot (Dublin: 06:00 UTC, as before; other zones 06:00 local). Every tick stamps. 3600 + 4800: one missed tick never pages.'),
    ('equipment-inspection-sweep', 3600, 4800, 'Equipment overdue chase (mig 470). TZ.6 (mig 720): Vercel cron 0 * * * *; acts per location at its daily slot (Dublin: 19:00 UTC, as before; other zones 19:00 local). Every tick stamps. 3600 + 4800: one missed tick never pages.'),
    ('morning-briefing', 3600, 4800, 'Monday morning briefing email (migs 257, 282). TZ.6 (mig 720): Vercel cron 0 * * * *; acts per location at its Monday slot (Dublin: Mon 06:00 UTC, as before; other zones Mon 06:00 local). Every tick stamps. 3600 + 4800: one missed tick never pages.'),
    ('churn-radar-digest', 3600, 4800, 'Monday churn + lead radar digest (mig 199). TZ.6 (mig 720): Vercel cron 0 * * * *; acts per location at its Monday slot (Dublin: Mon 07:00 UTC, as before; other zones Mon 07:00 local). Every tick stamps. 3600 + 4800: one missed tick never pages.'),
    ('ad-report-email', 3600, 4800, 'Daily ads performance email (mig 360). TZ.6 (mig 720): Vercel cron 0 * * * *; acts per location at its daily slot (Dublin: 07:00 UTC, as before; other zones 07:00 local). Every tick stamps. 3600 + 4800: one missed tick never pages.'),
    ('run-scheduled-reports', 3600, 4800, 'Scheduled reports (migs 053, 104). TZ.6 (mig 720): Vercel cron 0 * * * *; runs a location''s due schedules (next_run_at <= now) at its daily slot (Dublin: 07:00 UTC, as before; other zones 07:00 local). Every tick stamps. 3600 + 4800: one missed tick never pages.')
  ) as v(name, interval_s, grace_s, notes)
 where h.name = v.name;

-- Self-check (POST-state). Anything else aborts the whole file.
do $$
declare
  e record;
begin
  for e in select * from (values
    ('notify-winback', 3600, 4800),
    ('notify-onboarding-pace', 3600, 4800),
    ('notify-streak-at-risk', 3600, 4800),
    ('run-challenge-events', 3600, 4800),
    ('event-reminders', 3600, 4800),
    ('contract-reminders', 3600, 4800),
    ('equipment-inspection-reminder', 3600, 4800),
    ('equipment-inspection-sweep', 3600, 4800),
    ('morning-briefing', 3600, 4800),
    ('churn-radar-digest', 3600, 4800),
    ('ad-report-email', 3600, 4800),
    ('run-scheduled-reports', 3600, 4800)
  ) as v(name, interval_s, grace_s) loop
    perform 1 from public.cron_heartbeats h
     where h.name = e.name and h.expected_interval_seconds = e.interval_s and h.grace_seconds = e.grace_s;
    if not found then
      raise exception 'mig 720: cron_heartbeats row % is missing or did not end up on % + % (a heartbeat name differs from the route''s stampHeartbeat name?); nothing was applied', e.name, e.interval_s, e.grace_s;
    end if;
  end loop;

  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'cron_daily_slot_claims' and c.relrowsecurity) then
    raise exception 'mig 720: cron_daily_slot_claims is missing or has RLS off';
  end if;
  if exists (select 1 from information_schema.table_privileges
              where table_schema = 'public' and table_name = 'cron_daily_slot_claims' and grantee in ('anon', 'authenticated')) then
    raise exception 'mig 720: a client role holds a privilege on cron_daily_slot_claims';
  end if;
end $$;
