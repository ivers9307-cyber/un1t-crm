-- ============================================================
-- 023: Device push tokens for the iOS mobile app
--
-- The mobile app (Expo / React Native) registers an Expo push token
-- on login and de-registers on logout. We send notifications via the
-- Expo Push Service (https://exp.host/--/api/v2/push/send) using
-- src/lib/push.js — Expo proxies to APNs (iOS) and FCM (Android).
--
-- Schema notes:
--   - One row per (user_id, expo_push_token) — the same user can have
--     multiple devices (phone + iPad).
--   - last_seen_at is bumped every login so we can prune stale rows.
--   - token (Expo's "ExponentPushToken[xxx...]") is unique to prevent
--     dupes if the app re-registers without de-registering first.
--   - platform is informational only ('ios' | 'android' | 'web').
--   - device_name is optional, set client-side from Constants.deviceName
--     so admins can recognise tokens in the audit panel later.
--
-- Cleanup: when a token returns DeviceNotRegistered from Expo (uninstall,
-- token rotation), src/lib/push.js calls handleInvalidToken() which
-- deletes the row. No cron needed.
-- ============================================================

CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  device_name TEXT,
  app_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user_id ON device_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_last_seen ON device_tokens(last_seen_at);

COMMENT ON TABLE device_tokens IS
  'Expo push tokens for mobile devices belonging to a profile. One row '
  'per device. Used by src/lib/push.js to fan out notifications via the '
  'Expo Push Service. Stale rows are pruned automatically when Expo '
  'reports DeviceNotRegistered for a token.';

COMMENT ON COLUMN device_tokens.expo_push_token IS
  'Expo Push Token of the form ExponentPushToken[xxx]. Unique across the '
  'table so a re-register without de-register is idempotent.';

COMMENT ON COLUMN device_tokens.platform IS
  'ios | android | web. Informational only — Expo handles the dispatch.';

-- ============================================================
-- RLS
--
-- device_tokens is service-role-only. The mobile app reaches it via
-- POST /api/mobile/device-tokens and DELETE /api/mobile/device-tokens
-- using the service-role server client. No direct PostgREST access.
-- ============================================================

ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;

-- Explicit deny-all for anon and authenticated. Service role bypasses RLS.
DROP POLICY IF EXISTS "device_tokens deny anon"          ON device_tokens;
DROP POLICY IF EXISTS "device_tokens deny authenticated" ON device_tokens;

CREATE POLICY "device_tokens deny anon"
  ON device_tokens
  AS RESTRICTIVE
  FOR ALL
  TO anon
  USING (false) WITH CHECK (false);

CREATE POLICY "device_tokens deny authenticated"
  ON device_tokens
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (false) WITH CHECK (false);

-- ============================================================
-- Mobile feature permissions
--
-- profiles.permissions is already a JSONB controlling sidebar
-- visibility (see StaffForm.jsx defaultPermissionsByRole). The
-- mobile app reads permissions.mobile.* on login and hides any
-- tab/screen that's off. No schema change needed — JSONB allows
-- arbitrary keys — but this comment documents the convention so
-- readers of the schema know what to expect.
--
-- Expected shape:
--   permissions = {
--     dashboard: bool, pipeline: bool, ... (existing web flags),
--     mobile: {
--       schedule: bool,
--       pipeline: bool,
--       whatsapp: bool,
--       time_off: bool,
--       assistant: bool,
--       door_unlock: bool,
--       push_notifications: bool,
--       notify_time_off: bool,
--       notify_schedule: bool,
--       notify_swap: bool,
--       notify_lead: bool,
--       notify_whatsapp: bool
--     }
--   }
--
-- Defaults per role live in defaultMobilePermissionsByRole inside
-- StaffForm.jsx. The mobile app treats a missing permissions.mobile.*
-- key as "off" (deny by default).
-- ============================================================
