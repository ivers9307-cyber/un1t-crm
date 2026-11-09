# Host Portal Reorganisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regroup the signed-in host portal (`/host`) into six nav places and give each event a five-tab page, with four small additions that write nothing new.

**Architecture:** Server-rendered pages under `src/app/host/(portal)/`, each scoped by `getCurrentHost()` then `host_id`. Existing client components (`HostAttendeeTable`, `HostPromoCodes`, `EventSignupsCard`, …) move between pages unchanged; new work is page composition, four small libs in `src/lib/`, and edits to `HostNav`, `HostEventForm`, `HostPayouts` and `HostListPageEditor`. No API behaviour change, no migration.

**Tech Stack:** Next.js 16 App Router (JS, not TS), React Server Components, Supabase service-role client, Tailwind (dark host surface), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-09-host-portal-reorganisation-design.md`. Read it first; § 8 is the nothing-lost table every PR is checked against.

## Global Constraints

- Every server page: `const session = await getCurrentHost(); if (!session) redirect('/host/login')`, then any event read goes through `loadHostEvent` (Task 1) and `notFound()` on null. A layout is never the only gate.
- Another host's event id answers 404 on every route, the `/edit` redirect included.
- Never pass a function from a Server Component to a Client Component (`tests/server-to-client-function-props.test.js`). URL templates and plain data only.
- A failed read renders that block's "unavailable" line; never a 0 that looks like an answer.
- A non-Stripe host (`session.host.payment_provider !== 'stripe_connect'`) never sees net, fees, balance or payouts. Money label is "net" for Stripe, "gross" otherwise.
- "Sold" = `paidCount` from `getHostRevenue`; no figure when an event has no payments. "Booked" = the gate count (Task 2).
- "Today" = `todayIsoIn(zone)` on the host's anchor studio zone (Task 1's `loadHostToday`). Zone maths only through `@/lib/location-time` / `@shared/events`; never the `'Europe/Dublin'` literal.
- Selects name their columns; `.single()`/`.maybeSingle()` destructure `error` unless the chain pins `id`; every `<button>` inside a `<form>` has a `type`.
- Dark surface: reuse the `bg-<c>-500/15 text-<c>-300` chip recipe already in the host pages.
- Every screen holds at 375px wide (no horizontal page scroll; strips scroll inside themselves).
- Status labels come from `HOST_EVENT_STATUS_LABEL` (Draft, In review, Published, Needs changes); never retype them.
- Three PRs, each off fresh `origin/main` in a worktree, each leaving the portal whole. One changelog file per PR (`docs/changelog/entries/<PR>.md`) added after `gh pr create`. Run `npm ci` in a new worktree first. Run the CI mirror once, then `npm run build` on its own (never the full suite beside the build). Check the PR is still open in the same command as any later push. No customer or host names in PR bodies or tests.

## Review Focus

1. **A host with no events, or none upcoming and published.** Overview shows the "create one" line instead of Next up; Events shows the "create your first one" line; nothing crashes on empty arrays. → tests in Tasks 4 and 7.
2. **A non-Stripe host.** Earnings shows two tiles, By event (gross) and Statements, with no empty Balance or Payouts heading; Overview and rows say "gross". → tests in Tasks 5 and 7.
3. **Another host's event id, on every tab and on `/edit`.** 404, with no redirect that confirms the id exists. → test in Task 10 (layout) and one per tab page in Tasks 11 to 14.
4. **A session with no capacity (`race_waves.capacity` NULL) or a legacy `capacity_mode = 'teams'` event.** The bar shows "N booked" with no fill and no NaN; totals omit the "/ capacity". → tests in Task 2.
5. **A read fails mid-page (stats, fill, ratings, roll-up).** That block says unavailable, the rest renders, and no figure reads 0. → tests in Tasks 2, 7, 12 and 18.

Also pinned where it lives: an event dated today counts as upcoming, and a past-dated draft sits under Past (Task 1); a save with no edits never prompts and a dirty form always does (Task 9, Task 13).

---

# PR 1 — HOSTPORTAL.1: the six places

Branch `host-portal-six-places`. After this PR: new nav, `/host/events`, `/host/earnings`, `/host/page`, slim Overview. The event page and edit page are untouched except for one added link.

### Task 1: `host-portal` lib

**Files:**
- Create: `src/lib/host-portal.js`, `src/lib/host-portal.test.js`

**Interfaces — Produces:**
- `loadHostToday(db, host) → Promise<{ zone: string, today: string }>`: zone from `getLocationZone(db, <event_hosts.anchor_location_id>)`; on any error `logWarn` and fall back to `DEFAULT_TZ`. `today = todayIsoIn(zone)`. (Move this out of `(portal)/page.js`, which does it inline today.)
- `loadHostEvent(db, hostId, eventId, columns) → Promise<object|null>`: `race_events` by `id`, `columns` must include `host_id`; returns null when missing, errored, or `host_id !== hostId`.
- `groupHostEvents(events, today) → { needsAction, upcoming, past }`: `needsAction` = status `draft`|`rejected` and `race_date >= today`; `upcoming` = status `published`|`pending_review` and `race_date >= today`, soonest first; `past` = `race_date < today` (any status), newest first. A null `race_date` on a draft/rejected event goes to `needsAction`; on any other status to `upcoming`.
- `eventLandingHref(event) → string`: `/host/events/<id>/edit` for `draft`|`rejected`, else `/host/events/<id>`. (Task 13 changes `/edit` to `/setup`.)
- `HOST_STATUS_CHIP` (the four-entry map now inline in `page.js`) and `formatHostMoney(cents, currency)` (the `formatMoney` now duplicated in `page.js` and `HostPayouts.jsx`).
- `moneyLabel(host) → 'net' | 'gross'` and `eventMoneyCents(host, perEventRow) → number` (`net_to_host_cents` for Stripe, `gross_cents` otherwise).
- `loadPublicRatingAverages(db, eventIds) → Promise<Map<string, { average: number, count: number }>|null>`: public ratings only, one decimal; null when the read failed; empty map for no ids. Use the table and column names `src/app/api/host/events/[id]/ratings/route.js` uses; page past 1,000 rows.

- [ ] **Step 1: Write the failing tests**

```js
describe('groupHostEvents', () => {
  const ev = (id, status, race_date) => ({ id, status, race_date })
  it('puts today in upcoming and yesterday in past', () => {
    const g = groupHostEvents([ev('a', 'published', '2026-11-09'), ev('b', 'published', '2026-11-08')], '2026-11-09')
    expect(g.upcoming.map((e) => e.id)).toEqual(['a'])
    expect(g.past.map((e) => e.id)).toEqual(['b'])
  })
  it('files a future draft and a future rejected event under needsAction', () => {
    const g = groupHostEvents([ev('d', 'draft', '2026-12-01'), ev('r', 'rejected', '2026-12-02'), ev('p', 'pending_review', '2026-12-03')], '2026-11-09')
    expect(g.needsAction.map((e) => e.id).sort()).toEqual(['d', 'r'])
    expect(g.upcoming.map((e) => e.id)).toEqual(['p'])
  })
  it('files a past-dated draft under past, not needsAction', () => {
    const g = groupHostEvents([ev('old', 'draft', '2026-10-01')], '2026-11-09')
    expect(g.needsAction).toEqual([]); expect(g.past.map((e) => e.id)).toEqual(['old'])
  })
  it('orders upcoming soonest first and past newest first', () => { /* 3 dates each way */ })
  it('returns three empty arrays for no events', () => {
    expect(groupHostEvents([], '2026-11-09')).toEqual({ needsAction: [], upcoming: [], past: [] })
  })
})
describe('eventLandingHref', () => {
  it('opens a draft and a rejected event on the edit form', () => {
    expect(eventLandingHref({ id: 'e1', status: 'draft' })).toBe('/host/events/e1/edit')
    expect(eventLandingHref({ id: 'e1', status: 'rejected' })).toBe('/host/events/e1/edit')
  })
  it('opens every other status on the event page', () => {
    expect(eventLandingHref({ id: 'e1', status: 'published' })).toBe('/host/events/e1')
    expect(eventLandingHref({ id: 'e1', status: 'pending_review' })).toBe('/host/events/e1')
  })
})
describe('loadHostEvent', () => {
  it('returns null for another host\'s event', async () => { /* db stub row host_id 'h2', hostId 'h1' → null */ })
  it('returns null on a read error and on no row', async () => {})
  it('returns the row for its own host', async () => {})
})
describe('moneyLabel / eventMoneyCents', () => {
  it('is net for stripe_connect and gross for anything else', () => {
    expect(moneyLabel({ payment_provider: 'stripe_connect' })).toBe('net')
    expect(moneyLabel({ payment_provider: 'revolut' })).toBe('gross')
    expect(eventMoneyCents({ payment_provider: 'revolut' }, { net_to_host_cents: 0, gross_cents: 5000 })).toBe(5000)
  })
})
describe('loadPublicRatingAverages', () => {
  it('averages public ratings per event to one decimal', async () => { /* 5,4,4 → 4.3, count 3 */ })
  it('returns null when the read fails, and an empty map for no ids', async () => {})
})
```

- [ ] **Step 2:** `npx vitest run src/lib/host-portal.test.js` → FAIL (module not found).
- [ ] **Step 3:** Implement the eight exports. Then replace the inline `STATUS_CHIP`, `formatMoney` and the zone lookup in `src/app/host/(portal)/page.js` with imports (behaviour identical).
- [ ] **Step 4:** `npx vitest run src/lib/host-portal.test.js` → PASS.
- [ ] **Step 5:** Commit `HOSTPORTAL.1 — host-portal lib: event loader, grouping, landing link, money label, rating averages`.

### Task 2: session fill

**Files:**
- Modify: `src/lib/registration-move.js` (export the existing `loadWaveRegistrations` and `groupByWave`; no behaviour change)
- Create: `src/lib/host-session-fill.js`, `src/lib/host-session-fill.test.js`

**Interfaces — Produces:**
- `sessionFill(waves, rowsByWave, nowMs, event) → { sessions: Array<{ id, label, time, capacity: number|null, booked: number, full: boolean }>, booked: number, capacity: number|null }`. Pure. `booked` per wave = `loadForMode(holdingPlaces(rows, nowMs, event), mode, { held: true })` with `mode = event.capacity_mode === 'people' ? 'people' : 'teams'` (the exact gate count in `register/route.js`). `time` = `start_time.slice(0, 5)`. `full` = capacity is a number and `booked >= capacity`. Total `capacity` is null if any wave's is null. Waves sorted by `display_order` then `start_time`.
- `loadSessionFill(db, event) → Promise<{ ok: true, ...sessionFill } | { ok: false }>`: `event` carries `id, capacity_mode, entry_policy, race_waves ( id, start_time, capacity, label, display_order )`.

- [ ] **Step 1: Write the failing tests**

```js
const wave = (id, capacity, start_time = '10:00:00', label = null) => ({ id, capacity, start_time, label, display_order: 0 })
const reg = (status, size, registered_at = '2026-11-09T09:00:00Z') => ({ status, registered_at, team: { size } })
const NOW = Date.parse('2026-11-09T10:00:00Z')
it('counts confirmed people plus unpaid entries still holding a place', () => {
  const out = sessionFill([wave('w1', 30)], new Map([['w1', [reg('confirmed', 4), reg('pending_payment', 2)]]]), NOW, { capacity_mode: 'people' })
  expect(out.sessions[0]).toMatchObject({ booked: 6, capacity: 30, full: false, time: '10:00' })
})
it('drops an unpaid entry whose hold has lapsed', () => {
  const stale = reg('pending_payment', 2, '2026-11-01T09:00:00Z') // older than the default 48h hold
  expect(sessionFill([wave('w1', 30)], new Map([['w1', [stale]]]), NOW, { capacity_mode: 'people' }).sessions[0].booked).toBe(0)
})
it('marks a session full at capacity', () => { /* 30 of 30 → full true */ })
it('handles a session with no capacity: booked count, capacity null, never full, total capacity null', () => {
  const out = sessionFill([wave('w1', null), wave('w2', 10, '12:30:00')], new Map([['w1', [reg('confirmed', 3)]]]), NOW, { capacity_mode: 'people' })
  expect(out.sessions[0]).toMatchObject({ booked: 3, capacity: null, full: false })
  expect(out.capacity).toBeNull(); expect(out.booked).toBe(3)
})
it('counts teams, not people, on a teams-mode event', () => { /* two regs of size 4 → booked 2 */ })
it('returns no sessions for an event with no waves', () => { expect(sessionFill([], new Map(), NOW, {}).sessions).toEqual([]) })
it('loadSessionFill answers ok:false when the wave read fails', async () => {})
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS; also `npx vitest run src/lib/registration-move` → PASS (exports only).
- [ ] **Step 5:** Commit `HOSTPORTAL.1 — per-session booked count on the gate's rule`.

