-- 309: allow provider='strava' on hr_provider_connections.
--
-- STRAVA-INBOUND.1 (mig 308 + IB5 webhook branch + champ-app connect endpoint)
-- stores a routing record `hr_provider_connections(provider='strava', ...)` so the
-- webhook can resolve the member on a Strava workout.created. But the provider
-- CHECK still only allowed apple_health/fitbit/whoop/garmin, so the connect upsert
-- 500'd ('persist_failed') and the webhook always skipped 'unknown_user' — the
-- whole inbound-Strava path was inert. Widen the allow-list to include 'strava'.
ALTER TABLE hr_provider_connections DROP CONSTRAINT hr_provider_connections_provider_check;
ALTER TABLE hr_provider_connections ADD CONSTRAINT hr_provider_connections_provider_check
  CHECK (provider = ANY (ARRAY['apple_health'::text, 'fitbit'::text, 'whoop'::text, 'garmin'::text, 'strava'::text]));
