-- 755 — MIAHATCH.6 (Task 23): heartbeat row for the Mia purchase-intent
-- watcher (Vercel, */5 * * * *, src/app/api/cron/mia-purchase-intents/route.js).
--
-- The watcher settles paid Mia payment links from the un1t mirror (zero
-- un1t.online calls), closes an intent stuck in 'paid', re-checks recent
-- settles for a double payment and runs the silent expiry sweep. It stamps at
-- the end of every completed run, with counts only in last_outcome
-- { settled, stuck_marked, double_payment_cards, expired, errors }. A
-- per-intent failure is counted in last_outcome.errors but does NOT page:
-- the stamp is still taken (only is_stale pages, and last_outcome is for a
-- person reading the row). STALE means a list could not be read (or the
-- expiry sweep failed) on every tick for 15 minutes, or the cron stopped
-- firing. A run with nothing to do is healthy.
--
-- 300 + 600: a tick is every 5 minutes, and the 900 s before is_stale covers
-- one missed tick plus a normal run (with Vercel jitter), so one missed tick
-- never pages; two in a row do.
-- APPLY THIS MIGRATION RIGHT AFTER THE MIAHATCH.6 CODE DEPLOYS (CLAUDE.md
-- cron rule). It is born healthy (last_ok_at = now()), which leaves 15
-- minutes before it can page; if the deploy is slower, re-run this insert
-- after it (replaying is safe, it only refreshes the row and re-arms
-- last_ok_at, keeping last_outcome).
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at, notes)
values (
  'mia-purchase-intents',
  300,
  600,
  now(),
  'MIAHATCH.6 watcher: settles paid Mia payment links from the un1t mirror'
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
    ('mia-purchase-intents', 300, 600)
  ) as v(name, interval_s, grace_s) loop
    perform 1 from public.cron_heartbeats h
     where h.name = e.name and h.expected_interval_seconds = e.interval_s and h.grace_seconds = e.grace_s;
    if not found then
      raise exception 'mig 755: cron_heartbeats row % did not end up on % + %', e.name, e.interval_s, e.grace_s;
    end if;
  end loop;
end $$;
