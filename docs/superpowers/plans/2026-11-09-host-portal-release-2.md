# Host Portal Release 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the five extras held back from the host portal reorganisation: tagged share links and an event QR, an email-your-list shortcut, a preview beside the Your page editor, and a new-ratings notice; plus a guard test for event column lists.

**Architecture:** Small additions to pages that already exist under `src/app/host/(portal)/`, two new host-scoped API routes, one pure lib, and edits to two client components. Read-only apart from creating an email draft. No migration.

**Tech Stack:** Next.js 16 App Router (JS), React Server Components, Supabase service-role client, Tailwind (dark host surface), Vitest + React Testing Library, `qrcode`.

**Spec:** `docs/superpowers/specs/2026-11-09-host-portal-release-2-design.md`. Read it first; it holds the copy and the rules each task implements.

## Global Constraints

- Every server page and route: `getCurrentHost()` first (page: `redirect('/host/login')`; route: 401 `{ success: false, error: 'Unauthorized' }`), then scope every read and write to `session.host.id`. Another host's event answers 404.
- Never pass a function from a Server Component to a Client Component (`tests/server-to-client-function-props.test.js`).
- A failed read never renders a 0 or an empty state that looks like an answer.
- Selects name their columns; destructure `error` on `.single()` / `.maybeSingle()` unless the chain pins `id`; `await` every write and judge its `error`; every `<button>` inside a `<form>` has a `type`.
- Zone maths only through `@/lib/location-time` / `@shared/zoned-time`; never the `'Europe/Dublin'` literal.
- API responses are `{ success, data?, error? }`; a new route is registered in `src/lib/openapi.js` and passes `npm run check:route-guards`.
- Every screen holds at 375px wide.
- Every RTL test file calls `afterEach(cleanup)` (`tests/rtl-cleanup-after-each.test.js`).
- One PR off `origin/main`. Commit subjects start `HOSTPORTAL.4 —`. One changelog file `docs/changelog/entries/<PR>.md` after `gh pr create`. No customer or host names in tests or the PR body.

## Review Focus

1. **A source token Insights will not accept.** A tagged link whose `utm_source` fails `event-attribution`'s token rule is silently filed as the referrer or "Direct". → Task 1 tests every share token and `qr` through the real `sourceOf`.
2. **An event URL that already has a query string or a trailing slash.** The tagged link must still be one valid URL. → Task 1.
3. **Another host's event id on the two new routes.** 404, and the draft route creates nothing. → Tasks 1 and 2.
4. **The announce draft's link is not tagged at send time**, so email bookings show as Direct. → Task 2 runs the real `host-campaign-links` tagger over the draft body.
5. **Double click on "Write an email".** One draft, not two. → Task 2.

---

### Task 1: tagged share links and the event QR

**Files:**
- Create: `src/lib/event-share-links.js`, `src/lib/event-share-links.test.js`, `src/app/api/host/events/[id]/qr/route.js`, `src/app/api/host/events/[id]/qr/route.test.js`, `src/components/host/EventShareLinks.jsx`, `src/components/host/EventShareLinks.test.jsx`
- Modify: `src/lib/event-attribution.js` (label `qr: 'QR code'`), `src/app/host/(portal)/events/[id]/promote/page.js` and its test, `src/lib/openapi.js`

**Interfaces — Produces:**
- `SHARE_SOURCES = [{ token: 'instagram', label: 'Instagram' }, { token: 'whatsapp', label: 'WhatsApp' }, { token: 'facebook', label: 'Facebook' }, { token: 'tiktok', label: 'TikTok' }, { token: 'x', label: 'X' }, { token: 'linkedin', label: 'LinkedIn' }]`, `QR_SOURCE = 'qr'`.
- `taggedEventUrl(url: string, source: string) → string`: the URL with `utm_source=<source>` set (replacing an existing one, keeping any other query and the hash); returns `url` unchanged when it cannot be parsed.
- `EventShareLinks({ url, eventId, onSale })` (client): the "Copy a link for" row (one button per `SHARE_SOURCES`, each copies `taggedEventUrl(url, token)` and shows "Copied" for 2 s), a "QR code" link to `/api/host/events/<eventId>/qr` with `download`, the help line, and the not-on-sale line when `onSale` is false.
- `GET /api/host/events/[id]/qr` → PNG as the spec describes.

- [ ] **Step 1: Write the failing tests**

