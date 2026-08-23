-- SHELLY.10 — Shelly Cloud relay/plug control: per-location cloud connection,
-- adopted devices (one row per relay CHANNEL), daily energy per channel.
--
-- Apply any time: nothing reads these tables until the SHELLY deploy lands.
-- The cron heartbeat is deliberately NOT here — see 563, which must follow
-- the deploy that adds /api/cron/shelly-reconcile (the health check 503s on
-- a stale row; mig 561's header explains the trap).
--
-- Shape mirrors mig 560 (sonos_*): surrogate id + location_id NOT NULL UNIQUE
-- on the connection. Writes are service-role throughout (cron + staff routes
-- that authorise in app code), so there are no write policies — only
-- per-command RESTRICTIVE denials, never FOR ALL (the mig 483/485 class).
--
-- Transport note: the connection row IS the configuration (no env vars, no
-- tri-state). A future Integrator-API swap changes src/lib/shelly/client.js
-- only; nothing here names the transport.

CREATE TABLE public.shelly_connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id          uuid NOT NULL UNIQUE REFERENCES public.locations(id) ON DELETE CASCADE,
  host                 text NOT NULL,
  auth_key             text NOT NULL,
  auth_key_fingerprint text NOT NULL,
  key_hint             text NOT NULL,
  status               text NOT NULL DEFAULT 'connected',
  last_ok_at           timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  linked_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shelly_connections_status_check
    CHECK (status IN ('connected','action_needed','error')),
  -- Operator-supplied host the SERVER will fetch: an SSRF surface. App code
  -- normalises a pasted URL to its hostname; this is the backstop.
  CONSTRAINT shelly_connections_host_check
    CHECK (host ~ '^shelly-[a-z0-9-]+\.shelly\.cloud$'),
  CONSTRAINT shelly_connections_fingerprint_check
    CHECK (auth_key_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shelly_connections_key_hint_check
    CHECK (char_length(key_hint) BETWEEN 1 AND 4)
);

-- NOT unique, on purpose — see the column comment.
CREATE INDEX shelly_connections_fingerprint_idx
  ON public.shelly_connections (auth_key_fingerprint);

COMMENT ON TABLE public.shelly_connections IS
  'SHELLY.10 — one Shelly Cloud account per location. The row is the config: zero rows = integration dormant, the cron still stamps its heartbeat.';
COMMENT ON COLUMN public.shelly_connections.location_id IS
  'UNIQUE: one location = one Shelly account. NOT the PK (mig 560 rationale): routes read by location_id and write back by id.';
COMMENT ON COLUMN public.shelly_connections.host IS
  'Per-account API host from the Shelly app (e.g. shelly-103-eu.shelly.cloud). Can change; the owner re-pastes. Hostname only — no scheme, port or path.';
COMMENT ON COLUMN public.shelly_connections.auth_key IS
  'Shelly Cloud auth key, stored plain (house pattern: whatsapp_numbers.access_token, sonos_connections.refresh_token; at-rest encryption is Supabase''s). NEVER selected into a response or a log line — routes select key_hint instead. Rotates whenever the owner changes their Shelly password: the old key starts failing and the cron flips status to action_needed.';
COMMENT ON COLUMN public.shelly_connections.auth_key_fingerprint IS
  'sha256(auth_key) hex. Deliberately NOT UNIQUE: an owner with two studios may run both on one Shelly account. App code (classifyFingerprintClash) refuses linking a key already linked at a location in a DIFFERENT organization — mirrors chooseTenantToBind (xero/tenant-binding.js). Physical isolation lives on shelly_devices (device_id, channel) UNIQUE.';
COMMENT ON COLUMN public.shelly_connections.key_hint IS
  'Last 4 chars of auth_key, so the UI can show "••••abcd" without the route ever selecting the key.';
COMMENT ON COLUMN public.shelly_connections.status IS
  'connected = last tick had at least one 2xx; action_needed = auth failure or an invalid host (owner must re-paste; the cron retries every 15 min until then); error = every call failed for a non-auth reason (network/429/5xx) — retried every tick.';

CREATE TABLE public.shelly_devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  device_id      text NOT NULL,
  channel        smallint NOT NULL DEFAULT 0,
  name           text,
  model          text,
  gen            smallint,
  zone           text,
  enabled        boolean NOT NULL DEFAULT false,
  schedule_mode  text NOT NULL DEFAULT 'none',
  fixed_windows  jsonb NOT NULL DEFAULT '[]'::jsonb,
  class_rule     jsonb NOT NULL DEFAULT '{}'::jsonb,
  override       jsonb,
  last_applied   jsonb,
  last_state     jsonb,
  last_seen_at   timestamptz,
  adopted_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shelly_devices_schedule_mode_check
    CHECK (schedule_mode IN ('none','fixed','class')),
  CONSTRAINT shelly_devices_channel_check CHECK (channel BETWEEN 0 AND 15),
  -- Gen2+ ids are 12-hex MACs; kept loose (lowercase, no whitespace) so an
  -- unexpected id form fails in app code with a readable message, not as a
  -- constraint violation at adopt time.
  CONSTRAINT shelly_devices_device_id_check
    CHECK (device_id = lower(device_id) AND device_id ~ '^[0-9a-z_-]{4,64}$'),
  -- GLOBAL, not per-location: the whatsapp_numbers.phone_number_id (mig 176)
  -- / xero_connections_tenant_id_unique (mig 554) pattern. One physical relay
  -- channel serves exactly one location; the DB refuses what code forgets.
  CONSTRAINT shelly_devices_device_channel_unique UNIQUE (device_id, channel)
);

