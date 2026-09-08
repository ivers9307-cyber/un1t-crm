# NAV-BADGE.1 — Approvals Sidebar Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a number on the sidebar's Approvals row showing the pending approvals the signed-in user can actually act on at their own role and locations.

**Architecture:** Restore `GET /api/approvals/count` (deleted by HOME.3) as a thin delegation to the existing `getPendingApprovalsCount`, which already applies each of the eleven approvals providers' own role/location gates. The sidebar polls it with the existing `usePolledCount` hook and existing `{ success, data: { count } }` envelope — no new client machinery. The browser-tab prefix switches from `/api/home-queue/count` to the sum of the two badges actually on screen, so title and pills cannot disagree. Net polled URLs stay at three.

**Tech Stack:** Next.js 16 App Router, `withAuth` route wrapper, vitest + @testing-library/react (jsdom), Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-08-sidebar-nav-badges-design.md`

**Worktree:** `~/code/un1t-crm-navbadges`, branch `sidebar-nav-badges`, based on `origin/main` @ `81319019`. `node_modules` is already seeded. Run every command from that directory.

---

## File Structure

| file | responsibility |
|---|---|
| `src/app/api/approvals/count/route.js` | **Create.** Auth-gated count endpoint. Delegates; holds no scoping logic of its own. |
| `src/app/api/approvals/count/route.test.js` | **Create.** Pins the delegation and the response envelope. |
| `src/lib/openapi.js` | **Modify.** Register the new route (repo convention: every route is registered). |
| `src/components/Sidebar.jsx` | **Modify.** Add the poller, drop the `home-queue/count` poller, turn the badge ternary into a lookup, add the pill's `aria-label`. |
| `src/components/Sidebar.test.jsx` | **Modify.** Existing badge tests assume exactly one pill can render; a second one breaks `getByTestId`. Add Approvals coverage. |

No new library, no migration, no `shared/` change → **no OTA**.

---

### Task 1: The count endpoint

> **Amended after code review (see the fix commit on this branch).** The header
> comment and the `location: false` justification below contained two factual
> errors: head coaches do **not** approve rosters (`shared/permissions.js:452`
> sets `approvals_rosters: false` for them), and scoping is the caller's
> **active location**, not every location they hold a role at
> (`registry.js`'s `APPROVALS-LOCATION-SCOPE` block; only `host_events` is
> org-wide). The route's *logic* is unchanged and correct as written. Take the
> committed files as the source of truth for the comment text.


**Files:**
- Create: `src/app/api/approvals/count/route.js`
- Test: `src/app/api/approvals/count/route.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/approvals/count/route.test.js`:

```js
// NAV-BADGE.1 — GET /api/approvals/count. Restores the badge endpoint HOME.3
// deleted. Delegates to getPendingApprovalsCount (src/lib/approvals/registry.js),
// which applies each provider's own role/location gate — this route must hold
// NO scoping logic of its own, or the badge can drift from what /approvals shows.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/approvals/registry', () => ({ getPendingApprovalsCount: vi.fn() }))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'

const req = () => new Request('http://x/api/approvals/count')
const headCoach = { id: 'u1', role: 'head_coach', activeLocation: { id: 'loc1' } }

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue({ marker: 'db' })
})

describe('GET /api/approvals/count', () => {
  it('401s when unauthenticated, without touching the registry', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(getPendingApprovalsCount).not.toHaveBeenCalled()
  })

  it('delegates to getPendingApprovalsCount with the service-role db and the user', async () => {
    getCurrentUser.mockResolvedValue(headCoach)
    getPendingApprovalsCount.mockResolvedValue(7)
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: { count: 7 } })
    expect(getPendingApprovalsCount).toHaveBeenCalledWith({ marker: 'db' }, headCoach)
  })

  // The sidebar polls this for EVERY authenticated session (see Task 3 — a
  // client-side permission gate cannot see other locations). A session with no
  // approver authority must therefore get a cheap, quiet zero, never a 403.
  it('answers a quiet 0 for a session with no approver authority', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u2', role: 'staff', activeLocation: { id: 'loc1' } })
    getPendingApprovalsCount.mockResolvedValue(0)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { count: 0 } })
  })

  // location: false — approvals span locations (host_events is org-wide, an
  // owner sees every location they own), so requiring an active location would
  // hide real work behind a 400.
  it('does not require an active location', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u3', role: 'owner', activeLocation: null })
    getPendingApprovalsCount.mockResolvedValue(4)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { count: 4 } })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/app/api/approvals/count/route.test.js
