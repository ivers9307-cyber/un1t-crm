# Host sessions, duplicate and series (HOSTSERIES.1) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host can give an event several session times, copy an event to a new date in one click, and group dates into a series with one public page.

**Architecture:** Sessions are `race_waves` rows written by one sync helper (`src/lib/event-sessions.js`) that both host routes call. Duplicate is one lib function (`src/lib/event-duplicate.js`) behind a host route and a staff route. A series is a new `event_series` row referenced by `race_events.series_id`; the lib (`src/lib/event-series.js`) builds one by duplicating per date, and a public page under `/event/series/<slug>` lists the published dates. Every host route gates on `getCurrentHost()` and `host_id`; the staff route on `getCurrentUser()` + `races` at the event's studio.

**Tech Stack:** Next.js 16 App Router, supabase-js on the service role, Zod, Vitest (+ jsdom for components), PGlite for the migration test.

**Spec:** `docs/superpowers/specs/2026-11-08-host-event-features-design.md` § 1 and the Builder-check decisions 2, 5, 6.

## Global Constraints

- Branch `host-events-series` in the worktree `/Users/richardivers/code/un1t-crm-hostseries`, off `origin/main`. Migration number: the next after `origin/main`'s highest (817 at writing; re-check before applying).
- Migration applied with the Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj` BEFORE the code merges; `get_advisors` (security) after.
- New table: `enable row level security`, `revoke all on … from anon, authenticated`, no policy. New column on `race_events`: a `comment on column`.
- Host routes: `getCurrentHost()` in the route file (check:route-guards looks there) → 401; a row not the host's → 404 `{ success: false, error: 'Not found' }`. Response shape `{ success, data?, error?, issues? }`.
- Every new `/api` route is registered in `src/lib/openapi.js`.
- Postgres `TIME` comes back `HH:MM:SS`; the form and schema use `HH:MM`; compare after `.slice(0, 5)`.
- `race_waves` has `UNIQUE (race_event_id, start_time)`.
- Public pages live under `/event/` (already on the four allowlists); `RESERVED_EVENT_SLUGS` gains `'series'`.
- Customer-facing copy is operator-editable with a default: the series page headline defaults to the series name, its blurb to "Pick a date".
- "Today" for a public list is the event studio's day (`eventToday` from `src/lib/event-day.js`, or `todayIsoIn(zone)` with the anchor zone as `/h/[slug]/page.js` does).
- No `console.log`; `logError`/`logWarn` from `@/lib/log`. Every supabase write destructures `error`.
- Tests next to the code (`*.test.js` / `*.test.jsx`); run only the touched suites locally (`npx vitest run <paths>`); the thirteen-command CI mirror once before pushing; never the full suite beside a build.
- Commit messages: `HOSTSERIES.1 — <what>`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Two sessions swapped (10:00↔11:00) on save** must not half-apply: the sync returns 409 `duplicate_session_time` and leaves every wave as it was (Task 3 test "a swap is refused whole").
2. **Removing a session that has a live entry** must be refused by name, never cascade the entries away (Task 3 test "refuses to delete a session with live entries").
3. **Duplicating an event whose hero file was replaced since** must not leave the copy pointing at a deleted object: the copy has its own file or a null hero, never the source's URL (Task 5 test "hero copy failure leaves the copy without a hero").
4. **A series whose source event is unpublished** must not 404 the series page: the page lists only published upcoming dates and shows the "no dates yet" state (Task 8 test "lists only published upcoming dates").
5. **A draft copy created by Duplicate must keep the source's registration window relative to the date**: a window that closed the day before the source closes the day before the copy (Task 5 test "shifts the registration window by the date delta").

---

### Task 1: Migration — `event_series` and `race_events.series_id`

**Files:**
- Create: `supabase/migrations/817_event_series.sql`
- Test: `tests/migration-817-event-series.test.js` (PGlite, modelled on `tests/migration-708-registration-moves.test.js`)

**Interfaces:**
- Produces: table `public.event_series (id uuid pk default gen_random_uuid(), host_id uuid null references event_hosts(id) on delete cascade, location_id uuid not null references locations(id) on delete cascade, name text not null, slug text not null unique, headline text null, blurb text null, created_at timestamptz not null default now())`; column `race_events.series_id uuid null references event_series(id) on delete set null`; index `race_events_series_idx on race_events (series_id) where series_id is not null`.

- [ ] **Step 1: Write the failing test** — boot PGlite with minimal `event_hosts`, `locations`, `race_events` tables and the roles `anon`/`authenticated`; run the real file; assert: `event_series` exists with RLS on and no policy; `has_table_privilege('authenticated', 'public.event_series', 'SELECT')` is false; `race_events.series_id` exists; deleting the series row sets `series_id` null on its events; a second series with the same slug fails 23505.
- [ ] **Step 2: Run** `npx vitest run tests/migration-817-event-series.test.js` → FAIL (file missing).
- [ ] **Step 3: Write the migration** with a header comment (WHY/WHAT in the house style), `create table if not exists`, `alter table race_events add column if not exists series_id …`, the index, RLS + revoke, `comment on table` and `comment on column race_events.series_id` ('HOSTSERIES.1: the series this date belongs to; null = none').
- [ ] **Step 4: Run** the test → PASS. Also `npm run -s check:select-columns` → still green (nothing reads the column yet).
- [ ] **Step 5: Commit** `HOSTSERIES.1 — mig 817: event_series + race_events.series_id`.

### Task 2: Host schema — `sessions` replaces the single session; edit transition compares existing waves only

**Files:**
- Modify: `src/lib/host-events.js` (`HostEventSchema`, `computeEditTransition`)
- Test: `src/lib/host-events.test.js`

**Interfaces:**
- Produces: `HostEventSchema` field `sessions: z.array(SessionInputSchema).min(1).max(12)` where `SessionInputSchema = z.object({ id: uuidLike.optional(), start_time: /^\d{2}:\d{2}$/, label: z.string().max(120).nullable().optional(), capacity: z.number().int().min(1).max(100000) }).strict()`, with a `.superRefine` that rejects duplicate `start_time`s (`code 'custom'`, path `['sessions']`, message 'Each session needs its own start time.'). Fields `session_start_time`, `session_capacity`, `session_label` are removed. `HostEventSchema` also gains `series_id: uuidLike.nullable().optional()`.
- Produces: `computeEditTransition(current, changes)` unchanged signature; the wave rule now: re-review only when a wave present in BOTH `current.waves` and `changes.waves` (matched by `id`) has a different `start_time`.

- [ ] **Step 1: Write the failing tests** in `host-events.test.js`: `HostEventSchema` accepts two sessions and rejects (a) zero, (b) thirteen, (c) two at `10:00`, (d) the old `session_start_time` key (strict); `computeEditTransition`: adding a session to a published event keeps `published`; changing an existing session's time → `pending_review`; removing a session keeps `published`.
- [ ] **Step 2: Run** `npx vitest run src/lib/host-events.test.js` → FAIL.
- [ ] **Step 3: Implement** the schema and the transition rule (match waves by id; ignore entries without an id in `changes`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `HOSTSERIES.1 — HostEventSchema takes sessions[]; re-review only on an existing time change`.

### Task 3: Session sync helper

**Files:**
- Create: `src/lib/event-sessions.js`
- Test: `src/lib/event-sessions.test.js` (recording fake db like `registration-move.test.js`'s `fakeDb`)

**Interfaces:**
- Produces: `async function syncEventSessions(db, { eventId, sessions, currentWaves }) → { ok: true, waves: [{ id, start_time, label, capacity }] } | { ok: false, error: 'session_has_entries' | 'duplicate_session_time' | 'write_failed', message, session_time?: 'HH:MM' }`. `currentWaves` are the event's `race_waves` rows (id, start_time, label, capacity, display_order). Order of work: (1) for each current wave absent from `sessions` (by id): count live registrations on it (`race_registrations` where `wave_id = id and status in ('confirmed','pending_payment')`, `{ count: 'exact', head: true }` on the first `.select`) — any > 0 → return `session_has_entries` with that wave's `HH:MM`, BEFORE any write; (2) delete the removed waves; (3) update kept waves (`start_time`, `label`, `capacity`, `display_order` = index); (4) insert new ones. A 23505 on any write → `duplicate_session_time` ("Two sessions would share a start time. Change one time, save, then the other." — a swap is refused whole: no write happens before the pre-check that every kept wave's NEW time is not another kept wave's OLD time). Any other error → `write_failed`.
- Produces: `sessionsFromWaves(waves) → [{ id, start_time: 'HH:MM', label, capacity }]` sorted by `display_order` then `start_time` (for the edit page and the PUT diff).

- [ ] **Step 1: Write the failing tests**: inserts new, updates kept, deletes removed (ops recorded in that order); "refuses to delete a session with live entries" (count 2 → `session_has_entries`, zero writes); "a swap is refused whole" (A 10:00→11:00, B 11:00→10:00 → `duplicate_session_time`, zero writes); a failed read of the count → `write_failed`; `sessionsFromWaves` slices `HH:MM:SS` to `HH:MM`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `HOSTSERIES.1 — syncEventSessions: waves from the host form's sessions`.

