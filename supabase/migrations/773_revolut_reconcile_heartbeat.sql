-- 773 — REVPAY.3: heartbeat row for the Revolut pending-order reconcile cron
-- (Vercel, */15 * * * *, src/app/api/cron/revolut-reconcile/route.js).
--
-- The cron is the backstop for a lost or deferred Revolut webhook: it asks
-- Revolut for the state of every Revolut-backed payment still pending 10
-- minutes to 7 days after checkout (car deposits, race payments, paid class
-- bookings, paid trials, offer purchases, donations), at most 50 provider
-- calls a tick, and applies it through the webhooks' own helpers
-- (src/lib/revolut-reconcile.js). No schema change: the rotation that keeps a
-- forever-pending checkout from blocking the queue is computed from the clock.
--
-- It stamps at the end of every healthy run, with counts only in last_outcome
-- { candidates, due, checked, over_budget, settled, still_pending,
--   already_settled, not_applied, provider_failed, errors, provider_calls,
--   list_failed, by_domain }.
-- A per-row failure (or one getOrder failure) is a count and does NOT page:
-- the stamp is still taken. STALE means, on every tick for 35 minutes, a
-- candidate list could not be read, or every provider call failed (a revoked
-- REVOLUT_API_KEY, a Revolut outage), or the cron stopped firing. A run with
-- nothing due is healthy.
--
-- 900 + 1200 (the sync-class-occurrences sizing of mig 644 for a */15 cron):
-- stale at 35 minutes. One missed tick puts the gap between stamps at
-- ~1800 s plus jitter plus the run (maxDuration 300 s), which stays under
-- 2100 s, so it never pages; two missed ticks (~2700 s) do.
--
-- APPLY THIS MIGRATION RIGHT AFTER THE REVPAY.3 CODE DEPLOYS (CLAUDE.md cron
-- rule). It is born healthy (last_ok_at = now()), which leaves 35 minutes
-- before it can page; if the deploy is slower, re-run this insert after it
-- (replaying is safe: it only refreshes the row and re-arms last_ok_at,
-- keeping last_outcome).
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at, notes)
values (
  'revolut-reconcile',
  900,
  1200,
  now(),
  'REVPAY.3 backstop: settles Revolut payments whose webhook never landed'
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
    ('revolut-reconcile', 900, 1200)
  ) as v(name, interval_s, grace_s) loop
    perform 1 from public.cron_heartbeats h
     where h.name = e.name and h.expected_interval_seconds = e.interval_s and h.grace_seconds = e.grace_s;
    if not found then
      raise exception 'mig 773: cron_heartbeats row % did not end up on % + %', e.name, e.interval_s, e.grace_s;
    end if;
  end loop;
end $$;
