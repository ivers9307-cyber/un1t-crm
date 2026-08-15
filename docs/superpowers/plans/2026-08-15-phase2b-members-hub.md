# Phase 2B — Members Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the Members section into the second true hub: one `/members` sidebar entry, a `(members)` route group sharing `HubTabs` over unchanged URLs, and one deliberate URL move — `/admin/hyrox` → `/hyrox` (an `/admin` page, which the amended URL strategy explicitly allows to move).

**Architecture:** Exact reuse of the proven 2A recipe (see `src/app/(sales)/layout.js`, `src/app/sales/page.js`, and the `/sales` nav entry on main — they are the in-tree templates). Deltas specific to Members: 7 tabs with mixed gates; two full-screen destinations (`/live`, `/studio-management/timer`) are tabs but stay OUTSIDE the group (they must not inherit the strip); `/admin/hyrox` moves INTO the group as `/hyrox` with a legacy redirect.

**Hard dependency:** PR #1401 merged (it is — origin/main ≥ 123b493e). Branch: `git fetch && git worktree add -b hubs-2b-members ../un1t-crm-2b origin/main`, `npm ci`, baseline `npm test`.

**Known pre-existing quirk this plan handles:** the old `/bookings` nav entry was gated `anyPermission: ['events','bookings']` but the page (`src/app/bookings/page.js:49`) requires `bookings` — an events-only user saw the entry and bounced. Hub tabs mirror PAGE gates exactly (2A's reviewed invariant); the hub ENTRY keeps the permission superset so nobody who saw a Members-area entry today loses the section.

---

### Task 1: Move `/admin/hyrox` → `/hyrox` (inside the group) + redirect + repoints

**Files:**
- Move: `src/app/admin/hyrox/` (page.js + HyroxPlanner.jsx) → `src/app/(members)/hyrox/`
- Modify: `src/lib/approvals/providers/hyrox-sessions.js:11,32` (`/admin/hyrox` → `/hyrox`)
- Modify: `src/lib/approvals/providers/hyrox-sessions.test.js:14,20` (same, TDD: change first)
- Modify: `src/app/admin/page.js:65` (card href → `/hyrox`)
- Modify: `legacy-redirects.js` (+ rule) — NOT the test's `DELETED_STUB_SOURCES` (that list records deleted *stubs*; this is a page MOVE, same as the PRUNE.1d editor moves)

- [ ] Step 1 (TDD): update `hyrox-sessions.test.js` expectations to `/hyrox` / `/hyrox?focus=s1`; run `npx vitest run src/lib/approvals/providers/hyrox-sessions.test.js` → FAIL.
- [ ] Step 2: edit `hyrox-sessions.js` `reviewBase: '/hyrox'` and `` reviewUrl: `/hyrox?focus=${r.id}` `` → test PASS.
- [ ] Step 3: `mkdir "src/app/(members)" && git mv src/app/admin/hyrox "src/app/(members)/hyrox"`. The page keeps its own gate (`approvals_hyrox_sessions` renders no-access text; redirect if no active location) — it no longer sits under the `/admin` layout gate, which its own gate makes redundant. Verify the page has no import that depended on the admin layout (read it; report if so).
- [ ] Step 4: `src/app/admin/page.js:65` card `href: '/hyrox'` (label/desc/perm unchanged).
- [ ] Step 5: append to `legacy-redirects.js` (in the `// singles` block, with a one-line comment citing HUBS.2b): `{ source: '/admin/hyrox', destination: '/hyrox', permanent: false },`. Run `npx vitest run src/lib/legacy-redirects.test.js` → still green (rule additions don't break the invariants; the no-chains test must pass — `/hyrox` is not a retired tree).
- [ ] Step 6: grep `admin/hyrox` across src/ — remaining hits must be comments only. `npm test` → green. Commit: `"HUBS.2b — /admin/hyrox → /hyrox (hub member; redirect + approvals repoint)"`.

### Task 2: `/members` index route (TDD — mirror `src/app/sales/page.test.js` exactly, including the tier-1 location-gate case)

**Files:** Create `src/app/members/page.js` + `src/app/members/page.test.js` (literal segment, outside the group — redirects before render).

Redirect order (first permitted wins), mirroring PAGE gates:

```js
  if (hasPermission(user, 'bookings')) redirect('/bookings')
  if (hasPermission(user, 'races')) redirect('/events')
  if (hasPermission(user, 'challenges')) redirect('/challenges')
  if (hasPermission(user, 'pulse_admin')) redirect('/pulse')
  if (hasPermission(user, 'studio_management')) redirect('/live')
  if (hasPermission(user, 'class_timer')) redirect('/studio-management/timer')
  if (hasPermission(user, 'approvals_hyrox_sessions')) redirect('/hyrox')
  redirect('/')
```

(Plus signed-out → `/login`, `force-dynamic`, header comment naming the hub pattern.) Tests: signed-out; first-match for each of the 7 keys in order (a fixture per tier is fine — at minimum: bookings-holder → /bookings; races-only → /events; hyrox-only → /hyrox; none → /; plus one location-gate case `features:{bookings:false}` with all grants → /events). Commit `"HUBS.2b — /members hub index"`.

### Task 3: `(members)` route group

**Files:**
- Move: `src/app/bookings`, `src/app/events`, `src/app/challenges`, `src/app/pulse` → `src/app/(members)/` (URLs unchanged; `/live` and `/studio-management` deliberately NOT moved — full-screen surfaces must not inherit the strip)
- Create: `src/app/(members)/layout.js`

Layout (mirror `(sales)/layout.js`; only delta is per-tab perm arrays):

```js
// (members) — Members hub chrome. Same pattern as (sales)/layout.js: the
// group shares one tab strip WITHOUT changing member URLs. Live HR and the
// class timer are tabs but their routes stay OUTSIDE the group — they are
// full-screen surfaces and must not inherit the strip. Tab visibility
// mirrors each PAGE's own gate (not the old nav entry's looser gate).

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import HubTabs from '@/components/HubTabs'

export const dynamic = 'force-dynamic'

const TABS = [
  { id: 'bookings',   label: 'Bookings',    href: '/bookings',                perms: ['bookings'] },
  { id: 'events',     label: 'Events',      href: '/events',                  perms: ['races'] },
  { id: 'challenges', label: 'Challenges',  href: '/challenges',              perms: ['challenges'] },
  { id: 'pulse',      label: 'Pulse',       href: '/pulse',                   perms: ['pulse_admin'] },
  { id: 'live',       label: 'Live HR',     href: '/live',                    perms: ['studio_management'] },
  { id: 'timer',      label: 'Class timer', href: '/studio-management/timer', perms: ['class_timer'] },
  { id: 'hyrox',      label: 'Hyrox',       href: '/hyrox',                   perms: ['approvals_hyrox_sessions'] },
]

export default async function MembersHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children
  const tabs = TABS
    .filter(t => t.perms.some(p => hasPermission(user, p)))
    .map(({ perms: _p, ...t }) => t)
  return (
    <>
      {tabs.length > 1 && (
        <div className="px-8 pt-6">
          <HubTabs tabs={tabs} />
        </div>
      )}
      {children}
    </>
  )
}
```

- [ ] Verify each moved top-level page redirects signed-out users itself (bookings does — `page.js:48`; check events, challenges, pulse the same way; report any that don't rather than papering over).
- [ ] `npm test` (K5 must resolve `/events`, `/bookings` palette hrefs inside the group) and `npm run build` (alone) — route list unchanged for all moved trees, `/members` + `/hyrox` present, `/admin/hyrox` gone.
- [ ] Commit `"HUBS.2b — (members) route group: shared HubTabs over unchanged URLs"`.

### Task 4: Sidebar collapse (TDD)

**Files:** `src/lib/nav-items.test.js` first, then `src/lib/nav-items.js`.

- Members section membership → `['/members']`. New entry:
  `{ href: '/members', label: 'Members', icon: <lucide, e.g. HeartPulse or Users — pick one not already imported for another entry>, anyPermission: ['bookings', 'events', 'races', 'challenges', 'pulse_admin', 'studio_management', 'class_timer', 'approvals_hyrox_sessions'], extraActivePaths: ['/bookings', '/events', '/challenges', '/pulse', '/live', '/studio-management/timer', '/hyrox'], section: 'members' }`
  — `'events'` stays in the entry union (visibility superset, see header note) even though no tab uses it. Comment the entry accordingly, preserving relocated per-item comments per 2A precedent.
- DELETE the standalone `/bookings`, `/events`, `/challenges`, `/pulse` entries AND the `/live` group entry (with its timer child) AND the promoted `/admin/hyrox` entry.
- Update tests: members membership array; delete the `/live` children test; add a Members-entry assertion mirroring the Sales one (anyPermission + extraActivePaths arrays exactly as above).
- NOTE the trap: `extraActivePaths: ['/events']` must not also live on any other entry (the old Events entry had a redundant one — it dies with the entry). `/studio-management/timer` in extraActivePaths vs Operations' `/studio-management` entry prefix: BOTH will light (`/studio-management` entry matches by prefix, Members matches the timer path) — accept for now (pre-existing matcher semantics; the Operations hub PR will own the fix) but ADD a code comment on the Members entry flagging it.
- Run nav + palette + comms-ia-labels suites, then full `npm test`. Commit `"HUBS.2b — Members collapsed to one hub entry"`.

### Task 5: Finalize

Full CI mirror + `npm run build` + CHANGELOG entry (`HUBS.2b`, house numbered style: the hub recipe applied to Members; the one URL move `/admin/hyrox`→`/hyrox` with redirect + approvals-provider repoint; full-screen exclusions; the bookings gate-mismatch note) + push + `gh pr create` titled `"HUBS.2b — Members hub"` with preview-QA notes (strip on `/events/[id]/control` race-day operator page — inside the group, gets tabs; flag if it reads wrong; double-active on `/studio-management/timer` with the Operations entry). Body ends with the standard generated-with footer.

**Preview QA:** sidebar Members entry lights on all seven paths; tabs render on bookings/events/challenges/pulse/hyrox and NOT on /live or the timer; `/admin/hyrox` 307s to `/hyrox`; approvals inbox Hyrox rows deep-link to `/hyrox?focus=…`.
