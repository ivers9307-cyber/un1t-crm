# Phase 2A — Hub Framework, Sidebar Regroup & Sales Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regroup the Studio sidebar into hub-shaped sections, ship the reusable `HubTabs` framework, and convert Sales into the first true hub (single sidebar entry + tab strip) — with ZERO URL changes to existing pages.

**Architecture:** Per Richard's amended URL strategy (2026-08-15): hubs are expressed as **top-level route groups + shared tab chrome over existing URLs**, not URL migrations. `src/app/(sales)/` holds the moved-but-URL-identical `pipeline/`, `contacts/`, `activities/` trees plus a layout that renders `HubTabs`. A new `/sales` index route redirects to the first tab the user can see. The sidebar's `NAV_SECTIONS` is rewritten to the hub grouping (items keep their hrefs and gates); later PRs collapse each remaining section into its own hub entry the same way Sales is collapsed here.

**Tech Stack:** Next.js 16 App Router route groups, vitest (+ jsdom for the component test).

**Parent spec:** `docs/superpowers/specs/2026-08-14-platform-consolidation-design.md` §3.1, amended: existing page URLs stay; only `/admin` pages move (in the later dissolution PR).

**HARD DEPENDENCY:** PR #1400 (PRUNE.1) must be MERGED first — this plan relies on its route-group-aware K5 test helper and the `(hub)` communications precedent. Verify with `gh pr view 1400 --json state` before branching. Then: `git fetch && git worktree add -b hubs-2a-sales ../un1t-crm-2a origin/main` (never work in the primary clone). Run `npm ci`, then baseline `npm test && npm run lint`.

**Interim-state note (deliberate):** after this PR the sidebar has hub-named sections with their existing items inside; only Sales is collapsed to a single hub entry. `/approvals` + `/issues` sit in a header-less `queues` section until the phase-3 Home queue absorbs them. `/admin/hyrox`, `/admin/contracts` keep their `/admin` URLs until the dissolution PR.

---

### Task 1: `HubTabs` shared component

A parameterized generalization of `CommunicationsTabs` (the strongest existing strip: URL-driven, badge-capable, scroll + measured edge fades) with two fixes: **longest-match active state** (from `CalendlyTabs.jsx:33-36` — naive `startsWith` double-highlights nested hrefs) and **hide when fewer than 2 tabs** (from `dashboard/layout.js:40`). Badges poll via a per-tab child component so hooks stay legal.

**Files:**
- Create: `src/components/HubTabs.jsx`
- Test: `src/components/hub-tabs.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/hub-tabs.test.jsx`:

```jsx
// @vitest-environment jsdom
// HubTabs — the phase-2 hub tab strip. Contract: server layouts pass
// permission-filtered tabs; the strip owns active state (longest match),
// badge polling, and hides entirely when fewer than 2 tabs remain.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const mockPathname = vi.fn(() => '/pipeline')
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname() }))
vi.mock('./use-polled-count', () => ({ usePolledCount: vi.fn(() => 0) }))

import HubTabs from './HubTabs.jsx'
import { usePolledCount } from './use-polled-count'

const TABS = [
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline' },
  { id: 'contacts', label: 'Contacts', href: '/contacts' },
  { id: 'tasks',    label: 'Tasks',    href: '/activities' },
]

afterEach(cleanup)

describe('HubTabs', () => {
  it('renders a link per tab with the given hrefs', () => {
    render(<HubTabs tabs={TABS} />)
    const links = screen.getAllByRole('link')
    expect(links.map(l => l.getAttribute('href'))).toEqual(['/pipeline', '/contacts', '/activities'])
  })

  it('marks the longest matching tab active, not every prefix match', () => {
    mockPathname.mockReturnValue('/contacts/abc123')
    render(<HubTabs tabs={TABS} />)
    const active = screen.getAllByRole('link').filter(l => l.className.includes('font-semibold'))
    expect(active).toHaveLength(1)
    expect(active[0]).toHaveTextContent('Contacts')
  })

  it('renders nothing with fewer than 2 tabs', () => {
    const { container } = render(<HubTabs tabs={[TABS[0]]} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows a badge only when the polled count is positive, capped at 99+', () => {
    usePolledCount.mockReturnValueOnce(120)
    render(<HubTabs tabs={[{ ...TABS[0], badgeUrl: '/api/x/count' }, TABS[1]]} />)
    expect(screen.getByText('99+')).toBeTruthy()
  })

  it('polls only tabs that declare a badgeUrl', () => {
    usePolledCount.mockClear()
    render(<HubTabs tabs={TABS} />)
    expect(usePolledCount).not.toHaveBeenCalled()
  })
})
```

