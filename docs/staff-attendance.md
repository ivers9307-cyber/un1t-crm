# Staff attendance — zero-touch via UniFi Access + Protect

> Reference doc extracted from CLAUDE.md on 2026-06-01. Phase 1 (Access, mig 120) shipped May 9 2026; Phase 2 (Protect face-recognition, mig 142) shipped May 12 2026; Phase 3 (mobile geofence, mig 463) built July 30 2026 — ships in the 2.2.0 native binary.

**Status: Phase 1 shipped May 9 2026.** Auto-stamps shift arrivals from UniFi Access door-unlock webhooks. Owner / manager / master see the report at `/schedule/attendance`; staff do not (gated by the `attendance_reports` permission, default off for `staff` and `head_coach`).

### Architecture

```
UniFi Access controller (Stillorgan)
     │
     │  Alarm rule: "Door Unlocked" + All Users + All Methods
     │  POST → https://crm.un1tdublin.com/api/webhooks/unifi-access
     │  Header: X-Webhook-Token: <UNIFI_ACCESS_WEBHOOK_TOKEN>
     ▼
/api/webhooks/unifi-access
     │  1. Auth on shared secret (rotation: UNIFI_ACCESS_WEBHOOK_TOKEN_PREVIOUS)
     │  2. Iterate payload.events[]
     │  3. Resolve actor.user → profile_locations.unifi_user_id
     │  4. Match shift in ±4h window with start_time_override IS NULL
     │  5. Stamp shift_assignments.start_time_override = arrival time
     │  6. Always insert audit row to staff_attendance_events
     ▼
shift_assignments.start_time_override     staff_attendance_events
     │                                          │
     ▼                                          ▼
/schedule/attendance                       (audit trail / debugging)
  → on-time / late / no-show / pending
```

### UniFi alarm payload shape (firmware ~v3.x, observed live 2026-05-09)

This was discovered by capture, not docs. The shape is **alarm-envelope, not flat event** — earlier code that tried to parse a flat `event_type` / `actor.id` shape silently dropped every fire.

```json
{
  "alarm_id": "019e0da5-d0f3-7ec3-81c8-827431b33ecc",
  "events": [{
    "id": "access.entry.granted" | "access.unlocks.location_unlocked" | ...,
    "user": "<uuid>",                  // actor — links to profile_locations.unifi_user_id
    "device": "<uuid>" | "",           // door (empty for remote unlocks)
    "location": "<uuid>",              // UniFi internal location id (NOT our locations.id)
    "scope": { "locations": "<uuid>" },
    "time": "<iso>" | "",              // empty for remote unlocks → fall back to receipt time
    "unlock_method_text": <see method taxonomy below>
  }],
  "data": { "custom_content": "" }
}
```

**`unlock_method_text` taxonomy** (observed values, May 9-10 2026 at Stillorgan — verified live for everything below):

| Method | Semantics | Stamp? |
|---|---|---|
| `NFC` | Physical card tap on the door reader | ✅ |
| `Mobile Tap` | Phone NFC tap on the reader | ✅ |
| `Touch to Unlock` | Apple Wallet / Google Wallet hold-to-unlock | ✅ |
| `Face Unlock` | Door reader's built-in face recognition (NOT the Protect camera) | ✅ |
| `PIN` | Keypad code | ✅ |
| `Remote Unlock` | Operator pressed unlock in the desktop UniFi app or `/studio-management` UI | ❌ |
| `Mobile Button` | Operator pressed unlock in the UniFi mobile app — same conceptual action as Remote Unlock | ❌ |
| `request-to-exit device` (or `REX`) | Passive motion sensor / button on the inside of the door, fires on EXIT. Often arrives with `unifi_user_id=null` so it lands as `unknown_user` regardless | ⚠️ ambiguous |

The receiver's `REMOTE_UNLOCK_METHODS` regex matches the two operator-pressed methods (Remote Unlock + Mobile Button) so they're recorded for audit but never stamp a shift — the actor in the payload is the operator, not whoever walked through.

**Critical gotchas, all learned the hard way:**

