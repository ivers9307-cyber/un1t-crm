-- 455 — membership-snapshot cron goes daily (TREND-DAILY.1).
--
-- The business-board membership trend chart read monthly snapshots, so
-- after two months it had two points and read as broken. The cron now
-- runs daily at 02:00 UTC (vercel.json) writing one row per location
-- per Dublin day; tighten the heartbeat expectation to match.
--
-- Re-stamp last_ok_at so the tighter window doesn't flag the cron
-- stale before its first daily run (last monthly stamp was the 1st).
-- Per the sentinel rule, apply this AFTER the daily schedule deploys.

update cron_heartbeats
set expected_interval_seconds = 86400,   -- 1 day
    grace_seconds             = 172800,  -- 2 days
    last_ok_at                = now(),
    notes = 'Daily membership snapshot for the business-board trend. Runs 02:00 UTC daily (monthly before mig 455); 1d interval + 2d grace.'
where name = 'membership-snapshot';
