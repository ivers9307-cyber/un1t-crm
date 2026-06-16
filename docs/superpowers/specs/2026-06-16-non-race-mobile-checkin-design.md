# Non-race mobile check-in — mobile events browse surface (EVENT-CHECKIN.E) — design (2026-06-16)

## Goal
Let staff reach and check people in to **non-race** event kinds (workshop / seminar / open_day / masterclass) from the CF Studio mobile app. Today the mobile app is **race-only**: the "Events" hub tile routes straight to `/races` (race-day control), and there is no mobile list for non-race events, so they're unreachable on a phone. This is item **#3** from the EVENT-CHECKIN lineage (Phases A–D shipped web roster, web QR, native race roster, native QR scanner).

The check-in backend is already kind-agnostic and the existing native roster screen already works for any kind (non-race events are stored as 1-person synthetic "teams" that fit the roster structure). **The missing piece is purely mobile UI: a way to browse to a non-race event.**

## Decisions (Richard, 2026-06-16)
- **Scope:** fuller **browse parity** with web `/events` — events list, event detail with live attendance counts, attendee list, check-in. (Not a lean check-in-only launcher.)
- **Authoring stays on web:** no event create/edit on mobile. The web event form (waves, member pricing, Glofox push, TV logos) is a heavy multi-section form best kept on the big screen; the mobile use case is front-of-house ops at the door.
- **Surface model:** **one unified events list** (Approach 1), mirroring web's single `/events` list of all kinds — not two separate hub tiles. Race-day control is unchanged; only its entry point shifts (reached from a race's row/detail).
- **Reuse the existing check-in roster screen** (`mobile/app/races/checkin/[id].jsx`) as-is rather than rename it to `/events/...` immediately — keeps this work conflict-free with the unmerged Phase D scanner branch (which modifies `mobile/app/races/`). The `/races/` URL is an internal detail the user never sees. Rename is a follow-up once Phase D lands.

## Approach chosen
**Approach 1 — one unified events list (mirrors web `/events`).** The mobile "Events" tile opens a list of all event kinds. Tap a row → behaviour by kind:
- **non-race** → event detail (metadata + live counts) → "Attendees & check-in" (the kind-agnostic roster).
- **race** → the existing `/races/[id]` control board, untouched (it already has its own "Check in" button).

Rejected alternative — **Approach 2 (two hub tiles: "Race control" + "Events check-in")**: lower risk to the race flow but diverges from web's single `/events` list and splits events across two places. Approach 1 is the better parity match and doesn't actually disturb race control — it only changes the entry point.

## Surfaces & navigation
All **new** files live under `mobile/app/events/`, so there is **zero overlap with the unmerged Phase D branch** (which touches `mobile/app/races/`).

- **`mobile/app/events/index.jsx`** — events list, all kinds. Each row: name, kind badge (race / workshop / seminar / open_day / masterclass), date + time, registered count. Pull-to-refresh + `useFocusEffect` fresh-on-focus (per the stale-cache convention — `mobile/components/AcDeviceList.jsx` is the canonical pattern). Empty + error + loading states matching `mobile/app/races/index.jsx`.
- **`mobile/app/events/[id].jsx`** — event detail: header (name, kind, date/time, capacity + `capacity_mode`, public page link), a live **"X / Y in"** attendance summary, and action buttons:
  - "Attendees & check in" (all kinds) → the roster screen.
  - "Race-day control" (race kind only) → `/races/[id]`.