### Task 3: nav

**Files:**
- Modify: `src/components/host/HostNav.jsx`, `src/components/host/HostNav.test.jsx`

`LINKS`, in order: `{ href: '/host', label: 'Overview', exact: true }`, `/host/events` Events, `/host/contacts` Contacts, `/host/emails` Emails, `/host/earnings` Earnings, `/host/page` Your page. Export `LINKS`. The `<nav>` becomes a horizontally scrolling strip (`flex overflow-x-auto whitespace-nowrap`, full width below the brand row under `sm`).

- [ ] **Step 1:** In the test, rename `DASHBOARD` to `OVERVIEW` and add:

```js
it('lights Events on the list, an event page and the create page', () => {
  for (const p of ['/host/events', '/host/events/e1', '/host/events/e1/setup', '/host/events/new']) expect(isNavActive(p, EVENTS)).toBe(true)
})
it('lights Your page on /host/page only', () => {
  expect(isNavActive('/host/page', YOUR_PAGE)).toBe(true)
  expect(isNavActive('/host/pages', YOUR_PAGE)).toBe(false)
})
it('lists the six places in order', () => {
  expect(LINKS.map((l) => l.label)).toEqual(['Overview', 'Events', 'Contacts', 'Emails', 'Earnings', 'Your page'])
})
```

