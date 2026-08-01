# Homey Direct Control — Design

**Date:** 2026-08-01
**Status:** Approved in conversation (Richard, 2026-08-01)
**Repos:** un1t-crm (this spec) + a small champ-bridge strip PR
**Supersedes:** champ-bridge PR #9 (Homey actuation on the Pi, merged earlier today) and the Pi half of the 2026-07-05 Tapo design. **Richard's direction: the Pi is an independent piece (HR straps + InBody) and stays that way — the CRM talks to the Homey Pro directly over its internet-reachable API.** The CRM-side registry/engine/UI from mig 372 all stand.

## Architecture

```
un1t-crm (Vercel) ──HTTPS──▶ Homey Pro remote API ──▶ Tapo devices (+ any future brand)
  │ /api/cron/homey-reconcile (* * * * *)   Bearer API key
  │ toggle route fires commands directly     https://<cloudid>.connect.athom.com
  └ tapo_devices / desired-state engine / /automations/devices UI — unchanged (mig 372)
```

- **Same Web API remotely as locally**: `GET /api/manager/devices/device` (full device list + live capability values), `PUT /api/manager/devices/device/<id>/capability/onoff` `{value}`. Auth: `Authorization: Bearer <API key>` created in the Homey web app (Settings → API Keys, device read+control scope).
- **Reconcile model survives, cadence changes**: a per-minute Vercel cron does the idempotent desired-vs-actual pass the Pi loop did at 15s. Misses self-heal; 60s granularity is irrelevant for lights/TVs.
- **Manual toggles are instant**: the toggle route fires the command directly (fire-and-forget, own try/catch) after writing the override; the cron backstops if the direct call fails.
- **Accepted trade (Richard, stated once)**: schedules depend on studio internet + Athom cloud. An outage pauses automation until it returns; reconcile catches up immediately after. Homey's own app is the manual fallback.
- **Accepted debt**: `tapo_*` naming and the `sidecar_device_id` column stay (now holding `homey:<device-id>` ids).

## Config (Vercel env — no silent fallbacks, but feature-dormant when unset)

| Var | Notes |
|---|---|
| `HOMEY_API_URL` | Bare origin of the Homey's remote URL (`https://<cloudid>.connect.athom.com`). Path/query rejected. |
| `HOMEY_API_KEY` | Scoped API key, trimmed. |
| `HOMEY_LOCATION_ID` | uuid of the location this Homey serves (Stillorgan). Scopes the cron's device/occurrence queries. |

`getHomeyConfig()` in the client returns `null` unless ALL THREE are set and valid (origin-only URL — the classic mis-paste is the Homey web-app URL with a path); when null the cron **stamps its heartbeat and exits success with `skipped: true`** (dormant convention — a not-yet-configured feature must not page as a stale cron). Multi-studio later = per-location config table; env triple is v1 (YAGNI).

## Files

**New `src/lib/homey/devices.js`** (pure, fully tested — ported from the champ-bridge implementation reviewed today):
- `mapHomeyDevices(raw)` → `[{ sidecar_device_id: 'homey:<id>', kind: 'plug'|'switch', name_hint? }]` — accepts Homey's object-map or array; filter: `capabilities` array authoritative when present (empty array excludes), `capabilitiesObj` fallback; `class === 'socket'` → plug else switch.
- `mapHomeyStates(raw)` → `[{ sidecar_device_id, state: 'on'|'off'|null, reachable }]` — `state` strictly boolean else null (never guessed), null when `available === false`; `reachable = available !== false`.
- `planCommands(devices, states, nowMs, today, occurrences)` → `[{ sidecar_device_id, on }]` — for each **enabled** `tapo_devices` row: desired via existing `desiredState(d, nowMs, today, occurrences)` (`@/lib/tapo/desired-state` — override-first/fixed/class semantics untouched); skip when desired is null, device unknown to Homey, unreachable, or already in the desired state. Idempotent by construction.

**New `src/lib/homey/client.js`** (thin I/O):
- `getHomeyConfig()` → `{ url, apiKey, locationId } | null` (validation above).
- `homeyGetDevices(cfg)` → `{ ok, statusCode, body }`, never throws, `AbortSignal.timeout(8000)`.
- `homeySetOnoff(cfg, homeyDeviceId, on)` → same shape; strips the `homey:` prefix, `encodeURIComponent`, PUT `{value: on}`.

