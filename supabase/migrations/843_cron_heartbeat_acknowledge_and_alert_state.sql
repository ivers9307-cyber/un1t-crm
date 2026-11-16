-- 843_cron_heartbeat_acknowledge_and_alert_state.sql
--
-- STALEWATCH.1 (15 Nov 2026 feature audit, step 2 item 13): a stale job can be
-- acknowledged, and the in-CRM watchdog remembers which stale episode it has
-- already alerted on.
--
-- NOT APPLIED YET when this file was written. Apply it BEFORE the STALEWATCH.1
-- code deploys: the watchdog, the health check and the acknowledge route read
-- these columns, and a select naming a missing column fails whole. Applying
-- it early changes nothing: the columns start NULL (nothing acknowledged,
-- nothing alerted) and the view only gains columns at its end.
--
-- WHY
-- /api/cron/health-check carries one bit (any row stale -> 503). It had been
-- red since 21 Sep for one known fault, so the second and third stale jobs
-- changed nothing anyone could see; there was no way to say "known, being
-- handled", and nothing inside the CRM alerted at all.
--
-- WHAT
--   1. cron_heartbeats gains:
--        acknowledged_until  timestamptz  a known fault, quiet until then
--        acknowledged_by     uuid         who acknowledged (no FK: a heartbeat
--                                         row must never cascade off a profile)
--        acknowledged_note   text         why / who is on it
--        stale_alerted_at    timestamptz  the watchdog alerted on the current
--                                         stale episode at this time; cleared
--                                         when the job recovers
--   2. public.cron_health (security_invoker, unchanged) gains, at its end,
--      acknowledged_until, acknowledged_note, is_acknowledged and
--      stale_alerted_at, and is closed to anon/authenticated (server-only;
--      nothing in a browser or the phone reads it).
--
-- ROLLBACK: re-create cron_health as before (the view minus the four new
--   columns), then ALTER TABLE public.cron_heartbeats DROP COLUMN the four.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.cron_heartbeats
  ADD COLUMN IF NOT EXISTS acknowledged_until timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_by uuid,
  ADD COLUMN IF NOT EXISTS acknowledged_note text,
  ADD COLUMN IF NOT EXISTS stale_alerted_at timestamptz;

COMMENT ON COLUMN public.cron_heartbeats.acknowledged_until IS
  'STALEWATCH.1 (mig 843): a known fault is acknowledged until this time. While it is in the future a stale row neither alerts nor turns /api/cron/health-check red.';
COMMENT ON COLUMN public.cron_heartbeats.stale_alerted_at IS
  'STALEWATCH.1 (mig 843): when the stale-job watchdog alerted on the current stale episode. NULL = not alerted (or recovered since). Written only by the watchdog.';

CREATE OR REPLACE VIEW public.cron_health
WITH (security_invoker = on) AS
SELECT
  name,
  last_ok_at,
  expected_interval_seconds,
  grace_seconds,
  EXTRACT(epoch FROM now() - last_ok_at)::integer AS stale_seconds,
  expected_interval_seconds + grace_seconds AS max_allowed_seconds,
  (now() - last_ok_at) > make_interval(secs => (expected_interval_seconds + grace_seconds)::double precision) AS is_stale,
  acknowledged_until,
  acknowledged_note,
  (acknowledged_until IS NOT NULL AND acknowledged_until > now()) AS is_acknowledged,
  stale_alerted_at
FROM public.cron_heartbeats;

-- Server-only (mig 677's rule for a re-created relation): every reader of
-- cron_health is a service-role route. authenticated held table privileges on
-- it, but saw nothing (cron_heartbeats is deny-all under RLS), so this
-- changes no reader.
REVOKE ALL ON public.cron_health FROM anon, authenticated;

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'cron_health' AND column_name = 'is_acknowledged') THEN
    RAISE EXCEPTION '843: cron_health.is_acknowledged missing';
  END IF;
  IF NOT (SELECT coalesce('security_invoker=on' = ANY (reloptions), false) FROM pg_class WHERE oid = 'public.cron_health'::regclass) THEN
    RAISE EXCEPTION '843: cron_health must stay security_invoker';
  END IF;
END
$check$;

COMMIT;
