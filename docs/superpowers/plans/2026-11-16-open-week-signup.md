# Open Week Signup (OPENWEEK.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/openweek` page where a non-member picks a studio, picks up to five open week classes (one a day, 23–30 Nov 2026), gives their details once, and is booked into every class automatically.

**Architecture:** Open week is a new `kind` of the existing `corp_promos` promo. The existing claim route and both fulfilment modules (`corp-promo-claim.js` for un1t.online, `corp-promo-claim-glofox.js` for Glofox) grant the entitlement, then queue one CLASSFIRST.1 funded booking per picked class through `queueFundedClassBooking`. A pure module `src/lib/open-week.js` holds every rule (window, limits, expiry days) so the route, the classes list and the page share one judge.

**Tech Stack:** Next.js 16 App Router, Supabase (service role), zod 4, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-16-open-week-signup-design.md`

## Global Constraints

- Window: `2026-11-23` to `2026-11-30` inclusive, studio-local dates (`Europe/Dublin` via `zoneOfLocation`; never the literal, `check:guardrails` bans it outside tests).
- Limits: `max_classes = 5`, `max_per_day = 1`, judged by the class's studio-local `day`.
- Eligibility: anyone except a current member. Open week counts as the person's free trial afterwards.
- No new caller of `/credits/grant`: Hatch keeps calling `grantPromoCredits` from `corp-promo-claim.js` only (`tests/un1t-online-write-guard.test.js`).
- Every new table is service-role only: `REVOKE ALL … FROM anon, authenticated`, RLS on, no policy (CLAUDE.md, mig 677 rule).
- Every Supabase write destructures `error`; every `.select()` names columns that exist (`check:select-columns`).
- Customer-facing words are block fields with defaults (editable at `/settings/landing-page`), never hard-coded in a component.
- Migration number **847** (845/846 are taken by open PRs #2402/#2406; recheck `ls supabase/migrations` and open PRs before merge). Apply via Supabase MCP to `iyvtbjjxdggiadzwwvdj` BEFORE the code deploys; run `get_advisors` (security) after.
- Branch `open-week-signup`, worktree `~/code/un1t-crm-open-week` (run `npm ci` first). Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A class that fills between page load and submit** → that pick is refused with `class_unavailable` naming it; the visitor keeps their other picks. (Task 5 test.)
2. **A late signup (e.g. Sat 28 Nov evening)** → expiry days still cover the end of 30 Nov; never 0 days. (Task 2 test.)
3. **A visitor resubmitting / double-clicking** → one claim, bookings never doubled (one-live-claim index + `UNIQUE (claim_id, class_event_id)` + the queue's own unique). (Task 5 test.)
4. **A page opened before or after the week** → only window classes; on/after 1 Dec the picker shows the operator's "open week has finished" words, and the route refuses. (Task 2 + Task 6 tests.)
5. **Someone who already claimed /newstart or /corp** → still eligible for open week (only current membership refuses); someone who claimed open week is refused by /newstart and /corp afterwards. (Task 4 tests.)

---

### Task 1: Migration 847 and the promo view

**Files:**
- Create: `supabase/migrations/847_open_week_promos.sql`
- Modify: `src/lib/corp-promos-db.js` (`CORP_PROMO_COLUMNS`, `promoView`)
- Test: `tests/migration-847-open-week.test.js`, `src/lib/corp-promos-db.test.js` (create if absent)

**Interfaces:**
- Produces: `promoView(row)` returns the existing fields plus `kind: 'promo'|'open_week'`, `windowStartsOn: string|null` (`YYYY-MM-DD`), `windowEndsOn: string|null`, `maxClasses: number|null`, `maxPerDay: number|null`.
- Produces: table `corp_promo_claim_classes (id uuid pk, claim_id uuid → corp_promo_claims ON DELETE CASCADE, location_id uuid, class_event_id text NOT NULL, class_name text, class_starts_at timestamptz, created_at timestamptz default now(), UNIQUE (claim_id, class_event_id))`.

- [ ] **Step 1: Write the failing migration test** — reads the SQL file text and asserts: `ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'promo'` with `CHECK (kind IN ('promo', 'open_week'))`; columns `window_starts_on date`, `window_ends_on date`, `max_classes integer` (`BETWEEN 1 AND 20`), `max_per_day integer` (`BETWEEN 1 AND 5`); a CHECK that `kind <> 'open_week' OR (window_starts_on IS NOT NULL AND window_ends_on IS NOT NULL AND window_ends_on >= window_starts_on AND max_classes IS NOT NULL AND max_per_day IS NOT NULL)`; `CREATE TABLE IF NOT EXISTS public.corp_promo_claim_classes`; `REVOKE ALL ON public.corp_promo_claim_classes FROM anon, authenticated`; `ENABLE ROW LEVEL SECURITY`; no `CREATE POLICY`; the seed inserts `hatch-open-week` (platform `un1t_online`, `kind 'open_week'`, window `2026-11-23`/`2026-11-30`, `max_classes 5`, `max_per_day 1`, `credits 5`, `expires_in_days 14`, `live false`, tag `hatch-open-week`, lead_source `open_week`) resolved by `name = 'UN1T Hatch Street'` with a `RAISE EXCEPTION` when missing, `ON CONFLICT (location_id, key) DO NOTHING`. Model it on `tests/migration-787-corp-promo.test.js`.
- [ ] **Step 2: Run** `npx vitest run tests/migration-847-open-week.test.js` — Expected: FAIL (file missing).
- [ ] **Step 3: Write the migration** (BEGIN/`SET LOCAL lock_timeout = '5s'`/COMMIT, COMMENTs on each new column and the table naming OPENWEEK.1). `credits`/`expires_in_days` keep their NOT NULL columns; for open week they are only the staff-card fallback text, the grant uses the picks (Task 7). The Stillorgan row is NOT seeded (its Glofox ids do not exist yet; see Launch).
- [ ] **Step 4: Write the failing `promoView` test** (a row with the five new columns maps to the camelCase fields; a row without them maps `kind: 'promo'` and nulls), then add the five columns to `CORP_PROMO_COLUMNS` and map them in `promoView`.
- [ ] **Step 5: Run** both tests plus `npx vitest run tests/corp-promos-table-guard.test.js` and `npm run check:select-columns` — Expected: PASS.
- [ ] **Step 6: Commit** `OPENWEEK.1 — mig 847: open week promos and picked classes`.

### Task 2: The open week rules (pure)

**Files:**
- Create: `src/lib/open-week.js`, `src/lib/open-week.test.js`

**Interfaces:**
- Consumes: `promoView` shape (Task 1); `todayStrIn`, `zonedWallClockToInstant` from `@/lib/location-time`.
- Produces:
  - `isOpenWeek(promo): boolean`
  - `openWeekState(promo, zone, now = new Date()): 'open'|'over'` — `over` once today (studio date) is after `windowEndsOn`; signup is open before the week starts too.
  - `openWeekReadDays(promo, zone, now): number` — days to pass to `readPublicClasses` so the read reaches the end of `windowEndsOn` (today → windowEndsOn inclusive, min 1).
  - `inOpenWeek(cls, promo): boolean` — `cls.day` (`YYYY-MM-DD`, studio-local, already on `readPublicClasses` rows) between the window dates inclusive.
  - `judgeOpenWeekPicks(eventIds: string[], classes: object[], promo): { ok: true, picks: { event_id, name, starts_at, day }[] } | { ok: false, code: 'none_picked'|'too_many'|'two_on_one_day'|'class_unavailable', eventId?: string }` — dedupes ids first; `classes` is the server's read already filtered by `inOpenWeek`; picks returned in `starts_at` order.
  - `openWeekExpiresInDays(promo, zone, now): number` — the smallest whole `n ≥ 1` with `now + n×24h ≥ zonedWallClockToInstant(dayAfter(windowEndsOn), '00:00', zone)`.

- [ ] **Step 1: Write failing tests** (`process.env.TZ` irrelevant: pass `zone`): with promo window 2026-11-23..2026-11-30, max 5, per day 1, zone `'Europe/Dublin'`:
  - `openWeekState` at `2026-11-16T12:00Z` → `'open'`; at `2026-11-30T23:30Z` → `'open'`; at `2026-12-01T00:30Z` → `'over'`.
  - `openWeekReadDays` at `2026-11-16T12:00Z` → `15`; at `2026-11-28T20:00Z` → `3`.
  - `judgeOpenWeekPicks([], …)` → `none_picked`; six ids on six days → `too_many`; two ids both on `2026-11-24` → `two_on_one_day`; an id not in `classes` → `class_unavailable` with that `eventId`; `['b','a','a']` (b on 25th, a on 24th) → ok, picks `[a, b]`.
  - `openWeekExpiresInDays` at `2026-11-16T12:00Z` → `15` (16 Nov 12:00 + 15 d = 1 Dec 12:00 ≥ 1 Dec 00:00, 14 d is 30 Nov 12:00 < it); at `2026-11-30T22:00Z` → `1`.
  - Zone is honoured: at `2026-12-01T03:00Z`, `openWeekState` is `'over'` for `'Europe/Dublin'` but `'open'` for `'America/New_York'` (still 30 Nov 22:00 there), and `openWeekExpiresInDays` for New York is `1`.
- [ ] **Step 2: Run** `npx vitest run src/lib/open-week.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the six exports (no I/O).
- [ ] **Step 4: Run** — Expected: PASS. Also `npm run check:guardrails`.
- [ ] **Step 5: Commit** `OPENWEEK.1 — open week rules`.

