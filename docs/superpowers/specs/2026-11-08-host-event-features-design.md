# Host event features — design

**Date:** 2026-11-08. **Asked by:** Richard ("do this" on six items from an ideas list). **Scope:** six additions for event hosts (third-party organisers with a portal at `/host` and a public page at `/h/<slug>`), built as six PRs on `race_events`. Where a feature is free for staff-run events too (tiers, questions, calendar, duplicate), it lands for both; analytics and the public-page extras are host surfaces.

Decisions marked **(my call)** are mine, made because the request left them open; Richard can override any of them. Everything else is what he asked for or what the codebase already fixes.

Related: `docs/events.md` (the events model), `docs/superpowers/specs/2026-10-08-event-entry-move-design.md` (moves), PR #2321 (SAMETIME.1: a change of time on the same event, shipped first because a host hit it).

---

## 0. What exists today (the ground)

- An event is a `race_events` row (`kind` race | workshop | seminar | open_day | masterclass | lead_gen). Its times are `race_waves` rows (start_time, label, capacity). A host-created event has **exactly one wave**: `HostEventSchema` takes `session_start_time` / `session_capacity` / `session_label`, and the host routes write or update the first wave only. Pride Training Club works around this by creating one event per time ("… - 12:30PM") and staff adding a second wave by hand.
- Price: per head, `non_member_fee_cents` (hosts: "Ticket price") and optional member pricing (UN1T only). `computeTeamPricing` (`src/lib/member-validation.js`) sums it; promo codes discount the total; Stripe Connect hosts add a per-seat booking fee (`computeApplicationFeeCents`). The charge is `race_payments.amount_cents` with a per-head breakdown. No tiers, early bird or group price anywhere.
- An entry is `race_registrations` (one per team per event) + `teams` / `team_members` (the people: name, email) + `race_payments` (captain phone, money). No jsonb or notes column on registrations or members; `race_payments.metadata` is the only jsonb.
- Export: `fetchEventAttendees` + `buildAttendeeCsv` (`src/lib/attendee-csv.js`), one row per person.
- Calendar: `src/lib/event-ics.js` builds a floating-local-time VEVENT, used only by the post-signup confirmed page as a `data:` download. No calendar link in any email. `src/lib/ics.js` is the RFC 5545 writer with UTC times and line folding (the staff shift feed).
- Attribution: none for events. `contacts` carry utm/visit columns written by the studio funnels (`src/lib/visit-origin.js`); `funnel_events` is keyed per studio page, not per event. Host campaign emails add nothing to links; a click lands in `host_campaign_clicks` with no onward tie to a registration.
- Host public page `/h/<slug>`: hero, headline, blurb, upcoming event cards, mailing-list form. Past events are dropped. `event_hosts` has no about, photos or testimonials; the hero is a pasted URL. No ratings or reviews exist for events.
- Public paths under `/event/` are already allowlisted (`/event/entry/<token>` lives there); `RESERVED_EVENT_SLUGS = {entry}`.
- Every new table is closed to clients by default (mig 677); every new function is service-role only (mig 667); a jsonb settings column on `race_events` follows the `charity` pattern: Zod on write, resolve-with-defaults on read, `-- column-grant: withheld` comment.

---

## 1. Sessions, duplicate and series (PR 1, HOSTSERIES.1)

### Intent
A monthly workshop means re-typing the event. A host should create an event with several times, copy it to a new date in one click, and give one link that lists every date.

### Goals
- A host event can have 1–12 session times, each with its own label and capacity.
- **Duplicate**: one action copies an event to a new date as a draft.
- **Series**: a set of events with one public page listing the dates.

### Non-goals
- Recurrence rules (RRULE, "every second Tuesday"): a series is a list of dates the host picks.
- Editing every event in a series at once.
- Copying promo codes or registrations.

### Design
**Sessions.** `HostEventSchema` replaces `session_start_time` / `session_capacity` / `session_label` with `sessions: [{ id?, start_time 'HH:MM', label?, capacity 1..100000 }]` (1–12, start times unique). The host routes upsert waves by id, insert new ones, delete removed ones **only when the wave has no live entry** (409 `session_has_entries` otherwise, naming the time). `computeEditTransition` already re-reviews a published event when a wave time changes. The host form's Schedule section becomes a list with add/remove rows. **(my call)** The existing one-session fields are gone from the schema, not aliased: the form is the only caller.

