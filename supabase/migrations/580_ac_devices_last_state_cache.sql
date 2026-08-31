-- SENSIBO-RATE.1 — cache the last observed vendor state per AC device.
--
-- WHY: GET /api/studio-management/ac/devices/[id] called the vendor
-- LIVE on every request, and both AcControlPanel.jsx and mobile's
-- AcDeviceList.jsx poll that route every 30s per device card with no
-- visibility gating. So every open AC panel was a permanent 2
-- vendor calls/minute, forever, per client.
--
-- That is fatal against Sensibo specifically, which rate-limits on
-- BURSTS rather than volume (measured 2026-08-31: ~4 calls inside
-- 1.6s → 429, and the block persists >75s). Background polling from
-- a couple of open panels kept the token bucket at zero, so the AC
-- crons found no budget left when they actually needed to act, and
-- the gym-floor unit stopped auto-offing from 2026-08-29.
--
-- The ac-external-rule cron ALREADY polls every enabled device once
-- per tick to detect externally-started units. So the reading exists
-- — it was just being thrown away. Persist it and let the UI read
-- this instead of the vendor. Mutations (turn-on/off/extend) write
-- it too, so an action taken through the CRM reflects immediately;
-- only a change made on the wall panel or the vendor's own app lags,
-- by at most one cron tick, which is exactly what that cron is for.
--
-- Nullable with no backfill: a NULL simply means "not observed yet",
-- and the next ac-external-rule tick fills it in within ~5 minutes.
-- Nothing reads it before it is written.

ALTER TABLE ac_devices
  ADD COLUMN IF NOT EXISTS last_state    jsonb,
  ADD COLUMN IF NOT EXISTS last_state_at timestamptz;

COMMENT ON COLUMN ac_devices.last_state IS
  'SENSIBO-RATE.1 — last observed vendor state (Sensibo acState / ThinQ state). Written by the ac-external-rule cron and by every CRM-initiated power change. Read by the AC panel so 30s UI polling never hits the vendor. NULL = not observed yet.';

COMMENT ON COLUMN ac_devices.last_state_at IS
  'SENSIBO-RATE.1 — when last_state was observed. The panel renders it as an "as of" time; a stale value means the ac-external-rule cron is not running, not that the device is off.';
