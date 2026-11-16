-- 844_stale_job_watchdog_heartbeat.sql
--
-- STALEWATCH.1 — the heartbeat row for /api/cron/stale-job-watchdog.
--
-- SHIP ORDER: apply this AFTER the deploy that adds the cron (CLAUDE.md: a
-- heartbeat row seeded ahead of its route goes stale after interval + grace
-- and pages). Migration 843 must already be applied. The INSERT stamps
-- last_ok_at = now(), so the row is born healthy and the first real tick takes
-- over.
--
-- expected_interval = 900s (vercel.json '*/15 * * * *'), grace = 1800s: one
-- missed tick plus jitter never pages. The watchdog watches every other row;
-- this row is how anything watches the watchdog (the health check reads it
-- like any other).

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'stale-job-watchdog',
  now(),
  900,
  1800,
  'STALEWATCH.1 — every 15 min: alerts the masters once per job that newly goes stale (and records an error_events row for Sentinel), clears the alert when it recovers, and sends one daily digest of everything still stale. Acknowledged rows are quiet until their acknowledgement ends. Stamps only when it could read cron_health.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;