**Duplicate.** `src/lib/event-duplicate.js` `duplicateEvent(db, { sourceId, raceDate, actor })`: copies every operator field of the source (name, kind, description, venue, pricing columns, pricing tiers, registration questions, hero, accent, email copy, entry_policy, find_team, duration, charity settings with totals zeroed), all waves (times, labels, capacities), `status 'draft'`, a fresh slug via `uniqueEventSlug`, same `host_id` / `location_id`. Never copies registrations, promo codes, waitlist rows, moves or stats. Routes: `POST /api/host/events/[id]/duplicate` (host owns the source) and `POST /api/events/[id]/duplicate` (staff, manager+ holding `races` at the event's studio). UI: a **Duplicate** button on the host event page (date picker, then opens the new draft's edit page) and on the staff events list.

**Series.** New table `event_series` (id, host_id null for staff series, location_id, name, slug unique, created_at) and `race_events.series_id uuid null → event_series on delete set null`. A series is created from the host event page: **Make this a series** → pick dates (a list; the form offers weekly / fortnightly / monthly helpers that fill the list) → the lib duplicates the event once per date and stamps `series_id` on the source and every copy. Copies are drafts; the host submits each (or the series page shows only published dates, so an unsubmitted copy simply does not appear). An existing event can be **added to** a series from its edit page (a picker of the host's series). Public page **`/event/series/<slug>`** (under `/event/`, so no allowlist edit; `series` joins `RESERVED_EVENT_SLUGS`): the newest published event's hero and copy, then every published upcoming date as a card (date, time(s), price label, sold out / closed), each linking to `/event/<slug>`. Past dates are not shown. The host dashboard lists the series with its link; `/h/<slug>` groups cards under their series name **(my call)** rather than listing twelve near-identical cards.

### Data
- Mig: `event_series` (service role only, RLS on, no policy), `race_events.series_id` (withheld from client grants; `race_events` has no client grant today).
- Slug: `uniqueSeriesSlug` on `event_series.slug`, derived from the name.

### Left to the builder
Exact form layout; whether the staff RaceEventForm gets the series picker in this PR (it gets Duplicate; series on staff events can wait).

---

## 2. Pricing tiers (PR 2, TIERS.1)

### Intent
"First 20 at €25, then €35", "€30 until 1 Dec", "3+ people €28 each". Promo codes exist; tiers do not.

### Goals
- Tiers by **capacity**, by **date window**, or by **group size**, in any combination, on any event.
- The public page shows the current price and what comes next.
- The charge, the receipt and the host's revenue are right without new money paths.

### Non-goals
- Per-tier member prices (member pricing stays UN1T's two-rate model; tiers replace the **non-member** rate only).
- Tiers for the price-difference maths of a move (the gap keeps using the base fees; noted in the dialog copy).
- Refunds when a cheaper tier opens later.

### Design
`race_events.pricing_tiers jsonb` (null = none): an ordered array of `{ id, name (≤60), price_cents ≥0, capacity int|null, starts_at iso|null, ends_at iso|null, min_people int|null }`, validated by `PricingTiersSchema` in `src/lib/pricing-tiers.js` (≤8 tiers; ids unique). **Resolution** (`resolveTier({ tiers, nowMs, headcount, soldByTier })`, pure): the **first** tier in order that (a) is open now (window), (b) has room (`capacity` null, or sold < capacity), and (c) fits the group (`min_people` null or ≤ headcount). None → the base price. `soldByTier` counts people on live entries that hold a place (`holdingPlaces`) grouped by `race_registrations.pricing_tier_id`. The register route resolves the tier, passes `{ ...race, non_member_fee_cents: tier.price_cents }` to `computeTeamPricing`, stores `pricing_tier_id` on the registration; `race_payments.non_member_fee_cents` carries the tier price so receipts, the breakdown line and host revenue read true. **(my call)** Capacity is counted at claim time: two buyers in the same second can both get the last early-bird seat, the same tolerance the waitlist has.

**Public.** `GET /api/public/events/[slug]` adds `pricing: { base_cents, current: { id, name, price_cents, ends_at, spots_left (null when uncapped) } | null, next: { name, price_cents, starts_at } | null, group: { min_people, price_cents } | null }` (never the sold counts). The widget's price row reads "Early bird €25 · 6 left, then €35" / "€30 until Mon 1 Dec" / "3+ people: €28 each", and the live total uses `pricing` with the chosen headcount. The register response names the tier applied.

**Forms.** A shared `PricingTiersEditor` component (rows: name, price, limit, from, until, min people) on the host form (new **Pricing** section replacing the single price field, which stays as "Standard price") and on `RaceEventForm`. `HostEventSchema` gains `pricing_tiers`; a tier change on a published host event re-reviews it (`computeEditTransition`, like a price change).

### Data
Mig: `race_events.pricing_tiers jsonb`, `race_registrations.pricing_tier_id text null` (both withheld). `check:select-columns` learns them from the migration.

### Left to the builder
Copy for the widget's price row; how the Total card phrases a group price.

---

## 3. Registration questions (PR 3, QUESTIONS.1)

### Intent
Dietary needs, experience level, t-shirt size: asked at signup, exported with the attendees.

### Goals
- Up to 10 questions per event; each per **entry** or per **person**; text, single choice, or yes/no; optional or required.
- Answers in the attendee export and on the host and staff rosters.

### Non-goals
- Conditional questions, file uploads, editing answers after signup (the entry page can gain that later).
- Answers for Mia's solo booking path (it skips questions; the host sees "not asked").

### Design
`race_events.registration_questions jsonb` (null = none): `[{ id, label (≤120), type 'text'|'choice'|'yes_no', options [≤10 × ≤60] for choice, required bool, per 'entry'|'person' }]`, Zod `RegistrationQuestionsSchema` in `src/lib/registration-questions.js`, with `validateAnswers(questions, { entry, people[] })` (pure: required present, choice in options, text ≤500) returning the field-level issues the widget shows inline. Storage: `race_registrations.answers jsonb` (entry-level, `{ [qid]: value }`) and `team_members.answers jsonb` (per person). The widget renders entry questions after the captain fields and person questions under each person's name/email; the body gains `answers: { entry: {...}, people: [{...}] }`; the register route validates against the event's questions and stores. `buildAttendeeCsv` appends one column per question (entry answers repeated on each person's row). The host and staff rosters show answers in a per-entry disclosure. A shared `RegistrationQuestionsEditor` on both forms. Changing questions on a published host event does **not** re-review it **(my call)**: it is not price or time.

### Data
Mig: three jsonb columns (withheld; `team_members` is client-readable by RLS for members today? It is not: no client grant exists on `team_members` beyond policies; the builder confirms with `information_schema` and withholds the column from any column grant).

---

## 4. Add to calendar (PR 4, CALENDAR.1)

### Intent
A booker should put the event in their calendar from the confirmation email, the moved email and the event page, in their own zone.

### Goals
- One `.ics` route per event time, UTC times from the studio's zone, tenant identity.
- A Google Calendar link beside it.
- Links in the confirmation and moved emails, on the confirmed page (replacing the `data:` download) and on the public event page.

### Non-goals
- Calendar subscriptions (feeds) for hosts; Outlook-specific deep links (the `.ics` covers Outlook and Apple).

### Design
`src/lib/event-calendar-links.js` (pure): `eventInstant({ race_date, start_time, zone })` via `zonedWallClockToInstant`; `eventCalendarLinks({ event, wave, zone, baseUrl })` → `{ ics_url, google_url }` where `ics_url = ${baseUrl}/api/public/events/<slug>/calendar.ics?wave=<id>` and `google_url` is `calendar.google.com/calendar/render?action=TEMPLATE&text=…&dates=<utc>/<utc>&location=…&details=…`. Route `GET /api/public/events/[slug]/calendar.ics` (public, published events only, rate-limited like the other public event reads) builds with `buildIcsCalendar` from `src/lib/ics.js`: summary = event name, location = venue address or name (a host anchor's internal name is never used; `pickAudienceVenueName`), UID = `<event>-<wave>@<tenant host>`, PRODID the platform. **Duration**: new `race_events.duration_minutes int null`; null → 120 for `race`, 60 otherwise **(my call)**; the host and staff forms get a Duration field. Emails: `manageLineHtml`'s neighbour `calendarLineHtml(links)` ("Add to your calendar: Apple/Outlook · Google") in the confirmation and moved shells, built in `sendRaceConfirmations` / `sendRegistrationMovedEmail` from the registration's wave and the studio zone. `RaceConfirmedPage` and the widget's details block link to the same route (the widget: single-time events show it in the details block; multi-time events show it after a time is picked). `event-ics.js` stays for one release, then goes.

### Data
Mig: `race_events.duration_minutes` (withheld; the public route reads it on the server).

---

## 5. Signup analytics (PR 5, HOSTSTATS.1)

### Intent
A host wants to know how many people saw the page, how many booked, where they came from, and whether the waitlist converted.

### Goals
- Page views per event (deduped per visitor per day), registrations, conversion.
- Source per registration: utm, referrer host, or the host campaign that sent them.
- Waitlist: waiting / offered / booked counts.

### Non-goals
- Cross-event funnels, cohort analysis, revenue attribution beyond the count; a cookie banner (the view is first-party, no cookie; a random session id in `sessionStorage`).

### Design
Table `event_page_views` (id, race_event_id, session_id, source text, utm_campaign, utm_content, referrer_host, day date, created_at; unique (race_event_id, session_id, day); service role only). Route `POST /api/public/events/[slug]/view` (rate limit per slug + IP like `funnel-event`; a published event only) inserts with `on conflict do nothing`. The widget calls it on mount with the attribution it reads from the URL and remembers in `sessionStorage` (`src/lib/event-attribution.js`, modelled on `visit-origin.js`: `utm_source/medium/campaign/content`, `hc` = host campaign id, `document.referrer`'s host, capped and sanitised). The register body gains `attribution` (same shape); the route sanitises again and stores `race_registrations.attribution jsonb`. Host campaign emails: `renderHostCampaignHtml` appends `hc=<campaign id>` to links whose host is the tenant host and whose path starts with `/event/` or `/h/` **(my call)**, so a booking from a host email is attributable without touching the host's other links. `GET /api/host/events/[id]/stats` → `{ views, unique_visitors, registrations, confirmed, conversion_pct, by_source: [{ source, views, registrations }], waitlist: { waiting, offered, claimed } }`; the host event page shows it as a **Signups** card; the staff teams page gets the same card from `GET /api/events/[id]/stats` **(my call)**, cheap once the lib exists. Retention: a `purge-event-page-views` arm on the existing `purge-webhook-payloads` cron deletes rows older than 180 days, with its own `cron_heartbeats` row (invariant: an arm gets its own row).

### Data
Mig: `event_page_views`, `race_registrations.attribution jsonb`, the heartbeat row (applied after the code deploys).

---

## 6. Public page extras and ratings (PR 6, HOSTPAGE.2)

### Intent
A host page that sells: who they are, what it looks like, what people said, and the record of past events.

### Goals
- About section, photo grid (uploaded), testimonials (host-written), past-events archive.
- Post-event ratings from attendees, shown as an average and recent comments once the host has 3+.

### Non-goals
- Replies to ratings, ratings on staff-run UN1T events (Google reviews cover the studios), a public ratings page per event.

### Design
`event_hosts` gains `about_text (≤2000)`, `photos jsonb (≤12 × { url, caption ≤120 })`, `testimonials jsonb (≤6 × { quote ≤400, author ≤80 })`, `show_past_events bool default true`, `show_ratings bool default true`. `HostListPageEditor` gets the fields; photos upload through `POST /api/host/list-page/photos` (PNG/JPEG/WebP ≤5MB, compressed in the browser with `compressImageForUpload`, stored in the `branding` bucket under `host-photos/<host id>/`, the limits the bucket guard pins) and `DELETE …/photos?url=`. `/h/<slug>` renders: hero → about → upcoming events (grouped by series) → photos → "What people say" (testimonials, then the ratings summary) → past events (collapsed `details`, name + date, no link to signup; the host's `race_date < today`, published, newest first, ≤24).

**Ratings.** Table `event_ratings` (id, race_event_id, registration_id unique, host_id, contact_id, rating 1–5, comment ≤600, is_public bool default true, created_at; service role only). A **rating request arm** on the hourly `event-reminders` cron (its own `cron_heartbeats` row, `src/lib/cron-arm-health.js` entry): the morning after a host event (the studio's clock, `gateDailySlot`), every confirmed entry lead gets one email ("How was <event>?") with a signed link `/event/rate/<token>` (`rate` joins `RESERVED_EVENT_SLUGS`; token = registration id + event id, HMAC like `entry-manage-tokens.js`, 30-day life); `event_rating_requests` (registration_id unique, sent_at) makes it send-once. The page: five stars, an optional comment, one submission per registration (a second visit shows what they gave). Transactional consent gate like the reminders (`checkTransactionalConsent`); hosts' events only (a UN1T event never asks). The host portal event page lists the ratings with a **Hide** toggle (`is_public`); the public summary shows the average and count once ≥3 public ratings exist, plus the 3 newest public comments. Operator copy for the request email: `race_events.rating_email_subject/intro` (null = default), on the host form's email section.

### Data
Mig: the five `event_hosts` columns, `event_ratings`, `event_rating_requests`, the two copy columns, the heartbeat row.

---

## Build order and shared constraints

1. PR 1 sessions + duplicate + series → 2. PR 2 tiers → 3. PR 3 questions → 4. PR 4 calendar → 5. PR 5 analytics → 6. PR 6 page extras + ratings. PRs 1–3 and 5 all touch the host form, the register route and the widget, so they are sequential, each branched off main after the previous merges (or rebased).
- Each PR: one migration (numbered against `origin/main` at build time; applied via Supabase MCP before the code deploys, `get_advisors` after), tests first (`npm test` on the touched suites; the thirteen-command CI mirror before push; never the full suite beside a build on this Mac), one `docs/changelog/entries/<PR>.md`, OpenAPI registration for every new route, `check:select-columns` clean (new columns come from the migration), `check:route-guards` (public routes in `EXEMPT` with a reason), `check:location-scoping`.
- Host routes gate on `getCurrentHost()` + `host_id` ownership (404 otherwise); staff routes on `getCurrentUser()` + `races` at the event's studio; public routes read published events only through the service role.
- Customer-facing copy that a host would want to change is an operator field with a default (the rating email; the series page headline), never a literal.
- A new jsonb settings column carries `-- column-grant: withheld` and a Zod schema; a new table states `revoke all … from anon, authenticated`.
- Timezones: every "today" and "the morning after" is the event studio's clock (`eventToday`, `gateDailySlot`); an `.ics` instant comes from `zonedWallClockToInstant`.
- Series page, rating page and calendar route live under `/event/` so the four public allowlists are untouched; `RESERVED_EVENT_SLUGS` gains `series` and `rate`.

---

## Builder-check decisions (2026-11-08)

A reviewer read the document as a builder and asked seven questions. All seven are settled here **(my calls)**, each following the rule the codebase already applies; Richard can flip any of them.

1. **Tier counts stay private.** The public event API deliberately exposes no capacity number (only `is_full` per time), so `pricing.current` carries no `spots_left` either. The widget says "Early bird €25 (limited), then €35" and "€30 until Mon 1 Dec"; the exact remaining count is operator-only, on the forms and the host event page. Flip this if the "6 left" nudge is wanted.
2. **Adding a session never re-reviews a published host event; changing an existing session's time does.** `computeEditTransition` compares only waves that already exist (by id); a new time is additive and harms no booking. Removing a session with live entries is refused (409 `session_has_entries`), so a removal never re-reviews either.
3. **Every booking door prices the same way.** `applyTierPricing` (in `src/lib/pricing-tiers.js`) is called by the public register route AND `race-register-solo.js` (Mia quotes and books the tier, stamps `pricing_tier_id`). The legacy `src/app/api/public/races/[slug]/register/route.js` (no page calls it; `next.config.js` already rewrites that URL to the events route, which the file shadows) is deleted in PR 2 with its tests, so the rewrite takes over and there is one register path. PR 3 then has one door to put required questions on.
4. **Tiers count people, always, and only tiered entries consume tier seats.** A price is per head, so a capacity tier is "the first N people", whatever the event's `capacity_mode`; one tier is resolved for the whole entry (a 4-person team either fits or moves on). Entries without `pricing_tier_id` (staff-added through `/api/events/[id]/teams`, pre-tier bookings) never consume a tier seat; the forms say so beside the limit field.
5. **Duplicate shifts the registration window by the date delta and copies the hero file.** `registration_opens_at` / `closes_at` move by the same number of days as `race_date` (so "closes the day before" stays true); the hero object is copied in Storage to `race-hero/<new id>/` (the hero route deletes stale files on re-upload, so sharing the URL would lose the copy's image); `tv_logos` URLs copy as-is.
6. **Host events never use the windowed time picker.** `timePickerWaves`' 90-minute release window exists for UN1T's generated Hyrox waves; an event with a `host_id` lists every session plainly.
7. **The rating request goes out like a reminder.** Same identity (`resolveEventCommsLocation`: the organisation's comms location), same transactional consent gate and suppression path as the event reminders; the host's own sender domain is for the host's campaigns, and a rating request is part of the booking relationship, not marketing.

Also noted by the reviewer and adopted: `renderHostCampaignHtml` gains a `campaignId` argument for the `hc` link parameter; `event_series` carries `headline` and `blurb` (operator-editable copy for the series page, default "Pick a date"); the rating arm rides `event-reminders`' 09:00 daily slot; `race_events` still holds a pre-mig-677 table grant to `authenticated`, so the new columns are RLS-readable rather than withheld (nothing secret goes in them).
