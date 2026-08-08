-- FLEET-ALERT.1 — alert bookkeeping for the Raspberry Pi fleet.
-- Spec: docs/superpowers/specs/2026-08-02-fleet-health-alerting-design.md
--
-- WHY THIS EXISTS
-- The Stillorgan heart-rate bridge died on 2026-07-16 and nobody noticed for
-- 17 days; 1,186 heart-rate sessions were created with zero samples across
-- that window. BRIDGE-STATUS.1 (#1193) fixed the admin badge that lied about
-- it. This is the other half: nothing shouted. A corrected badge only helps
-- someone who goes and looks, and nobody did.
--
-- WHAT THIS TABLE IS *NOT*
-- Not a device inventory. `fleet.yaml` in the un1t-pi repo remains the record
-- of what hardware should exist; rows here appear only when Tailscale first
-- reports a device tagged tag:un1t-pi, and carry no configuration. Deleting a
-- row loses nothing but the memory of whether we have already alerted.
--
-- The sole purpose is alert de-duplication: without persisted state the cron
-- would re-alert every 5 minutes for as long as a device stayed down.

CREATE TABLE IF NOT EXISTS public.fleet_device_health (
  -- Tailscale hostname, which provisioning sets equal to the fleet.yaml name
  -- (e.g. 'stillorgan-tv1'). Stable across reboots and re-provisioning.
  device_name   TEXT        PRIMARY KEY,
  state         TEXT        NOT NULL CHECK (state IN ('ok', 'unreachable', 'service_down')),
  -- When the device ENTERED the current state — so an alert can say how long,
  -- and so a flapping device doesn't reset its clock on every tick.
  state_since   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = no alert sent for the current episode. Cleared on recovery so the
  -- next outage alerts again.
  alerted_at    TIMESTAMPTZ,
  last_checked  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.fleet_device_health IS
  'FLEET-ALERT.1 — per-device alert state for the Pi fleet. Alert de-duplication only; fleet.yaml in un1t-pi is the inventory of record.';

ALTER TABLE public.fleet_device_health ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS — these policies exist purely as defence in depth
-- so anon/authenticated can never read or write the table even if a future
-- handler accidentally uses the browser client. Mirrors cron_heartbeats
-- (mig 053).
CREATE POLICY "fleet_device_health_no_anon" ON public.fleet_device_health
  FOR ALL TO anon
  USING (FALSE) WITH CHECK (FALSE);

CREATE POLICY "fleet_device_health_no_authenticated" ON public.fleet_device_health
  FOR ALL TO authenticated
  USING (FALSE) WITH CHECK (FALSE);

-- Heartbeat row for the cron itself.
--
-- APPLY THIS BEFORE THE CRON DEPLOYS (same rule as migs 470/471) — otherwise
-- stampHeartbeat('fleet-health') UPDATEs zero rows every tick, logs a warning,
-- and cron_health stays blind to it. A monitoring feature whose own monitor is
-- silently dead would be a particularly poor joke.
--
-- Sizing: the cron runs every 5 minutes (Vercel */5). Budget expected+grace =
-- 300 + 1200 = 1500s (25 min) = 5 consecutive missed ticks. Looser than the
-- ratio used by the 60s crons (migs 119/471 budget ~3x cadence) because this
-- cron makes a network round-trip to api.tailscale.com and mints an OAuth
-- token before it can do any work — the same tail-latency argument mig 471
-- made for its Homey call. Still tight enough that a genuinely dead cron is
-- caught inside half an hour.
--
-- last_ok_at defaults to NOW() so cron_health reports healthy until the first
-- real tick stamps it (same rationale as migs 053/470/471).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) VALUES
  ('fleet-health', 300, 1200,
   'FLEET-ALERT.1 — every 5 min: reads Tailscale device reachability + bridge service health, alerts masters on transition. No-ops (but still heartbeats) when TAILSCALE_OAUTH_* env is unset. Vercel cron */5 * * * * UTC.')
ON CONFLICT (name) DO NOTHING;
