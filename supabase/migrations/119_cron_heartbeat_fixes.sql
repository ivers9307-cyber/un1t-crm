-- 119_cron_heartbeat_fixes.sql
--
-- Two issues surfaced by Betterstack cron health alerts:
--
-- 1. Three crons missing from cron_heartbeats. stampHeartbeat()
--    does an UPDATE WHERE name=$1, so an unregistered cron silently
--    no-ops and never appears in cron_health. The cron itself runs
--    fine, but monitoring is blind to it.
--      - ac-auto-off                      (mig 103, never seeded)
--      - auto-end-stale-hr-sessions       (Phase 3)
--      - run-strava-exports               (Phase 4)
--
-- 2. process-contact-imports had grace_seconds=30 against a 60s
--    interval — total budget 90s. Vercel cron tick jitter (which
--    can run 30-60s late under load) regularly trips this. Bumping
--    grace to 120s (3min total budget) absorbs jitter without
--    masking real failures (a genuine miss is multiple ticks).

BEGIN;

-- 1. Seed missing rows.
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES
  ('ac-auto-off',                  300, 180, 'Sensibo AC auto-off sweep — every 5 min'),
  ('auto-end-stale-hr-sessions',   300, 180, 'Heart-rate session autoclose + post-class email backstop — every 5 min'),
  ('run-strava-exports',           120,  90, 'Strava export queue worker — every 2 min')
ON CONFLICT (name) DO NOTHING;

-- 2. Bump process-contact-imports grace.
UPDATE public.cron_heartbeats
SET grace_seconds = 120,
    notes = COALESCE(notes, '') || ' [grace bumped 30→120s in mig 119 to absorb Vercel cron tick jitter]'
WHERE name = 'process-contact-imports'
  AND grace_seconds < 120;

COMMIT;
