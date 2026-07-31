# Staff attendance — mobile geofence

> Reference doc extracted from CLAUDE.md on 2026-06-01, rewritten
> 2026-07-31 when the UniFi attendance pipelines were removed.

**Status: built 2026-07-30 (mig 463); ships in the 2.2.0 native binary.**
Shift arrivals auto-stamp from an OS-level geofence around the gym,
registered by the CRM mobile app. Owner / manager / master see the
report at `/schedule/attendance`; staff do not (gated by the
`attendance_reports` permission, default off for `staff` and
`head_coach`). Manual entry remains the other way a shift gets stamped.

### Historical note — the UniFi pipelines (removed 2026-07-31)

Attendance originally had two other auto-stamping sources, both wired
off UniFi hardware, both **removed on 2026-07-31**:

- **Phase 1 — UniFi Access door taps (mig 120, shipped 2026-05-09).**
  A `POST /api/webhooks/unifi-access` receiver turned door-unlock alarms
  into shift stamps by resolving `actor.user` →
  `profile_locations.unifi_user_id`. It received **157 events and never
  once matched a staff member to a shift** — every event landed as
  `unknown_user` or `no_shift_in_window`. The Access webhook also went
  silent after 2026-05-18.
- **Phase 2 — UniFi Protect face recognition (mig 142, shipped
  2026-05-12).** A `POST /api/webhooks/unifi-protect` receiver plus a
  `ProtectFacePicker` on the staff editor. It was dark-launched and
  **never actually wired up** — no face was ever enrolled and linked, so
  it stamped nothing. A "Tailgates" panel on the attendance report
  surfaced its unmatched face events; it too is gone, since no new
  Protect events can be written.

What survives the removal, deliberately:

- **Door access control is untouched.** It is an *outbound* API
  integration (`src/lib/unifi-access.js`) — unlock, provisioning,
  offboarding revocation, door allowlists — and never depended on the
  inbound attendance webhooks. `profile_locations.unifi_user_id` and the
  `UnifiUserPicker` are **load-bearing for door provisioning**; see
  `docs/unifi-access-setup.md`.
- **`staff_attendance_events` history stays.** Rows with
  `source='unifi_access'` / `'protect'` and `provider='unifi_access'`
  webhook_events remain, and their DB CHECK constraints were left in
  place. The attendance report still renders those source badges as
  "Access" / "Face" so historical rows read correctly.

### Mobile geofence (mig 463)

**Status: built 2026-07-30 (branch `feat/geofence-attendance`); ships in the 2.2.0 native binary.** The CRM mobile app registers OS-level geofences around each geofence-enabled gym (expo-location + expo-task-manager), iOS/Android wake the app on region ENTER — even with the app killed — and it POSTs to `/api/attendance/geofence-checkin` (Supabase JWT via `authHeaders()`). The route clamps the client timestamp to now ± 5 min (phone clocks and queued retries are untrusted; `payload.clamped=true` on the audit row), dedups region flaps (one geofence event per profile+location per 10 min), then runs the shift-match + race-guarded stamp (`matchArrivalToShift` / `resolveScheduledAt` / `arrivalToTimeOnly` from `src/lib/staff-attendance.js`, `UPDATE … WHERE start_time_override IS NULL`) and inserts the audit row with `source='geofence'` (mig 463 widens the source CHECK). Location config lives in `locations.settings.geofence` (JSONB — enabled/latitude/longitude/radius_m/gate_copy; no DDL); the per-assignment opt-out is `profile_locations.geofence_exempt` (mig 463). Full design + trade-offs: `docs/superpowers/specs/2026-07-30-staff-geofence-attendance-design.md`.

**Outcome taxonomy additions.** Stored outcomes are unchanged from the original mig 120 taxonomy — the geofence route only ever writes `matched` / `already_stamped` / `no_shift_in_window` (`unknown_user` / `wrong_location` can't occur: the caller stamps only THEMSELVES, at a location they're assigned to). Three new outcomes exist in the **response only** and are never inserted (the `match_outcome` CHECK is untouched):