### Task 3: Open week words

**Files:**
- Modify: `src/lib/corp-promos.js`, `src/lib/corp-promos.test.js`

**Interfaces:**
- Produces: `OPEN_WEEK_COPY_DEFAULT` (frozen, every key of `CORP_PROMO_COPY_DEFAULT` plus `pick_heading`, `pick_hint`, `pick_cta`, `over_text`, `class_list_heading`); `corpPromoCopyFromBlocks(blocks, promoKey, { platform, kind })` uses `OPEN_WEEK_COPY_DEFAULT` when `kind === 'open_week'` (for both platforms) and returns the new keys too.

- [ ] **Step 1: Failing test**: `corpPromoCopyFromBlocks([], 'k', { kind: 'open_week' })` returns these exact defaults:
  - `title`: `Open Week at {studio_name}`; `heading`: `Open Week at {studio_name}`; `subhead`: `Come and try coach-led classes, on us. Pick your classes for 23–30 November and we'll book you in.`
  - `ticks`: `['Up to 5 classes, free', 'One class a day, 23–30 November', 'Booked for you, see them in the app']`
  - `cta_label`: `Book my classes`; `pick_heading`: `Pick your classes`; `pick_hint`: `One class a day, up to {max_classes}.`; `pick_cta`: `Continue with {count} classes`; `class_list_heading`: `Your classes`
  - `done_title`: `You're in 🎉`; `done_body`: `We're booking you into the classes below. Check your email for how to log in to the app.`
  - `active_member_text`: `You're already a member at {studio_name}, so just book your classes in the app as usual.`; `already_claimed_text`: `You've already signed up for Open Week. Your classes are in the app; reply to our email if anything looks off.`; `trial_used_text` and `trained_text` unchanged from the base.
  - `over_text`: `Open Week has finished. Ask at the front desk about trying a class.`
  - `email_subject`: `Your Open Week classes at {studio_name}`; `email_body`: `Hi {first_name}, we're booking you into your Open Week classes at {studio_name}:\n{class_list}\nYou'll get a confirmation for each class as it's booked. Log in to the app with this email to see them. Reply to this email if anything looks off.`
  - A block's own non-blank field still wins.
