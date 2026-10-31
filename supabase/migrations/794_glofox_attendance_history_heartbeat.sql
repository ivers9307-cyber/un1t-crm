-- 794 — ATTHISTORY.1: heartbeat row for /api/cron/glofox-attendance-history.
--
--   APPLY THIS MIGRATION RIGHT AFTER THE CODE DEPLOYS (or re-run it then).
--   stampHeartbeat() is UPDATE-only, and a row seeded before the route exists
--   goes stale after interval + grace and pages (CLAUDE.md, crons).
--
-- Cadence: vercel.json */10 * * * * → 600 s interval, 900 s grace, so STALE
-- 25 minutes after the last clean tick: one missed tick never pages, two do
-- (mig 645's sizing for glofox-detail-backfill, the same shape of job). Born
-- healthy; a replay re-arms it (last_outcome left alone). Tune the grace in a
-- new migration, not by hand. Pinned in tests/cron-heartbeat-schedule-pins.test.js.

insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at, notes)
values (
  'glofox-attendance-history',
  600,
  900,
  now(),
  'ATTHISTORY.1 (mig 793/794) — one-time full Glofox booking-history read per Glofox-linked contact at every Glofox studio (/api/cron/glofox-attendance-history, vercel.json */10 * * * *). Advances contacts.last_attended_at / last_booked_at (never regresses them) and stamps contacts.glofox_history_synced_at on EVERY attempt; the run''s glofox_sync_runs row carries the contact ids whose read failed. A tick with nothing pending is healthy and stamps. Stamped only when every eligible studio ran without a fault of its own (an unreadable candidate page or credentials withholds it). last_outcome: { eligible, read, no_bookings, attended, truncated, fetch_failed, update_failed, remaining, budget_exhausted, glofox_http }.'
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
    ('glofox-attendance-history', 600, 900)
  ) as v(name, interval_s, grace_s) loop
    perform 1 from public.cron_heartbeats h
     where h.name = e.name and h.expected_interval_seconds = e.interval_s and h.grace_seconds = e.grace_s;
    if not found then
      raise exception 'mig 794: cron_heartbeats row % did not end up on % + %', e.name, e.interval_s, e.grace_s;
    end if;
  end loop;
end $$;