(Match the repo's existing jsdom test conventions — check `src/components/comms-back-links.test.jsx` header for the exact `@vitest-environment` and testing-library import style used, and mirror it if it differs.)

- [ ] **Step 2: Run it — must fail (module missing)**

Run: `npx vitest run src/components/hub-tabs.test.jsx` → FAIL, cannot resolve `./HubTabs.jsx`.

- [ ] **Step 3: Implement `src/components/HubTabs.jsx`**

```jsx
'use client'

// HubTabs — the shared hub tab strip (phase-2 consolidation). Server hub
// layouts compute permission-filtered `tabs` ([{ id, label, href, badgeUrl? }])
// and this client strip owns pathname, badge polling and overflow.
//
// Generalised from CommunicationsTabs (scroller + measured edge fades —
// see COMMSLAYOUT.2 / COMMS-DETAIL-FIX.2 there for the full rationale)
// with two deliberate differences:
// - Active state is LONGEST match (CalendlyTabs' fix), because hub tabs
//   routinely nest (/bookings vs /bookings/event-types) and a bare
//   startsWith lights both.
// - Renders nothing below 2 tabs (dashboard/layout.js precedent): a
//   one-tab strip is chrome with no choice.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'
import { usePolledCount } from './use-polled-count'

// Hooks can't sit in the tabs.map loop, so each badge is its own component.
function TabBadge({ url }) {
  const count = usePolledCount({ enabled: true, url })
  if (!(count > 0)) return null
  return (
    <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold align-middle">
      {count > 99 ? '99+' : count}
    </span>
  )
}

export default function HubTabs({ tabs }) {
  const pathname = usePathname()
  const activeRef = useRef(null)
  const scrollerRef = useRef(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  const measure = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setEdges({
      start: max > 1 && el.scrollLeft > 1,
      end: max > 1 && el.scrollLeft < max - 1,
    })
  }, [])

  useLayoutEffect(() => {
    measure()
    const el = scrollerRef.current
    if (!el) return undefined
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    measure()
  }, [pathname, measure])

  if (!tabs || tabs.length < 2) return null

  const bestMatch = tabs
    .filter(t => pathname === t.href || (t.href !== '/' && pathname.startsWith(`${t.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]

  return (
    <div className="relative mb-6 max-w-3xl">
      <div
        ref={scrollerRef}
        data-testid="tabs-scroller"
        onScroll={measure}
        className="overflow-x-auto overscroll-x-contain scroll-px-7 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="flex w-max min-w-full p-1 bg-un1t-surface border border-un1t-border rounded-xl">
          {tabs.map(t => {
            const active = bestMatch?.href === t.href
            return (
              <Link
                key={t.id}
                href={t.href}
                ref={active ? activeRef : undefined}
                className={clsx(
                  'flex-1 whitespace-nowrap text-center px-3 py-2 rounded-lg text-sm transition-colors',
                  active
                    ? 'bg-un1t-text text-un1t-bg font-semibold'
                    : 'text-un1t-subtle hover:text-un1t-text'
                )}
              >
                {t.label}
                {t.badgeUrl ? <TabBadge url={t.badgeUrl} /> : null}
              </Link>
            )
          })}
        </div>
      </div>
      {edges.start && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-10 rounded-l-xl bg-gradient-to-r from-un1t-surface from-15% via-un1t-surface/80 to-transparent" />
      )}
      {edges.end && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-10 rounded-r-xl bg-gradient-to-l from-un1t-surface from-15% via-un1t-surface/80 to-transparent" />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test — PASS (5 tests)**

Run: `npx vitest run src/components/hub-tabs.test.jsx`

- [ ] **Step 5: Commit**

```bash
git add src/components/HubTabs.jsx src/components/hub-tabs.test.jsx
git commit -m "HUBS.2a — HubTabs: shared hub tab strip (longest-match active, badge-capable)"
```

---

### Task 2: `/sales` index route

**Files:**
- Create: `src/app/sales/page.js` (outside the `(sales)` group — it redirects before rendering, no chrome needed)
- Test: `src/app/sales/page.test.js`

- [ ] **Step 1: Write the failing test** (mirror the moved editor tests' mocking style — see `src/app/communications/(editors)/templates/email/[id]/page.test.js` for the exact `next/navigation` + `@/lib/auth` mock shape used in this repo)

Create `src/app/sales/page.test.js`:

```js
// /sales — hub index. Redirects to the first tab the user can see,
// in tab order (pipeline → contacts → tasks), home if none.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetCurrentUser = vi.fn()
vi.mock('@/lib/auth', () => ({ getCurrentUser: (...a) => mockGetCurrentUser(...a) }))
vi.mock('@/lib/permissions', async () => {
  const real = await vi.importActual('@/lib/permissions')
  return { ...real }
})
vi.mock('next/navigation', () => ({
  redirect: (url) => { throw new Error(`NEXT_REDIRECT:${url}`) },
}))

import SalesIndexPage from './page.js'

const userWith = (perms) => ({
  id: 'u1', role: 'staff',
  activeLocation: { id: 'loc1', features: {} },
  permissions: perms,
  // hasPermission consults the shared resolver; simplest faithful shape is a
  // per-user override map — copy the user fixture shape the editor page tests
  // use if it differs from this.
})

const expectRedirect = async (user, target) => {
  mockGetCurrentUser.mockResolvedValue(user)
  await expect(SalesIndexPage()).rejects.toThrow(`NEXT_REDIRECT:${target}`)
}

describe('/sales index', () => {
  beforeEach(() => mockGetCurrentUser.mockReset())

  it('redirects signed-out users to /login', async () => {
    mockGetCurrentUser.mockResolvedValue(null)
    await expect(SalesIndexPage()).rejects.toThrow('NEXT_REDIRECT:/login')
  })
})
```

Then add the four redirect-order cases:

```js
  it('lands on pipeline first when permitted', async () => {
    await expectRedirect(userWith({ pipeline: true, contacts: true, activities: true }), '/pipeline')
  })
  it('falls back to contacts without pipeline', async () => {
    await expectRedirect(userWith({ contacts: true, activities: true }), '/contacts')
  })
  it('falls back to tasks with only activities', async () => {
    await expectRedirect(userWith({ activities: true }), '/activities')
  })
  it('bounces home with none of the three', async () => {
    await expectRedirect(userWith({}), '/')
  })
```

IMPORTANT: the `userWith` fixture shape above is a sketch — before writing this test, READ how `hasPermission(user, key)` resolves a permission for a plain user object (`src/lib/permissions.js` re-exports the shared resolver) and copy the exact fixture shape from an existing test that exercises `hasPermission` with per-user permission maps (grep `src/lib` tests for `hasPermission(` fixtures; the editor page tests' faithful `assertLocationAccess` mocks show the house style). Adapt `userWith` so the four cases above drive the resolver truthfully — the case list and expected targets are the contract; only the fixture plumbing may change.

- [ ] **Step 2: Run — FAIL (module missing)**

- [ ] **Step 3: Implement `src/app/sales/page.js`**

```js
// /sales — Sales hub index. The sidebar's single Sales entry points here;
// the hub's real surfaces keep their existing URLs (/pipeline, /contacts,
// /activities — phase-2 amended URL strategy: hub chrome over existing
// URLs, no page moves). Redirect to the first tab this user can see.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function SalesIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (hasPermission(user, 'pipeline')) redirect('/pipeline')
  if (hasPermission(user, 'contacts')) redirect('/contacts')
  if (hasPermission(user, 'activities')) redirect('/activities')
  redirect('/')
}
```

- [ ] **Step 4: Run the test — PASS (5 cases)**

- [ ] **Step 5: Commit**

```bash
git add src/app/sales
git commit -m "HUBS.2a — /sales hub index (redirect to first visible tab)"
```

---

### Task 3: `(sales)` route group — tabs over existing URLs

**Files:**
- Move: `src/app/pipeline` → `src/app/(sales)/pipeline`; `src/app/contacts` → `src/app/(sales)/contacts`; `src/app/activities` → `src/app/(sales)/activities`
- Create: `src/app/(sales)/layout.js`

- [ ] **Step 1: Move the trees (URLs unchanged — route groups don't appear in URLs)**

```bash
mkdir "src/app/(sales)"
git mv src/app/pipeline src/app/contacts src/app/activities "src/app/(sales)/"
```

- [ ] **Step 2: Create `src/app/(sales)/layout.js`**

```js
// (sales) — Sales hub chrome. The group exists so /pipeline, /contacts and
// /activities share one tab strip WITHOUT changing their URLs (route groups
// are invisible to the router). Pages keep their own gates and headers; this
// layout only adds the strip, and only when the user can see 2+ tabs.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import HubTabs from '@/components/HubTabs'

export const dynamic = 'force-dynamic'

const TABS = [
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline',   perm: 'pipeline' },
  { id: 'contacts', label: 'Contacts', href: '/contacts',   perm: 'contacts' },
  { id: 'tasks',    label: 'Tasks',    href: '/activities', perm: 'activities' },
]

export default async function SalesHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) return children // pages own their auth redirects
  const tabs = TABS.filter(t => hasPermission(user, t.perm)).map(({ perm: _p, ...t }) => t)
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

- [ ] **Step 3: Tests + build**

Run: `npm test` → PASS (the K5 `pageFileFor` helper is route-group-aware since PRUNE.1c; palette hrefs `/pipeline`, `/contacts`, `/activities` must still resolve — if K5 fails here, the group traversal has a gap: investigate, don't paper over).

Run: `npm run build` (alone, 8GB machine) → exit 0; route list unchanged for `/pipeline`, `/contacts` (+ children), `/activities`; `/sales` present.

- [ ] **Step 4: Visual sanity note for the PR**

The strip sits above each page's own `p-8` container, so there will be double top-spacing on hub pages. If it looks bad in the Vercel preview, the fix belongs in the pages' containers (drop `pt-8` to `pt-4` on the three top-level pages), NOT in the layout — record whichever was done in the PR description.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(sales)" src/app/pipeline src/app/contacts src/app/activities 2>/dev/null; git add -u src/app
git commit -m "HUBS.2a — (sales) route group: shared HubTabs over unchanged URLs"
```

(If `git add` complains about the old paths no longer existing, `git add "src/app/(sales)"` plus `git add -u` covers the moves.)

---

### Task 4: Sidebar regroup — hub sections in `nav-items.js`

TDD against the exact-array tests. Items keep hrefs + gates; only `section` fields, `NAV_SECTIONS`, group children, and the new `/sales` entry change. Badge keys (`/invoices`, `/approvals`, `/issues`, `/communications`, `/communications/tickets`, `/dashboard`, `/settings`) are all untouched hrefs, so `Sidebar.jsx` needs NO edits.

**Files:**
- Modify: `src/lib/nav-items.test.js` (rewrite the section-membership assertions)
- Modify: `src/lib/nav-items.js`

- [ ] **Step 1: Rewrite the test's section expectations FIRST**

In `src/lib/nav-items.test.js`, replace the `NAV_SECTIONS` deep-equal (lines 27-38) with:

```js
    expect(NAV_SECTIONS).toEqual([
      { id: 'messages',   label: 'Messages' },
      { id: 'queues',     label: null },
      { id: 'sales',      label: 'Sales' },
      { id: 'members',    label: 'Members' },
      { id: 'money',      label: 'Money' },
      { id: 'marketing',  label: 'Marketing' },
      { id: 'team',       label: 'Team' },
      { id: 'operations', label: 'Operations' },
      { id: 'modules',    label: null },
      { id: 'account',    label: 'Account' },
    ])
```

Replace the per-section membership tests (old tests for work/accounting/sales/gym/studio/other/account) with exact-array assertions for the new grouping:

```js
    expect(hrefsIn('messages')).toEqual(['/communications', '/communications/tickets'])
    expect(hrefsIn('queues')).toEqual(['/approvals', '/issues'])
    expect(hrefsIn('sales')).toEqual(['/sales'])
    expect(hrefsIn('members')).toEqual(['/bookings', '/events', '/challenges', '/pulse', '/live', '/admin/hyrox'])
    expect(hrefsIn('money')).toEqual(['/accounting', '/invoices', '/card-receipts', '/orders'])
    expect(hrefsIn('marketing')).toEqual(['/automations', '/welcome'])
    expect(hrefsIn('team')).toEqual(['/schedule', '/admin/contracts', '/policies'])
    expect(hrefsIn('operations')).toEqual(['/maintenance', '/studio-management'])
    expect(hrefsIn('modules')).toEqual(['/cars/active'])
    expect(hrefsIn('account')).toEqual(['/settings'])
```

Add assertions for the new Sales entry and the changed groups:

```js
  it('the Sales hub entry ORs its member permissions and lights on member paths', () => {
    const sales = ALL_NAV.find(i => i.href === '/sales')
    expect(sales.anyPermission).toEqual(['pipeline', 'contacts', 'activities'])
    expect(sales.extraActivePaths).toEqual(['/pipeline', '/contacts', '/activities'])
  })

  it('Studio Management group keeps only its display children after promotions', () => {
    const sm = ALL_NAV.find(i => i.href === '/studio-management')
    expect(sm.children.map(c => c.href)).toEqual(['/admin/tv-displays', '/presentations'])
  })
```

Keep untouched: the structural tests (every-entry-has-gate, no-duplicate-hrefs, orphan-section, pinned pair, radar absence, `DASHBOARD_LINK_PERM_KEYS`) and the `/communications/tickets` gate test (its href, label and `email_inbox` permission do NOT change — `comms-ia-labels.test.js` must stay green untouched). The Live HR child test (`/live` children = `['/studio-management/timer']`) keeps its children assertion but its `section` expectation becomes `'members'`.

- [ ] **Step 2: Run — FAIL** (`npx vitest run src/lib/nav-items.test.js`)

- [ ] **Step 3: Rewrite `nav-items.js`**

Edit `src/lib/nav-items.js`:

1. `NAV_SECTIONS` (lines 269-278) → the 10-section array asserted above (keep the explanatory header comment, updating it to name the phase-2 hub programme and note `queues` dissolves into the phase-3 Home queue and `modules` holds vertical modules).
2. Re-`section` every entry per the membership arrays above. Gates, hrefs, icons, labels, order-within-section all unchanged EXCEPT:
   - NEW entry in `sales` section (import a suitable lucide icon, e.g. `Handshake`): `{ href: '/sales', label: 'Sales', icon: Handshake, anyPermission: ['pipeline', 'contacts', 'activities'], extraActivePaths: ['/pipeline', '/contacts', '/activities'], section: 'sales' }` — and DELETE the three old standalone entries for `/pipeline`, `/contacts`, `/activities`.
   - PROMOTE out of the Studio Management `children` array into standalone items (keeping each child's existing `permission` and, for `/welcome`, its `openInNewTab: true`): `/admin/hyrox` → section `members` (last), `/welcome` → section `marketing` (after `/automations`), `/admin/contracts` → section `team` (after `/schedule`). Studio Management's `children` shrinks to `['/admin/tv-displays', '/presentations']`.
   - `/live` (+ its timer child) moves to section `members`; `/studio-management` group and `/maintenance` move to section `operations`; `/policies` to `team`; `/orders` to `money`; `/cars/active` to `modules`; `/approvals` + `/issues` to `queues`; `/communications` + `/communications/tickets` to `messages`; `/bookings`, `/events`, `/challenges`, `/pulse` to `members`; `/accounting`, `/invoices`, `/card-receipts` to `money`; `/automations` to `marketing`; `/schedule` to `team`; `/settings` to `account`.
3. Move/adjust section comments so each block's commentary still sits with its items (the file is comment-dense; preserve the per-item comments verbatim when relocating entries).

- [ ] **Step 4: Run — PASS**

`npx vitest run src/lib/nav-items.test.js src/lib/comms-ia-labels.test.js src/lib/command-palette.test.js` → all green. (Palette entries for `/pipeline`, `/contacts`, `/activities` deliberately REMAIN — deep links still work, K5 still resolves them to real pages inside the group. Do NOT add a `/sales` palette entry: it's a redirect page and K5's no-redirect-stub guard would rightly reject it.)

Then full `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nav-items.js src/lib/nav-items.test.js
git commit -m "HUBS.2a — sidebar regrouped into hub sections; Sales collapsed to one hub entry"
```

---

### Task 5: Verification, CHANGELOG, PR

- [ ] **Step 1: Full CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails
```
All green (mobile-parity is untouched by section regrouping — verified in recon: it only compares permission keys, and this PR adds none).

- [ ] **Step 2: `npm run build`** → exit 0; route list: `/sales` new, all member URLs unchanged.

- [ ] **Step 3: CHANGELOG** — prepend a `HUBS.2a` entry (match the file's current numbered-table house style, next number in sequence): sidebar regrouped into hub sections per the consolidation spec (amended: hub chrome over existing URLs — no page URL changes, no redirect growth); new `HubTabs` framework (generalised CommunicationsTabs + CalendlyTabs longest-match active + hide-below-2); `(sales)` route group gives /pipeline, /contacts, /activities shared tabs at unchanged URLs; `/sales` index redirects to first visible tab; three Studio-Management children promoted to their hub sections; `queues` section is interim until the phase-3 Home queue.

- [ ] **Step 4: Commit + push + PR**

```bash
git add docs/CHANGELOG.md
git commit -m "HUBS.2a — changelog"
git push -u origin hubs-2a-sales
gh pr create --title "HUBS.2a — hub framework, sidebar regroup, Sales hub" --body "Phase 2A of the platform consolidation (spec §3.1, URL strategy amended 2026-08-15: hub chrome over existing URLs). Sidebar regrouped into hub sections; Sales is the first collapsed hub (single entry + HubTabs strip via a (sales) route group — zero URL changes, zero new redirects). Framework (HubTabs + the group pattern) is what every subsequent hub PR reuses.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Preview QA (GET-only): sidebar shows the new sections; Sales entry highlights on /pipeline, /contacts/abc, /activities; tab strip appears on all three (and hides for a single-permission user); /sales bounces to the right first tab; badges on Approvals/Issues/Invoices/Communications/Email inbox/Dashboard/Settings still render.
