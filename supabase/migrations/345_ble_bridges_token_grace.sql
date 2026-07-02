-- 345_ble_bridges_token_grace.sql
-- HR-WAVE2 (W2-C) — dual-token grace rotation + a terminal decommissioned state.
--
-- Two independent hardening changes to ble_bridges, both additive:
--
-- 1. Grace-window rotation. Today rotating a token is a hard cut — the route
--    overwrites api_token_hash and the old token dies instantly, so a mid-day
--    rotation takes live HR ingest down until the Pi is reflashed. That
--    discourages rotation entirely. We add a slot for the *previous* hash plus
--    an expiry; on rotation the route moves the current hash into
--    previous_token_hash with previous_token_expires_at = now() + 24h, so the
--    old token keeps authenticating for a short grace window while the Pi is
--    updated. verifyBridgeToken accepts the previous hash only while
--    previous_token_expires_at > now().
--
-- 2. Decommissioned bridges kept authenticating (security audit L2). status
--    only had liveness values (online/offline/error) — all of which a live
--    bridge legitimately passes through (offline is the resting default;
--    online/error are set by the heartbeat). There was no way to express
--    "this bridge is retired, reject its token even though the row survives".
--    We extend the CHECK to add a terminal 'decommissioned' state that
--    verifyBridgeToken refuses. The heartbeat never sets it (only 'online'/
--    'error'), so it can only be set by an operator via the admin route.

ALTER TABLE public.ble_bridges
  ADD COLUMN IF NOT EXISTS previous_token_hash       text,
  ADD COLUMN IF NOT EXISTS previous_token_expires_at timestamptz;

COMMENT ON COLUMN public.ble_bridges.previous_token_hash IS
  'sha256 of the prior bearer token during a rotation grace window; still authenticates while previous_token_expires_at > now() (mig 345).';
COMMENT ON COLUMN public.ble_bridges.previous_token_expires_at IS
  'When the previous_token_hash stops authenticating (rotation grace window end). NULL once expired/cleared (mig 345).';

-- Add a terminal 'decommissioned' state. The old CHECK only allowed the three
-- liveness values; widen it so an operator can retire a bridge and have its
-- token rejected at auth time.
ALTER TABLE public.ble_bridges
  DROP CONSTRAINT IF EXISTS ble_bridges_status_check;

ALTER TABLE public.ble_bridges
  ADD CONSTRAINT ble_bridges_status_check
    CHECK (status IN ('online', 'offline', 'error', 'decommissioned'));
