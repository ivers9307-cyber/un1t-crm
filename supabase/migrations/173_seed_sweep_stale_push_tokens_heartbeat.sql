-- NOTIF.5 — seed heartbeat for the daily stale-token sweep.
--
-- The sweep runs at 04:00 UTC (after glofox-sync at 03:00 and
-- pipeline-classify at 03:30 so we don't all hit the same window).
-- Heartbeat row needs to pre-exist before the first run, otherwise
-- stampHeartbeat() (UPDATE-only) silently no-ops — same gotcha that
-- bit mig 169 and that audit caught for glofox-sync + pipeline-classify
-- in migs 171–172.

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES
  ('sweep-stale-push-tokens', 86400, 7200,
   'NOTIF.5 — daily 04:00 UTC sweep of device_tokens.last_seen_at < NOW - 90d. 2h grace covers run-length + retries.')
ON CONFLICT (name) DO NOTHING;
