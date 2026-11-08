# HOSTPAGE.2 — Public Page Extras and Ratings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host page that sells (about, photos, testimonials, past events) and post-event ratings from attendees, shown as social proof once the host has three or more.

**Architecture:** Five new `event_hosts` columns edited from the existing `HostListPageEditor` (photos upload through a host-gated route into the `branding` bucket); `/h/<slug>` gains the sections as one server-rendered component fed by a pure lib. Ratings are a table written by a public token page the morning after a host event, requested by an **arm** of the hourly `event-reminders` cron on its own daily slot and heartbeat row; the host hides individual ratings from their portal event page; the public summary appears at 3+ public ratings.

**Tech Stack:** Next.js 16 App Router, supabase-js (service role), Zod, HMAC tokens (`node:crypto`), vitest + RTL (jsdom) + `react-dom/server`, PGlite migration tests.

**Spec:** `docs/superpowers/specs/2026-11-08-host-event-features-design.md` §6 (+ Builder-check decision 7: the rating request sends like a reminder; and the adopted note: the rating arm rides `event-reminders`' 09:00 daily slot).

## Global Constraints

- Host routes gate on `getCurrentHost()` + `host_id` ownership (404 otherwise); public token routes verify the token first and answer 404 on any failure; nothing public reads a draft event.
- `event_hosts`, `race_events`, `race_registrations` have no client privilege: new columns need `-- grant: none`. New tables state `alter table … enable row level security; revoke all on public.<t> from anon, authenticated;` (copy mig 817).
- Zone maths only via `@/lib/location-time` / `@/lib/event-day` (`eventToday`, `addDaysISO`, `dayStrIn`). "The morning after" = `race_date === addDaysISO(eventToday(ev, nowMs), -1)` judged per event on its studio's clock; the arm's slot is `DAILY_SLOTS['event-rating-requests'] = { hour: 9, rides: 'event-reminders' }` and `src/lib/cron-daily-slot.test.js`'s `LEGACY_SCHEDULE` + the arms list gain the entry.
- A cron arm stamps ONLY its own heartbeat row (`EVENT_RATING_REQUESTS_HEARTBEAT = 'event-rating-requests'`, mig 824 applied AFTER deploy), only on a tick that took one of its slots (`slotTickStampable`) and returned a clean outcome, under its own try/catch; the parent `event-reminders` stamp and status are never changed by the arm.
- Transactional sending exactly like reminders: identity `resolveEventCommsLocation` (fail-open to `ev.location_id`), consent `transactionalEmailSuppression(contact)` with `TRANSACTIONAL_CONSENT_SELECT`-shaped embed, copy through `resolveEventEmail({ kind: 'rating' })` so `race_events.rating_email_subject/intro` are operator copy with defaults, `sendTransactionalEmail({ tag: 'event-rating-request' })`, claim-before-send on `event_rating_requests (registration_id unique)`; a failed send KEEPS the claim (one ask per entry, ever).
- Hosts' events only: an event with `host_id IS NULL` never gets a request (spec non-goal) and a rating token for it verifies but the route answers 404.
- The branding bucket guard (`tests/branding-bucket-guard.test.js`) pins every writer: the photos route goes in `WRITERS` as `'getCurrentHost'`, imports `BRANDING_BUCKET_MAX_BYTES` from `./branding-media`… (read the guard's "each writer" tests before writing the route), and only writes under `host-photos/<host id>/`.
- `/event/rate/<token>` lives under `/event/` (the four public allowlists are untouched); `RESERVED_EVENT_SLUGS` gains `'rate'`.
- Nothing public renders a location name; the public summary shows a first name only, never an email.
- Register every new route in `src/lib/openapi.js`. `check:select-columns` and `check:location-scoping` green (public token routes get `EXEMPT` entries: the token is the scoping, as `/api/unsubscribe/host/[token]`).

## Review Focus

1. A rating link opened twice, or by someone forwarding the email → the second POST is refused (unique on `registration_id`) and the page shows what was given; the token cannot be used for another registration. (Task 5 route tests.)
2. A host event cancelled (`active=false`) or deleted after the morning-after tick → no request goes out; a late token on a deleted event is 404. (Task 4 runner test: `active=true` filter; Task 5: 404.)
3. A reminder-style opt-out (`email_administrative=false`, bounced/complained) → no email, claim kept, counted `skipped`. (Task 4 test.)
4. A host with exactly 2 public ratings, or 3 ratings of which one hidden → no public summary; 3 public → average to one decimal and the 3 newest comments; a rating with an empty comment contributes to the average but not the comment list. (Task 2 `ratingSummary` tests.)
5. A photo upload of a 6 MB JPEG or a GIF → 400 before Storage; a `DELETE` with a URL outside `host-photos/<this host>/` → 404, nothing removed. (Task 3 tests.)

---

### Task 1: Migration 823 — schema for the page extras and ratings

**Files:**
- Create: `supabase/migrations/823_host_page_extras_ratings.sql`, `tests/migration-823-host-page-extras-ratings.test.js`

**Interfaces (Produces):**
- `event_hosts`: `about_text text`, `photos jsonb`, `testimonials jsonb`, `show_past_events boolean not null default true`, `show_ratings boolean not null default true`.
- `race_events`: `rating_email_subject text`, `rating_email_intro text`.
- `public.event_ratings` (`id uuid pk default gen_random_uuid()`, `race_event_id uuid not null references race_events(id) on delete cascade`, `registration_id uuid not null unique references race_registrations(id) on delete cascade`, `host_id uuid not null references event_hosts(id) on delete cascade`, `contact_id uuid references contacts(id) on delete set null`, `rating smallint not null check (rating between 1 and 5)`, `comment text check (comment is null or char_length(comment) <= 600)`, `is_public boolean not null default true`, `created_at timestamptz not null default now()`); index `(host_id, is_public, created_at desc)`; index `(race_event_id)`.
- `public.event_rating_requests` (`registration_id uuid primary key references race_registrations(id) on delete cascade`, `race_event_id uuid not null references race_events(id) on delete cascade`, `sent_at timestamptz not null default now()`); index `(race_event_id)`.
- Both tables: RLS on, `revoke all … from anon, authenticated`; comments; header `-- grant: none (event_hosts/race_events/race_registrations have no client privilege; the two tables are service role only)`.

- [ ] **Step 1:** PGlite test (copy `tests/migration-821-event-page-views.test.js`): schema stubs for `event_hosts(id uuid pk)`, `race_events(id uuid pk)`, `race_registrations(id uuid pk)`, `contacts(id uuid pk)`, roles `anon`/`authenticated`; asserts: the five `event_hosts` columns with their defaults (`show_past_events` default `true`), a rating of 6 → `23514`, a 601-char comment → `23514`, a second rating for the same registration → `23505`, both tables have 0 client privileges and `relrowsecurity`, re-applies cleanly.
- [ ] **Step 2:** Run → FAIL (ENOENT). **Step 3:** Write the migration. **Step 4:** Run the test + `npm run -s check:select-columns` → PASS.
- [ ] **Step 5:** Apply via Supabase MCP (`list_projects` → `iyvtbjjxdggiadzwwvdj`), `get_advisors` (security) → no new ERROR; verify privileges with `execute_sql` as in mig 821.
- [ ] **Step 6:** Commit `HOSTPAGE.2 — mig 823: host page extras, rating copy, event_ratings and event_rating_requests`.

### Task 2: `src/lib/host-page-extras.js` + `src/lib/event-ratings.js` (pure)

**Files:**
- Create: `src/lib/host-page-extras.js` (+ `.test.js`), `src/lib/event-ratings.js` (+ `.test.js`)
- Modify: `src/lib/event-slug.js` (`RESERVED_EVENT_SLUGS` + `'rate'`), `src/lib/event-slug.test.js` (one assertion)

**Interfaces (Produces):**
- `host-page-extras.js`: `HOST_PHOTOS_MAX = 12`, `HOST_TESTIMONIALS_MAX = 6`; `HostPhotosSchema = z.array(z.object({ url: z.string().url().max(2000), caption: z.string().trim().max(120).optional().nullable() })).max(12)`; `HostTestimonialsSchema = z.array(z.object({ quote: z.string().trim().min(1).max(400), author: z.string().trim().max(80).optional().nullable() })).max(6)`; `hostPageExtras(host)` → `{ about: string (trimmed, ≤2000, '' when null), photos: [{url, caption}] (schema-valid entries only, in order, ≤12), testimonials: [{quote, author}] (valid only, ≤6), showPastEvents: boolean (default true), showRatings: boolean (default true) }`; `pastEventCards(rows, today, { max = 24 } = {})` → rows with `race_date < today` (string compare on ISO dates), newest first, sliced, mapped to `{ id, name, dateLabel: eventDateLong(race_date) }`.
- `event-ratings.js`: `RATING_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000`; `signRatingToken({ registrationId, eventId }, secret, { nowMs })` → `payload.hmac` (payload = base64url JSON `{ r, e, iat }`, HMAC-SHA256 like `entry-manage-tokens.js`); `verifyRatingToken(token, secret, { nowMs, ttlMs })` → `{ registrationId, eventId }` or `null` (bad shape, bad sig, expired, no secret); `ratingUrl({ registrationId, eventId, baseUrl })` → `${baseUrl}/event/rate/${token}` or `null` without secret (`SUPABASE_SERVICE_ROLE_KEY`, as `entryManageUrl`); `ratingSummary(rows, { minPublic = 3, comments = 3, nowMs } = {})` → `null` unless ≥3 rows with `is_public === true`, else `{ average: Number(avg.toFixed(1)), count, comments: [{ rating, comment, author (first_name or ''), created_at }] }` (public rows with non-empty `comment`, newest first, ≤3); `ratingRequestDefaults({ eventName, hostName, rateUrl })` → `{ subject: `How was ${eventName}?`, introHtml: `<p>Thanks for coming to <strong>${escapeHtml(eventName)}</strong>. Would you tell ${escapeHtml(hostName)} how it went? It takes ten seconds.</p>`, afterInfoHtml: a button linking `rateUrl` labelled `Rate ${eventName}` }` (use `escapeHtml` from `@/lib/event-email`).

- [ ] **Step 1:** Tests: `hostPageExtras` drops an invalid photo and a 401-char quote, caps at 12/6, defaults the booleans, `''` about; `pastEventCards` excludes today and future, orders newest first, caps 24. Tokens round-trip, reject a tampered signature, another secret, an expired `iat` (31 days), and `ratingUrl` is null without a secret. `ratingSummary`: 2 public → null; 3 public (one hidden extra) → average `4.3` from `[5,4,4]`, count 3, comments exclude empty and hidden, newest first, author is `first_name` only. `RESERVED_EVENT_SLUGS.has('rate')`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS (`src/lib/event-slug.test.js` included).
- [ ] **Step 5:** Commit `HOSTPAGE.2 — host page extras and rating libs (schemas, tokens, summary, request copy)`.

### Task 3: Editor + routes for the extras; photo upload/delete

**Files:**
- Modify: `src/app/api/host/list-page/route.js` (COLS + schema: `about_text` ≤2000, `photos: HostPhotosSchema`, `testimonials: HostTestimonialsSchema`, `show_past_events: z.boolean()`, `show_ratings: z.boolean()`; an array field is written as given, `''` rule unchanged for strings), `src/app/api/host/list-page/route.test.js` (two tests), `src/components/host/HostListPageEditor.jsx` (a "Page extras" block: About textarea, show toggles, testimonials list with add/remove, photos grid with upload + caption + remove), `src/components/host/HostSignupPageCard.jsx` (pass the new fields through `copy`; check how `copy` is loaded), `src/lib/openapi.js` (`HostListPageCopy`/`HostListPageUpdate` + the two photo routes), `tests/branding-bucket-guard.test.js` (`WRITERS['src/app/api/host/list-page/photos/route.js'] = 'getCurrentHost'`)
- Create: `src/app/api/host/list-page/photos/route.js` (+ `.test.js`), `src/components/host/HostListPageEditor.extras.test.jsx`

**Interfaces (Produces):**
- `POST /api/host/list-page/photos` multipart `file` → PNG/JPEG/WebP, ≤ `HOST_PHOTO_MAX_BYTES = 5 * 1024 * 1024` (export it; also assert `≤ BRANDING_BUCKET_MAX_BYTES` and the types ⊆ `BRANDING_BUCKET_MIME_TYPES`), stored at `host-photos/<host id>/<crypto.randomUUID()>.<ext>` (`upsert: false`), appends `{ url, caption: null }` to `event_hosts.photos` (refuses with 400 `photos_full` at 12) → `{ success: true, data: { url, photos } }`. `DELETE /api/host/list-page/photos?url=<url>` → the url must be in the host's `photos` AND resolve to a path under `host-photos/<host id>/` (else 404); removes the object (best-effort) and the entry → `{ success: true, data: { photos } }`.
- Editor: photos upload uses `compressImageForUpload` + `parseUploadResponse` from `@/lib/landing-media-upload`; save sends the full values incl. `photos`, `testimonials`, booleans.

- [ ] **Step 1:** Route tests (fakeDb; mock `getCurrentHost`; a fake `db.storage.from('branding')` with `upload`/`remove`): 401; a GIF → 400; 6 MB → 400; 12 photos → 400 `photos_full`; success appends and returns `photos`; DELETE of a foreign URL → 404 and no `remove`; DELETE of an own URL removes and rewrites. list-page tests: PATCH with `photos`/`testimonials`/`about_text`/`show_ratings:false` writes them; an invalid testimonial (401 chars) → 400. Editor test (jsdom): renders the About field and testimonial inputs from `initial`, adding a testimonial and saving PATCHes `testimonials` with the new entry; upload posts to `/api/host/list-page/photos`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run those + `tests/branding-bucket-guard.test.js` + `npm run -s check:location-scoping` → PASS.
- [ ] **Step 5:** Commit `HOSTPAGE.2 — page extras in the editor and the list-page route; host photo upload and delete`.

### Task 4: The rating request arm (runner + cron wiring + mig 824)

**Files:**
- Create: `src/lib/event-rating-requests.js` (+ `.test.js`), `supabase/migrations/824_event_rating_requests_heartbeat.sql`, `tests/migration-824-event-rating-requests-heartbeat.test.js`
- Modify: `src/lib/cron-daily-slot.js` (`DAILY_SLOTS['event-rating-requests'] = { hour: 9, rides: 'event-reminders' }`), `src/lib/cron-daily-slot.test.js` (`LEGACY_SCHEDULE` entry + the arms list `['event-rating-requests', 'qualification-digest', 'roster-runway']`), `src/lib/cron-arm-health.js` (`EVENT_RATING_REQUESTS_HEARTBEAT = 'event-rating-requests'`, `ratingRequestsArmHealthy(outcome)` = outcome object with `request_read_failed === 0` and `claim_failed === 0`, header paragraph), `src/app/api/cron/event-reminders/route.js` (after the reminders: `gateDailySlot(db, 'event-rating-requests', { nowMs, module: 'event-reminders' })`; when it holds slots, `runRatingRequests({ db, nowMs, isDue })` inside try/catch; stamp the arm's row only when `slotTickStampable(armGate) && ratingRequestsArmHealthy(outcome)`; the parent's stamp/status unchanged; response `data.rating_requests = outcome`), `src/app/api/cron/event-reminders/route.test.js` (two tests), `src/lib/event-email.js` JSDoc kind list (+ `'rating'`)

**Interfaces (Produces):**
- `runRatingRequests({ db, nowMs = Date.now(), isDue, baseUrlFor })` → `{ events, sent, skipped, request_read_failed, claim_failed }`. Candidates: `race_events` with `race_date in [UTC day -2 … 0]`, `active=true`, `status='published'`, `host_id not null`, `kind != 'lead_gen'`, select `id, name, slug, race_date, location_id, host_id, sending_location_id, accent_hex, hero_image_url, rating_email_subject, rating_email_intro, host:event_hosts!host_id ( id, name, anchor_location_id ), locations:location_id ( id, name, is_host_anchor, timezone )`; keep those where `isDue(ev.location_id)` and `ev.race_date === addDaysISO(eventToday(ev, nowMs), -1)`. Per event: confirmed registrations paged (`id, contact_id, contact:contact_id ( id, email, first_name, name, email_status, contact_preferences ( email_administrative ) )`), pre-skip via `event_rating_requests` lookups in chunks of 200, then per registration: claim (`insert { registration_id, race_event_id }`; `23505` → skipped; other error → `claim_failed++`, skipped), `transactionalEmailSuppression(contact)` → skipped (claim kept), build `rateUrl = ratingUrl({ registrationId, eventId, baseUrl: await resolveCustomerBaseUrl(db, ev.location_id) })` (resolver failure → `getAppUrl()` origin), `resolveEventEmail({ db, kind: 'rating', race: ev, contact, extras: { event_name, host_name, rate_url }, defaults: ratingRequestDefaults(...)` spread into the shell slots via `buildEventEmailShell`-compatible keys `{ subject, heading: eventName, introHtml, afterInfoHtml }`, brandLocationId: commsLocationId })`, `sendTransactionalEmail({ to, subject, htmlBody, contactId, locationId: commsLocationId, tag: 'event-rating-request' })` → `sent++`; any throw per registration → `logError`, continue. Mig 824: row `('event-rating-requests', now(), 86400, 21600, notes)` + self-check `DO` block, "apply RIGHT AFTER the deploy".

- [ ] **Step 1:** Runner tests (fakeDb; mocks: `@/lib/postmark`, `@/lib/event-comms-location` (resolver → `{ id: 'L1' }`), `@/lib/tenant-host`, `@/lib/app-url`, `@/lib/log`; `SUPABASE_SERVICE_ROLE_KEY` set): a host event dated yesterday on Europe/Dublin at `nowMs = 2026-07-19T08:05:00Z` sends one email per confirmed entry with a `/event/rate/` link whose token verifies to `{ registrationId, eventId }`, subject `How was Mobility Workshop?`; `isDue` false → nothing; a UN1T event (`host_id null`) is excluded by the query filter (assert `.not('host_id','is',null)` or `.neq`-equivalent appears in ops); an opted-out contact → skipped, claim inserted, no send; a `23505` claim → skipped without send; a claim error → `claim_failed 1`, no send; operator subject `rating_email_subject` wins. Cron route tests: the arm runs only when its own gate holds a slot (mock `gateDailySlot` per `cronName`), the arm's throw does not change the parent's 200/stamp, the arm stamps `'event-rating-requests'` only on a clean outcome. Slot test updates; mig 824 PGlite test (copy mig 822's).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run the new tests + `src/lib/cron-daily-slot.test.js` + `src/app/api/cron/event-reminders/route.test.js` + `npm run -s check:select-columns` → PASS; `grep -L stampHeartbeat src/app/api/cron/*/route.js` unchanged.
- [ ] **Step 5:** Commit `HOSTPAGE.2 — the rating request arm on event-reminders' 09:00 slot, its heartbeat row (mig 824, after deploy)`.

### Task 5: The public rating page and its routes

**Files:**
- Create: `src/app/api/public/event-rating/[token]/route.js` (+ `.test.js`), `src/app/event/rate/[token]/page.js`, `src/components/EventRatingPage.jsx` (+ `.test.jsx`)
- Modify: `scripts/check-location-scoping.mjs` (EXEMPT for the route: `race_events` and `race_registrations` reached only through the HMAC rating token naming one registration + event), `src/lib/openapi.js`

**Interfaces (Produces):**
- `GET /api/public/event-rating/[token]` → rate limit `rating:${ip}` 60/5 min; `verifyRatingToken(token, SUPABASE_SERVICE_ROLE_KEY)` else 404; reads `race_registrations` `id, status, race_event_id, race:race_event_id ( id, name, race_date, host_id, active, host:event_hosts!host_id ( name ) )` by id; 404 unless the row exists, `race_event_id === claim.eventId`, `race.host_id` set and `race.active`; reads `event_ratings` by `registration_id` (maybeSingle) → `{ success: true, data: { event: { name, date_label: eventDateLong(race_date), host_name }, existing: { rating, comment } | null } }`.
- `POST …` body `{ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(600).optional() }`; same token/row checks; insert `{ race_event_id, registration_id, host_id: race.host_id, contact_id, rating, comment: comment || null }`; `23505` → 409 `{ code: 'already_rated' }`; → `{ success: true, data: { rating, comment } }`.
- `EventRatingPage({ token })` (client): loads GET; five star buttons (`aria-label` "1 star" … "5 stars"), optional textarea (600), submit; shows "Thanks, you gave N stars" after success or when `existing`; 404 → "This link has expired or isn't valid."; page file mirrors `/event/entry/[token]/page.js` (noindex, no-referrer).

- [ ] **Step 1:** Route tests: 404 for a bad token, a mismatched event id, a UN1T event (`host_id null`), an inactive event; GET answers `existing` when rated; POST stores and returns; a second POST → 409; rating 6 → 400. Component tests (jsdom): renders stars + submits `rating 4` with the comment; shows the thanks state from `existing`; the invalid-link copy on 404.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run + `npm run -s check:location-scoping` + `npm run -s check:route-guards` → PASS.
- [ ] **Step 5:** Commit `HOSTPAGE.2 — /event/rate/<token>: one rating per entry, 30-day link`.

### Task 6: Host portal — ratings list with Hide; public `/h/<slug>` sections

**Files:**
- Create: `src/app/api/host/events/[id]/ratings/route.js` (+ `.test.js`), `src/app/api/host/events/[id]/ratings/[ratingId]/route.js` (+ `.test.js`), `src/components/host/HostEventRatings.jsx` (+ `.test.jsx`), `src/components/host/HostPublicExtras.jsx` (+ `.test.jsx`)
- Modify: `src/app/host/(portal)/events/[id]/page.js` (`<HostEventRatings eventId=… />` after the Signups card), `src/app/h/[slug]/page.js` (HOST_COLS + the five columns; load past events (`race_date < today`, published, active, ≤24, newest first: `id, name, race_date`) and public ratings (`event_ratings` by `host_id`, `is_public=true`, `rating, comment, created_at, contact:contact_id ( first_name )`, newest first, ≤200) in `Promise.all` with the existing loads; render `<HostPublicExtras …>` with `about` between the header and the events → restructure: `HostPublicEvents` keeps hero + events; `HostPublicExtras` renders `about` (prop `slot="about"`) above and the rest below — simplest: two components `HostAbout` (inline in HostPublicExtras as a named export) and `HostPublicExtras` for photos/testimonials/ratings/past), `src/lib/openapi.js`, `src/components/host/HostEventForm.jsx` + `src/lib/host-events.js` (`HostEventSchema`: `rating_email_subject` ≤300, `rating_email_intro` ≤5000) + `src/app/api/host/events/[id]/route.js` (select + update) + `src/app/host/(portal)/events/[id]/edit/page.js` (select) — the "Rating request" subject/intro fields in the email section

**Interfaces (Produces):**
- `GET /api/host/events/[id]/ratings` → own event or 404; `{ success: true, data: { ratings: [{ id, rating, comment, is_public, created_at, author }], summary: ratingSummary(rows) } }` (`author` = contact first name).
- `PATCH /api/host/events/[id]/ratings/[ratingId]` body `{ is_public: z.boolean() }` → the rating must belong to the event (and the event to the host) else 404; `.update().eq('id').eq('race_event_id').select('id')` and 404 on zero rows → `{ success: true, data: { id, is_public } }`.
- `HostEventRatings({ eventId })` (client): loads the list; each row shows stars, comment, author, date and a **Hide**/**Show** button calling the PATCH; empty → "No ratings yet. Attendees are asked the morning after the event."
- The `/h/<slug>` page reads ratings only when `hostPageExtras(host).showRatings` and past events only when `showPastEvents` (a toggle off means no read and no section).
- `HostAbout({ text })` → null when empty, else a `<section>` with the text in paragraphs (split on blank lines). `HostPublicExtras({ photos, testimonials, ratingSummary, pastEvents, accentHex })` → sections in order: photos grid (`<figure>` + `<figcaption>` when a caption), "What people say" (testimonials `<blockquote>` + `— author`; then the ratings summary line `★ 4.3 · 12 ratings` and up to 3 comments with `— First name`), "Past events" as `<details>` listing `name · dateLabel` without links; every section omitted when its data is empty; whole component null when all empty.