### Task 4: Host routes and form take sessions

**Files:**
- Modify: `src/app/api/host/events/route.js` (POST), `src/app/api/host/events/[id]/route.js` (GET/PUT), `src/app/host/(portal)/events/[id]/edit/page.js`, `src/components/host/HostEventForm.jsx`
- Create tests: `src/app/api/host/events/route.test.js`, `src/app/api/host/events/[id]/route.test.js` (mock pattern of `[id]/waitlist/route.test.js`), `src/components/host/HostEventForm.test.jsx` (jsdom)

**Interfaces:**
- Consumes: Task 2 schema; Task 3 `syncEventSessions`, `sessionsFromWaves`.
- Produces: POST inserts the event then calls `syncEventSessions` with `currentWaves: []` (rolls the event back on failure as today); the slug uses `time: input.sessions[0].start_time`. PUT: `changes.waves = input.sessions.filter(s => s.id).map(({ id, start_time }) => ({ id, start_time }))`, `currentForDiff.waves = sessionsFromWaves(current.race_waves)`; after the event update, `syncEventSessions`; a `session_has_entries` / `duplicate_session_time` answer is 409 with the lib's message; PUT also writes `series_id` when present in the body. GET returns `sessions: sessionsFromWaves(race_waves)` and `series_id`.
- Form: state `sessions: [{ key, id, start_time, label, capacity }]` (min 1, max 12; "Add a session" / remove buttons; remove disabled on the only row); `buildBody()` emits `sessions` (capacity as int) and no `session_*` keys; the edit page passes `initial.sessions = sessionsFromWaves(event.race_waves)` and `initial.series_id`.

