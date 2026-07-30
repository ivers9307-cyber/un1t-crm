# Staff geofence attendance — passive check-in via the CRM mobile app

**Date:** 2026-07-30 · **Status:** DRAFT — awaiting Richard's review
**Supersedes reliance on:** UniFi Protect face recognition (never wired up on-site; 0 faces linked, 0 events ever received). The UniFi Access door-tap pipeline stays as a co-equal signal once its webhook is restored (silent since 2026-05-18).

## 1. Goal

Staff attendance is stamped automatically when a staff member's phone enters a geofence around their gym — no tap, no scan, no conscious action. The CRM mobile app registers OS-level geofences; iOS/Android wake the app in the background on region entry (even if killed) and it POSTs a check-in to the CRM, which stamps the shift exactly the way the door-tap webhook does today.

**Hard requirement (Richard, 2026-07-30):** granting background ("Always") location permission is mandatory for staff. A staff member who has not granted it is blocked from the app's features by a full-screen gate until they do.

## 2. What already exists (reuse, don't rebuild)

- `src/lib/staff-attendance.js` — `matchArrivalToShift`, `bucketLateness`, `resolveScheduledAt` (27 tests). The geofence route calls these unchanged.
- `staff_attendance_events` (mig 120) — audit table with `match_outcome` buckets and race-guarded stamping (`UPDATE … WHERE start_time_override IS NULL`). Geofence becomes a third `source`.
- `/schedule/attendance` report — gains a `Geofence` source badge; no structural change.
- Mobile app auth guard in `mobile/app/(tabs)/_layout.jsx` — the permission gate slots in here, after login.
- `mobile/lib/api.js` `authHeaders()`/`api()` — all new mobile calls go through it (impersonation invariant).

## 3. Architecture

```
[ Staff phone — CRM mobile app ]
   │  OS geofence ENTER for a registered gym region
   │  (expo-location startGeofencingAsync + expo-task-manager;
   │   wakes the app in background, survives app kill)
   ▼
POST /api/attendance/geofence-checkin   (Supabase JWT via authHeaders)
   │  1. getCurrentUser() → profile
   │  2. validateBody: { location_id, entered_at, device_name? }
   │  3. Location has geofence attendance enabled + profile assigned there
   │  4. Clamp entered_at to now ± 5 min (client clocks are untrusted)
   │  5. Dedup: skip if a 'geofence' event for this profile+location
   │      exists in the last 10 min (region-flap guard)
   │  6. matchArrivalToShift (±4h window, shared with Access/Protect)
   │  7. UPDATE shift_assignments SET start_time_override
   │      WHERE start_time_override IS NULL   (existing race guard)
   │  8. INSERT staff_attendance_events (source='geofence')
   ▼
/schedule/attendance — Source column shows "Geofence"
```

Whichever signal fires first (door tap, geofence) wins the stamp; the loser lands as `already_stamped` — same defence-in-depth model as Access + Protect.

## 4. Data model (one forward-only migration — mig 463)

*(Amended 2026-07-30 after repo review: location-level config follows the FREQ-CAP.1 `locations.settings` blob convention instead of new columns; gate copy lives in the same blob, not `company_settings`, which is a branding-only table.)*

1. **`locations.settings.geofence`** (JSONB blob, no migration needed) — `{ enabled: false, latitude: null, longitude: null, radius_m: 150, gate_copy: null }`, read via a defaults helper (`geofenceFromLocationSettings`), written by a dedicated GET/PUT sub-route with a merge-write (never clobber sibling settings keys). `enabled` is the per-location rollout switch; `gate_copy` is the operator-editable gate text with a hard-coded default fallback.
2. **`staff_attendance_events.source`** — drop and re-add `staff_attendance_events_source_check` to allow `('unifi_access','protect','manual','geofence')` (the mig 120/122 constraint-recreate precedent).
3. **`profile_locations`** — add `geofence_exempt boolean NOT NULL DEFAULT false`. Operator toggle in `StaffForm.jsx` next to the existing UniFi pickers. Exempt staff are never gated and never stamped by geofence (covers phoneless staff, contractors, and doubles as the GDPR opt-out lever).

## 5. API surface (register both in `src/lib/openapi.js`)

### `GET /api/attendance/geofence-config`
Auth: session/JWT. Returns, for the current user, every assigned location where `geofence_attendance_enabled` and they are not `geofence_exempt`:
`{ success, data: { required: boolean, gate_copy: string, regions: [{ location_id, latitude, longitude, radius_m }] } }`
`required=false` (empty regions) means the app registers nothing and never gates. The app refetches on login and on foreground.

### `POST /api/attendance/geofence-checkin`
Auth: session/JWT (mobile). Zod: `{ location_id: uuidLike, entered_at: iso datetime, device_name: string.max(80).optional() }`. Flow as in §3. Responds `{ success, data: { match_outcome } }` — the app does nothing with the outcome beyond clearing its retry queue; all triage happens in the attendance report. Standard mutation-route skeleton (`getCurrentUser` → `validateBody` → `assertLocationAccess` → work).