| Response-only value | Meaning |
| ----- | ------- |
| `duplicate` | A `source='geofence'` event for this profile+location already exists in the last 10 min — region-flap dedup. Success-shaped so the phone dequeues. |
| `geofence_exempt` | The caller's `profile_locations.geofence_exempt` is true — never gated, never stamped. Success-shaped so a stale queued ping drains. |
| `impersonation_ignored` | The session is a master viewing-as a staff member (`user.impersonatingFrom`) — a geofence ping would stamp the TARGET's attendance, so the server ignores it. The mobile client already refuses to register regions mid-impersonation; this catches any queued ping that slips through. Known trade-off: a master's OWN arrival while impersonating is ignored and not retried — end View-as before relying on your own auto-stamp. |

Transient DB errors in the match/stamp path return **503 with `transient: true`** BEFORE any audit insert — a dedup-blocking row must never be written for a ping we didn't actually process, so the phone's SecureStore retry queue keeps the ping and retries on next foreground. Terminal 4xx responses drop the ping.

**Operator runbook:**

1. **Enable per location** — Settings → Locations → *location* (Details, below the comms frequency-cap card) → **Geofence attendance** card. Fields: enable toggle (OFF by default — the whole feature is inert until an operator flips it), latitude + longitude (find them in Google Maps → right-click the gym → copy coordinates), radius in metres (50–1000, default 150), and operator-editable permission-gate copy (blank = default). Owner / master only can edit (managers cannot).
2. Once enabled, every non-exempt staff member assigned to the location is blocked behind a full-screen background-location ("Always") permission gate in the mobile app (`LocationGate` — re-checks on every foreground so returning from OS Settings unblocks without a relaunch).
3. **Per-staff opt-out** — the "Geofence exempt" toggle on each location assignment in the staff editor (`StaffForm`): exempt staff are never permission-gated and never stamped (phoneless staff, contractors, GDPR objections).
4. **The Apple review account MUST be set Geofence-exempt BEFORE the 2.2.0 store submission** — otherwise the reviewer hits the Always-location wall on sign-in and rejects. Cross-reference the review-login runbook in `docs/repset-asc-metadata.md` (App Review test account + pre-submission checklist).
5. Verify: walk into the geofence with a shift starting within ±4h — `/schedule/attendance` shows the stamp with Source "Geofence"; for "I expected to be stamped but wasn't", check `staff_attendance_events.match_outcome` (and remember the three response-only outcomes above never land in the table — an absent row within the dedup window usually means exempt/impersonation/queue-drop, not a matcher bug).

**Native lane (2.2.0) — NOT OTA-able.** expo-location + expo-task-manager are NATIVE modules, so the feature ships only in a new EAS Build + store release; `runtimeVersion` bumps to 2.2.0 in lockstep. The 2.0.0 OTA lane (the 2.0.0 SDK-57 + 2.1.0 Repset binaries already in stores) stays frozen for this feature — existing installs never receive geofencing until the 2.2.0 binary lands. Mobile hardening baked into the lane: a custom entry file `mobile/index.js` registers the background task at bundle-global scope (Android headless launches never mount the router tree — a task-not-found fire natively unregisters the geofencing task); `syncGeofences()` self-heals torn-down OS registration; impersonation (View-as) bypasses the gate, skips region sync, and the server ignores impersonated check-ins.

**Key files:**
- **mig 463** `supabase/migrations/463_geofence_attendance.sql` — `'geofence'` added to the `staff_attendance_events` source CHECK + `profile_locations.geofence_exempt`
- `src/lib/geofence-attendance.js` — settings-blob parser + `DEFAULT_GATE_COPY` / radius bounds
- `src/app/api/attendance/geofence-checkin/route.js` — the check-in route (clamp, dedup, stamp, response-only outcomes, transient 503)
- `src/app/api/attendance/geofence-config/route.js` — the mobile app's region list + gate applicability (self-scoped, no params; regions capped at 15 — iOS caps region monitoring at 20 per app)
- `src/app/api/locations/[id]/geofence-attendance/route.js` — settings card read/write
- `src/components/settings/GeofenceAttendanceCard.jsx` + the exempt toggle in `src/components/StaffForm.jsx`
- `mobile/index.js` (custom entry), `mobile/lib/geofence.js` (task + retry queue + `syncGeofences`), `mobile/components/LocationGate.jsx`
- `/schedule/attendance` Source column gains the Geofence badge