- [ ] **Step 1: Write the failing route tests**: POST with two sessions calls `syncEventSessions` once with both and answers 200 `{ id }`; PUT on a published event that only adds a session answers `status 'published', reReview false`; PUT that changes an existing time answers `pending_review`; PUT whose sync answers `session_has_entries` → 409 with the message; GET returns `sessions` with `HH:MM`.
- [ ] **Step 2: Write the failing form test**: renders with two initial sessions, "Add a session" adds a third row, submit posts a body whose `sessions` has three entries and no `session_start_time` key.
- [ ] **Step 3: Run** both → FAIL. **Step 4: Implement** routes, edit page and form. **Step 5: Run** → PASS; also `npx vitest run src/lib/host-events.test.js`.
- [ ] **Step 6: Commit** `HOSTSERIES.1 — host create/edit write sessions[]; the form lists them`.

### Task 5: Duplicate lib

**Files:**
- Create: `src/lib/event-duplicate.js`, `src/lib/event-duplicate.test.js`

**Interfaces:**
- Produces: `async function duplicateEvent(db, { sourceId, raceDate, seriesId = null, name = null }) → { ok: true, event: { id, slug } } | { ok: false, error: 'not_found' | 'load_failed' | 'write_failed', message }`. Reads the source with `DUPLICATE_COLUMNS` (exported: every operator column — `kind, name, description, location_id, host_id, allowed_team_sizes, capacity_mode, member_pricing_enabled, members_only, member_fee_cents, non_member_fee_cents, payment_currency, registration_opens_at, registration_closes_at, hero_image_url, accent_hex, venue_name, venue_address, confirmation_email_subject, confirmation_email_intro, reminder_email_subject, reminder_email_intro, moved_email_subject, moved_email_intro, waitlist_email_subject, waitlist_email_intro, gap_email_subject, gap_email_intro, entry_policy, find_team, charity_enabled, charity, tv_logos, shared, staff_required, sending_location_id, race_date` + `race_waves ( start_time, label, capacity, display_order )`); verify each name exists in `supabase/migrations` before listing it (`check:select-columns` will fail a phantom). Writes: the event with `status 'draft'`, `active true`, `race_date: raceDate`, `series_id: seriesId`, `name: name ?? source.name`, slug `uniqueEventSlug(eventSlug({ place: venue_name, date: raceDate, time: first wave HH:MM, name }))`, `registration_opens_at/closes_at` shifted by `shiftByDays(iso, deltaDays)` (exported pure: `deltaDays = (Date.UTC(new) − Date.UTC(source)) / 86_400_000`, add `deltaDays × 86_400_000` ms; null stays null), `charity` with `raised_cents`/totals keys removed if present (read `CharitySettingsSchema` in `src/lib/charity-donations.js` for the key names; copy only keys it defines), `submitted_at/reviewed_at/rejected_reason` null; then the waves (same times, labels, capacities, order); then the hero: if `hero_image_url` contains `/race-hero/<sourceId>/hero.<ext>`, `db.storage.from('branding').copy(\`race-hero/${sourceId}/hero.${ext}\`, \`race-hero/${newId}/hero.${ext}\`)` and set `hero_image_url` to `getPublicUrl` of the new path; on a copy error → `hero_image_url: null` + `logWarn` (never fails the duplicate). A failed wave insert deletes the new event and returns `write_failed`.