- UniFi **reuses `alarm_id` across every fire** of the same alarm rule. A naive `dedupKey = alarm_id:index` silently drops every fire after the first. We add a 60-second receipt-time bucket to the dedup key so retries-within-a-minute dedupe but new fires don't (`${alarm_id}:${i}:${minute_bucket}`).
- The **alarm has an array of events** — process each one. The CRM iterates `events[]` rather than treating the alarm as a single event.
- `Mobile Button` looks deceptively in-person but isn't — it's the unlock button in the UniFi mobile app. Looks identical to Remote Unlock from the data plane's perspective. Initially missed in Phase 1; bitten on the May 10 morning verification when a Mobile Button event would have stamped the operator's shift if their UniFi user had been linked. Keep this in mind whenever new method strings appear: default to "don't stamp until proven in-person."
- Real card taps populate `device` (door uuid) and put one of the in-person methods in `unlock_method_text`. Verified end-to-end on May 10 morning: Mobile Tap and Face Unlock both flowed through cleanly with `match_outcome='unknown_user'` (because the morning-shift staff's UniFi users aren't linked to CRM profiles yet — link via the UnifiUserPicker in StaffForm to start auto-stamping).

### Webhook setup per location

1. Generate a long random token (`crypto.randomBytes(48).toString('base64url')`)
2. Vercel → un1t-crm → Settings → Environment Variables → Production: `UNIFI_ACCESS_WEBHOOK_TOKEN = <token>`. Redeploy after saving (Vercel doesn't pick up new env vars until next deploy).
3. UniFi Access app → Settings → Alarms → Add:
   - **Trigger**: Door Unlocked + All Users + All Methods
   - **Action**: Webhook
   - **URL**: `https://crm.un1tdublin.com/api/webhooks/unifi-access`
   - **Custom Header**: `X-Webhook-Token: <token>`
4. Tap a card on-site or remote-unlock from the app — within ~2s a row lands in `staff_attendance_events`.

### Linking staff to UniFi users

Each staff member needs `profile_locations.unifi_user_id` set per location, otherwise the webhook lands as `match_outcome='unknown_user'` and shifts never auto-stamp. Two paths:

1. **Auto** (existing) — flipping the per-location Door Access toggle in StaffForm runs `findOrCreateUnifiUser(cfg, profile)`, which finds the UniFi user by email or creates one. Works when the email on UniFi matches the CRM email, which it often doesn't (cards registered under personal not work emails).
2. **Manual picker** (new — `UnifiUserPicker` in StaffForm.jsx) — owner / manager / master picks the right UniFi user from a dropdown per location. Lazy-fetches from `GET /api/locations/[id]/unifi-users`. Sends `unifi_user_id` in the assignment payload to PUT /api/staff/[id], which honours the explicit value over the auto-create path (`skipFindOrCreate=true`).

### Match-outcome buckets (`staff_attendance_events.match_outcome`)

| Value | Meaning |
| ----- | ------- |
| `matched` | Stamped successfully — see `matched_assignment_id` |
| `no_shift_in_window` | Staff identified, but no shift starting within ±4h at this location (this is what remote unlocks settle on too) |
| `already_stamped` | Found a candidate shift but a parallel webhook beat us to it (race-guarded via `UPDATE … IS NULL`) |
| `unknown_user` | The `event.user` UUID doesn't match any `profile_locations.unifi_user_id` at this location — link the user via the picker |
| `wrong_location` | The staff member is registered in a different studio's UniFi instance — they tapped at this controller anyway |

For "I expected to be auto-stamped but wasn't", check this column to know which knob to turn.

### Files & routes

- **mig 120** `supabase/migrations/120_staff_attendance_events.sql` — table + `unifi_access` added to `webhook_events_provider_check`
- **`src/lib/staff-attendance.js`** — pure helpers: `resolveScheduledAt`, `bucketLateness`, `minutesLate`, `arrivalToTimeOnly`, `matchArrivalToShift` (27 tests)
- **`src/lib/unifi-access.js`** — `listUnifiUsers(cfg)` walks `/users/search` pagination; existing `findOrCreateUnifiUser` / `setUnifiUserPolicies` unchanged
- **`src/app/api/webhooks/unifi-access/route.js`** — receiver, alarm-envelope parser, dedup, stamp logic
- **`src/app/api/locations/[id]/unifi-users/route.js`** — lists UniFi users for the picker (owner / manager / master)
- **`src/app/api/attendance/route.js`** — owner-side report query (PostgREST embed uses `profile:profiles!profile_id` — `shift_assignments` has two FKs to profiles so disambiguation is required)
- **`src/app/schedule/attendance/page.js`** + **`src/components/AttendanceReportClient.jsx`** — the report UI (date range, status filter, CSV export)
- **`src/components/StaffForm.jsx`** — `UnifiUserPicker` subcomponent at the bottom of the file

### Resume notes

- **Pending: on-site card-tap smoke test (task #407)** — need a real NFC unlock at Stillorgan to confirm `event.id` for in-person taps matches `UNLOCK_EVENT_RE`. The remote-unlock path (`access.unlocks.location_unlocked`) is verified end-to-end. The regex `/access\.(entry|door|unlocks?)\.|door\.unlocked|entry\.(granted|success)/i` should catch real taps but won't be confirmed until a card actually fires.
- Only Stillorgan has UniFi Access today. Hatch Street will follow when the keys arrive — same runbook, new token can stay shared (the receiver fingerprints location from `locations.settings.unifi.host` matching the only-one-configured fallback today; multi-location will need a controller_id mapping).
- Richard's UniFi user `061ed911-2ca5-4bdf-bd44-614d3bd79dda` is manually linked to his CRM profile at Stillorgan. Other staff are unlinked — they need someone to click through the picker on each profile (or wait for the owner-driven onboarding pass).

### Phase 2 — UniFi Protect face-recognition (mig 142)

**Status: shipped May 12 2026.** Sibling pipeline to Phase 1 — when a Protect camera matches a staff member's enrolled face at the gym door, we auto-stamp their shift the same way Access card-taps do. Both receivers are co-equal: whichever fires first wins the stamp; the loser writes an `already_stamped` audit row pointing at the same matched_assignment_id. Defence in depth: tailgate detection (Protect fires, Access doesn't), card-reader fallback (Access broken, Protect still stamps), audit corroboration (both fire → high confidence).

```
Protect camera → Smart Detection → Alarm Manager → POST /api/webhooks/unifi-protect
                                                        │  X-Webhook-Token: <UNIFI_PROTECT_WEBHOOK_TOKEN>
                                                        ▼
                                                   1. Verify token
                                                   2. Resolve location by Protect host
                                                   3. Extract face_id (best-effort across firmwares)
                                                   4. profile_locations.protect_face_id → profile_id
                                                   5. matchArrivalToShift (shared with Access)
                                                   6. UPDATE shift_assignments WHERE start_time_override IS NULL
                                                   7. INSERT staff_attendance_events (source='protect')
```

**Key files:**
- `src/app/api/webhooks/unifi-protect/route.js` — receiver
- `src/lib/unifi-protect.js` — config + face-library client
- `ProtectFacePicker` in `src/components/StaffForm.jsx` — per-location picker (dropdown if Protect API reachable, else free-text fallback)
- `/api/locations/[id]/protect-faces` — backs the picker
- `profile_locations.protect_face_id` — the mapping (mig 142)
- `/schedule/attendance` Source column + Tailgates panel (P2.6/P2.7)

**Operator setup runbook:** `docs/unifi-protect-setup.md` covers prerequisites (AI Key, camera positioning, face enrolment), CRM-side config (`locations.settings.unifi_protect`), Alarm Manager wire-up, picker workflow, and end-to-end verification.

**Resume notes:**
- Receiver was dark-launched at mig 121 (P2.1) — every Protect alarm landed as `unknown_user` until mig 142 + the wire-up.
- The face_id field on the event payload is undocumented per-firmware. The receiver tries: `metadata.recognition_id`, `metadata.recognition.id`, `smartDetectFaceID`, `face_id`, `faceId`. Add more paths to that switch as new Protect versions surface different shapes.
- Faces enrolled in Protect but not linked in CRM appear in the Tailgates panel — operator action is to open the staff profile and use the Protect face picker. The picker degrades to manual text entry when the Protect API can't be reached, so the operator can always paste a face id directly from UniFi.

### Phase 3 — mobile geofence (mig 463)

**Status: built 2026-07-30 (branch `feat/geofence-attendance`); ships in the 2.2.0 native binary.** Third auto-stamping pipeline, co-equal with Access card-taps and Protect faces: the CRM mobile app registers OS-level geofences around each geofence-enabled gym (expo-location + expo-task-manager), iOS/Android wake the app on region ENTER — even with the app killed — and it POSTs to `/api/attendance/geofence-checkin` (Supabase JWT via `authHeaders()`). The route clamps the client timestamp to now ± 5 min (phone clocks and queued retries are untrusted; `payload.clamped=true` on the audit row), dedups region flaps (one geofence event per profile+location per 10 min), then runs the SAME shift-match + race-guarded stamp as the door-tap webhook (`matchArrivalToShift` / `resolveScheduledAt` / `arrivalToTimeOnly` from `src/lib/staff-attendance.js`, `UPDATE … WHERE start_time_override IS NULL`) and inserts the audit row with `source='geofence'` (mig 463 widens the source CHECK). Location config lives in `locations.settings.geofence` (JSONB — enabled/latitude/longitude/radius_m/gate_copy; no DDL); the per-assignment opt-out is `profile_locations.geofence_exempt` (mig 463). Full design + trade-offs: `docs/superpowers/specs/2026-07-30-staff-geofence-attendance-design.md`.

**Outcome taxonomy additions.** Stored outcomes are unchanged from mig 120 — the geofence route only ever writes `matched` / `already_stamped` / `no_shift_in_window` (`unknown_user` / `wrong_location` can't occur: the caller stamps only THEMSELVES, at a location they're assigned to). Three new outcomes exist in the **response only** and are never inserted (the `match_outcome` CHECK is untouched):

| Response-only value | Meaning |
| ----- | ------- |
| `duplicate` | A `source='geofence'` event for this profile+location already exists in the last 10 min — region-flap dedup. Success-shaped so the phone dequeues. |
| `geofence_exempt` | The caller's `profile_locations.geofence_exempt` is true — never gated, never stamped. Success-shaped so a stale queued ping drains. |
| `impersonation_ignored` | The session is a master viewing-as a staff member (`user.impersonatingFrom`) — a geofence ping would stamp the TARGET's attendance, so the server ignores it. The mobile client already refuses to register regions mid-impersonation; this catches any queued ping that slips through. |

Transient DB errors in the match/stamp path return **503 with `transient: true`** BEFORE any audit insert — a dedup-blocking row must never be written for a ping we didn't actually process, so the phone's SecureStore retry queue keeps the ping and retries on next foreground. Terminal 4xx responses drop the ping.

**Operator runbook:**

1. **Enable per location** — Settings → Locations → *location* (Details, below the comms frequency-cap card) → **Geofence attendance** card. Fields: enable toggle (OFF by default — the whole feature is inert until an operator flips it), latitude + longitude (find them in Google Maps → right-click the gym → copy coordinates), radius in metres (50–1000, default 150), and operator-editable permission-gate copy (blank = default). Owner / manager / master can edit.
2. Once enabled, every non-exempt staff member assigned to the location is blocked behind a full-screen background-location ("Always") permission gate in the mobile app (`LocationGate` — re-checks on every foreground so returning from OS Settings unblocks without a relaunch).
3. **Per-staff opt-out** — the "Geofence exempt" toggle on each location assignment in the staff editor (`StaffForm`): exempt staff are never permission-gated and never stamped (phoneless staff, contractors, GDPR objections).
4. **The Apple review account MUST be set Geofence-exempt BEFORE the 2.2.0 store submission** — otherwise the reviewer hits the Always-location wall on sign-in and rejects. Cross-reference the review-login runbook in `docs/repset-asc-metadata.md` (App Review test account + pre-submission checklist).
5. Verify: walk into the geofence with a shift starting within ±4h — `/schedule/attendance` shows the stamp with Source "Geofence"; for "I expected to be stamped but wasn't", check `staff_attendance_events.match_outcome` exactly as with Access/Protect (and remember the three response-only outcomes above never land in the table — an absent row within the dedup window usually means exempt/impersonation/queue-drop, not a matcher bug).

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

