-- B10 / BRIDGE-BLIND.1 — persist the bridge telemetry the CRM was throwing
-- away, and give fleet-health two more states to grade with.
--
-- WHY THIS EXISTS
-- 2026-08-12, Stillorgan: the heart-rate bridge heartbeated healthily for two
-- and a half hours while ingesting ZERO samples across two full classes.
-- Nothing could have alerted, and not because the signal was missing —
-- because it was discarded. The process was alive, so `status` stayed 'online'
-- and `last_seen_at` stayed fresh, and every surface that reads those two
-- columns (the admin badge, the TV connection dot, the fleet-health cron)
-- correctly reported a healthy bridge. Meanwhile the ANT+ scanner was wedged
-- and noble had come up `unauthorized`, so the BLE radio was never powered on
-- at all.
--
-- champ-bridge has sent per-adapter telemetry on EVERY heartbeat since it
-- shipped — `{ pending_samples, adapters: { ant: { stick_present, seen },
-- ble: { powered_on, connections } }, uptime_s }`, built by a function whose
-- own comment says it exists so the CRM can spot an "online but blind"
-- bridge. `/api/bridge/heartbeat` persisted last_seen_at / status /
-- software_version and dropped the rest on the floor. This is the storage half
-- of closing that gap.
--
-- TWO SHAPES, ON PURPOSE
--   * last_telemetry      — the whole (sanitised) payload, for a human
--                           debugging a bridge after the fact. The alerting
--                           path never reads it.
--   * last_ant_ok / last_ble_ok / last_pending_samples
--                         — denormalised scalars, because the fleet-health
--                           cron reads them for every bridge every 5 minutes
--                           and a jsonb path expression is not a thing to hang
--                           an alert on. Same reasoning as the denormalised
--                           columns on `contacts`.
--
-- NULLABLE, AND NULL IS NOT A FAULT
-- A bridge on older software sends no telemetry at all, so these stay NULL and
-- that bridge grades exactly as it does today. Only an explicit FALSE is a
-- fault. This is the same "ships dark" discipline as
-- fleet_devices.last_render_at (mig 474): a column that has never been
-- reported must never be read as "has stopped", or merging this would alert on
-- the whole fleet at once.

ALTER TABLE public.ble_bridges
  ADD COLUMN IF NOT EXISTS last_telemetry       jsonb,
  ADD COLUMN IF NOT EXISTS last_telemetry_at    timestamptz,
  ADD COLUMN IF NOT EXISTS last_pending_samples integer,
  ADD COLUMN IF NOT EXISTS last_ant_ok          boolean,
  ADD COLUMN IF NOT EXISTS last_ble_ok          boolean;

COMMENT ON COLUMN public.ble_bridges.last_telemetry IS
  'BRIDGE-BLIND.1 (mig 531) — last self-reported bridge telemetry, sanitised to a known projection by parseBridgeTelemetry() before storage: { pending_samples, uptime_s, adapters }. Whole-column overwrite, not historised. For human debugging only — the fleet-health cron reads the denormalised columns beside it, never this. NULL = the bridge has never reported telemetry (older software), which is NOT a fault.';

COMMENT ON COLUMN public.ble_bridges.last_telemetry_at IS
  'BRIDGE-BLIND.1 (mig 531) — when the telemetry beside it was received. Distinct from last_seen_at, which every bridge endpoint touches: a bridge on old software keeps a fresh last_seen_at with a NULL last_telemetry_at forever.';

COMMENT ON COLUMN public.ble_bridges.last_pending_samples IS
  'BRIDGE-BLIND.1 (mig 531) — samples sitting in the bridge''s local flush queue at the last heartbeat. A number that climbs and never falls means the bridge is READING straps fine but cannot deliver them (network/auth), which is a different fault from reading nothing. NULL = never reported.';

COMMENT ON COLUMN public.ble_bridges.last_ant_ok IS
  'BRIDGE-BLIND.1 (mig 531) — adapters.ant.stick_present from the last heartbeat: is the ANT+ USB stick open and started? FALSE = the bridge cannot read ANT+ straps at all. NULL = not reported (older software) and is NOT a fault — only an explicit FALSE grades adapter_down.';

COMMENT ON COLUMN public.ble_bridges.last_ble_ok IS
  'BRIDGE-BLIND.1 (mig 531) — adapters.ble.powered_on from the last heartbeat: is the Bluetooth radio powered and scanning? FALSE is exactly what a `noble state unauthorized` Pi reports, which is what went unseen for 2.5h on 2026-08-12. NULL = not reported and is NOT a fault.';

-- ── fleet_device_health: two new states ──────────────────────────
--
-- mig 472 pinned `state` to ('ok','unreachable','service_down') with an inline
-- CHECK. The cron's upsert would fail outright on the new grades, so the
-- constraint has to widen BEFORE the code that writes them deploys (the same
-- ordering rule migs 470/471/472 call out).
--
--   blind        — reachable, heartbeating, adapters not reporting a fault,
--                  yet zero heart-rate samples landed while a class was
--                  actually running. Deliberately the weaker claim of the two:
--                  a class where genuinely nobody wears a strap looks
--                  identical, so the alert copy states what was OBSERVED and
--                  does not assert a hardware failure.
--   adapter_down — the bridge itself reports a radio that is not ready. This
--                  is a standing configuration fault, not an outage: the Pi is
--                  up and doing everything it can. It is graded separately so
--                  it reads as "fix this box" rather than "the gym is down",
--                  and so it de-dups into ONE alert instead of one per class.
--
-- adapter_down is checked BEFORE blind on purpose: when a radio is admittedly
-- dead, "no samples during class" is a consequence, not news. Ranking it the
-- other way would flip the state back and forth (adapter_down between classes,
-- blind during them) and decideAlert re-alerts on every bad→bad transition —
-- which would have meant two pages per class, forever, for one known fault.

ALTER TABLE public.fleet_device_health
  DROP CONSTRAINT IF EXISTS fleet_device_health_state_check;

ALTER TABLE public.fleet_device_health
  ADD CONSTRAINT fleet_device_health_state_check
  CHECK (state IN ('ok', 'unreachable', 'service_down', 'blind', 'adapter_down'));

COMMENT ON COLUMN public.fleet_device_health.state IS
  'FLEET-ALERT.1 / BRIDGE-BLIND.1 — ok | unreachable (off the tailnet past OFFLINE_AFTER_MS) | service_down (on the tailnet, the thing it exists to do has stopped) | adapter_down (bridge reports a radio not ready — standing fault, alerts once) | blind (bridge online with healthy-looking radios, but zero samples during a running class — an observation, not a diagnosis).';
