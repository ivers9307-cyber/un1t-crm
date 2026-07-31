# Staff device visibility (STAFF-DEV) — versions, devices, geofence permission

**Date:** 2026-07-31 · **Status:** APPROVED (Richard, 2026-07-31)
**Origin:** "is there a way to see what app version each staff member is running" — during the GEO-ATT rollout, when it emerged that only Richard is on 2.2.0 and therefore nobody else has geofencing at all.

## 1. Goal

Answer three operational questions that currently require a DB query:

1. **Who hasn't updated?** — gating the geofence attendance rollout (a staff member below 2.2.0 has no geofencing code at all).
2. **Why isn't this person's attendance stamping?** — per-staff device/permission diagnosis.
3. **Who has never installed the app?** — the largest cohort, and invisible today.

## 2. Key finding — the data mostly exists

`device_tokens` (mig 023) already records per device: `user_id`, `expo_push_token` (unique), `platform`, `device_name`, `app_version`, `last_seen_at`. It is written by `POST /api/mobile/device-tokens` on login/registration.

Live snapshot 2026-07-31: 11 rows / 7 distinct staff. Richard on 2.2.0 (iPhone); Lukasz, Garrett, James, Mark, Dean, Lucy on 2.1.0; the rest are stale rows (1.4.0 iPad, 1.0.0, 0.1.x from May/June). **15 of 22 staff have no current device row at all.**

So this is predominantly a *surfacing* problem. The only new data capture is geofence permission state (§5).

## 3. Definitions (single source of truth: `src/lib/staff-devices.js`)

- **Current device** = the row with the greatest `last_seen_at` for that profile. All version/permission verdicts key off it.
- **Stale device** = `last_seen_at` older than 30 days. Rendered dimmed; never drives the verdict.
- **Target version** = the highest `app_version` (semver-compared) seen across the estate among devices active in the last 30 days. No operator setting — it self-updates when a new build lands (YAGNI; today that is 2.2.0 from a single install, which is the correct answer).
- **Outdated** = current device's `app_version` semver-below target version.
- **No device** = the profile has no `device_tokens` row at all (or only rows older than 90 days). Rendered explicitly, not hidden — this is the largest and most actionable cohort.

Version comparison is semver-ish and must tolerate the historical junk in the column (`0.1.0`, `1.0.0`, missing/empty). Unparseable → sorts lowest, never becomes the target.

## 4. Surfaces

### 4.1 Fleet view — staff list (`/settings/staff`)
A **Device** column: current version + relative last-seen (e.g. "2.1.0 · today"), an amber **Outdated** chip, a neutral **No device** chip, and the geofence-permission chip (§5). A **Needs update** filter chip narrows to outdated + no-device rows.

### 4.2 Per-staff Devices card — staff profile
Under the existing per-location assignment panels: every registered device — name, platform, version, last seen, push-token health (present / invalid) — stale rows dimmed, current row marked. Plus the geofence permission chip and its as-of timestamp.

### 4.3 Access
Reuses the existing staff-page gate (owner / manager / master). **No new `WEB_PERMISSIONS` key** — deliberate, so the mobile-parity linter needs no counterpart and nothing changes for staff-level users.

## 5. Geofence permission capture (the one new signal)

Migration adds to `device_tokens`:
- `geofence_permission text` — `'always' | 'when_in_use' | 'denied' | 'undetermined'`, nullable, CHECK-constrained.
- `geofence_permission_at timestamptz` — when the client last reported it.

Reported by mobile in the existing `POST /api/mobile/device-tokens` body (new optional fields) and re-sent by `LocationGate`'s foreground permission re-check when the value changes. **JS-only → ships over OTA on the 2.2.0 lane**; no store build.

Rendering rule: a device below 2.2.0, or any device that has never reported, shows **"—"**, never "denied". Absence of data is not a denial — that distinction is the whole diagnostic value.

## 6. Nudge to update

Button on the fleet view: push-notifies the currently-filtered outdated staff via the existing Expo pipeline (`src/lib/push.js`).

- Confirm dialog lists exactly who will receive it and shows an **editable message** with a sensible default (operator-editable copy, per the CLAUDE.md invariant, without new settings plumbing).
- **Throttle: once per staff member per 24 h**, enforced server-side against a `last_update_nudge_at` column on `device_tokens` (current device row). A second attempt inside the window skips that person and reports the skip count.
- Staff with no valid push token are skipped and counted — they cannot be reached by definition.
- Runs as a bounded fan-out on the request thread (≤ 22 recipients today); each send is independent, a failure never fails the response.

## 7. Out of scope (deliberate)

Historical version-adoption charts; remote device wipe / force-logout; OS version beyond `platform`; mobile-side UI for any of this; automatic nudging on a schedule.

## 8. Testing

- Pure-lib tests for `staff-devices.js`: current-device selection, stale threshold, semver compare with junk values, target-version derivation, outdated/no-device verdicts.
- Route tests: fleet + per-staff endpoints (auth gate, no cross-location leakage), nudge route (throttle honoured, no-token skip, recipient scoping).
- CI mirror + `npm run build`.

## 9. Rollout

1. Migration + server + web UI ship together (immediately useful with existing data; permission column simply reads null).
2. Mobile permission reporting follows over OTA; 2.2.0 installs begin populating within a day.
3. Nudge used once to push the fleet to 2.2.0 — which is the actual unblock for geofence attendance.
