# STUDIO-AC-DEVICES — unified AC control + LG ThinQ Connect integration

**Status:** Design locked. Ready to implement in phases.
**Author:** drafted with Richard, May 2026 (STUDIO-AC.0)

> **Decision history.** Initial draft proposed Option C (parallel
> Sensibo + ThinQ tables). Locked decision is **Option A**: a
> unified `ac_devices` table with per-staff per-device allowlist.
> The pivot is driven by Richard's requirement for per-AC-unit
> permissions on every account — a granular ThinQ model with a
> coarse Sensibo model would have been confusing for masters
> managing staff permissions.

---

## Why this exists

The two bathroom AC units at UN1T Stillorgan are LG units. They
are not on a Sensibo gateway (Sensibo is bound to the main studio
AC). Today there is no way for staff to turn the bathroom units
on or off remotely — somebody walks in with the LG remote.

LG opened the official `ThinQ Connect` API to third parties in
December 2024 ([news release](https://www.lgnewsroom.com/2024/12/lg-opens-thinq-api-to-foster-smart-home-innovation/)).
Ireland is a supported country. Air conditioners are first-class
in the device catalogue. We'll wrap the bathroom units behind the
same Studio Management UI that controls the Sensibo-managed unit
— **after** unifying both vendors behind a single device table so
permissions work consistently.

---

## Locked decisions

These are the answers Richard signed off on during the design
session. Everything below assumes them.

| Decision | Choice |
|---|---|
| Architecture | **Option A** — unified `ac_devices` table covering both vendors |
| Permission model | Per-device allowlist on `profile_locations.ac_device_ids` (uuid[]); both Sensibo and ThinQ are gated the same way |
| v1 control surface | On/off only. Mode + temp + fan baked into per-device defaults at setup time, not exposed per-press |
| Auto-off default | 30 min for new ThinQ bathroom devices. The existing Sensibo unit keeps its 90 min default — migration preserves it |
| Mobile parity | Web-only for v1. Mobile More-tab row is a follow-on PR if reception actually use the web panel on the floor |
| Multi-location rollout | Stillorgan only for v1. Schema is per-location ready; other locations add their PAT + devices when LG units are installed |

---

## LG ThinQ Connect — vendor brief

**Auth.** Personal Access Token (PAT). Generated at
<https://connect-pat.lgthinq.com/> after logging in with the LG
ThinQ account that owns the devices. PAT carries a Scope of
Authority that the issuer pre-selects (we'll request only Air
Conditioner — status + control, least-privilege). Long-lived;
revocable from the same portal.

**Client ID.** Every API consumer must present a unique
`X-Client-ID` header. uuid4 per logical client. We generate one
at integration-enable time and store it on the location row
alongside the PAT.

**Transport.** REST over HTTPS, JSON. No Node SDK exists (Python
only — [`thinqconnect`](https://github.com/thinq-connect/pythinqconnect))
so we'll call REST directly from Node. The API surface is narrow
enough that this is straightforward.

**Push notifications.** LG also offers MQTT over AWS IoT Core for
push events. Out of scope: serverless Next.js can't hold long-
running MQTT connections, and REST polling from the control UI is
sufficient for on/off bathroom AC.

**Country code.** `IE`.

**AC device profile** (relevant properties from
[`DEVICE_AIR_CONDITIONER`](https://thinq.developer.lge.com/en/cloud/docs/thinq-connect/device-profile/air-conditioner/)):

| Capability | Property |
|---|---|
| Power on/off | `operation.air_con_operation_mode` (POWER_ON / POWER_OFF) |
| Mode | `air_con_job_mode.current_job_mode` (cool / heat / dry / fan / auto) |
| Setpoint | `temperature.target_temperature_c` |
| Reading | `temperature.current_temperature_c` |
| Fan strength | `air_flow.wind_strength` (auto / low / mid / high) |
| Timer (relative) | `timer.relative_hour_to_stop`, `relative_minute_to_stop` |

Capability surface is a clean superset of what Sensibo gives us,
so the existing defaults model maps one-to-one.

---

## Existing integration we're unifying

Migration 103 (`103_ac_management_sensibo.sql`) added per-location
Sensibo credentials and an `ac_sessions` table. Routes under
`/api/studio-management/ac/`. UI: `AcControlPanel.jsx` on the
Studio Management page. Cron: `/api/cron/ac-auto-off`.

This works but assumes **one AC per location**. The bathroom case
(two units in one location) plus the new permission requirement
push us to refactor onto `ac_devices`.

---

## Schema

Migration **`mig 210_ac_devices.sql`** (number TBD — verify next
free slot at PR time).

```sql
-- The new unified table.
CREATE TABLE ac_devices (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references locations(id) on delete cascade,
  label           text not null,           -- "Studio Floor", "Bathroom M", "Bathroom F"
  provider        text not null check (provider in ('sensibo','thinq')),

  -- Provider-specific identifier. For sensibo this is the pod id;
  -- for thinq it's the deviceId returned by the LG listDevices call.
  provider_device_id text not null,

  -- Provider-specific credentials live on `locations` (shared by
  -- all devices of that provider at that location). ac_devices
  -- only stores the per-device IDs + defaults.

  default_mode    text default 'cool',
  default_temp_c  int  default 22,
  default_fan     text default 'auto',
  session_minutes int  default 30,         -- per-device auto-off
  enabled         bool default true,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique (location_id, provider, provider_device_id)
);

CREATE INDEX ac_devices_location ON ac_devices(location_id) WHERE enabled;

-- Backfill the existing Sensibo unit(s) into ac_devices. One row
-- per location that has both sensibo_api_key + sensibo_pod_id set.
-- Preserves the existing session_minutes default (90 min) so
-- nothing changes for the current user.
INSERT INTO ac_devices (location_id, label, provider, provider_device_id,
                        default_mode, default_temp_c, default_fan, session_minutes)
SELECT id,
       coalesce(name, 'Studio AC') || ' (Sensibo)',
       'sensibo',
       sensibo_pod_id,
       coalesce(ac_default_mode, 'cool'),
       coalesce(ac_default_temp, 18),
       coalesce(ac_default_fan, 'high'),
       coalesce(ac_session_minutes, 90)
FROM locations
WHERE sensibo_api_key is not null
  AND sensibo_pod_id  is not null;

-- ThinQ credentials on `locations` (peer of sensibo_api_key).
ALTER TABLE locations
  ADD COLUMN thinq_pat          text,
  ADD COLUMN thinq_client_id    text,
  ADD COLUMN thinq_country_code text default 'IE';

-- Per-device session attribution. Sessions created before this
-- migration get NULL device_id; new code only creates sessions
-- with a device_id set. Backfill the existing ones to the
-- migrated Sensibo row for that location (best effort — there's
-- only one ac_devices row per location at migration time, so this
-- is unambiguous).
ALTER TABLE ac_sessions
  ADD COLUMN device_id uuid references ac_devices(id) on delete set null;

UPDATE ac_sessions s
SET    device_id = d.id
FROM   ac_devices d
WHERE  d.location_id = s.location_id
  AND  s.device_id is null;

CREATE INDEX ac_sessions_device_active ON ac_sessions(device_id, started_at desc)
  WHERE device_id is not null;

-- Per-staff per-device allowlist. Mirrors profile_locations.unifi_door_ids.
ALTER TABLE profile_locations
  ADD COLUMN ac_device_ids uuid[] default '{}';

CREATE INDEX profile_locations_ac_device_ids
  ON profile_locations USING gin (ac_device_ids);
```

**What stays put.** The `sensibo_api_key`, `sensibo_pod_id`,
`ac_default_*`, and `ac_session_minutes` columns on `locations`
stay during phase 1. They're read-only legacy at that point;
nothing writes them anymore. We drop them in a later cleanup PR
once we're sure nothing reads from them. Defence in depth.

**Why credentials on `locations` not `ac_devices`.** Sensibo's
single API key controls multiple pods on the same account. ThinQ's
single PAT controls multiple devices on the same account. Both
naturally cluster as "per-location credential" rather than
"per-device credential," so we keep that shape.

---

## Helper libs

Three files, one new and two extended:

### `src/lib/sensibo.js` (unchanged interface)

Stays as-is. Its `listPods`/`getPodState`/`setPodState`/`turnPodOff`
exports are still the underlying Sensibo HTTP wrapper. We don't
touch it — the dispatcher calls it.

### `src/lib/thinq.js` (new)

Sibling to `sensibo.js`. Same shape:

```js
export async function listDevices({ pat, clientId, countryCode })
export async function getDeviceState(deviceId, { pat, clientId })
export async function setDeviceState(deviceId, command, { pat, clientId })
export async function turnOff(deviceId, ctx)
export function buildTurnOnState({ mode, tempC, fan })
export class ThinqError extends Error
```

Control body for "turn on at 22°C cool":
```json
{
  "operation": { "airConOperationMode": "POWER_ON" },
  "airConJobMode": { "currentJobMode": "COOL" },
  "temperature": { "targetTemperatureC": 22 },
  "airFlow": { "windStrength": "AUTO" }
}
```

8s timeout per call (matching Sensibo). Surface LG's `error.code` +
`error.message` verbatim — e.g. `1209` = device offline.

Test coverage: `src/lib/thinq.test.js`. Mock `fetch`, table-test
build/parse + a couple of error paths.

### `src/lib/ac-devices.js` (new — the dispatcher)

The thin layer that the API routes call. Knows how to load a
device + its credentials and route to the right vendor:

```js
export async function loadDeviceForUser(deviceId, { user, db })
export async function getState(deviceId, { user, db })
export async function turnOn(deviceId, { user, db })
export async function turnOff(deviceId, { user, db })
export async function extendSession(deviceId, { user, db })
```

Each function does:
1. Load `ac_devices` row by id (errors if not found)
2. Authorise: caller must be master, OR `device.id` ∈
   `user.profile_locations[device.location_id].ac_device_ids`
3. Load vendor credentials from the device's `location_id` row
   (the appropriate `sensibo_*` or `thinq_*` columns)
4. Dispatch to `sensibo.js` or `thinq.js`
5. Write `ac_sessions` row + audit log

This centralisation is the whole point of Option A — every route
goes through one function, so the permission check + audit log
can't be forgotten.

Test coverage: `src/lib/ac-devices.test.js`. The vendor dispatch
and the permission gate are both worth direct table tests.

---

## API routes

All under `/api/studio-management/ac/` — same prefix as today. The
existing routes are refactored to accept a `device_id` body/query
param.

| Verb | Path | Auth | What |
|---|---|---|---|
| GET  | `/devices` | `studio_management` | List devices visible to caller (allowlist-filtered for non-masters) with current state. The control panel polls this. |
| POST | `/devices/[id]/turn-on` | `studio_management` + per-device allowlist | Apply defaults, start session, push command. |
| POST | `/devices/[id]/turn-off` | `studio_management` + per-device allowlist | Mark session manual_off, push command. |
| POST | `/devices/[id]/extend` | `studio_management` + per-device allowlist | Bump `auto_off_at`. |
| GET  | `/devices/[id]/state` | `studio_management` + per-device allowlist | Live read. |
| GET  | `/lg-devices?pat=...&client_id=...` | master | Discovery helper for ThinQ setup UI. |
| GET  | `/sensibo-pods?api_key=...` | master | Discovery helper for Sensibo setup UI (existing `/pods` route, relocated for symmetry). |
| POST | `/devices` | master | Create a row from a discovery selection. |
| PATCH | `/devices/[id]` | master | Rename, change defaults, disable. |
| DELETE | `/devices/[id]` | master | Soft-disable (set `enabled=false`). Hard delete only via DB. |

**Backwards compatibility.** The current `AcControlPanel.jsx` calls
the no-device-id variants of these routes (e.g. POST `/turn-on`
with no body, implicitly meaning "the location's AC"). Phase 2
deprecates those endpoints but keeps them alive for one PR cycle —
they look up the single enabled `ac_devices` row for the active
location and dispatch as if the caller had passed `device_id`. The
panel ships in phase 3 with the new device-id calls; the legacy
endpoints get deleted once phase 3 lands.

---

## UI

### `AcControlPanel.jsx` — refactored

Renders a list of device cards. Each card is the same shape as
today's single-AC card: status + current temp + Turn on / Off /
Extend, sized for the floor reception staff. The non-master view
filters by `profile_locations.ac_device_ids` — staff who don't
have a device in their allowlist just don't see its card.

Empty state ("no AC devices configured for this location") is
master-visible only, with a link to the setup tab.

Polling: 30s per device list, local 1s ticker for countdowns.
Same shape as today.

### `LocationIntegrations.jsx` — new tab

A single **AC Devices** tab replaces the existing Sensibo-only
section. Three subsections inside:

1. **Sensibo credentials** — paste `sensibo_api_key`, test
   connection. Same UX as today, moved under the unified tab.
2. **LG ThinQ credentials** — paste PAT, country code defaults
   to IE, client_id is generated for you. Test connection hits
   `/lg-devices`.
3. **Devices** — table of `ac_devices` rows for this location.
   Add device buttons pull from Sensibo pod discovery or LG
   device discovery. Per-row: rename, set defaults, enable/disable.

### `StaffForm.jsx` — extend

In the per-location section (where `unifi_door_ids` already
lives), add an `ac_device_ids` multi-select sourced from the
location's configured `ac_devices`. Defaults: empty (opt-in
explicit). Master + the staff member's manager can edit.

### Audit log surface

Existing `/admin/audit-log` is already capable. New event names:
`ac.turn_on`, `ac.turn_off`, `ac.extend`, `ac.device_create`,
`ac.device_update`, `ac.device_delete`, `ac.permission_grant`,
`ac.permission_revoke`. Category: `studio_management`.

---

## Auto-off, fallback, race conditions

**Auto-off cron.** `/api/cron/ac-auto-off` extends to dispatch by
provider. Iterates `ac_sessions` where `auto_off_at <= now()` and
status is active, loads the linked `ac_devices` row, calls
`ac-devices.turnOff`. The vendor dispatch is hidden inside that
call so the cron itself is provider-agnostic.

**When LG cloud is down.** All routes return 502 with LG's error
code in the body. The panel surfaces a friendly "LG cloud
unreachable — try the AC remote" message. No retry attempts.

**When a device is offline (Wi-Fi dropped).** LG returns `1209`;
we surface "Device offline" specifically. Session is not logged.

**Race conditions.** Same guard as today: 409 if a session for
this `device_id` is already active. The panel shows the existing
session's countdown rather than letting staff double-start.

**Cross-provider race.** If a staffer turns on Bathroom-M and
Bathroom-F simultaneously (different devices), they're independent
sessions — no contention. The guard is per-device, not per-location.

---

## Permission model — worked example

Setting up for Stillorgan:

1. Master generates a PAT at LG, pastes into Stillorgan's AC
   Devices tab → LG ThinQ section.
2. Master clicks **Add device** → LG discovery → picks two ACs,
   names them "Bathroom M" and "Bathroom F". The pre-existing
   Sensibo "Studio Floor" device is already present from the
   migration backfill.
3. Master opens StaffForm for reception staffer Alice:
   - Stillorgan section → AC Devices: Studio Floor + Bathroom M
     + Bathroom F all ticked.
4. Master opens StaffForm for trainer Bob:
   - Stillorgan section → AC Devices: Studio Floor ticked.
     Bathroom M and F unticked.
5. Alice opens Studio Management → sees 3 cards, can control all.
6. Bob opens Studio Management → sees 1 card (Studio Floor),
   controls that only. Bathroom cards aren't rendered for him.

Master role bypasses the allowlist (sees + controls every device
in the locations they're a member of) — same as the master
behaviour for `unifi_door_ids`.

---

## Phased delivery

Three PRs, each independently mergeable.

### STUDIO-AC-DEVICES.1 — schema + helper libs

- Migration 210: `ac_devices` table, `profile_locations.ac_device_ids`,
  `ac_sessions.device_id`, `locations.thinq_*` columns, Sensibo
  backfill.
- `src/lib/thinq.js` + test.
- `src/lib/ac-devices.js` (dispatcher) + test.
- No route or UI changes yet — phase 1 is dead code from the
  user's POV. Verify nothing breaks (existing Sensibo path still
  reads from the legacy `locations` columns).

### STUDIO-AC-DEVICES.2 — route refactor + new routes

- All `/api/studio-management/ac/*` routes refactored to go through
  the dispatcher. New device CRUD routes. ThinQ discovery route.
- Cron extended for provider dispatch.
- Legacy no-device-id routes kept (deprecated) so phase 1's panel
  doesn't break before phase 3.

### STUDIO-AC-DEVICES.3 — UI

- `AcControlPanel.jsx` → device list.
- New AC Devices tab in `LocationIntegrations.jsx`.
- StaffForm gains the `ac_device_ids` multi-select.
- Audit log already surfaces — verify event names render correctly.
- Remove the legacy no-device-id routes that phase 2 left in
  place.

Total estimate: 2–3 sessions, depending on how the migration
verifies on a fresh local Supabase reset.

---

## Out of scope

- Multi-vendor refactor beyond Sensibo + ThinQ — if a third
  vendor appears, the dispatcher absorbs it (a new vendor file +
  a new `provider` enum value).
- MQTT push events from LG — REST polling sufficient.
- Mobile app surface — web-only for v1.
- Time-of-day scheduling (e.g. "turn on at 7am every weekday").
  Auto-off is the only schedule today.
- Coverage of non-AC LG devices (washers, fridges, etc.) —
  schema is generic enough but the UI is AC-only by design.
- Cleanup PR to drop legacy `sensibo_*` columns on `locations` —
  defer until at least one full release with the unified table in
  prod and no rollback needed.
