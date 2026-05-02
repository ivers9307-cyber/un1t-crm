-- 053_cron_heartbeats.sql
-- Cron health monitoring.
--
-- Why: on 2026-05-01 the CRON_SECRET on Vercel drifted from the value stored
-- in private.app_config.cron_secret used by pg_cron via pg_net. Result:
-- /api/cron/run-sequences silently 401'd every 5 minutes for ~22 hours. We
-- only caught it because someone manually grepped the Vercel runtime logs.
-- That can't be how we find out next time.
--
-- This migration:
--   1. cron_heartbeats — one row per cron job, last_ok_at stamped by the
--      route on each successful run.
--   2. cron_health view — derives is_stale by comparing now() vs last_ok_at
--      against expected_interval_seconds + grace_seconds.
--   3. Seeds rows for the three crons that exist today.
--
-- The /api/cron/health-check route (added in the same change) reads the
-- view and returns 503 if anything is stale, 200 otherwise — so an external
-- monitor (UptimeRobot, Better Stack, etc.) can ping one URL and know if
-- ANY cron is broken without needing per-cron monitor config.
--
-- Pattern matches rate_limit_buckets (mig 015 + 022): table in public,
-- RLS deny-all for anon/authenticated, service role bypasses RLS to do
-- the actual reads/writes from the route.

CREATE TABLE IF NOT EXISTS public.cron_heartbeats (
  name                       TEXT        PRIMARY KEY,
  last_ok_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expected_interval_seconds  INTEGER     NOT NULL CHECK (expected_interval_seconds > 0),
  grace_seconds              INTEGER     NOT NULL DEFAULT 60 CHECK (grace_seconds >= 0),
  notes                      TEXT
);

COMMENT ON TABLE public.cron_heartbeats IS
  'One row per cron job. Stamped on success by /api/cron/* routes. Read by cron_health view.';

ALTER TABLE public.cron_heartbeats ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS — these policies exist purely as defence in depth
-- so anon/authenticated can never read or write the table even if a future
-- handler accidentally uses the browser client.
CREATE POLICY "cron_heartbeats_no_anon" ON public.cron_heartbeats
  FOR ALL TO anon
  USING (FALSE) WITH CHECK (FALSE);

CREATE POLICY "cron_heartbeats_no_authenticated" ON public.cron_heartbeats
  FOR ALL TO authenticated
  USING (FALSE) WITH CHECK (FALSE);

-- Health view — computed live so is_stale always reflects NOW().
CREATE OR REPLACE VIEW public.cron_health AS
SELECT
  name,
  last_ok_at,
  expected_interval_seconds,
  grace_seconds,
  EXTRACT(EPOCH FROM (NOW() - last_ok_at))::INTEGER             AS stale_seconds,
  (expected_interval_seconds + grace_seconds)                   AS max_allowed_seconds,
  ((NOW() - last_ok_at) > make_interval(secs => (expected_interval_seconds + grace_seconds))) AS is_stale
FROM public.cron_heartbeats;

COMMENT ON VIEW public.cron_health IS
  'Live cron health. is_stale = true means last_ok_at is older than expected_interval + grace.';

-- Seed rows for the three crons in the codebase as of mig 053.
-- Initial last_ok_at = NOW() so the view reports healthy until the first
-- real tick stamps it for real. Otherwise the health-check would 503
-- immediately on deploy until the first tick lands.
--   run-sequences         pg_cron, every 5 min  → 300 + 60s grace
--   run-scheduled-reports Vercel,  daily 07:00  → 86400 + 1800s grace
--   prune-rate-limits     Vercel,  daily 03:30  → 86400 + 1800s grace
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) VALUES
  ('run-sequences',         300,    60,   'pg_cron */5 * * * * via pg_net (Vercel Hobby cron cap)'),
  ('run-scheduled-reports', 86400, 1800, 'Vercel cron 0 7 * * * UTC'),
  ('prune-rate-limits',     86400, 1800, 'Vercel cron 30 3 * * * UTC')
ON CONFLICT (name) DO NOTHING;