```js
// event-share-links.test.js
import { sourceOf, attributionSourceLabel } from './event-attribution'
it('every share token and the QR token is a source Insights accepts and labels', () => {
  for (const { token, label } of SHARE_SOURCES) {
    expect(sourceOf({ utm_source: token })).toBe(token)
    expect(attributionSourceLabel(token)).toBe(label)
  }
  expect(sourceOf({ utm_source: QR_SOURCE })).toBe('qr')
  expect(attributionSourceLabel('qr')).toBe('QR code')
})
it('adds utm_source to a bare URL', () => {
  expect(taggedEventUrl('https://example.test/event/abc', 'instagram')).toBe('https://example.test/event/abc?utm_source=instagram')
})
it('keeps an existing query and hash, and replaces an existing utm_source', () => {
  expect(taggedEventUrl('https://example.test/event/abc?x=1&utm_source=old#top', 'x')).toBe('https://example.test/event/abc?x=1&utm_source=x#top')
})
it('returns the input unchanged when it is not a URL', () => {
  expect(taggedEventUrl('not a url', 'x')).toBe('not a url')
})
// qr/route.test.js
it('401s without a host session', async () => {})
it('404s for another host\'s event and for an event with no slug', async () => {})
it('answers a PNG whose QR text is the event URL with utm_source=qr', async () => { /* mock qrcode.toBuffer and assert the string it was given; assert content-type image/png and the attachment filename */ })
// EventShareLinks.test.jsx
it('copies the tagged link for each source', async () => { /* click each; navigator.clipboard.writeText called with taggedEventUrl(url, token) */ })
it('shows the not-on-sale line only when onSale is false', () => {})
it('links the QR button to the event\'s QR route', () => {})
```

- [ ] **Step 2:** `npx vitest run src/lib/event-share-links.test.js 'src/app/api/host/events/[id]/qr' src/components/host/EventShareLinks.test.jsx` → FAIL.
- [ ] **Step 3:** Implement. On the Promote page render `<EventShareLinks url eventId onSale={eventIsPublic(event)} />` inside the Share block under the existing URL row (the event read gains `status, active`); when the URL is unavailable render none of it. Register the route in `openapi.js` beside `/api/host/signup-qr`.
- [ ] **Step 4:** tests PASS; also `npx vitest run 'src/app/host' src/lib/event-attribution.test.js tests/server-to-client-function-props.test.js`, `npm run check:route-guards`, `npm run check:location-scoping`.
- [ ] **Step 5:** Commit `HOSTPORTAL.4 — tagged share links and an event QR on the Promote tab`.

### Task 2: "Write an email about this event"

**Files:**
- Create: `src/lib/host-announce-draft.js`, `src/lib/host-announce-draft.test.js`, `src/app/api/host/events/[id]/announce-draft/route.js`, `…/announce-draft/route.test.js`, `src/components/host/AnnounceEventButton.jsx`, `src/components/host/AnnounceEventButton.test.jsx`
- Modify: `src/app/host/(portal)/events/[id]/promote/page.js` and its test, `src/components/host/HostEmails.jsx` and `HostEmails.test.jsx`, `src/lib/openapi.js`

**Interfaces — Produces:**
- `announceDraft({ event, sessions, eventUrl, zone }) → { subject: string, body_html: string }` (pure): subject = `event.name` cut to 200 characters; body as the spec describes. `sessions` = `[{ time: 'HH:MM', label }]`.
- `POST /api/host/events/[id]/announce-draft` → 201 `{ success: true, data: { id } }`; 401 no session; 404 not this host's event; 409 `{ success: false, error: 'Publish this event before emailing your list about it.' }` when `!eventIsPublic(event)`; 500 with the insert's message on a failed write.
- `AnnounceEventButton({ eventId, onSale, contactCount })` (client): shows the count line and the button; while a request is in flight the button is disabled; on success `router.push('/host/emails?open=<id>&notice=event')`; on failure shows the server's `error`. When `onSale` is false it renders the 409 sentence and no button.
- `HostEmails`: `?open=<id>` opens that draft once, after the campaign list has loaded, through the existing open-draft function; `?notice=event` sets the notice from the spec.

- [ ] **Step 1: Write the failing tests**