```

Expected: FAIL — `Failed to resolve import "./route"` (the route does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/app/api/approvals/count/route.js`:

```js
// GET /api/approvals/count — NAV-BADGE.1, the Approvals sidebar badge.
//
// HOME.3 deleted this route when it retired the eight per-item sidebar
// badges; MAIL-BADGE.1 then restored the Messages row, and this restores
// Approvals on the same narrow terms — one row, one poller, reading the
// number the /approvals page itself computes.
//
// It holds NO scoping logic. getPendingApprovalsCount fans out over the
// eleven providers applying EACH provider's own isVisible + role scoping,
// so a head coach counts rosters and shift swaps at their locations, an
// owner counts contractor invoices and FTE expenses, and master counts
// everything — without a line of that being restated here. Re-deriving the
// gate is how a badge starts disagreeing with the page it points at.
//
// permission: null, location: false — deliberately. The sidebar polls this
// for every authenticated session (a client-side gate reads the ACTIVE
// location only, and approvals span locations), so an ineligible session
// must get a cheap, quiet 0 rather than a 403. It is cheap because each
// provider's isVisible runs BEFORE its query.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: null, location: false },
  async ({ user, db }) => {
    const count = await getPendingApprovalsCount(db, user)
    return NextResponse.json({ success: true, data: { count } })
  }
)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/app/api/approvals/count/route.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/approvals/count/route.js src/app/api/approvals/count/route.test.js
git commit -m "NAV-BADGE.1 — restore GET /api/approvals/count"
```

---

### Task 2: Register the route in the OpenAPI spec

Repo convention (CLAUDE.md, "New API route"): every route is registered in `src/lib/openapi.js`.

**Files:**
- Modify: `src/lib/openapi.js` (insert immediately **before** the existing `registry.registerPath({ method: 'get', path: '/api/home-queue/count'` block, around line 6677)

- [ ] **Step 1: Add the registration**

Insert this block directly above the `/api/home-queue/count` registration:

```js
registry.registerPath({
  method: 'get',
  path: '/api/approvals/count',
  tags: ['Approvals'],
  security: [{ CookieAuth: [] }],
  summary: 'Count of pending approvals visible to the caller (sidebar badge)',
  description: 'NAV-BADGE.1 — the Approvals sidebar badge. Delegates to getPendingApprovalsCount, which fans out over every registered approvals provider applying each provider\'s own isVisible + role/location scoping, so the number is definitionally what GET /api/approvals/pending would render for the same caller. No permission gate and no active-location requirement: the sidebar polls this for every authenticated session (approvals span locations, so a client-side gate would hide real work), and a session with no approver authority gets a quiet 0 rather than a 403. Known limitation: a provider that throws is scored 0 by getPendingApprovalsCount, so one broken provider silently under-counts.',
  responses: {
    200: { description: '{ count }', content: { 'application/json': { schema: SuccessResponse(z.object({ count: z.number() })) } } },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 2: Verify the spec still builds**

```bash
npx vitest run src/lib/openapi.test.js
```

Expected: PASS. (`openapi.test.js` renders the whole document; a malformed block fails here.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/openapi.js
git commit -m "NAV-BADGE.1 — register /api/approvals/count in the OpenAPI spec"
```

---

### Task 3: Sidebar — poll the count, badge the row, retitle the tab

**Files:**
- Modify: `src/components/Sidebar.jsx` (the poller block at lines 74–115; the render site at line 230)
- Test: `src/components/Sidebar.test.jsx`

⚠️ **Read before writing tests:** `Sidebar.test.jsx` currently uses **singular** `screen.getByTestId('nav-badge')` in the `Messages badge` describe. Once Approvals can badge too, the shared `usePolledCount.mockReturnValue(n)` default makes *both* pills render and `getByTestId` throws "Found multiple elements". Those existing tests must move to `getAllByTestId` / URL-specific mocks. This is expected, not a regression.

- [ ] **Step 1: Write the failing tests**

In `src/components/Sidebar.test.jsx`, replace the entire `describe('Messages badge', …)` block with:

```js
// ── MAIL-BADGE.1 / NAV-BADGE.1 — the per-row outstanding-items badges ───
// Two rows can badge at once now, so every assertion here scopes to a row
// rather than reaching for "the" pill.
const badgeOnRow = (label) =>
  screen.getAllByTestId('nav-badge').find(b => b.closest('a')?.textContent?.includes(label))

describe('Messages badge', () => {
  it('sums the two hub counts onto the Messages row, estate mail included', () => {
    usePolledCount.mockImplementation(({ url }) => {
      if (url === '/api/whatsapp/unread-count') return 3
      if (url === '/api/email/mail/count?scope=all') return 14
      return 0
    })
    render(<Sidebar user={USER} />)
    expect(badgeOnRow('Messages').textContent).toBe('17')
  })

  it('renders NO badge at zero — an empty pill is noise', () => {
    usePolledCount.mockReturnValue(0)
    render(<Sidebar user={USER} />)
    expect(screen.queryByTestId('nav-badge')).toBeNull()
  })

  it('polls mail with scope=all — the estate, not the active studio', () => {
    render(<Sidebar user={USER} />)
    const urls = usePolledCount.mock.calls.map(([a]) => a?.url)
    expect(urls).toContain('/api/email/mail/count?scope=all')
  })

  it('caps the render at 99+', () => {
    usePolledCount.mockImplementation(({ url }) =>
      url === '/api/email/mail/count?scope=all' ? 250 : 0)
    render(<Sidebar user={USER} />)
    expect(badgeOnRow('Messages').textContent).toBe('99+')
  })
})

// ── NAV-BADGE.1 — the Approvals row ────────────────────────────────────
describe('Approvals badge', () => {
  it('badges the Approvals row from its own endpoint, not the Messages one', () => {
    usePolledCount.mockImplementation(({ url }) =>
      url === '/api/approvals/count' ? 7 : 0)
    render(<Sidebar user={USER} />)
    expect(badgeOnRow('Approvals').textContent).toBe('7')
    expect(badgeOnRow('Messages')).toBeUndefined()
  })

  // The endpoint self-gates, so there is nothing to gate on here. A
  // client-side hasPermission would also be checking the WRONG key: the nav
  // row's key is approvals_inbox, while the eleven providers each gate on
  // their own approvals_* key, so it could hide a badge for real work.
  it('polls unconditionally for a signed-in user', () => {
    render(<Sidebar user={USER} />)
    const call = usePolledCount.mock.calls.map(([a]) => a).find(a => a?.url === '/api/approvals/count')
    expect(call).toBeTruthy()
    expect(call.enabled).toBe(true)
  })

  it('no longer polls /api/home-queue/count — the title sums the visible pills now', () => {
    render(<Sidebar user={USER} />)
    const urls = usePolledCount.mock.calls.map(([a]) => a?.url)
    expect(urls).not.toContain('/api/home-queue/count')
  })

  it('titles the tab with the SUM of both badges, so title and pills agree', () => {
    usePolledCount.mockImplementation(({ url }) => {
      if (url === '/api/approvals/count') return 7
      if (url === '/api/whatsapp/unread-count') return 3
      return 0
    })
    render(<Sidebar user={USER} />)
    expect(document.title).toMatch(/^\(10\) /)
  })
})
```

Then fix the stale `HOME.3 badge retirement` describe (around line 53), whose comment now asserts the opposite of the shipped behaviour. Replace that whole describe with:

```js
describe('Sidebar — HOME.3 badge retirement, as amended', () => {
  // HOME.3 retired all eight per-item pills; MAIL-BADGE.1 restored Messages
  // and NAV-BADGE.1 restored Approvals. Everything else stays retired — in
  // particular the old RED pill and its "N pending" label are gone for good.
  it('badges only Messages and Approvals, even when every poller reports a count', () => {
    usePolledCount.mockReturnValue(7)
    mockPathname.mockReturnValue('/dashboard')
    render(<Sidebar user={USER} />)
    const rows = screen.getAllByTestId('nav-badge').map(b => b.closest('a')?.textContent)
    expect(rows).toHaveLength(2)
    expect(rows.join(' ')).toContain('Approvals')
    expect(rows.join(' ')).toContain('Messages')
    expect(screen.queryAllByLabelText(/pending$/)).toHaveLength(0)
    expect(document.querySelector('.bg-red-500')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/components/Sidebar.test.jsx
```