- [ ] **Step 2: Run** `npx vitest run src/lib/corp-promos.test.js tests/corp-promos-client-safe.test.js` — FAIL then implement, then PASS (the module stays client-safe: no plan ids).
- [ ] **Step 3: Commit** `OPENWEEK.1 — open week words`.

### Task 4: Eligibility

**Files:**
- Modify: `src/lib/corp-promo-eligibility.js`, `src/lib/corp-promo-eligibility-glofox.js` and their tests

**Interfaces:**
- Produces: `corpPromoEligibility(db, { …, openWeek = false })` — with `openWeek` true only the `already_claimed` check (a `promo_grant` ledger row for this `promoKey`, open or done) applies; `free_trial_used` and `trained` never refuse.
- Produces: `glofoxCorpPromoEligibility(db, { …, openWeekKeys = [] })` — for a promo NOT in `openWeekKeys`, a `granted` claim of ANY key in `openWeekKeys` at the studio refuses with the new reason `'free_trial_used'`. For an open week promo it is unchanged.

- [ ] **Step 1: Failing tests:** (un1t) a person with a `trial` ledger row and an un-cancelled `un1t_bookings` row → eligible with `openWeek: true`, refused `free_trial_used` without it; a `promo_grant` for the same key → `already_claimed` either way. (Glofox) a granted `stillorgan-open-week` claim refuses `stillorgan-newstart` when `openWeekKeys: ['stillorgan-open-week']` → `free_trial_used`; a granted `stillorgan-newstart` claim does NOT refuse `stillorgan-open-week`.
- [ ] **Step 2: Run** the two eligibility test files — FAIL, implement, PASS. The Glofox claims read already selects `corp_promo_claims` for the person at the location: widen it to `.in('promo_key', [promoKey, ...openWeekKeys])` and select `promo_key` too.
- [ ] **Step 3: Commit** `OPENWEEK.1 — open week eligibility`.