```js
// host-announce-draft.test.js
import { tagHostCampaignLinks } from './host-campaign-links' // use the real export name in that file
it('uses the event name as the subject, cut to 200 characters', () => {})
it('names the date, every session time, the venue and a Book your place link to the event URL', () => {})
it('escapes the event name and venue', () => { /* a name containing <script> and & */ })
it('produces a link the campaign tagger tags with hc', () => { /* run the real tagger over body_html with a campaign id and the URL's host; expect hc=<id> on the event link */ })
// announce-draft/route.test.js
it('401s without a session; 404s for another host\'s event and inserts nothing', async () => {})
it('409s for an event that is not on sale and inserts nothing', async () => {})
it('inserts one draft for this host with audience_kind all, email_type marketing, status draft and no design_json', async () => {})
it('answers 500 with the message when the insert fails', async () => {})
// AnnounceEventButton.test.jsx
it('posts once on a double click and goes to the composer with open and notice', async () => {})
it('shows the server error and stays', async () => {})
it('shows the publish-first sentence and no button when not on sale', () => {})
// HostEmails.test.jsx (add)
it('opens the draft named by ?open once the list has loaded, and only once', async () => {})
it('shows the event-draft notice for ?notice=event', async () => {})
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement. The Promote page gains an "Email your list" block between Share and Promo codes; its contact count is one `head: true` count on `host_contacts` for this host (a failed count renders the button with no count line). Read `src/lib/host-campaign-email.js`, `host-campaign-links.js` and `src/app/api/host/emails/preview/route.js` before fixing the body's format, and state the format you chose in your report. Register the route in `openapi.js`.
- [ ] **Step 4:** tests PASS; also `npx vitest run src/components/host 'src/app/host' 'src/app/api/host' tests/server-to-client-function-props.test.js tests/rtl-cleanup-after-each.test.js`, `npm run check:route-guards`, `npm run check:location-scoping`, `npm run check:select-columns`.
- [ ] **Step 5:** Commit `HOSTPORTAL.4 — write an email about this event, from the Promote tab`.

### Task 3: a preview beside the Your page editor

**Files:**
- Modify: `src/components/host/HostYourPage.jsx`, `src/components/host/HostYourPage.test.jsx`

`HostYourPage` already receives `url`. Derive the preview path from it (`new URL(url).pathname`, expected `/h/<slug>`; anything else → no preview). From `lg`: a two-column grid, editor left, preview right in a `sticky top-4` column: an `<iframe title="Preview of your public page" src={path} loading="lazy">` in a bordered frame about 640px tall, with the caption "This shows your saved page. Save to update it." A successful save (the editor's existing `onSaved`) bumps a counter used as the iframe's `key`, so it reloads. Below `lg`: the preview sits under the editor behind a `type="button"` "Show preview" / "Hide preview" toggle, closed by default, and the iframe is not rendered while closed.

- [ ] **Step 1: tests**

```js
it('renders an iframe of the page\'s own path with a title', () => { /* src === '/h/demo-host' for url https://example.test/h/demo-host */ })
it('reloads the preview after a successful save', async () => { /* the iframe element is a new node after save */ })
it('renders no preview when the url is not a /h/ page', () => {})
it('keeps the preview closed behind Show preview until asked', () => { /* the toggle exists; assert via the toggle\'s aria-expanded and the small-screen container */ })
```

- [ ] **Step 2:** FAIL. **Step 3:** implement (one iframe in the DOM at a time: choose the column or the toggled panel with CSS classes on wrappers, not two iframes loading the same page). **Step 4:** PASS, plus `npx vitest run src/components/host 'src/app/host/(portal)/page' tests/rtl-cleanup-after-each.test.js`. **Step 5:** Commit `HOSTPORTAL.4 — a preview beside the Your page editor`.

### Task 4: new ratings on the Overview

**Files:**
- Modify: `src/lib/host-rollup.js`, `src/lib/host-rollup.test.js`, `src/app/host/(portal)/page.js`, `src/app/host/(portal)/page.test.js`

**Interfaces — Produces:** `loadRecentRatingCounts(db, { eventIds, sinceIso }) → Promise<Map<string, number>|null>`: rows of `event_ratings` (`race_event_id` only) with `created_at >= sinceIso` for those events, paged past 1,000 with an order, ids chunked by 100, grouped to a count per event; `null` when any read failed; an empty map for no ids.

Overview: `sinceIso` = local midnight 7 days back in the host's zone, built the way the 30-day window is. In "Needs your attention", after the existing lines, up to three neutral lines (not the amber style), ordered by the event's date newest first: "{n} new rating{s} on **{event name}** this week. Read them →" linking to `/host/events/<id>/insights`. The block's heading shows when there is at least one line of any kind. `null` → no rating lines and a `logWarn`.

- [ ] **Step 1: tests**

```js
it('counts ratings per event since the boundary, hidden and public alike', async () => {})
it('returns null when a page fails and an empty map for no ids', async () => {})
it('Overview shows a singular and a plural line linking to Insights, at most three', async () => {})
it('Overview shows the attention heading for a rating line alone', async () => {})
it('Overview shows no rating line when the read failed', async () => {})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS, plus `npm run check:select-columns` and `npm run check:location-scoping`. **Step 5:** Commit `HOSTPORTAL.4 — new ratings on the Overview`.

### Task 5: guard for event column lists

**Files:**
- Create: `tests/host-event-columns-guard.test.js`

As spec § 5. Read `scripts/check-select-columns.mjs` (or whatever `npm run check:select-columns` runs) for the schema replay and reuse its exported functions if it exports any; if it exports nothing, import nothing and say so: then the guard may shell out to nothing and must instead parse the migrations with the smallest reader that proves top-level columns of `race_events` (CREATE TABLE, ADD COLUMN, DROP COLUMN, RENAME COLUMN). The test must find at least six `loadHostEvent(` call sites (fail if it finds fewer, so a refactor cannot silently empty it), must fail on a made-up column (prove it inside the test with a synthetic call-site string), and must pass on main as it is.

- [ ] **Step 1:** write the guard with its self-check. **Step 2:** run it → it must PASS on the real tree and its synthetic bad column must be caught. **Step 3:** Commit `HOSTPORTAL.4 — guard: every loadHostEvent column exists on race_events`.

### Task 6: ship

- [ ] CI mirror (the thirteen commands in `CLAUDE.md`), then `npm run build` on its own.
- [ ] `git push -u origin HEAD`, `gh pr create --base main` titled `HOSTPORTAL.4 — share links, event QR, email shortcut, page preview, new ratings`, add `docs/changelog/entries/<PR>.md`, push (check the PR is still open in the same command).
