# Tapo Device Control — Design

**Date:** 2026-07-05
**Status:** Approved in conversation (Richard, 2026-07-04/05); spec pending his written review
**Repos:** un1t-crm (CRM side) + champ-bridge (Pi side: bridge module + new Python sidecar)
**Scoping brief:** memory/tapo-scoping.md (research, risks, rejected alternatives)

## Problem

Stillorgan runs ~50 Tapo devices (bulk: P100/P110 Wi-Fi plugs driving lighting, TVs, speakers; plus S210/S220 battery wall switches via the H100 hub for bathroom lighting), all controlled manually through the Tapo app. Staff want them scheduled — some by time of day, some following the class timetable like the AC automation — with manual override from the CRM.

## Decisions made (with Richard)

1. **On/off only.** No energy monitoring anywhere in scope (P110s can meter; deliberately unused).
2. **Two schedule modes:** fixed time-of-day windows, and class-linked (on before first class / off after last, per zone — same semantics as class-climate on the `class_occurrences` spine).
3. **Device set:** ~50 devices, no power strips. Bulk P100/P110 plugs (direct Wi-Fi, KLAP — the best-supported python-kasa path); S210/S220 switches via H100 hub (weakest library corner — sequenced second, on-site verification gate before bathroom cutover).
4. **Manual override from CRM web + mobile** (UniFi door-toggle precedent). Tapo app remains a backup path.
5. **Stillorgan only; OFF by default** (automations-hub convention). Future studios may use a different device brand — the architecture isolates that choice in the sidecar (see §Topology).
6. **Operational rule (non-negotiable, from research):** firmware pinned + auto-updates OFF on every Tapo device; one Tapo business account; credentials live on the Pi only. TP-Link repeatedly breaks local control via undocumented firmware (see scoping brief).

## Topology

```
CRM (Vercel)                     Stillorgan Pi
──────────────                   ─────────────────────────────
tapo_devices table  ⇄  /api/bridge/tapo/*  ⇄  champ-bridge (Node)
operator UI + mobile     (bridge token)         │ reconciliation loop (~15s)
                                                ▼ localhost HTTP only
                                          tapo-sidecar (Python, python-kasa)
                                                │ KLAP (LAN)          │ sub-GHz via H100
                                          P100/P110 plugs       S210/S220 switches
```

- **tapo-sidecar** (new, champ-bridge repo): small Python service (python-kasa, systemd unit) exposing localhost-only HTTP: `GET /devices` (enumerate direct plugs + H100 children with stable ids), `GET /state`, `POST /device/{id}/state {"on":bool}`. Tapo account creds + device/hub addressing in Pi env/config. Never network-exposed beyond localhost.
- **champ-bridge tapo module** (Node): every ~15s: `GET /api/bridge/tapo/directives` (CRM; cached locally for offline continuity), read actuals from sidecar, apply diffs, `POST /api/bridge/tapo/state` with actuals + reachability. Reconciliation (desired vs actual) rather than fire-and-forget: Pi restarts, Wi-Fi blips, and missed ticks self-heal; commands are idempotent.
- **CRM never speaks Tapo.** A future studio on different hardware = a different sidecar behind the same directives contract; zero CRM changes.

## Desired-state model

Pure function (unit-tested, lives in un1t-crm `src/lib/tapo/desired-state.js` — web-only; the bridge receives *computed* desired states, not rules):

`desiredState(device, nowDublin, todaysOccurrencesForZone) → 'on' | 'off' | null(unmanaged)`

- Mode `fixed`: jsonb windows `[{days:[1..7], on:"HH:MM", off:"HH:MM"}]`, Dublin wall-clock (use `dublinTodayStr`/house TZ helpers; overnight windows — off < on — span midnight).
- Mode `class`: `{zone, lead_min, lag_min}` — on `lead_min` before the zone's first non-cancelled occurrence of the day, off `lag_min` after its last. No occurrences → off. Zone semantics MUST mirror how class-climate already maps occurrences to devices (planning reads `class_climate`/`class_occurrences` migs + runner and reuses its mapping — if class-climate is location-wide rather than per-zone, v1 zone = whole location and the field is just a label).
- Mode `none`: unmanaged (null → bridge never touches it).
- **Manual override wins:** `{state, until, set_by}` — active override supersedes schedule until `until` (default: end of Dublin day), then schedule resumes. Toggling to the scheduled state clears the override.

