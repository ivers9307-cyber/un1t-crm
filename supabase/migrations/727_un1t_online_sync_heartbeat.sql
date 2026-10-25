-- 727 — UN1TSYNC.8: heartbeat row for the un1t.online → CRM pull cron
-- (Vercel, */15 * * * *, src/app/api/cron/un1t-online-sync/route.js).
--
-- Stamped at the end of every run that discovered its locations. A location
-- that failed (revoked token, studio mismatch, API error) is a COUNT in
-- last_outcome { locations_processed, failed_locations, failed_by_reason,
-- skipped }, not a stale heartbeat: the cron is healthy, the location shows
-- action_needed on its connection and in tenant_cron_health. STALE means
-- discovery failed or the cron stopped firing for 45 minutes.
--
-- 900 + 1800: a tick is every 15 minutes, so one missed tick (interval +
-- Vercel jitter + a run that takes up to maxDuration) never pages; two do.
-- Apply this right AFTER the code deploys (CLAUDE.md cron rule). It is born
-- healthy (last_ok_at = now()), which leaves 45 minutes before it can page;
-- if the deploy is slower, re-run this insert after it (replaying is safe, it
-- only refreshes the row and re-arms last_ok_at).
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at, notes)
values (
  'un1t-online-sync',
  900,
  1800,
  now(),
  'UN1TSYNC.8 (mig 727) — un1t.online → CRM pull, every 15 min'
)
on conflict (name) do update
  set last_ok_at = now(),
      expected_interval_seconds = excluded.expected_interval_seconds,
      grace_seconds = excluded.grace_seconds,
      notes = excluded.notes;

do $$
declare e record;
begin
  for e in select * from (values
    ('un1t-online-sync', 900, 1800)
  ) as v(name, interval_s, grace_s) loop
    perform 1 from public.cron_heartbeats h
     where h.name = e.name and h.expected_interval_seconds = e.interval_s and h.grace_seconds = e.grace_s;
    if not found then
      raise exception 'mig 727: cron_heartbeats row % did not end up on % + %', e.name, e.interval_s, e.grace_s;
    end if;
  end loop;
end $$;
