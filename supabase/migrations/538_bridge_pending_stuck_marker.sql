-- B11 / BRIDGE-UNDELIVERED.1 — notice a bridge that is READING straps fine
-- but cannot DELIVER them.
--
-- WHY THIS EXISTS
-- Mig 531 started storing `ble_bridges.last_pending_samples` — how many samples
-- were sitting in the bridge's local flush queue at its last heartbeat — and
-- nothing grades on it. Its own COMMENT names the fault it would catch: "a
-- number that climbs and never falls means the bridge is READING straps fine
-- but cannot deliver them (network/auth)".
--
-- That is a THIRD failure, distinct from the two mig 531 covered:
--
--   unreachable / service_down  the bridge is not talking to us at all
--   adapter_down / blind        the bridge is talking, and reading nothing
--   THIS                        the bridge is talking, reading fine, and the
--                               readings are not arriving
--
-- And it is the one every existing grade actively certifies as healthy: the
-- heartbeats keep arriving, `status` stays 'online', `last_seen_at` stays
-- fresh, the radios report ready, so the whole fleet-health chain says OK
-- while the Pi's buffer backs up. champ-bridge caps that buffer at 5,000
-- samples (`src/buffer.js` MAX_BUFFER) and DROPS THE OLDEST past it — so the
-- window between "delivery broke" and "heart-rate data is being destroyed" is
-- minutes, and nothing was watching it.
--
-- WHY A MARKER COLUMN AND NOT A DERIVATION
-- `last_pending_samples` is a whole-column overwrite with no history — the
-- CRM sees one number per heartbeat and nothing about the one before it. So
-- "climbs and never falls" is NOT derivable from it: a single reading of 3,200
-- is indistinguishable from a healthy bridge mid-flush and from a queue that
-- has been stuck for an hour. Something has to remember WHEN.
--
-- The honest options were a time-series table (`bridge_telemetry_samples`) or
-- one transition marker. For a ONE-bridge fleet writing every 30s, a history
-- table is a table to prune, a retention decision, an index, and a second
-- source of truth about bridge health — all to answer a single question the
-- marker answers exactly: how long has the queue been non-empty? Same
-- reasoning as mig 531 denormalising the adapter flags out of `last_telemetry`
-- rather than making the cron read jsonb paths, and the same reasoning as
-- `fleet_device_health` existing at all (mig 472) — persist the transition,
-- not the stream.

ALTER TABLE public.ble_bridges
  ADD COLUMN IF NOT EXISTS pending_stuck_since timestamptz;

COMMENT ON COLUMN public.ble_bridges.pending_stuck_since IS
  'BRIDGE-UNDELIVERED.1 (mig 538) — start of the current unbroken run of heartbeats reporting a NON-EMPTY flush queue, i.e. when the bridge''s local sample buffer was last observed empty. Set by /api/bridge/heartbeat on the first telemetry reporting pending_samples > 0 while this is NULL; cleared to NULL by any telemetry reporting 0. NULL = the queue is draining normally, or the bridge sends no telemetry at all (older software) — NEITHER is a fault, and a bridge that never reports must never appear stuck. Age alone is NOT the alert: fleet-health also requires last_pending_samples above a backlog floor and a FRESH last_telemetry_at, because a frozen marker on a bridge that stopped reporting only ages, it does not mean anything.';

-- ── fleet_device_health: one more state ──────────────────────────
--
-- ORDERING DEPENDENCY, third time (migs 470/471/472 state the rule, 531
-- repeated it). `state` carries an inline CHECK: mig 472 pinned it to
-- ('ok','unreachable','service_down'), mig 531 widened it to add
-- ('blind','adapter_down'). The fleet-health cron UPSERTs the graded state
-- every 5 minutes, so a run that grades 'undelivered' against the mig-531
-- constraint fails the upsert for the WHOLE TICK — every device loses its
-- state row, which is the alert de-dup memory, which means the next tick
-- re-alerts on everything. This migration must therefore be APPLIED BEFORE
-- the code that writes the new state deploys.
--
-- This rebuilds the constraint from mig 531's list rather than diffing it, so
-- the full value set is readable in one place at the point of change.
--
--   undelivered — the bridge is on the tailnet, heartbeating, radios fine, and
--                 SELF-REPORTING a queue of samples it has not managed to send
--                 for longer than the flush loop could possibly explain. The
--                 strongest of the "online but not working" grades because it
--                 is not inferred: the bridge is telling us it is holding data.
--
-- Ranked ABOVE adapter_down and blind in gradeDevice — see the justification
-- in src/lib/fleet-health.js. Short version: those two say "no data is being
-- produced", this one says "data exists and is being lost on a clock", and a
-- standing radio fault must not mask an active loss.

ALTER TABLE public.fleet_device_health
  DROP CONSTRAINT IF EXISTS fleet_device_health_state_check;

ALTER TABLE public.fleet_device_health
  ADD CONSTRAINT fleet_device_health_state_check
  CHECK (state IN ('ok', 'unreachable', 'service_down', 'blind', 'adapter_down', 'undelivered'));

COMMENT ON COLUMN public.fleet_device_health.state IS
  'FLEET-ALERT.1 / BRIDGE-BLIND.1 / BRIDGE-UNDELIVERED.1 — ok | unreachable (off the tailnet past OFFLINE_AFTER_MS) | service_down (on the tailnet, the thing it exists to do has stopped) | undelivered (bridge online and reading, but self-reporting samples it has not been able to send — data is lost once its 5,000-sample buffer fills) | adapter_down (bridge reports a radio not ready — standing fault, alerts once) | blind (bridge online with healthy-looking radios, but samples stopped mid-class — an observation, not a diagnosis).';