The CRM computes desired states at directive-serve time (cheap: ≤50 devices, one occurrences query). The bridge's cached directives include the full day's schedule windows *resolved to concrete on/off timestamps* so fixed AND class schedules keep executing through a CRM/internet outage.

## Data model (one migration)

`tapo_devices`: `id uuid pk`, `location_id fk`, `name`, `kind ('plug'|'switch')`, `sidecar_device_id text` (stable id from the sidecar: device MAC / hub child id), `zone text null`, `enabled bool default false`, `schedule_mode ('none'|'fixed'|'class')`, `fixed_windows jsonb`, `class_rule jsonb`, `override jsonb null`, `last_state ('on'|'off'|null)`, `last_seen_at timestamptz`, timestamps. RLS per house pattern (single SELECT policy for location staff; writes manager — mirror a recent table; advisors after DDL). Indexes: `(location_id, enabled)`.

## Routes

- **Bridge (Bearer bridge token, existing `/api/bridge/*` auth pattern):**
  - `GET /api/bridge/tapo/directives?location_id=` → `{ devices: [{sidecar_device_id, desired, resolved_windows:[{on_at,off_at}]}] }`
  - `POST /api/bridge/tapo/state` → upserts `last_state`/`last_seen_at` per device; unknown sidecar ids returned in the response so the UI can offer "adopt new device".
- **Staff (session; new `device_control` permission — WEB_PERMISSIONS + mobile counterpart per parity linter):**
  - `GET/POST/PATCH /api/tapo/devices[...]` — registry CRUD (adopt from last bridge report, configure mode/windows/zone).
  - `POST /api/tapo/devices/[id]/toggle` — sets/clears override. 404-not-403 on cross-location. Register routes in openapi.js if siblings are.

## Operator UI

- Web: devices page under the automations surface (follow the automations-hub pattern — read it during planning): device list with live state dot + last-seen, per-device config (mode, windows editor, zone, lead/lag), toggle button, "adopt" flow for newly-seen sidecar devices. Customer-facing copy rule n/a (staff-only feature).
- Mobile (Wave 2): device list + toggle only, via `/api/*` wrappers with `authHeaders()`; JS-only OTA.

## Failure & ops

- Sidecar/device unreachable → bridge reports it; UI shows stale last-seen (amber dot >5 min, red >30 min). No alerting in v1 (candidate: needs-attention row later).
- CRM/internet outage → bridge executes cached resolved windows for the rest of the day; overrides unavailable until connectivity returns (Tapo app is the manual fallback).
- Pi power loss → systemd restarts sidecar+bridge; reconciliation restores desired state within one tick. Device clocks don't matter (we never use on-device schedules or energy counters).
- S210/S220 risk gate: Wave 1 ships with plugs verified on-site; switches are behind the same interface but bathroom cutover only after Richard confirms hub-child control works reliably on the real hardware.
- Firmware: pin + disable auto-update on all devices at install (documented in the PR/runbook; one-time manual pass in the Tapo app).

## Testing

- TDD: `desired-state.js` matrix (fixed windows incl. overnight, class lead/lag, no-occurrence days, override precedence/expiry, Dublin TZ edges under `TZ=Europe/Dublin` and a US TZ per house rule).
- Route guards + CI mirror as always. Sidecar: minimal pytest for its id-mapping/serialisation; on-Pi smoke is the real gate (device-verify milestone, Richard on-site).
- No DB tests (house convention).

## Waves

- **Wave T1 (un1t-crm):** migration, desired-state lib, bridge + staff routes, web devices UI. Mergeable/deployable alone (dormant until the Pi side exists).
- **Wave T2 (champ-bridge repo):** tapo-sidecar (Python) + bridge tapo module + Pi deployment notes. Ends with the on-site plug verification.
- **Wave T3:** mobile toggle parity (OTA) + bathroom-switch cutover after the hub-child verification gate.

## Out of scope

Energy monitoring/reporting; power strips; sensors/cameras/locks/AC (owned by UniFi/Sensibo); per-device usage analytics; push alerts on device-offline; multi-location rollout (config is per-location-ready, but only Stillorgan is enabled).
