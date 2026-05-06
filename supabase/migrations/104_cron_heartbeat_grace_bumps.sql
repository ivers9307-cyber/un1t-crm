-- Cron heartbeat grace_seconds bumps. Vercel's cron timing is
-- best-effort, not exact — a tick can fire 5–15 min late and
-- briefly trip is_stale=true if grace is too tight, which Better
-- Stack picks up as a 503 false alarm.
--
-- Daily crons had only 30 min of grace on a 24h interval. The fix
-- is to bump grace to a comfortable 2h for daily, and a few
-- minutes for the */5 and */15 cadences. 1-minute crons stay tight
-- because any real delay there matters and they tick 1440x/day.
--
-- Applied via Supabase MCP on 2026-05-06.

update public.cron_heartbeats
   set grace_seconds = 7200            -- 2h
 where name in ('prune-rate-limits', 'run-scheduled-reports');

update public.cron_heartbeats
   set grace_seconds = 180              -- 3 min on top of 5 min cadence
 where name in ('run-sequences', 'run-sms-broadcasts');

update public.cron_heartbeats
   set grace_seconds = 240              -- 4 min on top of 15 min cadence
 where name = 'race-timing-events';
