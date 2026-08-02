-- FLEET-ALERT.1 — link a bridge row to its Tailscale device.
-- Spec: docs/superpowers/specs/2026-08-02-fleet-health-alerting-design.md
--
-- WHY
-- The fleet-health cron reads device reachability from Tailscale and grades
-- bridges on service health from `ble_bridges`. Joining the two needs a shared
-- key, and there wasn't one:
--
--   Tailscale hostname   'stillorgan-bridge'    <- set by un1t-pi provisioning
--                                                  from the fleet.yaml name
--   ble_bridges.hardware_id 'stillorgan-pi-hr'  <- typed by an operator in the
--                                                  bridges admin, and sent by
--                                                  the Pi to authenticate
--
-- They are unrelated strings that merely look similar, and the live values do
-- not match. Keying on hardware_id would have silently matched nothing, and
-- the service-health half of the alert — the half that catches a Pi that is
-- powered on with a dead bridge service — would have been dead code that
-- looked like it worked.
--
-- Rather than overload hardware_id (it is an authentication identifier; making
-- it double as a network name would couple token auth to hostname changes),
-- this adds an explicit, nullable link.
--
-- NULL is a legitimate state: a bridge with no Tailscale device, or one not
-- yet linked, is still graded on reachability. It just doesn't get the second
-- signal. The bridges admin register form now asks for it, so newly registered
-- bridges are linked at birth.

ALTER TABLE public.ble_bridges
  ADD COLUMN IF NOT EXISTS tailscale_hostname TEXT;

COMMENT ON COLUMN public.ble_bridges.tailscale_hostname IS
  'FLEET-ALERT.1 — Tailscale device hostname (= the un1t-pi fleet.yaml device name, e.g. ''stillorgan-bridge''). Joins this row to its device for fleet-health alerting. NULL = not linked; the device is then graded on reachability only. NOT an auth identifier — that is hardware_id.';

-- One bridge row per device. Partial so the many NULLs don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS ble_bridges_tailscale_hostname_key
  ON public.ble_bridges (tailscale_hostname)
  WHERE tailscale_hostname IS NOT NULL;

-- Backfill the only live bridge. Stillorgan runs exactly one Pi 5 in the
-- bridge role, provisioned as 'stillorgan-bridge' (un1t-pi fleet.yaml), and
-- exactly one ble_bridges row exists for it. Guarded on hardware_id so this is
-- a no-op anywhere that row is absent.
UPDATE public.ble_bridges
   SET tailscale_hostname = 'stillorgan-bridge'
 WHERE hardware_id = 'stillorgan-pi-hr'
   AND tailscale_hostname IS NULL;
