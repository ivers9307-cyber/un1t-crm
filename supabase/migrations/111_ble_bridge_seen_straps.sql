-- 111_ble_bridge_seen_straps.sql
--
-- Adds ble_bridges.last_seen_straps jsonb so the bridge can report
-- which straps it currently has BLE connections to. The coach
-- pairing UI reads this to render "available straps" — the list a
-- coach picks from when assigning a strap MAC to an attendee at
-- start of class.
--
-- Schema shape (the bridge sends, server stores):
--   [
--     { mac: "AA:BB:CC:DD:EE:FF", name: "Polar H10", rssi: -54,
--       seen_at: "2026-05-08T16:30:00Z", last_bpm: 122 },
--     ...
--   ]
--
-- Refreshed on each POST /api/bridge/scan (every ~5s while a class
-- is forming, less often otherwise — bridge decides). It's
-- intentionally a single column, not a table: rows would churn
-- constantly and we never need history. The jsonb is overwritten,
-- not appended.
--
-- Visibility: staff at the bridge's location read this via the
-- existing "Staff can view bridges at location" policy. No
-- customer access.

ALTER TABLE public.ble_bridges
  ADD COLUMN IF NOT EXISTS last_seen_straps jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.ble_bridges.last_seen_straps IS
  'Latest snapshot of straps the bridge currently has BLE connections to. Overwritten on every POST /api/bridge/scan; not historised.';
