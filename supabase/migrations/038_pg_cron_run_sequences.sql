-- Schedule the sequence runner via pg_cron + pg_net.
--
-- Vercel's Hobby plan caps at 2 cron jobs and prevents
-- sub-daily schedules — and the project is already at the
-- limit (run-scheduled-reports + prune-rate-limits). Rather
-- than upgrade just for one 5-minute cron, we run it from
-- inside Postgres using the pg_cron + pg_net extensions.
--
-- Same effective behaviour: every 5 minutes, fire a GET to the
-- /api/cron/run-sequences endpoint with the CRON_SECRET bearer.
-- The endpoint itself is unchanged — same auth pattern, same
-- response shape.
--
-- Operator setup (one-time, after migration applies):
--
--   UPDATE private.app_config
--      SET value = '<the CRON_SECRET from Vercel env>',
--          updated_at = now()
--    WHERE key = 'cron_secret';
--
-- The base URL is pre-populated to https://crm.un1tdublin.com.
-- Update if the production hostname ever changes.
--
-- Verify it's firing:
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'run-sequences')
--    ORDER BY start_time DESC LIMIT 5;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE IF NOT EXISTS private.app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO private.app_config (key, value)
VALUES ('cron_base_url', 'https://crm.un1tdublin.com')
ON CONFLICT (key) DO NOTHING;

INSERT INTO private.app_config (key, value)
VALUES ('cron_secret', '')
ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  PERFORM cron.unschedule('run-sequences');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

SELECT cron.schedule(
  'run-sequences',
  '*/5 * * * *',
  $$
  SELECT net.http_get(
    url := (SELECT value FROM private.app_config WHERE key = 'cron_base_url')
           || '/api/cron/run-sequences',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (SELECT value FROM private.app_config WHERE key = 'cron_secret')
    )
  );
  $$
);

COMMENT ON TABLE private.app_config IS
  'Tiny config table for values that Postgres cron jobs need to read. Updated via SQL Editor by an operator. See migration 038.';
