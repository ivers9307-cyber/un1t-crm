-- FLEET-CMD.1 — remote actions issued to a Pi, and what came back.
-- Spec: docs/superpowers/specs/2026-08-02-fleet-remote-actions-design.md
--
-- THE SECURITY SPINE
-- `action` is an ENUMERATED NAME, never a command string. The Pi maps the name
-- to a command from its own hard-coded table and refuses anything it does not
-- recognise.
--
-- This is the single property that must not be softened for convenience. If
-- shell text could cross this boundary, a compromised admin session, an SQL
-- injection, or one stray UPDATE would be arbitrary root execution on hardware
-- sitting inside the gym. With a name-based enum the worst a hostile row can
-- do is reboot a Pi the operator already controls.
--
-- Corollary: no parameters. If an action ever needs an argument it gets a
-- typed, validated column — never free text.

CREATE TABLE IF NOT EXISTS public.fleet_commands (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_name TEXT NOT NULL REFERENCES public.fleet_devices(device_name) ON DELETE CASCADE,
  -- See above. Names only. The CHECK is the allowlist.
  action      TEXT NOT NULL CHECK (action IN
                ('restart_kiosk', 'reboot', 'shutdown', 'redeploy_bridge', 'pull_logs')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                ('pending', 'claimed', 'succeeded', 'failed', 'rejected', 'expired')),
  issued_by   UUID NOT NULL REFERENCES public.profiles(id),
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NOT nullable, deliberately. See below.
  expires_at  TIMESTAMPTZ NOT NULL,
  claimed_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  exit_code   INTEGER,
  -- Truncated device output. pull_logs (P2) is the only action that fills it
  -- with anything substantial.
  output      TEXT,
  error       TEXT
);

COMMENT ON TABLE public.fleet_commands IS
  'FLEET-CMD.1 — remote actions for the Pi fleet. Queue, audit log, and UI source in one table. `action` is an allowlisted NAME; the Pi owns the mapping to a command. Never store shell text here.';

COMMENT ON COLUMN public.fleet_commands.action IS
  'Allowlisted action NAME, not a command. The Pi agent maps it via its own hard-coded table and rejects unknown names. Adding a value here does nothing until the agent knows it.';

-- WHY EXPIRY IS NOT OPTIONAL
-- If a Pi is offline when someone presses Reboot and the command simply waits,
-- the Pi reboots itself whenever it next comes online — possibly mid-class,
-- hours later, with nobody expecting it. That is a worse failure than the
-- button not working.
--
-- The agent checks expiry itself before executing (its clock is NTP-synced;
-- provisioning waits for timedatectl before installing anything, precisely
-- because a Pi has no RTC), and the fleet-health cron sweeps stragglers.
COMMENT ON COLUMN public.fleet_commands.expires_at IS
  'FLEET-CMD.1 — hard delivery deadline, normally issued_at + 2 minutes. An undelivered command DIES rather than queuing: a reboot landing hours later mid-class is worse than a button that reported failure. Enforced by the agent and swept by the cron.';

COMMENT ON COLUMN public.fleet_commands.status IS
  'pending -> claimed -> succeeded|failed. rejected = the agent refused (unknown action, or wrong role for the device). expired = never delivered inside expires_at.';

-- The agent's Realtime subscription filters on device_name; the sweeper and
-- the page both read by status and recency.
CREATE INDEX IF NOT EXISTS fleet_commands_device_status_idx
  ON public.fleet_commands (device_name, status);

CREATE INDEX IF NOT EXISTS fleet_commands_issued_at_idx
  ON public.fleet_commands (issued_at DESC);

-- Pending work, for the sweeper.
CREATE INDEX IF NOT EXISTS fleet_commands_pending_idx
  ON public.fleet_commands (expires_at)
  WHERE status IN ('pending', 'claimed');

ALTER TABLE public.fleet_commands ENABLE ROW LEVEL SECURITY;

-- Blanket deny, and the agent is NOT an exception — it never reads this table.
--
-- The obvious design (agent subscribes to postgres_changes on this table) would
-- have forced a hole in this policy plus a per-device credential able to read
-- rows, which meant either minting custom JWTs or creating a Supabase auth user
-- per Pi. The latter is a live trap here: public.handle_new_user() is an
-- INVERTED allowlist, so an auth user created without an `invited_for` marker
-- is auto-granted a staff profile with pipeline and contacts access. Every
-- Raspberry Pi would have become a staff account.
--
-- So Realtime is used as a DOORBELL, not a data channel. The CRM broadcasts a
-- contentless "you have work" ping on a channel named for the device; the agent
-- then makes one authenticated request to /api/fleet/commands/next with its own
-- bearer token to find out what the command actually is. The channel carries no
-- secrets, so it does not matter that the anon key is public — an eavesdropper
-- learns only that some device was poked, and a forged ping makes the agent
-- perform an authenticated fetch that returns nothing.
--
-- The security boundary therefore stays exactly where it already was: an
-- authenticated CRM endpoint. No custom JWTs, no new auth users, no RLS hole.
--
-- Every legitimate write path is a service-role route that checks the
-- per-action permission key in app code first — routes bypass RLS entirely, so
-- app code is the real gate and these policies make an accidental browser
-- client fail closed rather than leak the command stream.
CREATE POLICY "fleet_commands_no_anon" ON public.fleet_commands
  FOR ALL TO anon
  USING (FALSE) WITH CHECK (FALSE);

CREATE POLICY "fleet_commands_no_authenticated" ON public.fleet_commands
  FOR ALL TO authenticated
  USING (FALSE) WITH CHECK (FALSE);
