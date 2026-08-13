-- 542 — GEO-ATT.21: let a device report that its permission could not be READ.
--
-- device_tokens.geofence_permission could say always / when_in_use / denied /
-- undetermined, or NULL for "never reported". There was no value for "the app
-- asked the OS and the call threw", so the mobile client skipped the report
-- entirely on that path (`if (!bg) return`). The row then kept its last good
-- value — typically 'always' — while geofencing had actually been torn down on
-- that handset. Every operator surface showed a green "Always" chip for a
-- device that was no longer clocking anyone in.
--
-- 'unknown' is deliberately NOT the same as NULL. NULL means "this device has
-- never told us" (an old build, or a device that has not foregrounded since
-- STAFF-DEV.7). 'unknown' means "this device told us, and the answer was that
-- it cannot tell" — which is a fault to chase, not an absence of data. Same
-- distinction the existing chips already draw between NULL ("—") and 'denied'.
--
-- Widening a CHECK is additive: existing rows all satisfy the new constraint,
-- and an older client that never sends 'unknown' is unaffected.

ALTER TABLE public.device_tokens
  DROP CONSTRAINT IF EXISTS device_tokens_geofence_permission_check;

ALTER TABLE public.device_tokens
  ADD CONSTRAINT device_tokens_geofence_permission_check
  CHECK (
    geofence_permission IS NULL
    OR geofence_permission = ANY (ARRAY[
      'always'::text,
      'when_in_use'::text,
      'denied'::text,
      'undetermined'::text,
      'unknown'::text
    ])
  );

COMMENT ON COLUMN public.device_tokens.geofence_permission IS
  'Background-location permission as the DEVICE last reported it (STAFF-DEV.7). '
  'NULL = never reported. ''unknown'' (mig 542) = the device reported that the '
  'permission API failed, so geofencing is NOT running on it — a fault, not an absence.';
