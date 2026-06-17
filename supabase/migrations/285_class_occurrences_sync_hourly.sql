-- 285: CLASS-CLIMATE.4 — sync-class-occurrences cron dropped from every
-- 15 min to hourly. A class timetable barely changes week to week, and
-- the 5-min class-climate cron keeps AC-timing precision independently
-- (it reads whatever's in the spine); the card's Refresh / Run-now also
-- sync on demand. Widen the heartbeat interval so cron-health doesn't
-- false-flag the slower cadence as stale.
UPDATE public.cron_heartbeats
   SET expected_interval_seconds = 3600,
       grace_seconds = 1800
 WHERE name = 'sync-class-occurrences';
