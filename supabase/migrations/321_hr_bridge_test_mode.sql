-- 321_hr_bridge_test_mode.sql
-- Time-boxed staff "HR test mode" per bridge. While test_mode_until is in the
-- future, a registered strap auto-routes to its member's session any time
-- (no live class required). Self-expiring so it can't be left on permanently.
ALTER TABLE public.ble_bridges
  ADD COLUMN IF NOT EXISTS test_mode_until timestamptz;

COMMENT ON COLUMN public.ble_bridges.test_mode_until IS
  'Staff HR test mode: while > now(), a registered strap creates a presence-less session any time. Self-expiring (mig 321).';
