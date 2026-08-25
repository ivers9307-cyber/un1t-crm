-- 567 — REPSET-PUB.1A: record the BINARY's build number per device.
--
-- WHY. Apple's unlisted-distribution rule is one-way, so the public iOS app
-- needs a NEW app record and a NEW bundle id (`ie.repset.app`); the old
-- unlisted app (`com.un1tdublin.crm`) keeps serving its installed base off
-- the SAME OTA lane until it is sunset. To run the migration report — "who
-- is still on the old binary?" — the two iOS binaries must be
-- distinguishable server-side, and `device_tokens` carries nothing that
-- separates them: `app_version` is the OTA-delivered JS version, identical
-- on both.
--
-- WHY NOT THE BUNDLE ID. It cannot be read honestly from JS.
-- `Constants.expoConfig` reflects the OTA-delivered config, so once the
-- bundle-id PR publishes, OLD binaries would report the NEW bundle id.
-- `expo-application` (the native source of truth) is not installed and
-- adding it is a native change — forbidden during the runtimeVersion freeze
-- window this whole programme depends on.
--
-- WHAT. `native_build` is the binary's Info.plist build number
-- (CFBundleVersion on iOS, versionCode on Android), read via
-- `Constants.nativeBuildVersion` from expo-constants (already a dependency,
-- no native add) and reported by the app on every device registration. It
-- is baked into the binary at build time and an OTA cannot change it — that
-- OTA-immunity is the entire point.
--
-- Text, not an integer, on purpose: it is a client-reported opaque
-- identifier, iOS build strings are not guaranteed numeric, and a
-- simulator can report nothing at all. NULL means "never reported" (a
-- client below this change, or a device that could not read it) — never
-- read a NULL as build zero. Classification lives in app code
-- (`classifyBinary` in src/lib/staff-devices.js), not in the column.

ALTER TABLE public.device_tokens
  ADD COLUMN IF NOT EXISTS native_build text;

COMMENT ON COLUMN public.device_tokens.native_build IS
  'REPSET-PUB.1A (mig 567) — the BINARY''s Info.plist build number (iOS CFBundleVersion / Android versionCode), reported by the app from Constants.nativeBuildVersion. OTA-IMMUNE: baked in at build time, unchanged by an eas update, which is why it — and not the bundle id or app_version — distinguishes the OLD unlisted iOS app from the NEW public `ie.repset.app` binary for the migration report. NULL = never reported (pre-1A client, or unreadable); NULL is NOT build zero.';