**New `src/lib/homey/reconcile.js`**:
- `reportDeviceStates(db, locationId, rows)` — the select→branch upsert **moved verbatim in behaviour** from `src/app/api/bridge/tapo/state/route.js` (auto-register unknown devices `enabled=false` = adopt flow; never stomp adopted config; honest `{updated, discovered, failed}` counters; insert 23505 = benign race → update path; a failed lookup must NOT fall through to insert).
- `runHomeyReconcile(db, { getDevices, setOnoff, now })` — orchestration: config null → `{ skipped: true }`; one Homey GET; load enabled `tapo_devices` + today's non-cancelled `class_occurrences` for `locationId` with the **DST-exact Dublin-day bounds copied from the directives route** (`dublinTodayStr`/`dublinDayStartMs`/`addDaysISO` — pulling tomorrow's occurrences keeps class devices ON all night; that comment moves with the code); `planCommands` → fire each (failures logged + counted, next minute retries); then `reportDeviceStates` with the full mapped snapshot. Homey GET failed → log with statusCode (401 = bad key vs network) and still return success to the cron (staleness in the UI is the alert, unchanged).

**New `src/app/api/cron/homey-reconcile/route.js`** — CRON_SECRET guard, `maxDuration 60`, delegates to `runHomeyReconcile`, `stampHeartbeat('homey-reconcile')` on success (including skipped), model: `class-climate` route.

**Modified `src/app/api/tapo/devices/[id]/toggle/route.js`** — after the override write succeeds, fire-and-forget `homeySetOnoff` in its own try/catch (house fire-and-forget pattern; never blocks/fails the response; no-op when config null).

**Deleted:** `src/app/api/bridge/tapo/directives/route.js`, `src/app/api/bridge/tapo/state/route.js` + their two `src/lib/openapi.js` registrations (nothing calls them; the bridge side is being stripped). The staff `/api/tapo/*` routes and UI are untouched.

**`vercel.json`:** `{ "path": "/api/cron/homey-reconcile", "schedule": "* * * * *" }`.

**Migration `471_homey_reconcile_heartbeat.sql`:** `cron_heartbeats` row for `homey-reconcile` (copy the mig 470 pattern; generous `stale_after` so the minutely cadence isn't flappy — use the same interval style neighbouring minutely/5-minutely crons use). Forward-only, applied via Supabase MCP against `iyvtbjjxdggiadzwwvdj` before the code deploys; `get_advisors` after.

## champ-bridge strip (separate small PR in that repo)

Remove `src/tapo.js`, `src/tapo-logic.js`, `src/homey.js` (+ all three test files), the tapo/homey config vars + `homeyConfigError`, the index.js tapo block, the README device-control section, and any tapo lines in `.env.example`. The Pi ends as HR + InBody only. (PR #9's sidecar deletion is retained either way.)

## Failure modes

- Homey cloud/API unreachable or 401 → zero state reports that minute → `last_seen_at` staleness drives the existing amber/red dots. Cron logs carry statusCode (401 = key problem).
- Vercel/cron outage → devices unmanaged until it returns; reconcile converges on the next successful run.
- Direct toggle command fails → override is already stored; the next cron minute applies it.

## Testing

House style (pure-lib, no DB): full matrices for `mapHomeyDevices`/`mapHomeyStates`/`planCommands` (port + adapt the champ-bridge suites incl. the filter-precedence and never-guess pins); `runHomeyReconcile` with injected deps + minimal fake db; existing `desired-state.test.js` untouched. CI mirror all six checks + `npm run build` (route deletions + new imports).

## Exit gate (no site visit needed for smoke)

Apply mig 471 → merge → set the three env vars in Vercel → within a minute: heartbeat green, `/automations/devices` fills with Homey devices (disabled). Then enable one plug: schedule window flips it; CRM toggle actuates near-instantly. Bathroom S210/S220 stay manual until the Homey→H100 hop is proven.

## Out of scope

Per-location Homey config table; Homey websocket/realtime; energy; renaming `tapo_*`/`sidecar_device_id`; Wave T3 mobile toggle (unchanged, later).
