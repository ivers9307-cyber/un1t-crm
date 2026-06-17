-- 286: CLASS-CLIMATE.5 — sync-class-occurrences cron moved to once daily at
-- 04:00 UTC (= 05:00 Dublin during BST; 04:00 Dublin in winter — the ±1h DST
-- drift is immaterial for a daily timetable sync, and the 48h window means
-- each run covers ~2 days, so today's classes are always already in the
-- spine). The 5-min class-climate cron keeps AC timing precise; Refresh /
-- Run-now sync on demand. Widen the heartbeat to a daily interval so
-- cron-health doesn't false-flag the cadence as stale.
UPDATE public.cron_heartbeats
   SET expected_interval_seconds = 86400,
       grace_seconds = 7200
 WHERE name = 'sync-class-occurrences';
