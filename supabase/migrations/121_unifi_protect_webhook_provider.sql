-- 121_unifi_protect_webhook_provider.sql
--
-- Phase 2 of zero-touch attendance: add UniFi Protect to the
-- webhook_events provider whitelist so the dedup chokepoint
-- accepts Protect alarm events.
--
-- This is a constraint-only migration. The receiver
-- (/api/webhooks/unifi-protect) is deployed in DARK-LAUNCH mode:
-- it authenticates the request, persists every event to
-- staff_attendance_events with source='protect', and logs key
-- payload fields — but does NOT yet match faces to staff or stamp
-- shifts. Same play that worked for Access in mig 120: capture
-- payloads against live UniFi traffic before writing the parser,
-- because the documented payload shape and the wire-observed
-- shape diverge often enough that we don't trust the docs.
--
-- Follow-up migrations:
--   122  — add profile_locations.protect_face_id + RLS, the
--          face↔profile mapping that lets the receiver resolve
--          identity (currently every dark-launch event lands as
--          match_outcome='unknown_user' by definition).
--
-- Note: staff_attendance_events.source already accepts 'protect'
-- from mig 120's design — no change to that table here.

BEGIN;

ALTER TABLE public.webhook_events DROP CONSTRAINT IF EXISTS webhook_events_provider_check;
ALTER TABLE public.webhook_events ADD CONSTRAINT webhook_events_provider_check
  CHECK (provider = ANY (ARRAY[
    'postmark', 'revolut', 'revolut_race', 'whatsapp', 'twilio', 'xero',
    'unifi_access', 'unifi_protect'
  ]));

COMMIT;