CREATE INDEX shelly_devices_location_idx ON public.shelly_devices (location_id);

COMMENT ON CONSTRAINT shelly_devices_device_channel_unique ON public.shelly_devices IS
  'SHELLY.10 — a relay channel belongs to one location, never two. Adopting a device already adopted elsewhere 23505s; the adopt route maps that to "already linked at another location" without naming it.';
COMMENT ON COLUMN public.shelly_devices.device_id IS
  'Shelly Cloud device id (12-hex MAC, lowercased). Identity for v2 get/set; set/groups addresses "<device_id>_<channel>".';
COMMENT ON COLUMN public.shelly_devices.channel IS
  'Relay channel (switch:N). Single-relay devices are 0; a Pro 4PM adopts as up to four rows sharing device_id.';
COMMENT ON COLUMN public.shelly_devices.gen IS
  'Device generation as reported by the cloud. v1 supports gen >= 2 only (Gen1 relays[]/meters[] shape is refused at discovery).';
COMMENT ON COLUMN public.shelly_devices.enabled IS
  'Schedule on/off. A live override is applied to EVERY adopted row, enabled or not (a manual action is not the schedule); windows only when enabled. Disabled rows still get their state refreshed.';
COMMENT ON COLUMN public.shelly_devices.fixed_windows IS
  '[{days:[1..7], on:"HH:MM", off:"HH:MM"}] — wall-clock in locations.timezone (off < on spans midnight; a "00:00" boundary means the start of that calendar day). Consumed by resolveServeWindows(device, dateStr, occurrences, tz).';
COMMENT ON COLUMN public.shelly_devices.class_rule IS
  '{lead_min, lag_min} for schedule_mode=class; defaults 15/10. Class mode follows the LOCATION-WIDE timetable (class_occurrences has no zone) — zone is a label.';
COMMENT ON COLUMN public.shelly_devices.override IS
  '{state:"on"|"off", until:iso, set_by:uuid, set_at:iso}. set_at is LOAD-BEARING (it keys the exactly-once stamp); state must be exactly on|off. Wins over the schedule while until > now. Applied by the cron EXACTLY ONCE (keyed "ov:<set_at>") so a failed direct toggle self-heals; the toggle route also fires set/switch directly. Default until = next local midnight. On expiry the schedule resumes: inside a window that means one "on"; outside every window it means one "off" only if the expired override was "on" (the cron closes only what it opened — an expired "off" issues nothing). mode none: never touched after expiry. NOT auto-cleared on expiry; only the toggle route''s auto action clears it.';
COMMENT ON COLUMN public.shelly_devices.last_applied IS
  '{key, action:"on"|"off", reason, at}. Boundary exactly-once (Sonos planAction model): key "w:<on_at ms>" for windows, "ov:<set_at>" for overrides, "run:<ms>" for run-now. Keys are STRINGS by design — no number/string jsonb round-trip ambiguity (the Sonos toMs class). Humans win between boundaries: a physical press is never stamped and never undone. Not stamped on a failed command so the next tick retries (a late on/off is correct for a relay).';
COMMENT ON COLUMN public.shelly_devices.last_state IS
  '{online, output, apower, aenergy_wh, temperature_c, source, at} from the last successful cloud read. online=false keeps the previous output/apower/aenergy_wh (frozen at last-known values while `at` advances — never diff (aenergy_wh, at) pairs across an offline span) and does not advance last_seen_at. output=null means unknown, not off. Every writer must write the FULL shape.';