Expected: FAIL. The `Approvals badge` cases fail because no `/api/approvals/count` poller exists (`call` is `undefined`, `badgeOnRow('Approvals')` is `undefined`), and the amended retirement test fails with 1 badge instead of 2.

- [ ] **Step 3: Implement — swap the pollers**

In `src/components/Sidebar.jsx`, replace the `homeQueueCount` block (lines 74–92, the comment beginning `// HOME.3 — the per-item nav badge apparatus` through the closing `})` of the `usePolledCount` call) with:

```js
  // HOME.3 retired eight per-item nav badges (invoices, approvals, radar,
  // issues, WhatsApp, email tickets, host events) because each was a separate
  // poller duplicating a count /dashboard/today already computed. MAIL-BADGE.1
  // restored Messages on narrow terms; NAV-BADGE.1 restores Approvals on the
  // same ones. Net polled URLs are unchanged at three — this one replaces the
  // /api/home-queue/count poller rather than joining it.
  //
  // `enabled: !!user`, NOT a permission check. A client-side hasPermission
  // would check approvals_inbox (the nav row's key) while the eleven providers
  // each gate on their own approvals_* key — a different question, which could
  // hide a badge for work the caller really has. The endpoint self-gates and
  // answers 0 cheaply: isProviderVisible runs before any query, so a staff
  // session makes zero database calls.
  const approvalsBadge = usePolledCount({
    enabled: !!user,
    url: '/api/approvals/count',
  })
```

- [ ] **Step 4: Implement — the badge lookup**

Immediately after the `messagesBadge` line (currently line 112), add:

```js
  // NAV-BADGE.1 — which rows carry a number. A row absent from this map gets
  // no pill. Keep it a map, not a chain of ternaries at the render site.
  const navBadges = {
    '/communications': messagesBadge,
    '/approvals': approvalsBadge,
  }
```

Then at the render site (currently line 230) replace:

```jsx
        badge={item.href === '/communications' ? messagesBadge : 0}
```

with:

```jsx
        badge={navBadges[item.href] ?? 0}
```

- [ ] **Step 5: Implement — the tab title**

Replace the title `useEffect` body's count expression: change every `homeQueueCount` reference to `titleCount`, and define it directly above the effect:

```js
  // NAV-BADGE.1 — the title is the SUM OF THE VISIBLE PILLS, not a parallel
  // derivation of them (that was /api/home-queue/count, which stays in place
  // for /dashboard/today but no longer feeds this). Summing what is rendered
  // is the only way the title and the pills cannot disagree.
  const titleCount = approvalsBadge + messagesBadge
```

The effect becomes:

```js
  useEffect(() => {
    if (typeof document === 'undefined') return
    const original = document.title.replace(/^\(\d+\+?\)\s+/, '')
    document.title = titleCount > 0
      ? `(${titleCount > 99 ? '99+' : titleCount}) ${original}`
      : original
    return () => {
      if (typeof document !== 'undefined') {
        document.title = document.title.replace(/^\(\d+\+?\)\s+/, '')
      }
    }
  }, [titleCount])
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run src/components/Sidebar.test.jsx
```

Expected: PASS, all describes.

- [ ] **Step 7: Commit**

```bash
git add src/components/Sidebar.jsx src/components/Sidebar.test.jsx
git commit -m "NAV-BADGE.1 — badge the Approvals row; title sums the visible pills"
```

---

### Task 4: Label the pill for screen readers

A bare number beside a label announces as "Approvals 7", which could be a count of anything. This is a small fix inside the code Task 3 already touched.

**Files:**
- Modify: `src/components/Sidebar.jsx` (the `SidebarItem` badge JSX, currently lines 509–516)
- Test: `src/components/Sidebar.test.jsx`

- [ ] **Step 1: Write the failing test**

Append to the `Approvals badge` describe in `src/components/Sidebar.test.jsx`:

