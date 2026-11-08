# HOSTSTATS.1 — Signup Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host (and staff) sees, per event, how many people viewed the page, how many booked, where they came from, and whether the waitlist converted.

**Architecture:** A first-party page-view table written by a public POST the signup widget fires on mount (deduped per visitor per day, no cookie: a random session id in `sessionStorage`); the same attribution object travels with the registration and is stored on the row; host campaign emails tag their event links with `hc=<campaign id>` so a booking from a host email is attributable. One lib (`event-stats.js`) aggregates; two thin routes and two server pages render it as a **Signups** card. Retention is an arm on the daily purge cron with its own heartbeat row.

**Tech Stack:** Next.js 16 App Router, supabase-js (service role), Zod, vitest + RTL (jsdom), `@/lib/location-time` for day buckets.

**Spec:** `docs/superpowers/specs/2026-11-08-host-event-features-design.md` §5 (+ "Builder-check decisions": `renderHostCampaignHtml` gains a `campaignId` argument).

## Global Constraints

- Every `/api` route runs on the service role: scope in code. Public routes that read `race_events` by slug need an `EXEMPT` entry in `scripts/check-location-scoping.mjs` (precedent: `calendar.ics`); host routes 404 (never 403) on another host's event; staff routes: manager+ holding `races` AT the event's studio, 404 outside the caller's studios (copy `/api/events/[id]/duplicate`).
- A new table is closed to clients by default (mig 677): state `revoke all on public.<t> from anon, authenticated;` + RLS on, no policy (copy mig 817). `race_registrations` has no client privilege (mig 682): a new column needs `-- grant: none` only.
- Zone maths only via `@/lib/location-time` (`zoneOfLocation`, `todayStrIn`). Never `'Europe/Dublin'` literals outside tests.
- The host's anchor location label must never reach a customer or the host's own card (nothing here renders a location name).
- supabase-js: `await` every write, destructure `error`, paginate reads with `.order()` + `.range()` (1,000-row cap), `.maybeSingle()` where 0 rows is normal.
- No `console.log`; `logWarn`/`logError` from `@/lib/log`.
- Cron arm: its own `cron_heartbeats` row, stamped only on a clean run of its own, under its own try/catch, placed so the parent cannot crash it out of its stamp; the row's migration is applied AFTER the deploy.
- Register every new route in `src/lib/openapi.js`. Standard response `{ success, data?, error? }`.
- Customer-facing copy on the card is operator-facing (host/staff), so plain literals are fine.

## Review Focus