-- numeric(14,3) is a STORAGE contract, not a rounder: handed a JS float with
-- more than three decimals Postgres ROUNDS SILENTLY rather than complaining,
-- so the rounding has to happen upstream and does — energy.js round3() rounds
-- every figure it writes, because 0.1 + (1000.3 - 1000.1) is 0.29999999999993
-- unrounded and a day is 1440 samples of that. 14 digits leaves 11 before the
-- point, far beyond any relay's lifetime Wh.
CREATE TABLE public.shelly_energy_daily (
  device_id       uuid NOT NULL REFERENCES public.shelly_devices(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  day             date NOT NULL,
  wh_start        numeric(14,3) NOT NULL,
  wh_last         numeric(14,3) NOT NULL,
  wh_total        numeric(14,3) NOT NULL DEFAULT 0,
  samples         integer NOT NULL DEFAULT 0,
  resets          integer NOT NULL DEFAULT 0,
  first_sample_at timestamptz NOT NULL,
  last_sample_at  timestamptz NOT NULL,
  PRIMARY KEY (device_id, day),
  CONSTRAINT shelly_energy_daily_nonneg_check
    CHECK (wh_start >= 0 AND wh_last >= 0 AND wh_total >= 0 AND samples >= 0 AND resets >= 0)
);

CREATE INDEX shelly_energy_daily_location_day_idx
  ON public.shelly_energy_daily (location_id, day DESC);

COMMENT ON TABLE public.shelly_energy_daily IS
  'SHELLY.10 — per-channel daily consumption rolled from the monotonic aenergy.total (Wh) counter by the per-minute cron. READ PER DEVICE (<= 31 rows for 30 days). A location-wide 30-day read is 50 x 30 = 1,500 rows — over the 1k PostgREST cap — so it must .range()-paginate or aggregate in SQL.';
COMMENT ON COLUMN public.shelly_energy_daily.device_id IS
  'FK to shelly_devices.id (the ROW, one per channel) — not the Shelly hex device_id. ON DELETE CASCADE: removing a device row destroys its energy history, and because (device_id, channel) is UNIQUE across locations, moving a plug to another location is necessarily a remove-then-adopt — the UI must say so before a remove.';
COMMENT ON COLUMN public.shelly_energy_daily.day IS
  'Calendar day in locations.timezone at sample time (dayStrInTz), so a 23:30 sample under BST lands on the right day.';
COMMENT ON COLUMN public.shelly_energy_daily.wh_total IS
  'Sum of positive deltas between consecutive samples (THE figure; kWh = /1000). Not wh_last - wh_start: that breaks on a counter reset (after a reset wh_start can exceed wh_last). Day N starts from day N-1''s wh_last so the midnight-straddling minute is not lost.';
COMMENT ON COLUMN public.shelly_energy_daily.resets IS
  'Counter went backwards to < half its previous value (factory reset / some firmware updates): the new total is counted from 0. A small backwards move (flash-save rollback after a power cut) is NOT a reset and counts 0; exactly half is a rollback.';

ALTER TABLE public.shelly_connections  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shelly_devices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shelly_energy_daily ENABLE ROW LEVEL SECURITY;

-- Connections hold the auth key: master or owner-at-location only, and
-- client code never selects the key column (routes use service role).
CREATE POLICY shelly_connections_select ON public.shelly_connections
  FOR SELECT TO authenticated
  USING (private.auth_is_master() OR private.auth_is_owner_at(shelly_connections.location_id));
CREATE POLICY shelly_connections_deny_insert ON public.shelly_connections
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY shelly_connections_deny_update ON public.shelly_connections
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY shelly_connections_deny_delete ON public.shelly_connections
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

-- Devices and energy carry no secrets: any staff member at the location.
CREATE POLICY shelly_devices_select ON public.shelly_devices
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(shelly_devices.location_id));
CREATE POLICY shelly_devices_deny_insert ON public.shelly_devices
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY shelly_devices_deny_update ON public.shelly_devices
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY shelly_devices_deny_delete ON public.shelly_devices
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

CREATE POLICY shelly_energy_daily_select ON public.shelly_energy_daily
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(shelly_energy_daily.location_id));
CREATE POLICY shelly_energy_daily_deny_insert ON public.shelly_energy_daily
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY shelly_energy_daily_deny_update ON public.shelly_energy_daily
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY shelly_energy_daily_deny_delete ON public.shelly_energy_daily
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);
