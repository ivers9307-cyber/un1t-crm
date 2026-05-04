-- ============================================================
-- 097: Move ALL crons to Vercel + drop the dead pg_net plumbing
--
-- We're moving to a single source of truth for scheduled work:
-- vercel.json. After mig 066 dropped private.app_config the two
-- pg_cron jobs left over (race-timing-events from mig 085, and
-- process-contact-imports from mig 096) have been failing on every
-- tick with "relation private.app_config does not exist". Vercel
-- Cron has been doing the actual work the whole time — these jobs
-- were dead duplicates that just spammed cron.job_run_details.
--
-- This migration takes care of three knock-on cleanups while we're
-- in here, so nothing pg_cron / pg_net related survives:
--
--   1. Unschedule the two leftover pg_cron jobs.
--   2. Drop the fire_deal_webhooks() trigger, function, and the
--      empty webhook_subscriptions table. These were a never-used
--      n8n integration that was the only remaining consumer of
--      pg_net.http_post. webhook_subscriptions has 0 rows in prod
--      and the corresponding /api/webhooks route is removed in
--      the same commit.
--   3. DROP EXTENSION pg_net + pg_cron. With no callers left there
--      is no reason to keep async-HTTP-from-Postgres or in-DB cron
--      installed; both have caused outages historically (the May 1
--      silent-401 incident, mig 053).
--
-- Also refresh the cron_heartbeats.notes column so it matches the
-- new reality (every cron is Vercel-managed). The seed rows from
-- mig 053 still claim run-sequences is pg_cron, which is wrong.
-- ============================================================

BEGIN;

-- 1. Unschedule the two leftover pg_cron jobs.
DO $$
BEGIN
  PERFORM cron.unschedule('race-timing-events');
EXCEPTION WHEN OTHERS THEN NULL;
END$$;

DO $$
BEGIN
  PERFORM cron.unschedule('process-contact-imports');
EXCEPTION WHEN OTHERS THEN NULL;
END$$;

-- 2. Drop the dead deal-webhook plumbing. fire_deal_webhooks() is
-- the only function in the database that uses pg_net.
DROP TRIGGER IF EXISTS deal_webhook_trigger ON public.deals;
DROP FUNCTION IF EXISTS public.fire_deal_webhooks();
DROP TABLE IF EXISTS public.webhook_subscriptions;

-- 3. Drop the extensions.
DROP EXTENSION IF EXISTS pg_net;
DROP EXTENSION IF EXISTS pg_cron;

-- Refresh the cron heartbeat notes so they describe what actually
-- runs the job today. The original seed in mig 053 still labels
-- run-sequences as 'pg_cron */5'; fix that and add rows for the
-- remaining Vercel crons so the health check covers everything.
UPDATE public.cron_heartbeats
   SET notes = 'Vercel cron */5 * * * * UTC'
 WHERE name = 'run-sequences';

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) VALUES
  ('run-sms-broadcasts',       300,  60,  'Vercel cron */5 * * * * UTC'),
  ('race-timing-events',       900,  120, 'Vercel cron */15 * * * * UTC'),
  ('process-contact-imports',  60,   30,  'Vercel cron * * * * * UTC')
ON CONFLICT (name) DO UPDATE
  SET expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds              = EXCLUDED.grace_seconds,
      notes                      = EXCLUDED.notes;

COMMIT;
