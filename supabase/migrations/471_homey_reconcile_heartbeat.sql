-- HOMEYD.4 — heartbeat row for the per-minute homey-reconcile cron.
-- Created for the Homey direct-control cron, spec 2026-08-01
-- (docs/superpowers/specs/2026-08-01-homey-direct-control-design.md).
--
-- APPLY THIS BEFORE THE CRON DEPLOYS (same rule as mig 470) — otherwise
-- stampHeartbeat('homey-reconcile') UPDATEs zero rows every tick, logs a
-- warning, and un1t-sentinel's cron_health monitoring stays blind to it.
--
-- expected_interval_seconds/grace_seconds sizing: this is the tightest
-- cadence any cron in this repo has run at (Vercel `* * * * *`, 60s).
-- The next-tightest existing cron, process-invoice-analysis (mig 377,
-- also a Vercel `*/2 * * * *` worker), budgets expected+grace = 120+240
-- = 360s = 3x its own cadence. Scaling that ratio straight to 60s would
-- give a 180s (3min) window. mig 119's process-contact-imports (also a
-- 60s-cadence cron) has held stable at exactly that 180s budget since,
-- so 180s would probably survive — but this cron differs: it does a
-- network round-trip to a Homey Pro (via Athom's cloud relay) before it
-- can even start committing writes, adding tail latency a pure-DB drain
-- cron doesn't have. So we go generous instead of ratio-exact: 60s expected
-- interval (matches the real schedule) + 840s grace = 900s (15min)
-- total budget. Still tight enough to catch a genuinely dead cron (15
-- consecutive missed ticks), loose enough that normal jitter or a
-- single slow/timed-out Homey call never flaps it.
--
-- last_ok_at defaults to NOW() so cron_health reports healthy until the
-- first real tick stamps it (same rationale as mig 053/470).

insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) values
  ('homey-reconcile', 60, 840,
   'HOMEYD.4 — per-minute Homey Pro reconcile: diffs desired vs actual device state, fires on/off commands, reports state. Vercel cron * * * * * UTC.')
on conflict (name) do nothing;
