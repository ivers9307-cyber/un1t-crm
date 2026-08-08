-- FLEET-CMD.1 — the CRM's record of what Pis exist.
-- Spec: docs/superpowers/specs/2026-08-02-fleet-remote-actions-design.md
--
-- WHY THIS EXISTS
-- Until now the CRM had no idea a kiosk Pi existed. `ble_bridges` knew about
-- the bridge (location_id, hardware_id, and since mig 473 tailscale_hostname),
-- so it quietly became the de facto device registry — which made every other
-- Pi look like a bridge with missing columns. It isn't. The bridge is one role
-- among three, no kiosk routes through it, and at runtime a kiosk talks only
-- to the CRM.
--
-- This table is the primary record for EVERY Pi. `ble_bridges` keeps what is
-- genuinely bridge-specific (HR token, strap state, service status) and hangs
-- off the device rather than standing in for it.
--
-- THE LOCATION WAS NEVER UNKNOWN
-- un1t-pi's fleet.yaml carries location_id per site, and roles/kiosk.js bakes
-- it straight into the Chromium URL at provisioning time:
--     ${crmBaseUrl}/tv/${device.location_id}?kiosk=1
-- Every Pi has known where it lives since the day it was imaged. The CRM
-- simply never wrote it down. This migration is the CRM catching up with the
-- manifest, not new information being discovered.
--
-- WHY location_id AND role ARE NULLABLE
-- The fleet-health cron discovers devices from Tailscale, and Tailscale knows
-- a hostname and nothing else. A Pi provisioned tomorrow appears there before
-- anyone registers it here. Requiring a location would have forced a choice
-- between the cron failing on unknown devices or silently skipping them — and
-- a silently unmonitored Pi is exactly the failure FLEET-ALERT.1 exists to
-- prevent. So the cron auto-registers what it finds, and an unclaimed row
-- (location_id NULL) is a visible "needs a home" rather than a phantom.
--
-- Unclaimed devices are inert on purpose: with no location they fall outside
-- every non-master's scope, and with no role no action is applicable to them.

CREATE TABLE IF NOT EXISTS public.fleet_devices (
  -- Tailscale hostname, equal to the fleet.yaml device name.
  device_name     TEXT PRIMARY KEY,
  -- NULL = discovered by the cron but not yet claimed. See above.
  location_id     UUID REFERENCES public.locations(id) ON DELETE RESTRICT,
  role            TEXT CHECK (role IN ('kiosk', 'bridge')),
  label           TEXT,
  -- Per-device credential for the agent (FLEET-CMD.1). Hash only; the raw
  -- token is shown once at issue and written to /etc/un1t-pi/agent.env by
  -- provisioning. Same discipline as ble_bridges.api_token_hash.
  api_token_hash  TEXT,
  token_issued_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.fleet_devices IS
  'FLEET-CMD.1 — primary record of every Raspberry Pi in the fleet, whatever its role. fleet.yaml in un1t-pi remains the provisioning source of truth; this is the CRM''s copy, auto-registered on discovery by the fleet-health cron and claimed to a location by an admin.';

COMMENT ON COLUMN public.fleet_devices.location_id IS
  'NULL = discovered but unclaimed. Unclaimed devices are outside every non-master''s scope and offer no actions.';

COMMENT ON COLUMN public.fleet_devices.role IS
  'Governs which remote actions apply: restart_kiosk is kiosk-only, redeploy_bridge is bridge-only. NULL until claimed.';

CREATE INDEX IF NOT EXISTS fleet_devices_location_idx
  ON public.fleet_devices (location_id);

ALTER TABLE public.fleet_devices ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS; these exist so anon/authenticated can never touch
-- the table even via an accidental browser client. Mirrors mig 472.
CREATE POLICY "fleet_devices_no_anon" ON public.fleet_devices
  FOR ALL TO anon
  USING (FALSE) WITH CHECK (FALSE);

CREATE POLICY "fleet_devices_no_authenticated" ON public.fleet_devices
  FOR ALL TO authenticated
  USING (FALSE) WITH CHECK (FALSE);

-- Seed the live Stillorgan fleet from fleet.yaml. Hatch is deliberately absent:
-- its location_id is null in the manifest (the CRM location does not exist
-- yet), and those Pis are not provisioned.
INSERT INTO public.fleet_devices (device_name, location_id, role, label) VALUES
  ('stillorgan-bridge', 'a0000000-0000-0000-0000-000000000001', 'bridge', 'HR bridge'),
  ('stillorgan-tv1',    'a0000000-0000-0000-0000-000000000001', 'kiosk',  'TV 1'),
  ('stillorgan-tv2',    'a0000000-0000-0000-0000-000000000001', 'kiosk',  'TV 2')
ON CONFLICT (device_name) DO NOTHING;

-- Health rows now describe a known device rather than floating free on a
-- string that arrived from Tailscale. Safe to add: the cron registers the
-- parent before upserting health, and the three existing health rows are
-- exactly the three devices seeded above.
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS; the guard keeps this migration
-- safe to re-run if it ever half-applies.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fleet_device_health_device_fk'
  ) THEN
    ALTER TABLE public.fleet_device_health
      ADD CONSTRAINT fleet_device_health_device_fk
      FOREIGN KEY (device_name) REFERENCES public.fleet_devices(device_name)
      ON DELETE CASCADE;
  END IF;
END $$;

-- FLEET-CMD.1 — maintenance window.
--
-- reboot and shutdown make a device unreachable ON PURPOSE. Without this the
-- cron pages the masters about the outage the operator just caused, and the
-- entire value of FLEET-ALERT.1 rests on it never crying wolf.
--
-- Deliberately consumed in decideAlert(), NOT gradeDevice(): a suppressed
-- device still GRADES unreachable and still reads as down in any UI. Hiding
-- the grade would reintroduce the precise lie BRIDGE-STATUS.1 (#1193) existed
-- to fix — a badge that says fine while the device is dead.
--
-- NULL = no window. 'infinity' is used for shutdown, which has no expected
-- return: the device stays suppressed until it reports in again.
ALTER TABLE public.fleet_device_health
  ADD COLUMN IF NOT EXISTS suppressed_until TIMESTAMPTZ;

COMMENT ON COLUMN public.fleet_device_health.suppressed_until IS
  'FLEET-CMD.1 — alerting is suppressed until this time because an operator initiated a reboot/shutdown. Suppresses the ALERT only; the state column still reports the truth. ''infinity'' for shutdown (no expected return).';