- **Check-in roster:** **reuse `mobile/app/races/checkin/[id].jsx` unchanged.** It is already kind-agnostic — `checkinCounts` / `registrationAttendance` (in `src/lib/event-checkins.js`) explicitly treat a registration with zero team members as 1 expected person, and a non-race signup is a 1-person synthetic team. The detail screen routes here with the event id.
- **`mobile/app/(tabs)/more.jsx`** — the "Events" tile now routes to `/events` (the new list). The old single-card chooser screen `mobile/app/events.jsx` is retired/replaced by `mobile/app/events/index.jsx` (both map to the `/events` route — only one can exist). `mobile/lib/events-hub.js` + its test are updated accordingly (the chooser abstraction is no longer needed now that there's one rich list).

## Data / endpoints
- **NEW `GET /api/events`** — staff-accessible list of all event kinds at the active location. Returns each event's `kind` + the data needed to render a row and compute the registered count (reusing the existing `src/lib/event-signups.js` helper from #547 / EVENTS-HEADCOUNT, which already knows teams-vs-people via `capacity_mode`). `GET /api/races` is **not** reusable — it is manager-gated and omits the `kind` column.
  - Guard: `getCurrentUser()` + `hasPermission(user, 'races')`. **No `MANAGER_ROLES` check** — matches web `/events` (staff-accessible) and the check-in route. Location-scoped via `getUserLocationIds` / optional `?location_id=` with `assertLocationAccess` (same shape as `GET /api/races`).
  - **Time source:** `race_events` stores only `race_date` (a date); start times live on `race_waves`. The row/detail "time" is the **earliest wave's `start_time`** (embed `waves:race_waves(...)` and take the min, matching how the race control board derives wave labels). An event with no waves shows date only.
  - Register in `src/lib/openapi.js`.
- **Extend `GET /api/events/[id]/checkin`** — add event metadata (`race_date`, start time, `capacity`, `capacity_mode`, `slug`, registration window, `active`) to the response's `event` object. Purely additive — existing consumers (the roster screen) ignore the new fields. The detail screen and the check-in screen then share this single fetch.
- **NEW `mobile/lib/events-api.js`** — thin client: `listEvents({ locationId })` → `GET /api/events`, `getEvent(id, { locationId })` → `GET /api/events/[id]/checkin` (reused for detail metadata + counts). All calls go through the shared `api()` helper so Bearer + `x-active-location` + `x-impersonate-target` are built once and can't drift (per the #382 lesson — never hand-roll a Bearer header in a mobile `/api/*` wrapper).

## Permissions / roles
- **Reuse the existing `races` permission key.** No new permission key → no `check:mobile-parity` change (race check-in already shipped on this key in #552, so its parity is already satisfied).
- The new `GET /api/events` list endpoint is **staff-accessible** (`hasPermission('races')`, no `MANAGER_ROLES`) to match web `/events` and serve front-of-house door staff. This is the one deliberate divergence from `GET /api/races` (manager+).
- **Race-day control stays manager+** (unchanged). A staff member tapping a race row reaches the control board, which already renders a graceful "manager only" state for non-managers. Letting staff also check in to *races* on mobile is a possible small follow-up, but is out of scope for #3 (which is about non-race check-in).

## Pure logic & reuse
- Extract a small shared, unit-tested **event-kind presentation helper** (label + badge tone per kind) so web and mobile render kinds identically — web currently inlines a `KIND_BADGE` map in `src/app/events/page.js`. Put it in **`shared/events.js`** (mobile already imports shared modules by relative path, e.g. `shared/race-control.js`); replace the web inline `KIND_BADGE` map with it so the two can't drift.
- Reuse `src/lib/event-signups.js` (registered count) and `src/lib/event-checkins.js` (present/expected) — do **not** re-roll counting logic.

## Scope boundaries (explicitly out of scope)
- **No event create/edit on mobile** — authoring stays web.
- **No port of `RaceTeamsManager`** (add/remove/edit members, move waves). "Attendees" on mobile = the check-in roster (view + tap to check in), not team editing.
- **No in-app QR scanner here** — that is Phase D (#553), a separate native build + App Store release.
- **No renaming `/races/checkin/[id]` → `/events/...`** in this PR — deferred to a follow-up after Phase D merges, to avoid conflicts.

## Testing & verification
- TDD the new shared event-kind helper and any shaping logic in `GET /api/events`.
- Full CI mirror before pushing: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards`, plus a real `npm run build` (the new route + new imports must pass Turbopack — vitest/eslint won't catch an unresolvable import).
- Security advisor not needed (no migration / no schema change).
- Mobile screens are auth-gated, so not author-verifiable; they ship via OTA and need operator device QA (non-blocking, as with Phase C).

## Shipping
- Branch off **`main`** (done: `event-checkin-e-mobile-events`). `main` has Phases A–C; Phase D is the still-open PR #553.
- All changes are **pure-JS → OTA-able** (no native deps, no `app.config.js`/plugin/version change). Merging to `main` auto-publishes the OTA to the production channel.
- One PR: **`EVENT-CHECKIN.E` — non-race mobile check-in via a mobile events browse surface.**

## Related
- Original feature design: `docs/superpowers/specs/2026-06-16-event-checkin-attendance-design.md`.
- Memory: `event-checkin-feature` (Phases A–D status), `events-headcount-display` (`event-signups.js`, `capacity_mode`).
