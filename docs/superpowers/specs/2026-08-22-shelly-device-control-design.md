# Shelly Device Control — Design

**Date:** 2026-08-22
**Status:** Approved in conversation (Richard, 2026-08-22)
**Repo:** un1t-crm
**Sibling of:** `docs/superpowers/specs/2026-08-20-sonos-control-integration-design.md` (the per-location cloud-device pattern this copies). **Replaces the use case** the retired Tapo/Homey path served (`2026-07-05-tapo-device-control-design.md`, `2026-08-01-homey-direct-control-design.md`): scheduled power for lights, equipment and signage, plus manual toggles from the CRM.

## Why

The Tapo→Homey device path was deleted in SONOS.14 (#1484). Studios still need plugs and relays scheduled around the day and the class timetable, switched by hand from the CRM, and visible in terms of power and energy. Shelly is the one vendor in the scoping research with a genuinely open, documented cloud API. There is no Shelly code anywhere in the estate; this is net-new.

Richard's framing for it: **keep each location separate, and handle multiple studio owners like a SaaS platform.** Every tenant connects their own Shelly Cloud account; devices, schedules, state and energy are strictly per-location; nothing any tenant does can read or actuate another location's devices.

## Decisions (Richard, 2026-08-22)

1. **v1 scope = all four:** scheduled on/off (fixed windows and class-linked via `class_occurrences`), live toggle and live state, live watts, and a **daily kWh history with a 30-day view**.
2. **Connection = the per-location Shelly "Authorization cloud key" + server host**, pasted by an owner or master. Richard applies for Shelly's **Integrator API in parallel** (https://forms.office.com/e/KDxYr4K3vF or support@shelly.cloud; business email required; timeline unpublished). A later transport swap changes `src/lib/shelly/client.js` only — nothing in the tables names the transport.
3. **Gen2+ hardware is already installed at Stillorgan**, so the exit gate is a live plug on the day it ships. Gen1 (`relays[]`/`meters[]`) is out of v1; discovery marks it unsupported.
4. **`device_control` is owned by `bundle_marketing` OR `bundle_operations`.** Today it is Marketing-only and a new location seeds Marketing off, so a SaaS tenant would never have seen device control.

## What the Shelly Cloud API gives us (researched 2026-08-22)

- **v2 Cloud Control API** — the surface v1 builds on. `POST https://<host>/v2/devices/api/{get|set/switch|set/groups}?auth_key=…`, JSON bodies. `get` takes 1–10 ids and returns `[{id, type, code, gen, online:0|1, status, settings}]`; a Gen2+ `status['switch:N']` carries `{output, apower (W), voltage, current, aenergy:{total (Wh, monotonic), by_minute (mWh, last 3 min)}, temperature:{tC}, source}`. `set/switch` `{id, channel, on}` answers a bare 200 with no body. `set/groups` `{switch:{ids:['<id>_<channel>', …], command:{on}}}` answers `{failedCommands:{…}}` on partial failure (shape unverified on a real account — see the fallback below). Errors come as `{error:'DEVICE_OFFLINE'|'DEVICE_NOT_FOUND'|'DEVICE_INVALID_CHANNEL'|'BAD_REQUEST'|…}`.
- **One request per second per account** — per *account*, not per location. 429 on excess, no `Retry-After`.
- **Reads of an offline device succeed** (`online:0`, last-known status); writes to it fail.
- **Discovery needs v1**: `POST https://<host>/device/all_status?show_info=true&no_shared=true&auth_key=…` → `{isok, data:{devices_status:{<id>:…}}}`. Deprecated but live; device ids are 12-hex MACs; the `show_info` payload is unverified, so the parser is defensive.
- **The key is per account, grants full control of it, and changes whenever the owner changes their Shelly password.** A stored key then starts 401ing silently. The per-account host can also change (Shelly relocates tenants). A "key rejected → re-paste" repair flow is therefore part of v1, not a nicety.
- Gen3/Gen4 share the Gen2 RPC shape, so "Gen2+" means `gen >= 2`. A Pro 3EM exposes `em:0` and no relay — unsupported in v1. There is no cloud endpoint that proxies on-device `Schedule.Create` / `Webhook.Create`; those need local commissioning and are deferred.

## Architecture

```
un1t-crm (Vercel) ──HTTPS──▶ https://<per-location host>.shelly.cloud/v2/devices/api/* ──▶ that studio's devices
  │ /api/cron/shelly-reconcile   (* * * * *)   per-location loop; accounts in parallel, same-account serial
  │ /api/shelly/*                staff routes via withAuth('device_control'); connection = master or owner-at-location
  │ /automations/shelly          the one operator page (+ link card on /automations, card in the Integrations hub)
  └ src/lib/schedule/desired-state.js   the rescued window engine, now with an optional per-location `tz`
```

Three differences from the Sonos build, all deliberate:

- **No env vars and no tri-state config.** Shelly has no OAuth app to register; the `shelly_connections` row *is* the configuration. Zero rows = dormant (the cron stamps its heartbeat and exits).
- **Relay commands are idempotent**, so the manual override is two-way (`{state:'on'|'off', until}`) and the engine's `desiredState()` semantics are usable again. Sonos had to restrict its override to suppression because `loadFavorite` restarts the playlist.
- **Per-location timezone.** `locations.timezone` has existed since mig 004 (nullable free text, default `Europe/Dublin`) and nothing schedule-related reads it. The engine gains an additive `tz` parameter; Dublin behaviour is bit-identical.

## The command model — boundary exactly-once, plus a two-way override

State lives in `shelly_devices.last_applied = {key, action:'on'|'off', reason, at}`. Keys are **strings** — `w:<on_at ms>` for a window, `ov:<set_at iso>` for an override, `run:<ms>` for run-now — so the Sonos `toMs` class of bug (a jsonb number coming back as a string and `===` never matching) cannot happen.

Per adopted device, per tick:

1. **A live override** (`until > now`) is applied **once** (key `ov:<set_at>`) — for **every adopted device, enabled or not**. A manual action is independent of the schedule, and applying it from the cron is what lets a failed direct toggle self-heal. After that the device is left alone; a physical press is never fought.
2. **`schedule_mode:'none'`** → never touched, including after an override expires. The UI says "stays until changed".
3. **Inside a window** (enabled devices) → `on`, unless `last_applied` is exactly `{this window's key, 'on'}`. Unlike Sonos, a relay **re-opens after its own close under the same key**: `on` is idempotent, and a class window that shrank for one tick (an occurrence-sync blip) must not leave the room dark for the rest of the day.
4. **Outside every window** → `off`, once, if the last thing *we* did was an `on` (window or override key; reason `window_close` or `override_expired`). We never stamp a human's physical `on`, so it is never undone here. An override that expires at midnight while a window is already past its `off_at` → one `off` at midnight. That is "the schedule resumes" and is the wanted behaviour.

Properties this buys, and the rules that protect them:

- **Failed commands are not stamped**, so the next tick retries. A late `on`/`off` is correct for a relay; `DEVICE_OFFLINE` simply waits for the device to come back. Missed ticks self-heal. A redeploy mid-window does nothing.
- **A failed `class_occurrences` read is not "no classes".** With an empty window set the outside-window rule would switch a device off mid-class. On a load error, class-mode devices are skipped for that tick (logged); fixed-mode devices proceed.
- **Class mode fetches exactly the location's local day** — `[dayStart, nextDayStart)` in the location's timezone, never `+24h`/`+36h`. The engine collapses every occurrence it is given into one window, so tomorrow's 06:00 class would hold devices on all night (the documented Tapo trap). A class that crosses local midnight is cut at midnight; accepted for a gym.
- **Toggle** (`on`/`off`): record the intent first — `override {state, until, set_by, set_at}`, `until` defaulting to the next *local* midnight — then fire `set/switch` directly in its own try/catch. Success stamps `last_applied` with the override key so the cron does not re-send. Failure answers `{applied:false, pending:true, code}` and the cron applies it when the device is reachable. **`auto`** = clear the override, then run-now. **Run-now** = `planDeviceAction(…, {force:true})` applied immediately and stamped.

## Tenancy — the SaaS rules

- **One Shelly account per location**: `shelly_connections.location_id UNIQUE`.
- **No global UNIQUE on the key.** An owner with two studios may legitimately run both off one Shelly account. The connect route instead refuses a key whose **sha256 fingerprint** is already linked at a location in a *different organization* (409, generic copy), and allows same-org sharing (the response names the sibling locations). This is `chooseTenantToBind` from the Xero tenant-binding fix, applied in app code.
- **Physical isolation lives on devices**: `shelly_devices UNIQUE (device_id, channel)` is **global**. A relay channel serves exactly one location; the database refuses what a code path forgets (the `whatsapp_numbers.phone_number_id` / mig-554 pattern).
- **Adopt is not an existence oracle.** The device must be present on the caller's own Shelly account (one `get`) *before* any cross-tenant holder lookup; otherwise the route answers 404 "Not found on this Shelly account". A naive uniqueness check first would let anyone probe ids and learn that some other tenant owns a device.
- **Discovery names come from the caller's own cloud account**, never from our database. Our database contributes one bit per row — `adopted: 'here' | 'elsewhere' | null` — plus the holder's location name *only when the holder is in the same organization*. Cross-org, the flag alone.
- **No route accepts a `location_id`.** Every handler derives the location from `user.activeLocation.id` (validated against the user's assignments by `getCurrentUser`) and every query chain carries `.eq('location_id', …)`. Detail routes 404 on malformed and foreign ids alike. The cron iterates every connection with a per-location `try/catch`, so one tenant's 401 or 429 never aborts the sweep.
- **RLS** binds only the browser client and is written anyway: `shelly_connections` SELECT = master or owner-at-location (it holds the key); `shelly_devices` and `shelly_energy_daily` SELECT = staff in location; writes are service-role, denied per command (never `RESTRICTIVE FOR ALL`, which folds away SELECT).
- **The key never leaves the server.** Routes select `key_hint` (last four characters) and expose `has_auth_key`; no response, log line or thrown error carries the key, and the client never logs a URL because `auth_key` rides in the query string.
- **The host is an SSRF surface** — an operator-supplied hostname the server will fetch. `normaliseShellyHost` accepts a bare host or a pasted URL, keeps the hostname only, lowercases it, and requires `^shelly-[a-z0-9-]+\.shelly\.cloud$`; the same regex is a CHECK constraint on the table.

## Rate limits

One request per second per account. Per location per tick the cron batches reads (10 ids per `get`) and writes (`set/groups`, at most one call per direction), spaces calls ≥1 s apart (the `sleep` is injectable), and on a 429 retries once after 1.1 s then gives up for the tick. **Connections are grouped by key fingerprint: groups run in parallel (bounded at 4), locations within a group run serially**, because two same-owner studios share one budget. Fifty devices per location and one hundred connections are hard caps, logged loudly when hit — never silent truncation. The run has a 90 s deadline and the route a 120 s `maxDuration`. If `set/groups` misbehaves on a real account the fallback is a per-device `set/switch` loop under the same deadline: exactly-once keeps correctness, only application latency grows.

## Data model (migration 562; heartbeat in 563 after the deploy)

```sql
shelly_connections
  id uuid PK
  location_id uuid NOT NULL UNIQUE → locations CASCADE      -- one account per location
  host text NOT NULL  CHECK (host ~ '^shelly-[a-z0-9-]+\.shelly\.cloud$')
  auth_key text NOT NULL                                     -- plain, house pattern; never selected by a route
  auth_key_fingerprint text NOT NULL  CHECK ('^[0-9a-f]{64}$')   -- indexed, NOT unique (same-org sharing)
  key_hint text NOT NULL                                     -- last 4, what the UI shows
  status text NOT NULL DEFAULT 'connected' CHECK (connected|action_needed|error)
  last_ok_at, last_error, last_error_at, linked_by, created_at, updated_at

shelly_devices
  id uuid PK
  location_id uuid NOT NULL → locations CASCADE
  device_id text NOT NULL (lowercase), channel smallint NOT NULL DEFAULT 0
  UNIQUE (device_id, channel)                                -- GLOBAL
  name, model, gen, zone (label only — class_occurrences has no zone)
  enabled boolean NOT NULL DEFAULT false                      -- house convention: adopted devices do nothing until enabled
  schedule_mode text NOT NULL DEFAULT 'none' CHECK (none|fixed|class)
  fixed_windows jsonb '[]'   -- [{days:[1..7], on:'HH:MM', off:'HH:MM'}] wall-clock in locations.timezone
  class_rule jsonb '{}'      -- {lead_min, lag_min}, defaults 15/10
  override jsonb             -- {state, until, set_by, set_at}
  last_applied jsonb         -- {key, action, reason, at}
  last_state jsonb           -- {online, output, apower, aenergy_wh, temperature_c, source, at}
  last_seen_at, adopted_by, created_at, updated_at

shelly_energy_daily
  device_id uuid → shelly_devices CASCADE   -- the ROW (one per channel)
  location_id uuid → locations CASCADE
  day date                                  -- local day in locations.timezone
  wh_start, wh_last, wh_total numeric(14,3), samples int, resets int, first_sample_at, last_sample_at
  PRIMARY KEY (device_id, day)
```

No foreign key from devices to the connection: a disconnect deletes the connection row and keeps adopted devices and their configuration for a re-link.

**Energy roll (pure, `rollDailyEnergy`).** `aenergy.total` is a monotonic Wh counter that resets on a factory reset and some firmware updates, and can roll back a few Wh after a power cut (flash-save lag). Each sample adds `total − wh_last` when the counter rose; a drop to less than half the previous value is a reset (count `total` from zero, `resets++`); a smaller drop is a rollback and counts nothing. A new local day starts from yesterday's `wh_last` so the minute that straddles midnight — or a whole cron outage — lands in today. `wh_total` is the sum of those deltas, never `wh_last − wh_start`. Energy is read **per device** (≤ 31 rows); a location-wide 30-day read would be 1,500 rows, over the PostgREST cap.

## Timezone

A new `src/lib/tz-time.js` (the existing `dublin-time.js` is pinned by `tests/shared-pair-sync.test.js` and cannot grow an export) provides `dayStrInTz`, `wallMsInTz`, `dayStartMsInTz`, `nextLocalMidnightMs`, `resolveTz`. It also fixes a latent bug in the engine's private `dublinWallMs`: the guess-and-correct compared minute-of-day only, which is a whole day wrong for any negative-offset zone. Correcting from the full date-time read-back is bit-identical for Dublin and right for New York. `resolveDayWindows` / `resolveServeWindows` / `desiredState` gain a trailing `tz` parameter defaulting to `Europe/Dublin`; the Sonos planner is untouched.

## Operator surface

**One page, `/automations/shelly`**, gated on the existing `device_control` permission, reached from a second card on `/automations` ("Smart plugs") next to Studio music. Owners and masters see the connection panel (host + key paste, status, re-paste, two-step disconnect); everyone with `device_control` sees discovery/adopt, device cards (health chip, on/off + watts, On/Off/Back-to-schedule toggle with until-midnight/1 h/3 h presets, schedule editor — none/fixed/class — enable toggle, Run now, a 30-day energy bar chart, remove). The page polls the device list every 30 s while visible; a manual Refresh is one batched cloud read for the whole location. There is deliberately **no per-device live endpoint** — N cards each calling the cloud would collide with the cron on the 1 req/s budget.

Health chip: no `last_seen_at` → "Waiting for first status"; `online:false` → Offline (toggle disabled); fresh (≤ 3 min) → green with state and watts; 3–10 min → amber; > 10 min → red "Stale — check the Shelly connection". Because the cron reads every device every tick, age *is* the right signal here (Sonos, acting at boundaries only, could not use age).

**Integrations hub** gets a per-location Shelly card (status, host, device counts, last error) assembled from one batched read of non-secret columns, deep-linking to the page. No settings-tree row and no `LocationIntegrations` tab — one surface.

**Bundles:** `device_control → ['bundle_marketing', 'bundle_operations']` (OR), with the SQL seed regenerated by `scripts/generate-bundle-sql.mjs` as migration 564. Verified behaviour-neutral for every existing location on 2026-08-22; the snapshot query is re-run before merge.

## Routes

`withAuth({ permission:'device_control', schema })` everywhere; connection `PUT`/`DELETE` add `guardMasterOrOwner(user, locationId)`. `GET|PUT|DELETE /api/shelly/connection`, `GET /api/shelly/discover`, `GET|POST /api/shelly/devices`, `PATCH|DELETE /api/shelly/devices/[id]`, `POST …/[id]/toggle`, `POST …/[id]/run-now`, `GET …/[id]/energy?days=`, `POST /api/shelly/refresh`. 409 vocabulary: `not_connected`, `key_rejected`, `adopted`, `disabled`, `no_schedule`. Zod shapes live in `src/lib/shelly/schemas.js` and are imported by both the routes and `openapi.js`. The Sonos window validation (`findWindowOverlap`, the base window shape) moves to `src/lib/schedule/windows.js` and the Sonos window editor to a shared `WindowsEditor.jsx`; Sonos behaviour is unchanged.

## Testing

- **Pure, unit-tested** under both `TZ=Europe/Dublin` and `TZ=America/New_York`: the tz helpers (parity with today's Dublin maths, the NY day-wrap regression, both DST transitions), the engine's `tz` parameter, `planDeviceAction` (a 21-row override/window interplay table), the energy roll (first sample, new day, reset, rollback), status normalisation (Plug S, Pro 4PM, Plus 1 without metering, Pro 3EM, Gen1, offline-with-empty-status), host normalisation and SSRF rejections, fingerprint clash classification.
- **Client against mocked `fetch`**: pacing, the single 429 retry, auth classification, bare-200 success, group failures, never-throws, no key in any result or log.
- **Reconcile with injected deps and a fake db**: batching, state-only-when-changed, offline handling, energy upsert, one write per direction, failed ids unstamped, auth → `action_needed` with other locations still reconciled, same-fingerprint serial / different-fingerprint parallel, a thrown error in one location caught and redacted.
- **Routes**: discovery masking (same-org name / other-org flag only), adopt ordering (404 before the holder lookup), connection PUT paths, toggle pending path, and new cases in `tests/cross-tenant/session-routes.test.js` (manager sees only their location; owner of another location patching a device → 404 and the row unchanged; staff → 403).
- **Hub**: an assembly fixture whose connection row carries a secret asserts the payload never contains it.

## Accepted trades

- **Cloud dependency.** A studio internet or Shelly cloud outage pauses schedules until it returns; exactly-once catches up at the next tick. On-device schedules would survive outages and are deferred because they need local commissioning.
- **Boundaries and manual actions only.** A device switched off at the wall mid-window stays off until the next boundary. Deliberate — the alternative fights the room. A continuous desired-vs-actual "drift" mode is a deferred option, not a bug.
- **The key dies on a password change** and must be re-pasted. Status and the hub make it visible within a tick; the Integrator API would remove the trait and is being applied for.
- **Shared rate budget across same-owner studios.** Serialising them costs wall-clock (≈ 7–10 s per account per tick), not correctness.
- **Energy counters can lie after a reset**; the roll bounds the damage to one sample and records `resets` so the figure can be audited.

## Out of scope for v1

Mobile toggle (would be the first `device_control` mobile counterpart), Gen1 devices, the Integrator API transport (needs a persistent websocket worker outside Vercel), on-device schedules/webhooks, a desired-vs-actual drift mode, offline/key-rejected alerts, covers and lights (`set/cover`, `set/light`), a `LocationIntegrations` tab. None need schema changes to add.