### Task 5: Claim route accepts the picks

**Files:**
- Modify: `src/app/api/public/corp-claims/route.js`, its `route.test.js`; `src/lib/openapi.js` (the body schema)
- Create: `src/lib/open-week-claim.js` (server-only), `src/lib/open-week-claim.test.js`

**Interfaces:**
- Consumes: Task 2 (`isOpenWeek`, `openWeekState`, `openWeekReadDays`, `inOpenWeek`, `judgeOpenWeekPicks`), `readPublicClasses(db, locationId, days, { blocks })`, `listCorpPromos(db, { locationId })`.
- Produces: `resolveOpenWeekPicks(db, { locationId, blocks, promo, zone, eventIds, now }) → { ok: true, picks } | { ok: false, code: 'over'|'timetable_unavailable'|'none_picked'|'too_many'|'two_on_one_day'|'class_unavailable', eventId? }`.
- Produces: `insertClaimClasses(db, { claimId, locationId, picks }) → { error }` (one insert of all rows; caller judges `error`).
- Produces: route body field `event_ids: z.array(z.string().trim().min(1).max(64)).max(20).optional()`; for an open week promo `event_id` is ignored and `event_ids` required.
- Produces: the fulfilment calls receive `picks` (array, empty for other promos).

- [ ] **Step 1: Failing tests for `resolveOpenWeekPicks`** (mock `readPublicClasses`): `over` after 30 Nov; a read error → `timetable_unavailable`; a class outside the window is not pickable (`class_unavailable`); a full class (absent from the read) → `class_unavailable` with its id; a valid pick set → its picks.
- [ ] **Step 2: Failing route tests:** open week promo + `event_ids` of 3 valid classes → claim insert carries `promo_key`, `platform`, `credits: 3`, and `corp_promo_claim_classes` gets 3 rows; `class_unavailable` answers `400 { code: 'class_unavailable', event_id }` with the default `CLASS_UNAVAILABLE_TEXT` BEFORE any contact capture; `over` answers `200 { success:false, code:'over', error: copy.over_text }`; `too_many`/`two_on_one_day`/`none_picked` → `400` with codes; un1t eligibility called with `openWeek: true`; Glofox eligibility called with `openWeekKeys` from `listCorpPromos` filtered to `kind === 'open_week'`; a `corp_promo_claim_classes` insert error → claim stamped `failed` (`reason 'classes_unrecorded'`) and `503`, fulfilment not called; a repeat claim (`23505` on the claim insert) → `already_claimed` as today, no class rows.
- [ ] **Step 3: Run** `npx vitest run src/lib/open-week-claim.test.js src/app/api/public/corp-claims` — FAIL.
- [ ] **Step 4: Implement.** In the route, branch once on `isOpenWeek(promo)`: judge picks where `resolveChosenClass` runs today (before the lead), copy-fill tokens add `max_classes`, insert claim then class rows, pass `picks` to fulfilment. Update `src/lib/openapi.js`.
- [ ] **Step 5: Run** the tests, `npm run check:route-guards`, `npm run check:location-scoping`, `npm run check:select-columns` — PASS.
- [ ] **Step 6: Commit** `OPENWEEK.1 — claim route takes open week picks`.