- [ ] **Step 1:** Route tests (as Task 5 of the stats plan: host 401/404/200; PATCH 404 for a rating on another event, 200 flips). Component tests: `HostEventRatings` renders rows and PATCHes `is_public:false` on Hide; `HostPublicExtras` (renderToStaticMarkup, as `HostPublicEvents.test.jsx`): omits empty sections, shows `★ 4.3 · 3 ratings`, past events carry no `<a href`, testimonial author rendered; `HostAbout` splits paragraphs. Form test (`HostEventForm.test.jsx` style): the rating fields submit `rating_email_subject`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run the new tests + `src/components/host/HostPublicEvents.test.jsx` + `src/components/host/HostEventForm.test.jsx` + `src/app/host/(portal)/events` + `npm run -s check:location-scoping` + `npm run -s check:select-columns` → PASS.
- [ ] **Step 5:** Commit `HOSTPAGE.2 — host page sections (about, photos, testimonials, ratings, past events); host ratings list with Hide; rating request copy on the host form`.

### Task 7: Gates, review, PR

- [ ] lint + the twelve `check:*` gates + `npm run build` ALONE; then `npm test` ALONE.
- [ ] Fresh whole-branch review (model "fable") with the review package + this plan's Review Focus; fix pass (RED→GREEN each); commit.
- [ ] Check #2326 (HOSTSTATS.1) merged + deployed → apply mig 822 and verify `cron_health`; `git fetch origin main && git merge origin/main`; push `host-page-extras`; `gh pr create --base main`; changelog entry; auto-merge (merge). After THIS PR deploys: apply mig 824 and verify its `cron_health` row.
