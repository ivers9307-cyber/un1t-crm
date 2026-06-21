-- 304: inclusion core — allow source='participation' on heart_rate_sessions
-- + credit-attendance cron heartbeat. (303 is reserved by the win-back migration,
-- applied to prod but pending PR #620 merge — do not reuse it.)

ALTER TABLE public.heart_rate_sessions DROP CONSTRAINT IF EXISTS heart_rate_sessions_source_check;
ALTER TABLE public.heart_rate_sessions ADD CONSTRAINT heart_rate_sessions_source_check
  CHECK (source IN ('ble_bridge','apple_health','fitbit','whoop','garmin','manual','participation'));

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('credit-attendance', 86400, 7200, 'Daily 03:00 UTC — credit participation sessions for Glofox-attended classes.')
ON CONFLICT (name) DO NOTHING;
