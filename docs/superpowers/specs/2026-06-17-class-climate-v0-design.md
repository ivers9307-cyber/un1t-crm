# Class Climate v0 — Glofox schedule spine + first schedule-driven automation

**Status:** built + shipped 2026-06-17 (CLASS-CLIMATE.1, mig 284). A deliberately thin, deployed slice to evaluate the concept "the Glofox class schedule drives automations in the platform" before investing in the generalised framework.

## Why
The Glofox class timetable should become a **shared schedule spine** that multiple subsystems read — first AC climate control ("class at 8am → turn the AC on for 60 min"), later HR-session allocation, and future actions (lights/doors/TV). v0 builds the spine + the first rider (AC) so the operator can *see* it working and decide if it's the right shape.

## Architecture (v0)
```
Glofox timetable ──/api/cron/sync-class-occurrences (15m)──▶ class_occurrences (the spine)
                                                                   │
location_automations(class_climate, config) ──/api/cron/class-climate (5m)──▶ AC on
                                                                   │
                                          ac_sessions(system row, auto_off_at = class_end+off)
                                                                   │
                                          existing /api/cron/ac-auto-off ──▶ AC off
```

- **Spine** (`class_occurrences`, mig 284): local mirror of `/2.0/events`, one row per class instance. `raw` keeps the full event for forward-compat (room etc.). Shared — HR allocation will read it too.
- **First rider** = the `class_climate` curated automation. It lives in the EXISTING automations plumbing: a `location_automations` row (mig 276) with `config = { device_ids[], offset_on_min, offset_off_min, class_filter[] }`. **No new permission** — gated by the existing `automations` perm.
- **Runtime**: `/api/cron/class-climate` reads the spine, and for any class whose pre-class window is open turns the configured AC on by writing a **system `ac_sessions` row** (`started_by NULL`) with `auto_off_at = class_end + offset_off`. The **existing `ac-auto-off` cron performs the OFF**, and the **external-rule cron sees the active session and leaves it alone** — so no new off-path and no fights between crons. Idempotency + run history via `automation_fire_log` (one row per occurrence × device × step).
- **New AC primitive**: `vendorTurnOn(device, location)` in `ac-devices.js` — symmetric to the existing `vendorTurnOff`, a system power-on the cron uses.

## Operator surface
A dedicated **Class climate control** card on `/automations`: toggle, device picker, on/off offsets, optional class-name filter. Plus two on-demand tests so it can be verified without waiting for a class:
- **Run schedule check now** → the real climate logic (`/api/automations/class_climate/run-now`), reports what it turned on / would turn on.
- **Test AC now** → turns the chosen units on immediately via the existing `/api/studio-management/ac/devices/[id]/turn-on` route (instant hardware check).

**Off by default** per location; enabled only when Glofox is connected + ≥1 AC device is picked.

## Deliberately NOT in v0 (decide after seeing it)
- The generalised multi-action schedule framework (lights/doors/TV as registered handlers on one engine).
- HR-session allocation on the same spine (the contact-subject consumer).
- Analytics / per-class history surfaces.
- A dedicated `room`/zone column (Glofox doesn't expose it today — `raw` captures it if it ever appears; AC targeting is config-driven via `device_ids`).

## Known follow-ups
- Verify `time_start`/`duration` units against the first real sync (`mapEventToOccurrence` parses both seconds and ms defensively; eyeball `class_occurrences.starts_at/ends_at` after the first cron run).
- The existing bridge booking-matcher UTC `Z` bug (`bridge-samples.js:301`) is untouched here — it belongs to the future HR-allocation consumer, not this slice. (The spine sidesteps it by using Glofox epoch time directly.)
