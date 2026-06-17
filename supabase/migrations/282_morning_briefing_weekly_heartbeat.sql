-- BRIEFING.3 — widen the morning-briefing heartbeat to a WEEKLY cadence.
-- The cron moved from daily (vercel.json "0 6 * * *") to Mondays only
-- ("0 6 * * 1"). Without this, public.cron_health would flag the row stale
-- ~26h after each Monday run (the old daily 86400s + 2h grace from mig 257)
-- and /api/cron/health-check would 503 falsely for the rest of the week.
-- Weekly = 604800s; keep the existing 2h grace. Refresh last_ok_at so there's
-- no transient staleness in the window between deploy and the next Monday run.
UPDATE public.cron_heartbeats
SET expected_interval_seconds = 604800,
    last_ok_at = NOW()
WHERE name = 'morning-briefing';