### Task 6: Classes list for the page

**Files:**
- Modify: `src/app/api/public/classes/route.js` and its `route.test.js`

**Interfaces:**
- Consumes: Task 2 helpers, `readCorpPromo`.
- Produces: for `?page=<slug>&studio=<path>` where the page's offer is `promo_credits` and the block's promo is a live open week promo: `{ success: true, classes, open_week: { state, max_classes, max_per_day, starts_on, ends_on } }`, classes read with `openWeekReadDays` and filtered by `inOpenWeek`; state `over` returns `classes: []`.

- [ ] **Step 1: Failing tests:** an open week page lists only 23–30 Nov classes and carries `open_week`; a normal promo page is unchanged (no `open_week` key).
- [ ] **Step 2: Run, implement, run** — PASS.
- [ ] **Step 3: Commit** `OPENWEEK.1 — classes list for open week`.

### Task 7: Fulfilment books every pick

**Files:**
- Modify: `src/lib/class-first-booking.js` (+ test), `src/lib/corp-promo-claim.js` (+ test), `src/lib/corp-promo-claim-glofox.js` (+ test), `src/lib/un1t-online-write-ops.js` (comment only: amount/expiry come from the promo or, for open week, the claim's picks)

**Interfaces:**
- Produces: `fundedBookingsFromPicks(row, picks, { fundedBy }) → object[]` — one `queueFundedClassBooking` argument per pick (same shape as `fundedBookingFromRow`, with that pick's `event_id`/`name`/`starts_at`).
- Consumes: `openWeekExpiresInDays` (Task 2); `fulfil*Claim(db, { …, picks = [] })`.

- [ ] **Step 1: Failing tests:**
  - `fundedBookingsFromPicks` returns one entry per pick with the claim's contact, location and terms.
  - Hatch: open week claim with 3 picks → `grantPromoCredits` called with `amount: 3`, `expiresInDays: openWeekExpiresInDays(...)`; claim stamped `credits: 3`; `queueFundedClassBooking` called 3 times; a failure of the 2nd queue call still queues the 3rd and returns `granted`. A normal promo is unchanged (`amount: promo.credits`, one funded booking from the row).
  - Glofox: open week claim on an existing account with status `trial` (and with credits `> 0`) → no help card, plan purchased, picks queued; status `member` → `help('live_plan: member')` as today; a normal promo with status `trial` still files help.
  - Both: the ops alert text for an open week claim says to book their picked classes by hand, listing them.
- [ ] **Step 2: Run** the three test files — FAIL, implement, PASS. Keep `grantPromoCredits`' only caller in `corp-promo-claim.js`; run `npx vitest run tests/un1t-online-write-guard.test.js tests/mia-no-charge-no-refund-guard.test.js tests/glofox-write-retry-guard.test.js`.
- [ ] **Step 3: Commit** `OPENWEEK.1 — book every open week pick`.

### Task 8: Confirmation email lists the classes

**Files:**
- Modify: `src/lib/corp-promo-emails.js` (+ test)

**Interfaces:**
- Produces: `sendCorpPromoEmail(db, { claim, copy, studioName, zone, appLinks, classes = [] })` — token `{class_list}` renders each class as `Tue 24 Nov, 07:00, <name>` in the studio zone (HTML: a `<ul>`; text: one per line, names escaped); `corpPromoTokens` gains `max_classes`.
- Consumes: both fulfilment modules pass `classes: picks` (Task 7 call sites).

- [ ] **Step 1: Failing test:** an open week send with two picks renders both lines in order with escaped names; an empty list renders the token as blank; normal promo emails unchanged.
- [ ] **Step 2: Run, implement, run** — PASS.
- [ ] **Step 3: Commit** `OPENWEEK.1 — open week confirmation email`.

### Task 9: The page: studio choice, multi-pick, done screen

**Files:**
- Create: `src/components/landing-page/OpenWeekPickStep.jsx` (+ `.test.jsx`)
- Modify: `src/components/landing-page/CorpPromoFunnel.jsx` (+ test), `src/app/(public)/[slug]/[[...rest]]/page.js` (+ `page.test.jsx`), `src/components/landing-page/EditOfferLayout.jsx` (editor preview passes `openWeek`)

**Interfaces:**
- Consumes: `useClassList` and `cadenceGroups`/`Tile` from `ClassPickStep.jsx`; the classes response's `open_week` (Task 6); copy keys (Task 3).
- Produces: `OpenWeekPickStep({ list, copy, maxClasses, maxPerDay, picks, onChange, onContinue })` — day tiles with each day's slots; tapping a slot on a day that already has a pick replaces it (when `maxPerDay === 1`); a pick past `maxClasses` is ignored and the hint shows; the continue button reads `pick_cta` with `{count}` and is disabled at 0. Every button `type="button"`.
- Produces: `CorpPromoFunnel` prop `openWeek: { maxClasses, maxPerDay }|null`; with it the pick step is `OpenWeekPickStep`, the form submits `event_ids`, the "Change" summary lists picks, `class_unavailable` returns to the pick step with that class removed and the error shown, and the done screen lists the classes under `class_list_heading`.
- Produces (page): for an all-studios `promo_credits` page with no `?studio=`, render a studio choice (one link-styled tile per enabled studio row to `?studio=<public path>`, words from block field `studio_heading`, default `Choose your studio`) instead of the card; with a studio, pass `openWeek` from the promo row when `kind === 'open_week'`, and copy filled with `max_classes`.

- [ ] **Step 1: Failing component tests** for `OpenWeekPickStep` (replace-on-same-day, cap at 5, counter text `Continue with 2 classes`, disabled at 0) and `CorpPromoFunnel` (posts `event_ids`, handles `class_unavailable`, done screen lists names). Move the fake clock inside `act()` if timers are used (CLAUDE.md).
- [ ] **Step 2: Failing page test:** `/openweek` with two studios and no `?studio=` renders two choices linking to `?studio=stillorgan` and `?studio=hatch-street`; with `?studio=hatch-street` renders the card with `openWeek`.
- [ ] **Step 3: Run, implement, run** — PASS; `npm run check:guardrails` (button types, contrast).
- [ ] **Step 4: Commit** `OPENWEEK.1 — open week page`.

### Task 10: Ship

**Files:**
- Create: `docs/changelog/entries/<PR>.md` (after `gh pr create`)

- [ ] **Step 1:** `npm ci` (if not yet), then the CI mirror: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths` — all green. Then `npm run build` alone (never alongside the full suite on this machine).
- [ ] **Step 2:** Recheck the migration number against `origin/main` and open PRs; rename if taken.
- [ ] **Step 3:** Push `open-week-signup`, `gh pr create --base main` with a body listing the launch steps below; add the changelog entry; push.
- [ ] **Step 4:** After Richard's go-ahead, apply mig 847 via Supabase MCP (`apply_migration`, project `iyvtbjjxdggiadzwwvdj`), then `get_advisors` security. Only then merge.

## Launch (manual, after merge)

1. Richard creates a Glofox plan named **Open Week Free Trial** (5 classes, €0, private, complimentary allowed, ending 30 Nov) and sends its membership id and plan code. (The word "Trial" in the name is what makes /trial treat it as a used free trial.)
2. Insert the Stillorgan row (`stillorgan-open-week`, platform `glofox`, `kind 'open_week'`, the same window and limits, the three Glofox fields, tag `stillorgan-open-week`, lead_source `open_week`, `live true`) with a small follow-up migration, the NEWSTART.2 way.
3. Set `hatch-open-week` `live = true`.
4. Create the `/openweek` campaign page in `/settings/landing-page`, offer type promo credits, all studios, each studio row's block naming its open week promo key; publish.
5. One staff test claim at each studio; confirm the bookings appear in Glofox / un1t.online and the email lists them; cancel the test bookings.
