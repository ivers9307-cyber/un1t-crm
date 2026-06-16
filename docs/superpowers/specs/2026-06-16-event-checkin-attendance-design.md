# Event Check-in / Attendance — design (2026-06-16)

## Goal
Per-person attendance check-in for every event kind (`race_events`: race / workshop / seminar / open_day / masterclass). Staff mark who actually turned up, watch live counts vs capacity, and surface no-shows. Web **and** native CF Studio mobile; roster tap **and** per-attendee QR scan.

## Decisions (Richard, 2026-06-16)
- **Granularity:** per PERSON (a `team_members` row), with a one-tap "check in whole team" for team races.
- **Surfaces:** web operator page AND native mobile (the phone-at-the-door use case).
- **Method:** searchable roster (tap) AND per-attendee QR scan.
- **All event kinds.**
- NOT to be confused with Mia's "first-class check-in" (#494, mig 263) — that's an agent retention message after a Glofox *class*; this is operator-facing event-door attendance.

## Data model — `race_checkins` (mig 281)
One row per checked-in person per registration:
`{ id, race_registration_id FK→race_registrations ON DELETE CASCADE, team_member_id FK→team_members ON DELETE CASCADE, contact_id FK→contacts NULL ON DELETE SET NULL, location_id (denormalised, RLS), checked_in_at, checked_in_by FK→profiles, created_at }`, `UNIQUE(race_registration_id, team_member_id)`.
- Row present = checked in; deleting the row = undo. Idempotent upsert on the unique key.
- Lives on its own table (not on `team_members`) because a team can register for more than one event — attendance must be per-registration, not per-person-globally.
- RLS: location-scoped SELECT for `authenticated` (`private.auth_is_in_location(location_id)`); every API route uses the service-role client for writes (defence-in-depth, matches the codebase pattern).
- No new status value. `no_show` stays; a no-show is **derived** (confirmed registration + event date passed + zero check-in rows). Optional post-event "mark the rest as no-show" action stamps `status='no_show'` on registrations whose members never checked in.

## Pure logic — `src/lib/event-checkins.js` (unit-tested)
- `checkinCounts(registrations)` → `{ present, expected }` (people; confirmed-only; a confirmed reg with no member rows counts as 1 expected).
- `registrationAttendance(registration)` → `{ present, expected, allPresent, nonePresent }` for per-team UI state.
- (Phase B) `signCheckinPayload` / `verifyCheckinPayload` — HMAC over `{registration_id, member_id}` with an env secret; stateless, no token column (reuses the `webhook-auth` signature pattern).

## API
- `POST /api/events/[id]/checkin` `{ team_member_id, race_registration_id }` → upsert `race_checkins` (idempotent), emit the reserved `race.checked_in` contact-event (mig 085). Manager+; `assertLocationAccess`.
- `DELETE /api/events/[id]/checkin?team_member_id=…&race_registration_id=…` → remove the row (undo).
- `POST /api/events/[id]/checkin/all` `{ race_registration_id }` → check in every member of a registration (the "whole team" shortcut).
- (Phase B) `POST /api/events/[id]/checkin/scan` `{ payload, sig }` → verify → check in.
- (Phase A) `POST /api/events/[id]/no-shows` → derive + stamp `no_show` for un-checked-in confirmed registrations (operator-triggered, post-event).

## Surfaces
- **Web (Phase A):** `/events/[id]/checkin` — server component loads the roster (registrations → teams → team_members + race_checkins) grouped by wave/team; a client component handles tap-to-check-in, "check in whole team", search, live `X / Y people in`, and undo. Phone-browser friendly. Linked from the `/events` row and `/events/[id]/teams`.
- **Web QR (Phase B):** per-attendee QR on confirmations (`race-confirmations`) + a camera scanner (`getUserMedia` + a small QR-decode lib) on the check-in page → the scan endpoint.
- **Mobile (Phase C):** a CF Studio check-in screen (roster + native camera scanner via `expo-camera`) behind a new `mobile.events_checkin` permission, talking to the same `/api/*` via `authHeaders`. Parity-linter wiring.

## Phases (each its own PR)
- **A — Core (web):** mig 281 + `race_checkins` + RLS; pure helpers + tests; check-in / undo / check-in-all / no-show API + `race.checked_in` event; web `/events/[id]/checkin` page with counts/undo/search; link from the events list.
- **B — QR (web):** signed per-attendee QR on confirmations + web scanner + scan endpoint.
- **C — Mobile:** native check-in (roster + scanner) + new mobile permission + parity.

## Out of scope (v1)
- Self check-in kiosk (attendee self-service).
- A historical attendance analytics dashboard (the live counts on the page suffice for now).

## Verification
TDD the pure helpers; full CI mirror (`npm test` + lint + parity + mobile-imports + route-guards) + `next build` per PR; security advisor after mig 281. Pages are auth-gated, so not browser-verified by the author.