Delete the old "does not light up any link on an unrelated section" case for `/host/events/new` (Events now owns it).

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `HOSTPORTAL.1 — six nav places`.

### Task 4: Events page

**Files:**
- Create: `src/app/host/(portal)/events/page.js`, `src/app/host/(portal)/events/page.test.js`, `src/components/host/HostEventRow.jsx`, `src/components/host/HostPastEvents.jsx`
- Modify: `src/app/host/(portal)/events/[id]/page.js` (add a "View event page" link to `/event/<slug>`, new tab, beside Export CSV: the row's View link is about to go)

**Interfaces — Consumes:** Task 1 exports; `getHostRevenue`; `listHostSeries`; `HostSeriesList`; `HostSubmitButton`.
**Produces:** `HostEventRow({ event, detail, action })`, a server-safe component: name + chip, `detail` string, wrapped in a link to `eventLandingHref(event)`; `action` is an optional node (the Submit button) rendered outside the link. `HostPastEvents({ rows })`, a client component showing the first 20 rows with a "Show all" button (`rows` = plain `{ id, name, status, statusLabel, href, detail }`).

Page: heading "Events" with "N events · M series". Groups in order Needs action, Upcoming, Series, Past; a group with no rows is not rendered. Row detail: date, then `· N sold · €X net|gross` when the event has a revenue row; past rows add `· ★ 4.8 (19)` when `loadPublicRatingAverages` has an entry. A draft row's `action` is `<HostSubmitButton eventId />`; a rejected row has none. No events at all: the existing "No events yet — create your first one" line.

- [ ] **Step 1: Write the failing test** (style of `events/[id]/page.waitlist.test.js`: mock `host-auth`, `supabase`, `host-revenue`, `event-series`, `host-portal`'s loaders; call `Page()`; walk the element tree):

```js
it('renders the four groups in order, each only when it has rows', async () => {})
it('gives a draft row the submit button and a needs-changes row none', async () => {})
it('renders the first-event line and no groups for a host with no events', async () => {})
it('says gross, never net, for a non-Stripe host', async () => {})
it('omits the sold figure for an event with no payments', async () => {})
it('still renders the lists when revenue and ratings reads fail', async () => {})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS, and `npx vitest run 'src/app/host/(portal)/events/[id]'` still PASS.
- [ ] **Step 5:** Commit `HOSTPORTAL.1 — /host/events: needs action, upcoming, series, past`.

### Task 5: Earnings page

**Files:**
- Modify: `src/components/host/HostPayouts.jsx` → named exports `HostPayoutsProvider({ children })` (fetches `/api/host/stripe/payouts` once, context value `data|null`), `HostBalance()` (heading "Balance" + Available / On the way), `HostPayoutList()` (heading "Payouts" + list or "No payouts yet."). Each of the two renders nothing, heading included, when data is null. Keep the default export (built from the three) until Task 7 stops importing it, then remove it there.
- Create: `src/components/host/HostPayouts.test.jsx`, `src/app/host/(portal)/earnings/page.js`, `src/app/host/(portal)/earnings/page.test.js`

Page order inside `<HostPayoutsProvider>`: h1 "Earnings"; the "N paid bookings · €X collected after refunds" line and the Stripe dashboard link (both conditions exactly as `(portal)/page.js` has them today); `<HostBalance />`; "All time" tiles (the four-tile Stripe set or the two-tile set, moved verbatim, booking-fee label included); "By event" (one row per `revenue.perEvent`: date, name, `N sold`, money by `eventMoneyCents`, linking to `/host/events/<event_id>`); `<HostPayoutList />`; `<HostStatements />`. `revenue === null` → "Revenue is unavailable right now."; `paidCount === 0` → "No ticket sales yet." in place of tiles and By event.

- [ ] **Step 1: Write the failing tests**

```js
// HostPayouts.test.jsx
it('renders neither heading when the fetch returns no data', async () => {})
it('renders Balance and Payouts from one fetch', async () => { /* fetch mock called exactly once */ })
// earnings/page.test.js
it('shows four tiles for a Stripe host and two for any other', async () => {})
it('never renders Net to you or booking fees for a non-Stripe host', async () => {})
it('lists by-event rows with gross for a non-Stripe host', async () => {})
it('shows the unavailable line when revenue throws', async () => {})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `HOSTPORTAL.1 — /host/earnings: balance, all time, by event, payouts, statements`.

### Task 6: Your page

**Files:**
- Modify: `src/components/host/HostListPageEditor.jsx`: add prop `layout` (`'drawer'` default = today's markup; `'sections'` = the same fields grouped under seven headings, in this order: "Top of page" (`list_headline`, `list_blurb`, `hero_image_url`, `accent_hex`), "About you" (`about_text`), "Upcoming events" (`events_headline`, `events_blurb`), "Photos", "What people say" (testimonials + Show ratings), "Past events" (Show past events), "Join the list" (`list_button_label`, `list_success_message`)). In `'sections'` there is no Cancel button and `onClose` is not required. One Save, same PATCH.
- Create: `src/components/host/HostYourPage.jsx` (client): `HostYourPage({ url, joinUrl, signupCount, copyValues })`. Heading row with Open / Copy link / QR code (`/api/host/signup-qr`), the URL and "N list signups", the editor in `layout="sections"` (holding `copy` state the way `HostSignupPageCard` does), then "Signup form only" with Copy link / Open / QR code (`/api/host/signup-qr?page=join`) and the line "Just the form, for bios and stories."
- Create: `src/app/host/(portal)/page/page.js` (move the `signupUrl` / `joinUrl` / `signupCount` / `signupCopy` block out of `(portal)/page.js` verbatim), `src/components/host/HostYourPage.test.jsx`

- [ ] **Step 1: Write the failing tests** (extend `HostListPageEditor.extras.test.jsx` for the layout; new file for the page component):

```js
it('sections layout renders the seven headings in visitor order', () => {
  expect(headings()).toEqual(['Top of page', 'About you', 'Upcoming events', 'Photos', 'What people say', 'Past events', 'Join the list'])
})
it('sections layout sends the same PATCH body as the drawer layout for the same edits', async () => {})
it('sections layout has no Cancel button', () => {})
it('HostYourPage shows both links with their own QR hrefs', () => {})
```

If the signup block fails on the server page, render "Your page is unavailable right now." (today the card just hides).

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `HOSTPORTAL.1 — /host/page: the public page editor in visitor order`.

### Task 7: Overview

**Files:**
- Rewrite: `src/app/host/(portal)/page.js`; Create: `src/app/host/(portal)/page.test.js`

Sections, top to bottom (spec § 6.3; the "Last 30 days" row arrives in Task 18):
1. "Welcome, {host name}." and today's date in the anchor zone.
2. "Needs your attention" (heading only when it has a line): the Stripe warning (today's condition and copy); one amber line per `rejected` event: bold name, "needs changes.", then `{brand.name} asked: "<rejected_reason>"` when the reason is set, then a link "Open →" to `eventLandingHref(event)`. The events select becomes `id, name, slug, race_date, kind, active, status, rejected_reason, venue_name, capacity_mode, entry_policy, race_waves ( id, start_time, capacity, label, display_order )` (what `loadSessionFill` and the Next up card need).
3. "Next up": the first `upcoming` event with status `published`. Name, chip, date, session times, venue; buttons "Attendees" (`/host/events/<id>`) and "Event page" (`/event/<slug>`, new tab). Tiles: Booked (`booked / capacity`, or `booked` alone when capacity is null; sub-line naming any full session; "unavailable" when `loadSessionFill` is `ok: false`), Waitlist (`stats.waitlist.waiting`), Page views (`stats.views`, sub-line `<conversion_pct>% booked` when not null), "Net so far"/"Gross so far" (sub-line `N sold`; omitted figure → "—" when no revenue row). Stats from `loadEventStats`; when `ok: false` both stats tiles read "unavailable". No such event → one line: "Nothing on sale yet — create an event." linking to `/host/events/new`.
4. "Coming up": the first three of `[...needsAction, ...upcoming]` sorted by date, as `HostEventRow`s with the same detail string as the Events page rows, then "All events →" (`/host/events`). Not rendered when empty.

Removed from this page: signup card, revenue tiles, `HostPayouts`, `HostStatements`, `HostSeriesList`, the full list. With the imports gone, delete `src/components/host/HostSignupPageCard.jsx` and the default export of `HostPayouts.jsx` in this task.

- [ ] **Step 1: Write the failing tests**

```js
it('shows the reviewer note for a needs-changes event with a link to it', async () => {})
it('renders no Needs your attention heading when nothing needs attention', async () => {})
it('picks the nearest published upcoming event for Next up, skipping an earlier draft', async () => {})
it('shows the create line when there is no published upcoming event', async () => {})
it('reads unavailable, not 0, when the stats or the fill read fails', async () => {})
it('labels the money tile gross for a non-Stripe host', async () => {})
it('no longer renders payouts, statements, the series list or the signup card', async () => {})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `HOSTPORTAL.1 — /host is a short Overview`.

### Task 8: ship PR 1

- [ ] Walk spec § 8 against the running app (`npm run dev`, a host session): every row reachable. Check each new page at 375px.
- [ ] CI mirror (the thirteen commands in `CLAUDE.md`), then `npm run build`.
- [ ] `git push -u origin HEAD`, `gh pr create --base main` titled `HOSTPORTAL.1 — the host portal's six places`, add `docs/changelog/entries/<PR>.md`, push.

---

# PR 2 — HOSTPORTAL.2: the event page's five tabs

Branch `host-portal-event-tabs`, off `origin/main` after PR 1 merges.

### Task 9: unsaved-changes guard

**Files:**
- Create: `src/lib/unsaved-guard.js`, `src/lib/unsaved-guard.test.js`, `src/components/host/GuardedLink.jsx`
- Modify: `src/components/host/HostNav.jsx` (links become `GuardedLink`), `src/app/host/(portal)/layout.js` (the "+ Create event" link becomes `GuardedLink`)

**Interfaces — Produces:**
- `setUnsaved(flag: boolean)`, `hasUnsaved() → boolean`, `confirmLeave() → boolean` (true when nothing is unsaved, else the result of `window.confirm('You have unsaved changes. Leave without saving?')`; clears the flag when the answer is yes).
- `GuardedLink(props)`: `next/link` whose `onClick` calls `confirmLeave()` and `preventDefault()`s on false. Same props as `Link`.

- [ ] **Step 1: tests**

```js
it('confirmLeave is true and never prompts when nothing is unsaved', () => {})
it('prompts once when unsaved, and clears the flag on yes', () => {})
it('keeps the flag when the host says no', () => {})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `HOSTPORTAL.2 — unsaved-changes guard for host links`.

### Task 10: event layout, header, tabs, ⋯ menu

**Files:**
- Create: `src/app/host/(portal)/events/[id]/layout.js`, `src/app/host/(portal)/events/[id]/layout.test.js`, `src/components/host/HostEventTabs.jsx`, `src/components/host/HostEventTabs.test.jsx`, `src/components/host/HostEventMenu.jsx`

**Interfaces — Produces:**
- `EVENT_TABS = [{ key: 'overview', label: 'Overview', path: '' }, { key: 'attendees', label: 'Attendees', path: '/attendees' }, { key: 'setup', label: 'Set up', path: '/setup' }, { key: 'promote', label: 'Promote', path: '/promote' }, { key: 'insights', label: 'Insights', path: '/insights' }]` and `activeTab(pathname, eventId) → key` (exported from `HostEventTabs.jsx`; `/edit` counts as `setup`).
- `HostEventTabs({ eventId, attendeeCount })`: client, `GuardedLink`s, `aria-current="page"` on the active one, horizontally scrolling strip; the Attendees tab shows `attendeeCount` when it is a number.
- `HostEventMenu({ eventId, status, hasRegistrations, brandName })`: client; a "⋯" button (`aria-label="More actions"`, `aria-expanded`) toggling a panel that renders `<HostEventActions …/>` unchanged; closes on Escape and outside click.

Layout: `getCurrentHost`, `loadHostEvent` (columns `id, host_id, status, name, slug, race_date, venue_name, series_id, series:event_series ( id, name, slug ), race_waves ( start_time, display_order )`), `notFound()` on null, then: `GuardedLink` "← Events"; h1 name + chip; the line `date · 10:00, 12:30 · venue · part of series <link to /event/series/<slug>>`; actions "View event page" (`/event/<slug>`, new tab), `DuplicateEventButton` (`editHref="/host/events/{id}/setup"`, `dark`), `HostEventMenu`; `HostEventTabs`; `{children}`. `DuplicateEventButton` navigates with `router.push` after it makes the copy: have it call `confirmLeave()` first and stay put on false (it returns true when nothing is unsaved, so the staff events list is unaffected). `attendeeCount` and `hasRegistrations` from one count read on `race_registrations` (not cancelled); a failed count passes `attendeeCount={null}` and `hasRegistrations={true}` (the safe side for Delete).

- [ ] **Step 1: tests**

```js
// HostEventTabs.test.jsx
it('maps each path to its tab, and /edit to setup', () => {
  expect(activeTab('/host/events/e1', 'e1')).toBe('overview')
  expect(activeTab('/host/events/e1/attendees', 'e1')).toBe('attendees')
  expect(activeTab('/host/events/e1/edit', 'e1')).toBe('setup')
})
// layout.test.js
it('404s for another host\'s event before rendering anything', async () => {
  await expect(Layout({ params: Promise.resolve({ id: 'theirs' }), children: null })).rejects.toThrow('NOT_FOUND')
})
it('hands DuplicateEventButton a string template, never a function', async () => {})
it('treats a failed count as "has registrations"', async () => {})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS, plus `npx vitest run tests/server-to-client-function-props.test.js`. **Step 5:** Commit `HOSTPORTAL.2 — event header, tabs and the more-actions menu`.

### Task 11: Attendees tab

**Files:**
- Create: `src/app/host/(portal)/events/[id]/attendees/page.js`
- Move: `events/[id]/page.waitlist.test.js` → `events/[id]/attendees/page.waitlist.test.js` (import path and mocks updated; assertions unchanged)

Do this before Task 12 rewrites the old page. Copy, verbatim, from the old event page (Task 12 then removes them there): the `fetchEventAttendees` / `loadMoveHistory` / questions / `entries` mapping, the counts line, the Export CSV link (only when there are registrations), `HostAttendeeTable`, `EventWaitlistPanel` with the same two URLs and `dark`.

- [ ] **Step 1:** move the test and add `it('404s for another host\'s event', …)`. **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `HOSTPORTAL.2 — Attendees tab`.

### Task 12: Overview tab and the price line

**Files:**
- Create: `src/lib/host-price-line.js`, `src/lib/host-price-line.test.js`, `src/components/host/SessionFillBars.jsx`
- Rewrite: `src/app/host/(portal)/events/[id]/page.js`; Create: `src/app/host/(portal)/events/[id]/page.test.js`

**Interfaces — Produces:**
- `hostPriceLine({ race, soldByTier, nowMs, zone }) → string`. Parts joined by " · ": the current tier `"<name> €<price>"` (from `publicPricing({ race, nowMs, soldByTier })`); `"<left> of <capacity> left"` when that tier has a capacity (left = capacity − sold, floor 0); `"then standard €<base>"` when a tier is current; each group tier as `"<min_people> or more people €<price> each"`. No tiers: `"€<base> per person"`. Base 0 or null with no tiers: `"Free"`. Euro amounts drop `.00`.
- `SessionFillBars({ sessions })`: pure render of Task 2's `sessions`; label `"<time> · <label>"`, bar width `min(100, booked/capacity)`, text `"30 / 30 · full"`, `"8 / 30"`, or `"3 booked"` with no bar when capacity is null.

Page (tab 1): tiles Bookings (`regs.length`, sub `"<confirmed> confirmed · <people> attendees"`), Waitlist (waiting, sub `"<offered> offered"`), Page views (sub `"<conversion_pct>% of visitors booked"`), money (`"Net to you"` + gross beneath, or `"Gross"`). "Sessions": `SessionFillBars`, or "Session numbers unavailable right now." "Price right now": `hostPriceLine(...)` with a link "Change in Set up →"; needs `loadSoldByTier(db, { eventId, race })`; on a throw/failed read show "Price unavailable right now."

- [ ] **Step 1: tests**

```js
// host-price-line.test.js — tiers built with the shapes in src/lib/pricing-tiers.test.js
it('names the open tier, what is left, the standard price and the group price', () => {
  expect(hostPriceLine({ race: raceWith(earlyBird25cap20, group28min3, { base: 3500 }), soldByTier: { [earlyId]: 14 }, nowMs, zone }))
    .toBe('Early bird €25 · 6 of 20 left · then standard €35 · 3 or more people €28 each')
})
it('skips a sold-out tier', () => { /* soldByTier 20 of 20 → line starts with the standard price */ })
it('says Free for a €0 event with no tiers', () => { expect(hostPriceLine({ race: raceWith({ base: 0 }), soldByTier: {}, nowMs, zone })).toBe('Free') })
it('shows the standard price alone when there are no tiers', () => { /* '€35 per person' */ })
// page.test.js
it('404s for another host\'s event', async () => {})
it('reads unavailable for sessions and price when those reads fail, and still renders the tiles', async () => {})
it('shows Gross and no net for a non-Stripe host', async () => {})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `HOSTPORTAL.2 — event Overview tab: tiles, session bars, price right now`.

### Task 13: Set up tab

**Files:**
- Create: `src/app/host/(portal)/events/[id]/setup/page.js`, `…/setup/page.test.js`
- Replace: `src/app/host/(portal)/events/[id]/edit/page.js` with a page that runs the same host + `loadHostEvent` check, then `redirect('/host/events/<id>/setup')`
- Modify: `src/components/host/HostEventForm.jsx`, `src/components/host/HostEventForm.test.jsx`, `src/lib/host-portal.js` (`eventLandingHref` → `/setup`; update its test), `src/app/host/(portal)/events/new/page.js` (back link → `/host/events`)

Setup page: the old edit page's select and `initial` mapping, **including `rating_email_subject` and `rating_email_intro`** (spec § 11; already present if RATINGCOPY.1 merged). The reviewer's note box as today. Then `<HostEventForm mode="edit" eventId initial brandName status={event.status} />`.

Form changes:
- New prop `status`. Each section's wrapper gets an id: `setup-basics`, `setup-schedule`, `setup-tickets`, `setup-questions`, `setup-look`, `setup-emails`.
- In edit mode, a jump bar above the form: six `type="button"` pills labelled Basics, Schedule & sessions, Tickets & pricing, Questions at signup, Page look, Emails; each scrolls its section into view; Emails also sets `showEmail` true.
- Dirty tracking: keep `JSON.stringify(buildBody())` from mount as the baseline; `setUnsaved(current !== baseline)` in an effect; a `beforeunload` listener while dirty; `setUnsaved(false)` on unmount.
- After a successful **edit** save: stay on the page, reset the baseline, `router.refresh()`, and show "Saved." (Task 17 adds the off-sale line). After a successful **create**: `router.push('/host/events/<id>/setup')`.
- `cancelHref`: `/host/events/<id>` in edit mode, `/host/events` in create mode; the Cancel link is a `GuardedLink`.
- Beside Save, when `status` is `draft` or `rejected`: `<HostSubmitButton eventId />`.

- [ ] **Step 1: tests**

```js
// HostEventForm.test.jsx
it('renders the six jump pills in edit mode and none in create mode', () => {})
it('the Emails pill opens the email copy section', () => {})
it('is not dirty on mount and is dirty after an edit', () => { /* setUnsaved spy: last call false, then true */ })
it('stays on the page after an edit save, shows Saved., and is clean again', async () => { /* router.push not called */ })
it('sends create to the new event\'s setup tab', async () => { expect(push).toHaveBeenCalledWith('/host/events/new-id/setup') })
it('shows Submit for review on a draft and a rejected event only', () => {})
// setup/page.test.js
it('404s for another host\'s event', async () => {})
it('passes the rating email copy into the form', async () => {
  expect(formProps.initial).toMatchObject({ rating_email_subject: 'How was it?', rating_email_intro: 'Tell us.' })
})
it('shows the reviewer note on a rejected event', async () => {})
// edit/page test
it('redirects its own event to setup and 404s another host\'s', async () => {})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `HOSTPORTAL.2 — Set up tab: the edit form with a jump bar and an unsaved-changes guard`.

### Task 14: Promote and Insights tabs

**Files:**
- Create: `…/events/[id]/promote/page.js`, `…/promote/page.test.js`, `…/events/[id]/insights/page.js`, `…/insights/page.test.js`, `src/components/host/CopyLinkButton.jsx` (client: `CopyLinkButton({ url })`, the copy-with-"Copied" pattern from the old signup card)

Promote: "Share" (the public URL `<origin>/event/<slug>` built with `resolveCustomerBaseUrl(db, <host anchor_location_id>)` as the Your page link is, with `CopyLinkButton`); `HostPromoCodes`; "Series" with `HostSeriesActions` (same six props as the old page). Insights: `EventSignupsCard stats={statsRes.ok ? statsRes.stats : null} dark` and `HostEventRatings eventId`, in a two-column grid from `lg`, stacked below.

- [ ] **Step 1: tests:** each page 404s for another host's event; Promote renders the three blocks with the right `eventId`; Insights passes `stats={null}` when `loadEventStats` is `ok: false`. **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `HOSTPORTAL.2 — Promote and Insights tabs`.

### Task 15: ship PR 2

- [ ] Update Overview's "Attendees" button (Task 7) to `/host/events/<id>/attendees`.
- [ ] Walk spec § 8 again in the browser as a host: every row; a draft opens on Set up; a published event's Set up saves a description change without leaving; a dirty form prompts on a tab click, a nav click and a reload; all five tabs at 375px. Open one event page in a production build (`npm run build && npm start`) to catch a server-to-client prop crash the tests cannot see.
- [ ] CI mirror, then `npm run build`. Push, `gh pr create` titled `HOSTPORTAL.2 — one event, five tabs`, changelog entry, push.

---

# PR 3 — HOSTPORTAL.3: warn and confirm, and the 30-day roll-up

Branch `host-portal-warn-rollup`, off `origin/main` after PR 2 merges.

### Task 16: one rule for "this edit takes it off sale"

**Files:** Modify `src/lib/host-events.js`, its test file, and `src/app/api/host/events/[id]/route.js`

**Interfaces — Produces:**
- `RE_REVIEW_REASONS = ['date', 'price', 'tiers', 'session_time']` and `RE_REVIEW_REASON_LABEL = { date: 'the date', price: 'the standard price', tiers: 'a pricing tier', session_time: "an existing session's start time" }`.
- `reReviewReasons(current, changes) → string[]` (subset of `RE_REVIEW_REASONS`, in that order; `[]` when `current.status !== 'published'`). The four existing comparisons move here unchanged.
- `computeEditTransition` becomes `reasons.length > 0` on top of it; its return shape is unchanged.
- `editChangesFromInput(input) → changes`: the exact object the PUT route passes to `computeEditTransition` today, extracted so the route and the form build it the same way. The route calls it.

- [ ] **Step 1: tests**

```js
it('returns each reason alone for each of the four edits', () => { /* four cases, exact arrays */ })
it('returns [] for a cosmetic edit, an added session and a removed session', () => {})
it('returns [] for any edit to a draft, in-review or rejected event', () => {})
it('agrees with computeEditTransition on every case above', () => { /* reReview === reasons.length > 0 */ })
it('has a label for every reason and no label without a reason', () => {
  expect(Object.keys(RE_REVIEW_REASON_LABEL).sort()).toEqual([...RE_REVIEW_REASONS].sort())
})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS, plus the existing `route.test.js` for the PUT. **Step 5:** Commit `HOSTPORTAL.3 — reReviewReasons: one rule for the route, the notice and the dialog`.

### Task 17: the notice and the confirm step

**Files:** Modify `src/components/host/HostEventForm.jsx` and its test

- Notice, in edit mode when `status === 'published'`, above the jump bar. Copy: "This event is on sale. Changing {labels joined with commas and a final 'or'} takes it **off sale** until {brandName} approves it again: the public page goes offline and new bookings stop. Existing bookings are kept. Everything else saves straight away." The label list is rendered from `RE_REVIEW_REASON_LABEL` in `RE_REVIEW_REASONS` order, never retyped.
- On submit, when `status === 'published'`: `reasons = reReviewReasons(current, editChangesFromInput(buildBody()))` with `current = { status, non_member_fee_cents: initial.non_member_fee_cents, race_date: initial.race_date, pricing_tiers: initial.pricing_tiers, waves: initial.sessions.map((s) => ({ id: s.id, start_time: s.start_time })) }`, reset to the saved values after each successful save. If non-empty, open a dialog (the repo's dark modal pattern; not `window.confirm`) titled "Take this event off sale?", body "You changed {the labels for `reasons`}. Saving sends the event to {brandName} for review. Until it is approved the public page is offline and nobody can book. Existing bookings are kept.", buttons "Save and send for review" (performs the PUT) and "Keep editing" (closes, sends nothing). Both `type="button"`.
- After a save whose response has `data.reReview === true`: the line reads "Saved. This event is off sale until {brandName} approves it again." whether or not the dialog was shown.

- [ ] **Step 1: tests**

```js
it('shows the notice on a published event only, listing all four labels', () => {})
it('saves a description change on a published event with no dialog', async () => { /* fetch called once */ })
it('asks before saving a date change and sends nothing until confirmed', async () => { /* fetch not called; dialog names "the date" */ })
it('Keep editing closes the dialog, sends nothing and keeps the edit', async () => {})
it('Save and send for review performs the PUT', async () => {})
it('never asks on a draft, whatever changed', async () => {})
it('says off sale after a save the server marks reReview, even with no dialog', async () => {})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `HOSTPORTAL.3 — Set up warns and asks before a save that takes a published event off sale`.

### Task 18: the 30-day roll-up

**Files:**
- Modify: `src/lib/host-revenue.js` (`getHostRevenue(db, hostId, { sinceIso = null } = {})`; when set, add `.gte('completed_at', sinceIso)` to the payments read; a refunded payment still counts by its `completed_at`), its test
- Create: `src/lib/host-rollup.js`, `src/lib/host-rollup.test.js`
- Modify: `src/app/host/(portal)/page.js`, `page.test.js`

**Interfaces — Produces:** `loadHostRollup(db, { hostId, eventIds, sinceIso, sinceDay }) → Promise<{ bookings: number|null, views: number|null, signups: number|null, contacts: number|null }>`, each a `head: true` exact count and each `null` when its own read failed: `race_registrations` (`status = 'confirmed'`, `registered_at >= sinceIso`, `race_event_id in eventIds`); `event_page_views` (`day >= sinceDay`, `race_event_id in eventIds`); `host_contacts` (`host_id`, `source = 'mailing_list'`, `created_at >= sinceIso`); `host_contacts` (`host_id`, all). No event ids → bookings and views are 0 without a query. Chunk `eventIds` by 100 for the `in` filters and sum.

Overview gains "Last 30 days" between Next up and Coming up: tiles Bookings; "Net earned"/"Gross collected" (windowed `getHostRevenue`, `net_to_host_cents` or `gross_cents`); "Event page views" (sub "across all events"); "List signups" (sub "<contacts> contacts"). `sinceDay` = today minus 30 days in the anchor zone; `sinceIso` = that day's local midnight via `zonedWallClockToInstant`. A null figure renders "unavailable".

- [ ] **Step 1: tests**

```js
it('counts each figure with its own window and filters', async () => { /* assert the filters handed to the db stub */ })
it('returns null for the one figure whose read failed and numbers for the rest', async () => {})
it('answers 0 bookings and 0 views for a host with no events without querying', async () => {})
it('getHostRevenue leaves the payments read unwindowed by default and adds completed_at >= sinceIso when asked', async () => {})
it('Overview shows unavailable for a null roll-up figure and never 0', async () => {})
it('Overview shows Gross collected, not Net earned, for a non-Stripe host', async () => {})
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS, plus `npm run check:select-columns`. **Step 5:** Commit `HOSTPORTAL.3 — the last 30 days on Overview`.

### Task 19: ship PR 3

- [ ] In the browser as a host with a published test event: a description edit saves with no dialog; a price edit shows the dialog; "Keep editing" sends nothing (network tab); confirming flips the chip to In review and shows the off-sale line. Then have staff re-approve the test event.
- [ ] CI mirror, then `npm run build`. Push, `gh pr create` titled `HOSTPORTAL.3 — warn before taking an event off sale; the last 30 days`, changelog entry, push.