- [ ] **Step 1: Write the failing tests**: copies the listed columns and all waves; status draft; slug derived from the new date; "shifts the registration window by the date delta" (source 2026-11-14 closes 2026-11-13T18:00Z, copy 2026-12-12 → closes 2026-12-11T18:00Z); "hero copy failure leaves the copy without a hero" (storage.copy returns `{ error }` → `hero_image_url` null, event still created); a wave insert failure deletes the event and returns `write_failed`; unknown source → `not_found`; `shiftByDays(null, 7)` → null.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm run -s check:select-columns`.
- [ ] **Step 5: Commit** `HOSTSERIES.1 — duplicateEvent: a draft copy on a new date`.

### Task 6: Duplicate routes and buttons

**Files:**
- Create: `src/app/api/host/events/[id]/duplicate/route.js` (+ `route.test.js`), `src/app/api/events/[id]/duplicate/route.js` (+ `route.test.js`), `src/components/DuplicateEventButton.jsx` (+ `.test.jsx`)
- Modify: `src/app/host/(portal)/events/[id]/page.js` (button beside Export CSV), `src/app/(members)/events/page.js` (a "Duplicate" action in both action cells, next to Edit), `src/lib/openapi.js`

**Interfaces:**
- Consumes: Task 5 `duplicateEvent`.
- Produces: both routes `POST` with body `{ race_date: 'YYYY-MM-DD' }` (Zod, `validateBody`), answer `{ success: true, data: { id, slug } }`; host: own event or 404; staff: `getCurrentUser` → `hasPermissionForLocation(user, race.location_id, 'races')` and `hasRoleAtLocation(user, race.location_id, MANAGER_ROLES)` → else 403, `assertLocationAccessOr404`. `DuplicateEventButton({ eventId, apiUrl, editHrefFor: (id) => string, dark = false })`: a date input (default: source date + 7 days, passed as `defaultDate`) and a Duplicate button; on success `router.push(editHrefFor(id))`; errors inline. Host page: `apiUrl=/api/host/events/<id>/duplicate`, `editHrefFor = (id) => /host/events/${id}/edit`, `dark`. Staff list: `apiUrl=/api/events/<id>/duplicate`, `editHrefFor = (id) => /events/${id}/edit`.

- [ ] **Step 1: Failing route tests**: host: 401 without a session; 404 for another host's event; 200 with `{ id, slug }`; 400 for a bad date. Staff: 403 for a member without the role; 200 for a manager.
- [ ] **Step 2: Failing component test**: renders the date input with the default, posts `{ race_date }` to `apiUrl`, navigates to `editHrefFor(id)` (mock `next/navigation`).
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** routes, component, page wiring, openapi entries. **Step 5: Run** → PASS; `npm run -s check:route-guards`.
- [ ] **Step 6: Commit** `HOSTSERIES.1 — Duplicate: host and staff routes and button`.

### Task 7: Series lib and host routes

**Files:**
- Create: `src/lib/event-series.js`, `src/lib/event-series.test.js`, `src/app/api/host/events/[id]/series/route.js` (+ test), `src/app/api/host/series/route.js` (+ test), `src/app/api/host/series/[id]/route.js` (+ test)
- Modify: `src/lib/event-slug.js` (`RESERVED_EVENT_SLUGS` adds `'series'`), `src/lib/openapi.js`

**Interfaces:**
- Consumes: Task 5 `duplicateEvent`.
- Produces in `event-series.js`: `seriesSlugBase(name)` (reuse `placeToken`-style slugging from `event-slug.js`); `async uniqueSeriesSlug(db, base)` (probe `event_series.slug`; a failed probe reads as taken; `-2, -3…`); `async createSeriesFromEvent(db, { sourceId, dates: ['YYYY-MM-DD', …] (1–24, unique, none equal to the source date), name }) → { ok: true, series: { id, slug }, created: [{ id, slug, race_date }] } | { ok: false, error: 'not_found' | 'load_failed' | 'write_failed' | 'already_in_series', message }`: reads the source (`id, host_id, location_id, race_date, series_id`), refuses a source already in a series, inserts the series (`host_id`, `location_id`, `name`, slug), stamps `series_id` on the source, duplicates once per date with `seriesId` (a failure after some copies returns `write_failed` with `created` so far listed in `message`; nothing is rolled back: the host sees the drafts). `async addEventToSeries(db, { eventId, seriesId })` (same host_id on both or `not_found`). `async loadSeriesPage(db, { slug, today }) → { series, dates: [...events with EVENT_COLS as in /h/[slug]/page.js], zone } | null` (published, active, `race_date >= today`, ordered by date then first wave time). `async listHostSeries(db, hostId) → [{ id, name, slug, headline, blurb, upcoming_count }]`.
- Routes: `POST /api/host/events/[id]/series` body `{ name (1–120), dates: string[] }` → `createSeriesFromEvent`; `GET /api/host/series` → `listHostSeries`; `PATCH /api/host/series/[id]` body `{ headline?: ≤120|null, blurb?: ≤500|null, name?: 1–120 }` (own series or 404).

- [ ] **Step 1: Failing lib tests**: `uniqueSeriesSlug` suffixes a taken slug and treats a failed probe as taken; `createSeriesFromEvent` refuses `already_in_series`, refuses a date equal to the source's, creates the series then stamps the source then duplicates each date with the series id (ops order), returns `write_failed` naming the created ids when the third duplicate fails; `loadSeriesPage` filters published + upcoming and returns null for an unknown slug; `RESERVED_EVENT_SLUGS.has('series')`.
- [ ] **Step 2: Failing route tests**: 401/404/200 for the three routes; PATCH trims and nulls empty strings.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** (+ openapi). **Step 5: Run** → PASS; `check:route-guards`, `check:select-columns`.
- [ ] **Step 6: Commit** `HOSTSERIES.1 — event series: lib and host routes`.

### Task 8: Public series page

**Files:**
- Create: `src/app/event/series/[slug]/page.js`, `src/components/SeriesDatesPage.jsx` (server component), `src/lib/event-series-page.test.js` (pure helpers: card building and copy defaults)
- Modify: `src/lib/event-series.js` (add `seriesPageCopy(series) → { headline: series.headline || series.name, blurb: series.blurb || 'Pick a date' }`)

**Interfaces:**
- Consumes: Task 7 `loadSeriesPage`, `seriesPageCopy`; `toBrowseCard`/`isEventSoldOut` from `src/lib/public-events.js`; `pickHostBranding`-style hero: the newest date's `hero_image_url`/`accent_hex`.
- Produces: `/event/series/<slug>` renders (dark, Poppins like `/event/[slug]`): hero (image of the first upcoming date that has one, the series headline, the blurb), then a card per date (`toBrowseCard`, linking to `/event/<slug>` unless closed), or "No dates are open right now." when none. `generateMetadata`: title `${headline} — ${org brand}` (the org brand via `getOrgBrandName` of the location's org, as `/h/[slug]` does), description = blurb. `notFound()` for an unknown slug.

- [ ] **Step 1: Failing tests**: `seriesPageCopy` defaults; "lists only published upcoming dates" (a draft date and a past date are absent from the cards; a series with none still renders the empty state — test via the pure card builder `seriesCards(dates, { now, zone })` that wraps `toBrowseCard`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** page + component. **Step 4: Run** → PASS; `npm run build` once (new page: Turbopack resolution).
- [ ] **Step 5: Commit** `HOSTSERIES.1 — /event/series/<slug>: one page, every date`.

### Task 9: Host portal — make a series, series list, dashboard and public grouping

**Files:**
- Create: `src/components/host/HostSeriesActions.jsx` (+ test), `src/components/host/HostSeriesList.jsx`
- Modify: `src/app/host/(portal)/events/[id]/page.js` (the series action beside Duplicate; a "Part of series <name> · view page" line when `series_id` is set), `src/app/host/(portal)/page.js` (a **Series** section above "Your events": name, upcoming count, public link, inline headline/blurb edit via PATCH), `src/components/host/HostEventForm.jsx` (a "Series" select in Schedule when the host has series: `GET /api/host/series`; emits `series_id`), `src/app/h/[slug]/page.js` + `src/components/host/HostPublicEvents.jsx` (cards grouped: `groups: [{ seriesName|null, seriesSlug|null, cards }]`, a series group shows its name as a sub-heading and a "All dates →" link to `/event/series/<slug>`; events with no series render as today)

**Interfaces:**
- Consumes: Task 7 routes; `HostEventForm` from Task 4.
- Produces: `HostSeriesActions({ eventId, eventName, raceDate, seriesId, seriesName, seriesSlug })`: when `seriesId` is null, a **Make this a series** disclosure with a name field (default `eventName`), a date list (add/remove rows; helpers "+ weekly ×4", "+ monthly ×3" that append dates from `raceDate`), posting to `/api/host/events/<id>/series`; on success shows the public link and refreshes. `HostPublicEvents` gains `groups` (keeps `cards` for callers that pass only cards). `/h/[slug]/page.js`'s `EVENT_COLS` adds `series_id, series:event_series ( id, name, slug )`.

- [ ] **Step 1: Failing tests**: `HostSeriesActions` posts `{ name, dates }` with the weekly helper producing four dates 7 days apart from `raceDate`; `HostPublicEvents` renders a group heading and the "All dates" link for a series group and plain cards for the null group.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npx vitest run src/components/host src/app/h` and `npm run -s check:select-columns`.
- [ ] **Step 5: Commit** `HOSTSERIES.1 — host portal: make a series, series list, grouped public cards`.

### Task 10: Gates, migration apply, PR

- [ ] **Step 1:** `npm test -- src/lib/host-events.test.js src/lib/event-sessions.test.js src/lib/event-duplicate.test.js src/lib/event-series.test.js src/app/api/host src/app/api/events/\[id\]/duplicate src/components/host src/components/DuplicateEventButton.test.jsx tests/migration-817-event-series.test.js` → all green.
- [ ] **Step 2:** the CI mirror (`npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths`) → green; `npm run build` → green (new page + routes).
- [ ] **Step 3:** Apply `817_event_series.sql` with `apply_migration` on `iyvtbjjxdggiadzwwvdj` (confirm the project via `list_projects`); `get_advisors` type security → no new finding.
- [ ] **Step 4:** Push `host-events-series`, `gh pr create --base main`, then add `docs/changelog/entries/<PR>.md` (one row, `| #<PR> | HOSTSERIES.1 — … | 2026-11-08. … |`) and push again after confirming the PR is still open.
