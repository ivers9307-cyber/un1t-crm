-- 311: Strava direct inbound — backfill tracking + cron heartbeat.
-- import_backfilled_at stamps when the strava-import cron has done the one-time
-- last-30-days backfill for a connection, so it isn't re-pulled every tick.
ALTER TABLE contact_external_integrations
  ADD COLUMN IF NOT EXISTS import_backfilled_at timestamptz;

INSERT INTO cron_heartbeats (name, expected_interval_seconds, grace_seconds)
VALUES ('strava-import', 300, 600)
ON CONFLICT (name) DO NOTHING;