```js
  it('labels the pill for screen readers — a bare number announces as nothing', () => {
    usePolledCount.mockImplementation(({ url }) =>
      url === '/api/approvals/count' ? 7 : 0)
    render(<Sidebar user={USER} />)
    expect(screen.getByLabelText('7 items need your attention')).toBeTruthy()
  })

  it('says "item", singular, at one', () => {
    usePolledCount.mockImplementation(({ url }) =>
      url === '/api/approvals/count' ? 1 : 0)
    render(<Sidebar user={USER} />)
    expect(screen.getByLabelText('1 item needs your attention')).toBeTruthy()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/components/Sidebar.test.jsx -t "screen readers"
```

Expected: FAIL — `Unable to find a label with the text of: 7 items need your attention`.

- [ ] **Step 3: Implement**

In `SidebarItem`, replace the badge JSX with:

```jsx
      {badge > 0 && (
        <span
          data-testid="nav-badge"
          // NAV-BADGE.1 — the number alone announces as "Approvals 7", which
          // could be a count of anything. The label says what it counts. It is
          // NOT capped like the visible text: "99+ items" is fine to hear.
          aria-label={`${badge} ${badge === 1 ? 'item needs' : 'items need'} your attention`}
          className="ml-auto rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-700"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/components/Sidebar.test.jsx
```

Expected: PASS, all describes.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.jsx src/components/Sidebar.test.jsx
git commit -m "NAV-BADGE.1 — label the nav badge for screen readers"
```

---

### Task 5: Full gate, browser verification, ship

- [ ] **Step 1: Run the whole suite**

```bash
npm test
```

Expected: PASS. Baseline on this branch is 22,049 tests across 1,295 files; this plan adds tests and modifies `Sidebar.test.jsx`, so expect a slightly higher total and **zero** failures. A failure in `home-queue` or `poll-store` means something outside this plan's blast radius was touched — investigate rather than adjust the test.

- [ ] **Step 2: Run the eleven-check CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: 0 errors. Two checks are load-bearing for this change specifically:
- `check:route-guards` — the new route must be recognised as session-guarded. It is, via `withAuth`.
- `check:guardrails` — the pill's `bg-amber-500/10 text-amber-700` already satisfies `no-low-contrast-chip`; do not change the ramp.

- [ ] **Step 3: Run the production build**

```bash
npm run build
```

Expected: exit 0. This task adds a new route and new imports, and `next build` is the only check that catches import-resolution and Turbopack failures — vitest runs on mocked imports and will not.

- [ ] **Step 4: Verify in the browser — jsdom cannot do this**

🔴 This estate has already shipped a toggle that did nothing behind a green suite. jsdom judges the pill's *presence*, never its *layout*.

Start the preview, sign in, and confirm with a screenshot:
1. The Approvals row shows a number matching `/approvals` (at the time of writing: 7 — five time-off, two contractor invoices).
2. **Two pills render at once** without either overlapping its row label or pushing the label out of the row — Messages and Approvals side by side is the case jsdom cannot judge.
3. The browser tab reads `(N) …` where N is the two pills added up.

- [ ] **Step 5: Add the changelog row and open the PR**

Push, open the PR, then add the row keyed by the PR number under the table header in `docs/CHANGELOG.md` (rows carry the PR number, so the number is known only after `gh pr create`; `merge=union` in `.gitattributes` keeps concurrent inserts conflict-free — never edit a pushed row).

```bash
git push -u origin HEAD
gh pr create --base main --fill
```

Then commit the changelog row and push again. Wait for **Test & lint** and **Next build** to go green before merging — `main` is branch-protected and the branch must be up to date.

---

## Out of scope — do not do these here

Each is logged as a follow-up in the spec. Touching them widens the diff into surfaces this plan has not tested.

- **No `/money` badge.** `invoices_queue` is already an approvals provider, so a Money badge would count the same rows twice under a narrower definition (`received`/`extracted` vs the provider's four statuses) and a different permission (`invoices_inbox` vs `bookkeeper`).
- **Do not "fix" the two invoices-queue definitions.** They disagree on `main` today; that is pre-existing and belongs in its own change.
- **Do not delete `/api/home-queue/count`.** It still serves `/dashboard/today`. Only the sidebar stops consuming it.
- **Do not give `getPendingApprovalsCount` a `{ count, degraded }` contract.** It would improve the silent-under-count limitation, but it also changes `home-queue.js`'s caller and belongs in its own change.
- **No badge registry, no aggregate endpoint, no `poll-store` refactor.** With one source they are scaffolding; build them when a real second source can shape them.
