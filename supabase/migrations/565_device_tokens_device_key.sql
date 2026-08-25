-- 565 — ANDROID-VIS.1: give device_tokens an identity that does not
-- depend on a push token.
--
-- WHY. The table was keyed by `expo_push_token` (NOT NULL + UNIQUE), so a
-- row could only exist for a device that had successfully obtained an Expo
-- push token. On Android that requires FCM credentials which have never
-- been configured for this project, so `getExpoPushTokenAsync()` throws,
-- mobile/lib/push-register.js swallows the failure by design, and NO ROW IS
-- EVER WRITTEN. Prod on 2026-08-24: 13 iOS rows, zero Android rows ever,
-- while Android staff sign in every week. That made Android invisible to
-- push (unavoidable until FCM is set up) AND to the staff-device /
-- geofence_permission report (avoidable — that is what this fixes).
--
-- WHAT. `device_key` is an app-generated, SecureStore-persisted per-install
-- id (mobile/lib/device-key.js — no new native dependency, so no
-- runtimeVersion bump). It becomes the device identity; the push token
-- becomes an optional CAPABILITY of that identity.
--
-- DUAL IDENTITY, deliberately. The unique index on `expo_push_token`
-- STAYS: 13 live iOS rows are keyed by it, older clients still upsert on
-- it, and a push token must never be claimed by two rows at once. Postgres
-- treats NULLs as distinct in a unique index, so any number of token-less
-- rows coexist under it. The route adopts a legacy row into a device_key
-- the first time an updated client reports (UPDATE … WHERE
-- expo_push_token = $1 AND device_key IS NULL), so no backfill is possible
-- or needed here — we cannot know a device's key until it tells us.
--
-- The CHECK keeps every row reachable by at least one identity, so a row
-- can never become an orphan that no client can ever update again.

ALTER TABLE public.device_tokens
  ALTER COLUMN expo_push_token DROP NOT NULL;

ALTER TABLE public.device_tokens
  ADD COLUMN IF NOT EXISTS device_key text;

-- Partial + explicit: the existing 13 rows have a NULL device_key and must
-- stay legal. NULLs are distinct in a btree unique index anyway; the WHERE
-- clause states the intent and keeps the index small.
CREATE UNIQUE INDEX IF NOT EXISTS device_tokens_device_key_key
  ON public.device_tokens (device_key)
  WHERE device_key IS NOT NULL;

ALTER TABLE public.device_tokens
  DROP CONSTRAINT IF EXISTS device_tokens_identity_present;
ALTER TABLE public.device_tokens
  ADD CONSTRAINT device_tokens_identity_present
  CHECK (expo_push_token IS NOT NULL OR device_key IS NOT NULL);

COMMENT ON COLUMN public.device_tokens.device_key IS
  'ANDROID-VIS.1 (mig 565) — app-generated per-install id, persisted in SecureStore. The device IDENTITY. NULL on rows registered by clients older than 2.3.x; those are adopted into a key the first time an updated client reports.';
COMMENT ON COLUMN public.device_tokens.expo_push_token IS
  'ANDROID-VIS.1 (mig 565) — NULLABLE since mig 565. NULL = this device is registered for reporting but cannot receive push (no FCM credentials on Android, or notification permission declined). EVERY SENDER MUST FILTER `expo_push_token IS NOT NULL`.';