1. A visitor with `sessionStorage` disabled (private mode) → the view is still counted once (a per-request id), the widget never throws, and the register call still works with `attribution: null`. (Task 1 tests `rememberEventAttribution` under a throwing storage; Task 3 route accepts a missing attribution.)
2. A hostile `attribution` body (10 KB utm string, `javascript:` referrer, `hc` that is not a uuid) → sanitised to capped strings / nulls, never a 500, never stored raw. (Task 1 `sanitiseEventAttribution` tests.)
3. Two bookings from the same campaign email, one via `/h/<slug>` then `/event/<slug>` → both attributed `host_email` with the campaign id (the capture runs on `/h/` too and the tab's first touch is kept). (Task 1 "first touch wins" test; Task 4 capture component on `/h/`.)
4. A host whose event has views but zero registrations, and one with registrations but zero views (pre-feature event) → `conversion_pct` is `0` and `null` respectively, never `Infinity`/`NaN`. (Task 5 tests.)
5. A campaign link that already carries a query (`/event/x?utm_source=ig`) or an `hc` → `hc` appended with `&`, never duplicated; a link to another host (`/h/other`) on the tenant host is tagged too (it is still "this campaign sent them"); an external link is untouched. (Task 6 tests.)

---

### Task 1: `src/lib/event-attribution.js` — the attribution object, both sides

**Files:**
- Create: `src/lib/event-attribution.js`, `src/lib/event-attribution.test.js`

**Interfaces:**
- Produces:
  - `EVENT_ATTRIBUTION_KEY = 'un1t_event_attribution'`
  - `rememberEventAttribution({ search = window.location.search, referrer = document.referrer } = {})` → browser; no-op after first call in a tab (first touch) and on any storage failure. Stores `{ session_id, utm_source, utm_medium, utm_campaign, utm_content, hc, referrer }` (raw strings, each `.slice(0, 300)`); `session_id` = `crypto.randomUUID()` when available else 16 random base36 chars.
  - `readEventAttribution()` → the stored object or `null` (raw; the server sanitises).
  - `sanitiseEventAttribution(input)` → `{ session_id, source, utm_source, utm_medium, utm_campaign, utm_content, host_campaign_id, referrer_host }` or `null` when `input` is not an object. Rules: `session_id` must match `/^[A-Za-z0-9_-]{8,64}$/` else `null`; utm_* trimmed, `.slice(0, 120)`, empty → `null`; `host_campaign_id` = `hc` only when `uuidLike.safeParse` passes, else `null`; `referrer_host` = lower-cased host of an http(s) referrer with leading `www.` removed, else `null`; `source` = `sourceOf(...)`.
  - `sourceOf({ host_campaign_id, utm_source, referrer_host })` → `'host_email'` when `host_campaign_id`; else `utm_source` lower-cased (≤40 chars) when present; else `referrerSourceLabel(referrer_host)` when present; else `'direct'`.
  - `referrerSourceLabel(host)` → `'instagram' | 'facebook' | 'google' | 'whatsapp' | 'strava' | 'linkedin' | 'tiktok' | 'x' | 'youtube'` for the known hosts (incl. `l.instagram.com`, `lm.facebook.com`, `m.facebook.com`, `wa.me`, `t.co`), else the host itself.
  - `sourceLabel(source)` → operator label: `host_email` → "Host email", `direct` → "Direct", `instagram` → "Instagram", `facebook` → "Facebook", `google` → "Google", `whatsapp` → "WhatsApp", `strava` → "Strava", `linkedin` → "LinkedIn", `tiktok` → "TikTok", `x` → "X", `youtube` → "YouTube", else the raw source.

- [ ] **Step 1: Write the failing tests** — `src/lib/event-attribution.test.js` (`// @vitest-environment jsdom`):
  - `rememberEventAttribution` stores first touch, keeps it on a second call with different params, generates a `session_id` matching the regex, swallows a throwing `sessionStorage.setItem`.
  - `readEventAttribution` → `null` when nothing stored or malformed JSON.
  - `sanitiseEventAttribution({ session_id: 'abc', utm_source: 'x'.repeat(500), hc: 'nope', referrer: 'javascript:alert(1)' })` → `session_id null`, `utm_source.length 120`, `host_campaign_id null`, `referrer_host null`, `source 'x…'`.
  - `sanitiseEventAttribution({ hc: '80000000-0000-4000-8000-000000000001', utm_source: 'instagram' })` → `source 'host_email'`.
  - `sanitiseEventAttribution({ referrer: 'https://l.instagram.com/?u=x' })` → `referrer_host 'l.instagram.com'`, `source 'instagram'`; `https://www.example.org/p` → `source 'example.org'`; `{}` → `source 'direct'`; `sanitiseEventAttribution('str')` → `null`.
  - `sourceLabel('host_email')` → `'Host email'`; `sourceLabel('example.org')` → `'example.org'`.
- [ ] **Step 2:** `npx vitest run src/lib/event-attribution.test.js` → FAIL (module missing).
- [ ] **Step 3:** Implement per Interfaces. `uuidLike` from `@/lib/schemas`. Browser helpers guard `typeof window === 'undefined'`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `HOSTSTATS.1 — event attribution: first-touch capture in the tab, server-side sanitiser and source labels`.

### Task 2: Migration 821 — `event_page_views` + `race_registrations.attribution`

**Files:**
- Create: `supabase/migrations/821_event_page_views.sql`, `tests/migration-821-event-page-views.test.js`

**Interfaces:**
- Produces table `public.event_page_views` (`id uuid pk default gen_random_uuid()`, `race_event_id uuid not null references race_events(id) on delete cascade`, `session_id text not null`, `source text not null default 'direct'`, `utm_campaign text`, `utm_content text`, `referrer_host text`, `day date not null`, `created_at timestamptz not null default now()`, `unique (race_event_id, session_id, day)`), index `(race_event_id, day)`, index `(created_at)` for the purge; `alter table … enable row level security; revoke all on public.event_page_views from anon, authenticated;` comments on table and `source`. `alter table public.race_registrations add column if not exists attribution jsonb;` + comment; header `-- grant: none (race_registrations has no client privilege, mig 682; event_page_views is service role only)`.

- [ ] **Step 1:** Test (copy `tests/migration-820-event-duration.test.js`'s style): file exists, contains `create table if not exists public.event_page_views`, the unique constraint text, `revoke all on public.event_page_views from anon, authenticated`, `enable row level security`, `add column if not exists attribution jsonb`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Write the migration. **Step 4:** Run the test + `npm run -s check:select-columns` (still green) → PASS.
- [ ] **Step 5:** Apply via Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj` (confirm with `list_projects`; never `tpttqakxmyxrwnqjepfm`), then `get_advisors` (security): no new ERROR. Verify with `execute_sql`: `select count(*) from information_schema.table_privileges where table_name='event_page_views' and grantee in ('anon','authenticated')` → 0.
- [ ] **Step 6:** Commit `HOSTSTATS.1 — mig 821: event_page_views and race_registrations.attribution`.

### Task 3: `POST /api/public/events/[slug]/view` + the register route stores attribution

**Files:**
- Create: `src/app/api/public/events/[slug]/view/route.js`, `…/view/route.test.js`
- Modify: `src/app/api/public/events/[slug]/register/route.js` (schema line ~60-110; both `race_registrations` inserts: lead_gen ~352, main ~890), `scripts/check-location-scoping.mjs` (EXEMPT, next to the `calendar.ics` entry), `src/lib/openapi.js`
- Test: `src/app/api/public/events/[slug]/register/route.attribution.test.js`

**Interfaces:**
- Consumes: `sanitiseEventAttribution`, `sourceOf` (Task 1); `eventIsPublic` from `@/lib/host-events`; `zoneOfLocation`, `todayStrIn` from `@/lib/location-time`; `checkRateLimit`/`getClientIp`/`rateLimitResponse`.
- Produces: `ViewBodySchema = z.object({ session_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), attribution: z.record(z.string(), z.unknown()).optional() })`. Rate limit key `event-view:${slug}:${ip}`, max 60 / 5 min. Reads `race_events` `id, active, status, host_id, location_id, locations:location_id ( timezone )` by slug + `active=true` + `status='published'`; not public → 404. Inserts `{ race_event_id, session_id, source, utm_campaign, utm_content, referrer_host, day: todayStrIn(zoneOfLocation(race.locations)) }`; insert error code `'23505'` → `{ success: true, data: { recorded: false } }` (same visitor, same day); other error → `logWarn('event-view', …)` + `{ success: true, data: { recorded: false } }` (telemetry never 5xxs the visitor); success → `{ recorded: true }`. The register body gains `attribution: z.record(z.string(), z.unknown()).nullable().optional()`; both inserts carry `attribution: sanitiseEventAttribution(body.attribution)`.

- [ ] **Step 1:** View route tests (`fakeDb` from `@/lib/event-waitlist.test-helpers`, mocks as in `calendar.ics/route.test.js`): records with `source 'instagram'` + `day` for `Europe/Dublin` under a fixed `vi.setSystemTime('2026-07-18T23:30:00Z')` → `day '2026-07-19'` (zone, not UTC); 404 for a draft; 23505 → `recorded false`, 200; a bad `session_id` → 400; a missing `attribution` → `source 'direct'`.
- [ ] **Step 2:** Register tests (copy the mocks block of `route.questions.test.js`): the main insert payload has `attribution.source 'host_email'` and `attribution.host_campaign_id` for a body with `attribution: { hc: <uuid>, session_id: 'sess-0001' }`; no attribution → `attribution: null`.
- [ ] **Step 3:** Run both → FAIL. **Step 4:** Implement route + schema + inserts; EXEMPT entry text: `'HOSTSTATS.1 page-view beacon: race_events row resolved by published slug + active/published (the same row the public event page serves); writes one event_page_views row keyed by that event; reads nothing else.'`; openapi `registerPath` for `post /api/public/events/{slug}/view` (tags `['Public']`, no security, 200/400/404/429).
- [ ] **Step 5:** Run both tests + `npm run -s check:location-scoping` + `npm run -s check:route-guards` → PASS.
- [ ] **Step 6:** Commit `HOSTSTATS.1 — the page-view beacon route; registrations store their attribution`.

### Task 4: The widget fires the beacon and sends attribution; `/h/<slug>` captures first touch

**Files:**
- Create: `src/components/EventAttributionCapture.jsx` (client; `useEffect(() => rememberEventAttribution(), [])`, renders null), `src/components/RaceSignupWidget.attribution.test.jsx`
- Modify: `src/components/RaceSignupWidget.jsx` (mount effect ~294; register body ~518), `src/app/h/[slug]/page.js` (render `<EventAttributionCapture />` at the top of the page body), `src/app/event/[slug]/page.js` (same, beside the widget; the widget's own call is the belt, this is braces for the SSR'd hero)

**Interfaces:**
- Consumes: `rememberEventAttribution`, `readEventAttribution` (Task 1).
- Produces: on mount the widget calls `rememberEventAttribution()` then `fetch('/api/public/events/${slug}/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id, attribution }) })` inside `try/catch` with `.catch(() => {})`, once per mount, only when `readEventAttribution()?.session_id` exists; the register body gains `attribution: readEventAttribution()` (may be `null`).

- [ ] **Step 1:** Widget test (jsdom; model on `RaceSignupWidget.calendar.test.jsx`): with `window.history.replaceState({}, '', '/event/mob?utm_source=instagram&hc=80000000-0000-4000-8000-000000000001')`, after render `fetch` was called with the `/view` URL and a body whose `session_id` matches the regex and `attribution.hc` is the uuid; submitting the form posts `attribution` with the same `session_id`; with `sessionStorage.setItem` throwing, no `/view` call and the submit body has `attribution: null`, and nothing throws.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run the new test + `src/components/RaceSignupWidget*.test.jsx` → PASS.
- [ ] **Step 5:** Commit `HOSTSTATS.1 — the widget records the view and sends its attribution; /h/ and /event/ capture first touch`.

### Task 5: `src/lib/event-stats.js` + the two stats routes + the Signups card on both pages

**Files:**
- Create: `src/lib/event-stats.js`, `src/lib/event-stats.test.js`, `src/app/api/host/events/[id]/stats/route.js` (+ `route.test.js`), `src/app/api/events/[id]/stats/route.js` (+ `route.test.js`), `src/components/EventSignupsCard.jsx` (+ `EventSignupsCard.test.jsx`, jsdom)
- Modify: `src/app/host/(portal)/events/[id]/page.js` (card between the header and `HostSeriesActions`), `src/app/(members)/events/[id]/teams/page.js` (card between `<header>` and `RaceTeamsManager`), `src/lib/openapi.js`

**Interfaces:**
- Consumes: `sourceLabel` (Task 1).
- Produces: `loadEventStats(db, eventId)` → `{ ok: true, stats }` | `{ ok: false, error }`. Reads, each paged by `readAll(query, orderCol)` (order asc, `.range(from, from+999)`, stop on a short page, at most 10 pages, `capped: true` when the cap hit): `event_page_views` `select('session_id, source')` by `race_event_id`; `race_registrations` `select('status, attribution')` by `race_event_id`; `event_waitlist` `select('status')` by `race_event_id`. `stats = { views, unique_visitors (distinct session_id), registrations (status !== 'cancelled'), confirmed (status === 'confirmed'), conversion_pct (confirmed / unique_visitors * 100, 1 dp; null when unique_visitors is 0), by_source: [{ source, label: sourceLabel(source), views, registrations }] sorted by views desc then registrations desc then source (a registration whose attribution is null counts under 'unknown', label 'Unknown'), waitlist: { waiting, offered, claimed }, capped }`. `EventSignupsCard({ stats, dark = false })` renders heading "Signups", four figures (Page views, Visitors, Booked, Conversion as `12.5%` or `—`), a "Where they came from" list (label · views · booked) only when `by_source.length > 0`, and a "Waitlist" line `waiting · offered · booked from the list` only when any waitlist count > 0; `stats` null → renders "Signup stats unavailable right now." Routes return `{ success: true, data: stats }`; a lib error → 503 `{ success: false, error: 'Unavailable' }`.

- [ ] **Step 1:** Lib tests: aggregates a fixture (3 views, 2 sessions, 2 registrations: one `instagram` confirmed, one `null` pending, 1 cancelled ignored; waitlist waiting/offered/claimed/expired) → exact `stats`; zero visitors → `conversion_pct null`; views but no registrations → `0`; a read error → `{ ok: false }`; 1,001 views → `.range` called twice.
- [ ] **Step 2:** Route tests: host route 401 without session, 404 for another host's event, 200 with `data.views`; staff route 403 without `races`, 404 outside the caller's studios, 200 (mock `getCurrentUser`/`assertLocationAccessOr404`/`hasRoleAtLocation`/`hasPermission*` as `duplicate/route.test.js` does — read it first).
- [ ] **Step 3:** Card tests: renders `12.5%`, `—` for null, "Host email" label, hides the waitlist line when all zero, the unavailable copy for `stats null`.
- [ ] **Step 4:** Run → FAIL. **Step 5:** Implement lib, routes (copy the auth prologues of the duplicate routes verbatim), card (`dark`: `border-white/10 bg-white/[0.02] text-white` idiom from `HostPromoCodes`; light: `border-un1t-border bg-un1t-surface text-un1t-text`, chips `bg-<c>-500/10 text-<c>-700`), pages (server: `const statsRes = await loadEventStats(db, race.id)` → `<EventSignupsCard stats={statsRes.ok ? statsRes.stats : null} dark />`), openapi entries for both GETs (`EventStatsResponse` schema).
- [ ] **Step 6:** Run all new tests + `npm run -s check:location-scoping` + `npm run -s check:select-columns` → PASS.
- [ ] **Step 7:** Commit `HOSTSTATS.1 — event stats lib, host and staff stats routes, the Signups card`.

### Task 6: Host campaign links carry `hc=<campaign id>`

**Files:**
- Create: `src/lib/host-campaign-links.js`, `src/lib/host-campaign-links.test.js`
- Modify: `src/lib/host-campaign-email.js` (`renderHostCampaignHtml` signature ~1084 and both return paths), `src/lib/host-campaign-queue.js` (~235: pass `campaignId: campaign.id, tenantHost: hostOf(baseUrl)`), `src/lib/host-campaign-email.test.js` (one new test)

**Interfaces:**
- Consumes: `markupTagSpans(html)` → spans `{ start, end, isEnd, name, attrs: [{ nameStart, nameEnd, valueStart, valueEnd, valueOuterStart, end }] }` (exported from `host-campaign-email.js`).
- Produces: `tagHostCampaignLinks(html, { campaignId, tenantHost })` → html with every `<a href>` whose decoded URL (`&amp;` → `&`) parses, has `.host.toLowerCase() === tenantHost.toLowerCase()`, and a pathname starting `/event/` or `/h/`, rewritten with `searchParams.set('hc', campaignId)` (so an existing `hc` is replaced, a query is joined with `&`), the value re-escaped (`&` → `&amp;`, `"` → `&quot;`); unchanged html (same string) when `campaignId` or `tenantHost` is falsy or nothing matched. Edits applied right-to-left over `valueStart..valueEnd` so offsets stay valid. `renderHostCampaignHtml({ …, campaignId = null, tenantHost = null })` runs `tagHostCampaignLinks` on its final string on both return paths.

- [ ] **Step 1:** Tests: tags `/event/x` and `/h/other` on the tenant host; joins `?utm_source=ig` with `&amp;hc=`; replaces an existing `hc`; leaves `https://other.example/event/x`, `/unsubscribe/host/t` and `mailto:` alone; no-op without `campaignId`; a `<a href='/event/x'>` single-quoted and a bare `<a href=/event/x>` are both tagged (valueOuterStart covers quoting — read `scrubTagAttributes` for the replacement idiom). `host-campaign-email.test.js`: `renderHostCampaignHtml({ host, subject, bodyHtml: '<a href="https://un1t.repset.ie/event/mob">Book</a>', unsubscribeUrl, campaignId: '8000…01', tenantHost: 'un1t.repset.ie' })` output contains `/event/mob?hc=8000…01`, and the footer unsubscribe link carries no `hc`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; queue computes `tenantHost` once per campaign: `let tenantHost = null; try { tenantHost = new URL(baseUrl).host } catch {}`.
- [ ] **Step 4:** Run the two test files + `src/lib/host-campaign-queue.test.js` → PASS.
- [ ] **Step 5:** Commit `HOSTSTATS.1 — host campaign event links carry hc=<campaign id>`.

### Task 7: Retention — the `purge-event-page-views` arm + mig 822 heartbeat row

**Files:**
- Create: `src/lib/event-page-views-purge.js`, `src/lib/event-page-views-purge.test.js`, `supabase/migrations/822_purge_event_page_views_heartbeat.sql`, `tests/migration-822-purge-event-page-views-heartbeat.test.js`
- Modify: `src/app/api/cron/purge-webhook-payloads/route.js` (after the tables loop, before the parent's stamp decision), `src/lib/cron-arm-health.js` (export `PURGE_EVENT_PAGE_VIEWS_HEARTBEAT = 'purge-event-page-views'` + a header paragraph), `src/app/api/cron/purge-webhook-payloads/route.test.js` (two tests)

**Interfaces:**
- Produces: `EVENT_PAGE_VIEWS_RETENTION_DAYS = 180`; `purgeEventPageViews(db, { nowMs = Date.now() } = {})` → `{ ok: true, deleted, pages, cutoff }` | `{ ok: false, error, deleted, pages, cutoff }`: delete-as-you-go, `select('id').lt('created_at', cutoff).order('created_at', { ascending: true }).range(0, 499)`, `delete().in('id', ids).lt('created_at', cutoff)`, short page ends, at most 20 pages. `runEventPageViewsPurgeArm(db)` → the result, and when `ok` awaits `stampHeartbeat(PURGE_EVENT_PAGE_VIEWS_HEARTBEAT, { deleted, pages, cutoff })` under its own try/catch (a failed stamp → `logWarn`, result unchanged). The parent route calls `runEventPageViewsPurgeArm(db)` inside `try/catch` after its loop, records `outcome.event_page_views = result`, and NEVER lets the arm change its own stamp decision or status code (an arm failure is logged by the arm and visible in its own stale row). Mig 822: `cron_heartbeats` row `('purge-event-page-views', now(), 86400, 43200, '<notes naming the arm, the 180-day rule, the parent cron and the 03:45 UTC slot>')` with the 805-style self-check `DO` block; `-- apply RIGHT AFTER the deploy that stamps it`.

- [ ] **Step 1:** Lib tests (`fakeDb`): deletes two pages then stops on a short page; nothing to purge → `deleted 0`, still stamps; a delete error → `ok false`, no stamp; cutoff is 180 days before `nowMs`. Parent tests: the arm's result appears in the response `data.event_page_views`; an arm that throws does not stop the parent from stamping `'purge-webhook-payloads'` (mock `@/lib/event-page-views-purge`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (+ migration + its text test as in Task 2).
- [ ] **Step 4:** Run the three test files → PASS; `grep -L stampHeartbeat src/app/api/cron/*/route.js` unchanged.
- [ ] **Step 5:** Commit `HOSTSTATS.1 — the page-view retention arm (180 days) with its own heartbeat row (mig 822, after deploy)`.
- [ ] **Step 6 (after the PR's deploy is live):** apply mig 822 via `apply_migration`; verify `select name, is_stale from cron_health where name='purge-event-page-views'`.

### Task 8: Gates, review, PR

- [ ] Run the twelve `check:*` gates + `npm run lint` + the touched test files; then `npm run build` ALONE (never beside the suite); then `npm test` alone.
- [ ] Fresh whole-branch review (model "fable") with the review package; fix pass; commit.
- [ ] `git fetch origin main && git merge origin/main`; push `host-signup-stats`; `gh pr create --base main`; changelog entry `docs/changelog/entries/<PR>.md`; auto-merge (merge).
