-- Audit followup — two daily crons in vercel.json had no
-- cron_heartbeats row, so stampHeartbeat() was matching 0 rows on
-- every tick.
--
--   glofox-sync       (daily 03:00) — Glofox member/contact sync
--   pipeline-classify (daily 03:30) — pipeline-stage auto-classifier
--
-- Both run once a day so the missing heartbeat went unnoticed —
-- nothing was monitoring whether they actually ran. The
-- corresponding cron routes already call stampHeartbeat('<name>');
-- they just had no row to UPDATE.
--
-- pipeline-classify additionally had a bug in the JS — it called
-- stampHeartbeat(db, 'pipeline-classify') passing the Supabase
-- client as the first arg, but the function signature is
-- stampHeartbeat(name). The string-type guard in cron-heartbeat.js
-- silently returned and never stamped. Fixed in the same ship as
-- this migration so once both land together, the heartbeat
-- pipeline-classify writes nightly will actually persist.

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES
  ('glofox-sync',       86400, 7200, 'Daily 03:00 UTC — Glofox contact + member sync. 2h grace covers run length + retries.'),
  ('pipeline-classify', 86400, 7200, 'Daily 03:30 UTC — pipeline-stage auto-classifier. 2h grace.')
ON CONFLICT (name) DO NOTHING;