Outcome buckets reuse the existing taxonomy: `matched`, `no_shift_in_window`, `already_stamped`. (`unknown_user`/`wrong_location` can't occur — the profile comes from the JWT and the route checks assignment.)

## 6. Mobile app changes (native build required)

**Deps:** `expo-location`, `expo-task-manager`. iOS: `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSLocationWhenInUseUsageDescription`, `UIBackgroundModes: [location]`. Android: `ACCESS_BACKGROUND_LOCATION` (+ Play Console sensitive-permission declaration). This is native, not OTA-able: bump `runtimeVersion` and ship in the next store build (ships in the 2.2.0 native lane (2.1.0 is already in the store)). Re-sync `mobile/package-lock.json` (`npm install --package-lock-only`).

**Background task** — `TaskManager.defineTask(GEOFENCE_TASK, …)` at module top level (imported from `app/_layout.jsx` so it's registered on headless launch). On `Location.GeofencingEventType.Enter`: enqueue `{ location_id, entered_at: new Date().toISOString() }` into an AsyncStorage-backed retry queue, then attempt the POST. Queue drains on next app foreground if the background POST fails (gym basements have bad signal). Exit events are ignored in v1.

**Registration** — after auth bootstrap, fetch `/api/attendance/geofence-config`; `startGeofencingAsync` with the returned regions (or `stopGeofencingAsync` when empty). Re-run when the config response changes (compare a hash) so operator edits propagate without a reinstall.

**Permission gate** — new `LocationGate` component wrapping the authed tree in `app/(tabs)/_layout.jsx`, after the existing auth guard and biometric lock:

- Applies only when `required=true` from the config endpoint (i.e. at least one enabled, non-exempt location). Everyone else never sees it.
- If background permission is not granted: render a full-screen blocker instead of the tab tree. Copy = `geofence_gate_copy` (fallback default explains auto-attendance and that only gym arrival is detected). Primary button runs the two-step request (foreground → background; on iOS the "Always" upgrade, on Android 11+ a deep link to the app's location settings, which is the only path the OS allows). If permanently denied, the button becomes "Open Settings" (`Linking.openSettings()`).
- Re-check on every `AppState` → active transition, so returning from Settings unblocks immediately without relaunch. Revoking permission later re-engages the gate at next launch/foreground.
- **App Review escape hatches (guideline 5.1.1 risk):** the Apple review/demo account must resolve to `required=false` — enforce by keeping the review profile `geofence_exempt=true` (add this to the review-login runbook). Store review notes explain the app is an employee tool and attendance auto-detection is core functionality for staff accounts.

## 7. Privacy / GDPR

Only geofence *transition events for gym regions* ever leave the phone — the OS does the monitoring; the app receives no location data outside those entries and the server stores only "arrived at location X at time T", identical in sensitivity to the existing door-tap data. Required actions: a staff-handbook line stating attendance is auto-detected via the staff app, and the per-staff `geofence_exempt` toggle as the objection mechanism. The gate copy must state plainly what is detected and what is not.

## 8. Edge cases & failure modes

- **Region flap** (walking past the gym, GPS jitter): 10-min server dedup + the `start_time_override IS NULL` guard mean at most one stamp per shift; spurious entries land as `already_stamped`/`no_shift_in_window` audit rows, which is acceptable noise.
- **Phone dead / left at home:** manual stamping (`source='manual'`) and the door-tap pipeline remain; the attendance report already handles `pending`.
- **Force-quit on iOS:** region monitoring still relaunches the app for geofence events (documented iOS behaviour) — but Low Power Mode and precise-location-off degrade accuracy; note in the operator doc.
- **Staff assigned to multiple gyms:** all their enabled locations register (OS limit is 20 regions on iOS — fine at current scale; config endpoint caps at 15 to leave headroom).
- **Clock skew / spoofing:** `entered_at` clamped server-side; a malicious staff member with a jailbroken location spoofer can fake presence — same trust level as handing a card to a colleague; out of scope.

## 9. Testing

- Unit: dedup-window helper, config-shape builder, gate decision logic (pure, in `shared/` if mobile also needs it — run `check:mobile-imports`/`check:mobile-parity`).
- Route tests: geofence-checkin outcome buckets, clamp, dedup, exempt/disabled rejections.
- Device QA (release checklist): Xcode simulated-location run through enter → stamp → report badge; Android background-permission flow on 11+; gate → Settings → return unblocks; review account never gated.
- `npm run build` locally (new routes/imports) + the six-check CI mirror.

## 10. Rollout

1. Migration + server routes + report badge ship first (dark: no location enabled).
2. Operator sets Stillorgan lat/lng + enables the toggle; exempts the review account.
3. Mobile lands in the 2.2.0 native store build; staff update, hit the gate once, grant, done.
4. Watch `staff_attendance_events source='geofence'` for a week alongside the (restored) Access webhook for corroboration.

## Out of scope (deliberate)

- Shift-*end* stamping via geofence exit (future; exit events are noisy).
- BLE iBeacon precision upgrade (needs a native module; hold in reserve).
- WiFi/MAC network-presence detection (Option A — rejected in favour of this).
- Hatch Street (no roster live there; enabling is just the location toggle once it is).
