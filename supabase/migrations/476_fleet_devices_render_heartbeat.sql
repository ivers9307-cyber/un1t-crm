-- FLEET-CMD.2 — prove the kiosk is actually RENDERING, not merely powered.
-- Spec: docs/superpowers/specs/2026-08-02-fleet-remote-actions-design.md
--
-- THE BLIND SPOT THIS CLOSES
-- FLEET-ALERT.1 grades a kiosk on Tailscale reachability alone, because a
-- kiosk ran chromium and nothing else and reported nothing to the CRM. So the
-- single most likely real failure — a Pi that is powered, on the tailnet,
-- answering SSH, and showing a BLACK SCREEN — grades `ok`. The alert we built
-- to stop a 17-day silent failure cannot see the failure mode most likely to
-- happen on a wall TV.
--
-- WHY THIS SIGNAL AND NOT AN AGENT PROBE
-- The obvious fix is to have the fleet agent run `pgrep chromium`. That is
-- weaker than it looks: it proves a process exists, not that anything is on
-- screen. A chromium stuck on an error page, a failed bundle, or a dead
-- network all pass `pgrep` while the board is blank.
--
-- The TV page already polls /api/public/live/[locationId] every 4 seconds
-- (30s only overnight — see src/lib/live-poll.js). That request ARRIVING is a
-- far stronger claim: the process is alive, the network works, the page
-- loaded, and React is running. It is the difference between "something called
-- chromium exists" and "the board is alive".
--
-- And it costs nothing. The traffic already happens; we are only writing down
-- that it did.
--
-- WHAT IT STILL CANNOT SEE
-- A Pi rendering correctly into a TV that is switched off, unplugged, or on
-- the wrong HDMI input. No software signal can — that needs eyes in the room.

ALTER TABLE public.fleet_devices
  ADD COLUMN IF NOT EXISTS last_render_at TIMESTAMPTZ;

COMMENT ON COLUMN public.fleet_devices.last_render_at IS
  'FLEET-CMD.2 — last time this kiosk''s BROWSER fetched the live board. Stamped by /api/public/live/[locationId] when the TV page passes ?device=. Proof the screen is actually rendering: process alive, network up, page loaded and React running. NULL for a bridge (no browser) and for a kiosk that has not yet been redeployed with the device-tagged URL.';

-- Partial: only kiosks ever carry a render time, and the grader reads it per
-- device on every tick.
CREATE INDEX IF NOT EXISTS fleet_devices_render_idx
  ON public.fleet_devices (last_render_at)
  WHERE role = 'kiosk';
