# Add to calendar (CALENDAR.1) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A booker can put the event in their calendar from the confirmation email, the moved email, the confirmed page and the public event page, with the right instant in their own zone.

**Architecture:** One pure module (`src/lib/event-calendar-links.js`) turns an event + session time + studio zone into a UTC instant and two links: a `.ics` download served by a public route (`GET /api/public/events/[slug]/calendar.ics?wave=<id>`, built with the RFC 5545 writer in `src/lib/ics.js`) and a Google Calendar template URL. The instant is the studio's wall clock converted with `zonedWallClockToInstant`; the duration is a new `race_events.duration_minutes` (null → 120 for a race, 60 otherwise). Every surface links to the same route, so the old client-side `data:` file goes.

**Tech Stack:** Next.js 16, supabase-js (service role), Vitest (+ jsdom), PGlite.

**Spec:** `docs/superpowers/specs/2026-11-08-host-event-features-design.md` § 4.

## Global Constraints

- Branch `host-calendar-links`, stacked on `host-registration-questions` (PR #2324, auto-merge). Migration `820_event_duration.sql`. Apply before merge; `get_advisors` after.
- Zone maths only through `@/lib/location-time` / `shared/zoned-time` (`zonedWallClockToInstant`); `race_date` + `start_time` are the studio's wall clock. Never `new Date(`${d}T${t}Z`)`. Tests run the maths for Europe/Dublin and America/New_York across a DST change.
- A host anchor location's internal name never reaches a customer: the LOCATION field is `venue_address` → `venue_name` → `pickAudienceVenueName` (the same rule the emails use).
- Public route: published, active events only; rate-limited like `GET /api/public/events/[slug]`; `text/calendar; charset=utf-8`, `Content-Disposition: attachment; filename="<slug>.ics"`, `Cache-Control: no-store`; a bad or foreign `wave` → 404. `/api/public/**` is exempt by path in `check:route-guards`. The UID is `<event id>-<wave id or 'event'>@<tenant host>` so a re-download updates the same calendar entry.
- Emails: a `calendarLineHtml(links)` next to `manageLineHtml` in the confirmation and moved shells: "Add it to your calendar: <a>Apple / Outlook</a> · <a>Google</a>." Operator copy can carry `{{calendar_url}}` and `{{google_calendar_url}}` merge tags.
- Commit messages `CALENDAR.1 — <what>`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A Dublin event in July** must land at the right UTC instant (BST, UTC+1), and a New York studio's event in January at UTC-5 (Task 2 tests).
2. **An event with no wave** (lead-gen, or a legacy row) gets no calendar link anywhere rather than a 09:00 guess (Task 2 `eventCalendarLinks` → null; Task 4 renders nothing).
3. **A host anchor's internal label** never appears in LOCATION (Task 2 test).
4. **The .ics route for a draft or unpublished event** is 404 (Task 3 test).
5. **A multi-time event's public page** links only once a time is picked (Task 4 widget test).

---

### Task 1: Migration 820

**Files:** Create `supabase/migrations/820_event_duration.sql`, `tests/migration-820-event-duration.test.js` (PGlite).

**Produces:** `race_events.duration_minutes int null check (duration_minutes between 5 and 1440)` with a comment (null = 120 for a race, 60 otherwise).

- [ ] Test: column exists, nullable int; 0 and 1441 are refused (23514); re-applies. RED → write → GREEN; `check:select-columns`. Commit `CALENDAR.1 — mig 820: race_events.duration_minutes`.

### Task 2: Calendar links lib

**Files:** Create `src/lib/event-calendar-links.js`, `src/lib/event-calendar-links.test.js`.

**Produces:**
- `eventDurationMinutes(event) → number` (the column, else 120 for `isRaceKind(event.kind)`, else 60).
- `eventInstant({ race_date, start_time, zone }) → { startMs, endMs } | null` via `zonedWallClockToInstant(race_date, start_time.slice(0,5), zone)`; null without a date or time.
- `eventLocationText(event) → string`: `venue_address || venue_name || pickAudienceVenueName({ venueName: event.venue_name, eventLocation: event.locations })`.
- `eventCalendarLinks({ event, wave, zone, baseUrl }) → { ics_url, google_url, starts_at, ends_at } | null`: `ics_url = ${baseUrl}/api/public/events/${slug}/calendar.ics?wave=${wave.id}` (no `?wave` when the event has exactly one wave and none is given); `google_url = https://calendar.google.com/calendar/render?action=TEMPLATE&text=<name>&dates=<YYYYMMDDTHHMMSSZ>/<…>&location=<loc>&details=<url of the event page>`; null when `eventInstant` is null.
- `buildEventCalendarIcs({ event, wave, zone, hostname, brandName }) → string` using `buildIcsCalendar` from `./ics` (`prodId -//${PLATFORM_NAME}//Events//EN`, one event: uid `${event.id}-${wave?.id || 'event'}@${hostname}`, `dtstampMs: Date.now()`, start/end, summary `event.name`, location, description `Booked at ${brandName}` when a brand is known, else omitted).

- [ ] Tests: Dublin July → `Z` string one hour behind the wall clock; New York January → five hours ahead; no wave → null; anchor label never in LOCATION (a `locations.name` of "X (host events)" with `is_host_anchor: true` and no venue → the venue resolver's answer); duration default per kind; `google_url` encodes `dates=` correctly; `.ics` is CRLF, folded, has `DTSTART:…Z`. RED → GREEN. Commit `CALENDAR.1 — event-calendar-links lib`.

### Task 3: The .ics route

**Files:** Create `src/app/api/public/events/[slug]/calendar.ics/route.js` (+ `route.test.js`). Modify `src/lib/openapi.js` (register).

**Produces:** `GET`: rate limit `event-ics:<ip>` (60 / 5 min, fail-open as the siblings); select `id, name, slug, kind, race_date, venue_name, venue_address, active, status, host_id, duration_minutes, location_id, locations:location_id ( id, name, address, timezone, is_host_anchor, organization_id ), waves:race_waves ( id, start_time, label )` by slug, `active` + `published` (and `eventIsPublic`); `wave` query param must match one of the waves (or be absent when there is exactly one; else 404); zone = `zoneOfLocation(locations)`; identity via `resolveCustomerBaseUrl` hostname + `getLocationBranding(...).companyName`; respond with the headers above.
- Tests: 200 text/calendar with DTSTART, 404 draft, 404 foreign wave, 404 missing wave on a multi-time event, the filename header. Commit `CALENDAR.1 — GET /api/public/events/[slug]/calendar.ics`.

### Task 4: Links on every surface

**Files:** Modify `src/lib/race-confirmations.js` (select `duration_minutes` and `locations.timezone` in both loads; `calendarLineHtml(links)`; ctx gains `calendarLinks` built with `eventCalendarLinks({ event: race, wave, zone: zoneOfLocation(race.locations), baseUrl })`; the confirmation and moved default footers append it after the manage line; extras gain `calendar_url`, `google_calendar_url`), `src/app/api/public/event-registrations/[id]/route.js` (select `venue_name, venue_address, duration_minutes, kind` and `locations.timezone`; respond with `calendar: eventCalendarLinks(...)` built on the request origin's tenant base, or null), `src/components/RaceConfirmedPage.jsx` (replace the `data:` ICS with two links from `data.calendar`; nothing when null), `src/app/event/[slug]/confirmed/page.js` (drop `resolveEventIcsIdentity`), `src/components/RaceSignupWidget.jsx` (details block: a calendar row from `race.calendar` — the public GET adds `calendar: { by_wave: { [waveId]: { ics_url, google_url } } }` — shown for a single-time event always, for a multi-time event once `waveId` is chosen), `src/app/api/public/events/[slug]/route.js` (select `duration_minutes`; build `calendar.by_wave`). Delete `src/lib/event-ics.js` + its test (nothing else imports it).
- Tests: confirmation email HTML contains both links and the extras (`race-confirmations` test files: add cases); event-registrations route returns `calendar`; `RaceConfirmedPage` renders the two links / none; widget shows the row for one time and only after a pick for two. Commit `CALENDAR.1 — calendar links in the emails, the confirmed page and the event page`.

### Task 5: Duration on both forms

**Files:** `src/lib/host-events.js` (`duration_minutes: z.number().int().min(5).max(1440).nullable().optional()`), `src/lib/event-save-schemas.js` (both sets), host routes (write/read), host edit page, `src/app/api/events/route.js` + `[id]/route.js` (write/select), `HostEventForm` (a Duration field in Schedule, minutes, placeholder "60" / "120"), `RaceEventForm` (next to the waves), `event-duplicate.js` `DUPLICATE_COLUMNS` + `'duration_minutes'`.
- Tests: schema; host form posts it; route round trip; duplicate carries it. Commit `CALENDAR.1 — duration on the host and staff forms`.

### Task 6: Gates, migration, review, PR

- [ ] Touched suites; full suite alone; mirror; build. Apply 820; advisors. Fresh review → fix pass → push, PR against main, changelog entry, auto-merge.
