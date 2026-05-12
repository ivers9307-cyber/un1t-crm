# UniFi Protect — staff face-recognition attendance setup

Phase 2 of zero-touch attendance: when a staff member walks past a
Protect camera at the gym door, the camera matches their face, fires
a webhook to the CRM, and we auto-stamp the start of their shift.

This guide covers everything an operator needs to:
1. Wire UniFi Protect to the CRM webhook receiver
2. Enrol staff faces
3. Link those faces to CRM staff profiles
4. Verify the end-to-end flow

It also acts as a resume-from-cold-chat reference for engineers
picking up the codebase later.

## Architecture

```
[ UniFi Protect Camera ]
         │
         │  Smart Detection → Face Match
         ▼
[ Protect NVR — Alarm Manager ]
         │
         │  POST /api/webhooks/unifi-protect
         │  Header: X-Webhook-Token: <UNIFI_PROTECT_WEBHOOK_TOKEN>
         ▼
[ /api/webhooks/unifi-protect — receiver ]
         │
         │  1. Verify HMAC token
         │  2. Resolve location by Protect host
         │  3. Extract face_id from event payload
         │  4. Look up profile_locations.protect_face_id → profile_id
         │  5. Find shift_assignment in ±4h window
         │  6. UPDATE shift_assignments SET start_time_override = …
         │     WHERE start_time_override IS NULL  (race guard)
         │  7. INSERT staff_attendance_events (audit row)
         ▼
[ /schedule/attendance — operator-facing report ]
         │
         │  Source column shows "Face" / "Access" / both
         │  Tailgates panel surfaces unmatched-Protect events
```

## Prerequisites (P2.0)

Before any of this works, the following need to be true at the
location:

- **Camera positioning** — the camera must see faces head-on as
  staff approach the door. A camera 2.5m up pointing down at 45°
  works for most gym entrances. Side-on / behind-the-counter angles
  miss faces.
- **AI Key** — Protect's face detection needs a UniFi AI Key (or
  Pro NVR with on-board AI). If the NVR is bare-metal Cloud Key
  Gen2 without AI, faces won't even be detected.
- **Smart Detection enabled per camera** — Cameras → [camera] →
  Recording → Smart Detection → Face Recognition: ON.
- **Face library exists** — at least one staff member enrolled in
  Cameras → Smart Detections → Known Faces. Without a face
  library, every Smart Detection event lands as "unmatched" and
  nothing stamps.

## CRM-side configuration

Per location, in `locations.settings.unifi_protect`:

```json
{
  "host":               "https://protect.un1tdublin.com",
  "api_key":            "<from UniFi → Local Users → API Key>",
  "allow_self_signed":  false
}
```

The `host` is reused from `settings.unifi.host` if not set
explicitly — operator can paste the host once into the Access
settings and we use it for both. `api_key` is Protect-specific
(Access uses `api_token`).

Set `UNIFI_PROTECT_WEBHOOK_TOKEN` in Vercel env. Mirror it as
`UNIFI_PROTECT_WEBHOOK_TOKEN_PREVIOUS` while rotating.

## UniFi Protect — alarm wire-up

In each location's UniFi Protect:

1. Settings → System → **Alarm Manager** → **Add Alarm**
2. **Trigger:** Smart Detection → Face Recognition (matched + unmatched)
3. **Zone:** draw an entry-zone polygon around the door interior.
   Without this, the alarm fires on people walking past on the
   street outside.
4. **Action:** Webhook
5. **URL:** `https://crm.un1tdublin.com/api/webhooks/unifi-protect`
6. **Custom Header:** `X-Webhook-Token: <UNIFI_PROTECT_WEBHOOK_TOKEN>`

## Linking faces to staff profiles

For each staff member at this location:

1. Open their CRM profile → Edit → scroll to the per-location
   assignments panel.
2. Two pickers under each location card:
   - **UniFi Access user** — for card taps (Phase 1)
   - **UniFi Protect face** — for face matches (Phase 2)
3. Click the Protect face picker:
   - **Dropdown mode** (Protect configured + reachable): pick the
     face from the list of enrolled faces.
   - **Manual mode** (any failure): paste the face id directly
     from the UniFi Protect UI (Cameras → Smart Detections → Known
     Faces → click face → copy id from URL or details panel).
4. Save the profile.

The `protect_face_id` is what the receiver uses to map an inbound
alarm to a staff profile. Without it, real face matches land as
`match_outcome='unknown_user'` in the audit table and surface in
the Tailgates panel of the attendance report.

## Verifying end-to-end

1. Have a staff member walk past the camera during their scheduled
   shift window.
2. Within ~2 seconds, check the attendance report at
   `/schedule/attendance`:
   - Their row should show **Actual** = the face-match time
   - **Status** = On time (or Late)
   - **Source** = `Face` (or `Access` + `Face` if they also tapped
     a card)
3. If nothing happens:
   - Check Vercel logs for `webhook-unifi-protect` entries
   - Check `staff_attendance_events` table for `source='protect'`
     rows — `match_outcome` tells you what went wrong:
     - `unknown_user` — face seen but not enrolled OR enrolled but
       not linked in CRM (use the Protect face picker on the staff
       profile)
     - `wrong_location` — face linked to a profile at a different
       location (staff member visiting from another studio)
     - `no_shift_in_window` — staff member identified but no shift
       within ±4h of the event time
     - `already_stamped` — Access webhook beat us to it (good — both
       fired, audit trail captures both)
     - `matched` — auto-stamped successfully

## Defence-in-depth with Access

The Access (card-tap) and Protect (face-match) receivers are
co-equal. Whichever fires first wins the stamp; the other writes
an `already_stamped` audit row pointing at the same shift. This
gives us:

- **Tailgate detection** — Protect fires, Access doesn't → member
  walked in behind a staff card-tap (or visitor entered through
  an unmonitored door).
- **Card reader fallback** — Access reader broken → Protect still
  stamps from face match alone.
- **Audit corroboration** — both fire → high confidence the staff
  member was actually there.

The Tailgates panel (P2.7) surfaces every unmatched-Protect event
in the date window. Three legitimate causes for a row appearing
there:
- Genuine tailgate (member walks behind staff tap)
- Unenrolled staff member (need to add their face to Protect)
- Enrolled face not linked in CRM (need to use the Protect picker)

## Resume-from-cold-chat checklist

If you're picking up this work later and need orientation:

- **Receiver** — `src/app/api/webhooks/unifi-protect/route.js`
- **Lib** — `src/lib/unifi-protect.js` (config + face listing)
- **Picker** — `ProtectFacePicker` in `src/components/StaffForm.jsx`
- **API for picker** — `/api/locations/[id]/protect-faces`
- **DB column** — `profile_locations.protect_face_id` (mig 142)
- **Shared with Access** — `matchArrivalToShift` +
  `arrivalToTimeOnly` + `resolveScheduledAt` from
  `src/lib/staff-attendance.js`
- **Attendance UI** — `src/components/AttendanceReportClient.jsx`
  (SourceBadges + TailgatesPanel)
- **Migrations** — 121 (dark-launch table extension) + 142 (face
  mapping). Note: P2 was originally specced as mig 123 but
  mig 122-141 got used by other features; the shift to 142 is
  cosmetic, not architectural.

The dark-launch period ended when mig 142 + the receiver wire-up
shipped. Before that, every Protect event landed as `unknown_user`
by definition.
