# Host Portal Nav + Signup Page Surfacing & Customisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give hosts persistent portal navigation with a prominent Create-event CTA, surface their existing `/h/[slug]` lead-capture page (link, QR, count), make the page copy host-customisable, and add a "Mailing list signups" audience to the email composer.

**Architecture:** Two PRs off `feat/host-portal-nav-signup` (worktree `~/code/un1t-crm-hostgrowth`). PR A is UI + one extracted helper, no schema. PR B is one forward-only migration (4 copy columns on `event_hosts` + `audience_kind` on `host_campaigns`), one new host-session route, and threading the new audience through create/update/send/composer. Spec: `docs/superpowers/specs/2026-07-30-host-portal-nav-signup-design.md`.

**Tech Stack:** Next.js 16 App Router (server components + small client components), Supabase service client, Zod, Vitest, `qrcode` (already a dep), Tailwind.

**Repo rules that bind every task:** service-role routes enforce access in code; builders are thenables (`try/catch`, never `.catch`); `await` every insert/update; migrations applied via Supabase MCP against `iyvtbjjxdggiadzwwvdj` then `get_advisors`; `type="button"` on non-submit buttons; no silent env fallbacks; register routes in `src/lib/openapi.js`; CI mirror = `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`, plus `npm run build` locally (new routes/imports).

**Discovered during planning (deviations from spec wording, same intent):**
- `ensureHostSlug` already exists as a private function in `src/app/api/hosts/[id]/email-domain/route.js:65` — Task A2 extracts it to `src/lib/hosts.js` and reuses it; no new derivation logic.
- `host_campaigns.audience_event_id` is a uuid FK, so the "Mailing list signups" audience cannot ride a sentinel value in it. PR B's migration adds `host_campaigns.audience_kind text NOT NULL DEFAULT 'all' CHECK (audience_kind IN ('all','event','mailing_list'))` with a backfill (`audience_event_id IS NOT NULL → 'event'`).
- QR is served by a new host-session GET route returning PNG (mirrors `src/app/api/events/[id]/qr-code/route.js`) rather than client-side rendering — keeps the client bundle clean and matches the repo pattern.

---

## PR A — header nav + signup card (branch `feat/host-portal-nav-signup`, PR title "HOST-GROWTH.A — host portal nav + signup-page card")

### Task A1: HostNav component + layout rewire + dashboard pill removal

**Files:**
- Create: `src/components/host/HostNav.jsx`
- Modify: `src/app/host/(portal)/layout.js` (header block, lines 23-37)
- Modify: `src/app/host/(portal)/page.js` (remove pills, lines 132-159)

- [ ] **Step 1: Create the client nav component**

```jsx
'use client'

// Host-portal header navigation (HOST-GROWTH.A). Persistent on every
// (portal) page: Dashboard / Contacts / Emails links with an active state,
// plus the prominent "+ Create event" CTA. Client component only for
// usePathname — no data fetching here.

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/host', label: 'Dashboard', exact: true },
  { href: '/host/contacts', label: 'Contacts', exact: false },
  { href: '/host/emails', label: 'Emails', exact: false },
]

// Exact match for /host (otherwise it would light up on every page);
// prefix match for the sections so detail pages keep them active.
export function isNavActive(pathname, { href, exact }) {
  if (exact) return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export default function HostNav() {
  const pathname = usePathname() || ''
  return (
    <nav aria-label="Host portal" className="flex items-center gap-1">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={`rounded-lg px-3 py-1.5 text-sm ${
            isNavActive(pathname, l)
              ? 'bg-white/10 text-white font-semibold'
              : 'text-white/60 hover:text-white hover:bg-white/5'
          }`}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  )
}
```

- [ ] **Step 2: Rewire the layout header**

In `src/app/host/(portal)/layout.js`, add imports and replace the `<header>` block. The impersonation safeguard comment and logic stay exactly as-is.

```jsx
import Link from 'next/link'
import HostNav from '@/components/host/HostNav'
```

```jsx
      <header className="border-b border-white/10">
        <div className="max-w-4xl mx-auto px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-3 shrink-0">
            <span className="font-bold tracking-[0.2em]">UN1T</span>
            <span className="text-xs uppercase tracking-[0.15em] text-white/45">Hosts</span>
          </div>
          <HostNav />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link
              href="/host/events/new"
              className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-white/90 whitespace-nowrap"
            >
              + Create event
            </Link>
            <span className="text-white/70 hidden sm:inline">{session.host.name}</span>
            {/* SAFEGUARD: HostSignOut calls supabase.auth.signOut(), which would
                destroy the admin's real staff session. An admin viewing-as must
                exit via the banner's "Exit to CRM", never sign out here. */}
            {session.impersonatedBy ? null : <HostSignOut />}
          </div>
        </div>
      </header>
```

Notes: `flex-wrap` + `py-2.5` (not fixed `h-14`) lets the nav wrap to a second row on narrow screens with the CTA staying visible; host name hides on the smallest screens (`hidden sm:inline`) — sign out remains.

- [ ] **Step 3: Remove the dashboard pills**

In `src/app/host/(portal)/page.js`, replace the "Your events" heading row (the `div.flex.items-center.justify-between` containing the three `Link` pills, lines 133-158) with just:

```jsx
        <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">Your events</h2>
```

And make the empty state actionable (replace the existing `No events yet` paragraph):

```jsx
          <p className="text-white/50 text-sm">
            No events yet — <Link href="/host/events/new" className="text-white underline underline-offset-2 hover:text-white/80">create your first one</Link>.
          </p>
```

(`Link` is already imported in this file.)

- [ ] **Step 4: Verify**

Run: `npm run lint && npm run build`
Expected: both green (no new lint errors, build resolves the new import).

- [ ] **Step 5: Commit**

```bash
git add src/components/host/HostNav.jsx 'src/app/host/(portal)/layout.js' 'src/app/host/(portal)/page.js'
git commit -m "HOST-GROWTH.1 — persistent host-portal header nav + prominent Create event CTA"
```

### Task A2: Extract `ensureHostSlug` into `src/lib/hosts.js` (TDD)

**Files:**
- Modify: `src/lib/hosts.js` (add export)
- Modify: `src/app/api/hosts/[id]/email-domain/route.js` (delete local copy at lines 62-75, import instead)
- Test: `src/lib/hosts.test.js` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/hosts.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { ensureHostSlug } from './hosts'

// Minimal supabase-shaped mock: db.from('event_hosts').update({slug}).eq('id', X)
// resolves { error } — ensureHostSlug retries with -2, -3… suffixes on 23505.
function mockDb(errorsInOrder) {
  const updates = []
  let call = 0
  const db = {
    from: vi.fn(() => ({
      update: vi.fn((patch) => ({
        eq: vi.fn(async () => {
          updates.push(patch.slug)
          const error = errorsInOrder[call] || null
          call += 1
          return { error }
        }),
      })),
    })),
  }
  return { db, updates }
}

describe('ensureHostSlug', () => {
  it('returns the existing slug without writing', async () => {
    const { db } = mockDb([])
    const slug = await ensureHostSlug(db, { id: 'h1', name: 'Acme', slug: 'acme' })
    expect(slug).toBe('acme')
    expect(db.from).not.toHaveBeenCalled()
  })

  it('derives from the name and persists', async () => {
    const { db, updates } = mockDb([null])
    const slug = await ensureHostSlug(db, { id: 'h1', name: 'Pride Training Club', slug: null })
    expect(slug).toBe('pride-training-club')
    expect(updates).toEqual(['pride-training-club'])
  })

  it('suffixes on unique violation', async () => {
    const { db, updates } = mockDb([{ code: '23505' }, null])
    const slug = await ensureHostSlug(db, { id: 'h1', name: 'Acme', slug: null })
    expect(slug).toBe('acme-2')
    expect(updates).toEqual(['acme', 'acme-2'])
  })

  it('throws on a non-unique-violation error', async () => {
    const { db } = mockDb([{ code: '42501', message: 'nope' }])
    await expect(ensureHostSlug(db, { id: 'h1', name: 'Acme', slug: null })).rejects.toThrow(/slug persist failed/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/hosts.test.js`
Expected: FAIL — `ensureHostSlug` is not exported.

- [ ] **Step 3: Move the function**

Cut the `ensureHostSlug` function (with its comment) from `src/app/api/hosts/[id]/email-domain/route.js` verbatim into `src/lib/hosts.js` as an `export async function`, adding the import it needs there:

```js
import { sanitizeDomainLabel } from '@/lib/postmark-domains'
```

In the email-domain route, delete the local copy and add:

```js
import { ensureHostSlug } from '@/lib/hosts'
```

(Behaviour identical — the function body does not change.)

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/lib/hosts.test.js && npm run build`
Expected: 4 tests PASS; build green (import cycle check — `postmark-domains` must not import `hosts`; it doesn't today).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hosts.js src/lib/hosts.test.js 'src/app/api/hosts/[id]/email-domain/route.js'
git commit -m "HOST-GROWTH.2 — extract ensureHostSlug to src/lib/hosts.js for reuse"
```

### Task A3: Signup QR route (`GET /api/host/signup-qr`)

**Files:**
- Create: `src/app/api/host/signup-qr/route.js`

- [ ] **Step 1: Create the route**

Mirrors `src/app/api/events/[id]/qr-code/route.js` (800×800 PNG, margin 2, ECC 'M') but host-session-gated and pointing at the host's own `/h/[slug]`:

```js
// GET /api/host/signup-qr — printable QR PNG for the host's public
// mailing-list signup page /h/[slug] (HOST-GROWTH.A). Host session only;
// ensures the slug exists first (same lazy derivation the email-domain
// flow uses). Same PNG geometry as the events QR route: 800×800,
// quiet-zone margin 2, ECC 'M'.

import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { ensureHostSlug } from '@/lib/hosts'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: hostRow } = await db
    .from('event_hosts')
    .select('id, name, slug')
    .eq('id', session.host.id)
    .maybeSingle()
  if (!hostRow) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  let slug
  try {
    slug = await ensureHostSlug(db, hostRow)
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }

  const png = await QRCode.toBuffer(`${getAppUrl()}/h/${slug}`, {
    type: 'png', width: 800, margin: 2, errorCorrectionLevel: 'M',
  })
  return new NextResponse(png, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="signup-qr-${slug}.png"`,
      'Cache-Control': 'no-store',
    },
  })
}
```

- [ ] **Step 2: Verify guards + build**

Run: `npm run check:route-guards && npm run build`
Expected: green — the script accepts `getCurrentHost` (every existing `/api/host/*` route passes with it).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/host/signup-qr/route.js
git commit -m "HOST-GROWTH.3 — GET /api/host/signup-qr printable QR for the signup page"
```

### Task A4: "Your signup page" dashboard card

**Files:**
- Create: `src/components/host/HostSignupPageCard.jsx` (client — copy button needs the clipboard)
- Modify: `src/app/host/(portal)/page.js` (new section between the Stripe banner and Revenue; extra queries)

- [ ] **Step 1: Create the client card**

```jsx
'use client'

// "Your signup page" card (HOST-GROWTH.A) — surfaces the host's public
// /h/[slug] lead-capture page: full URL + copy, open, QR download, and
// the mailing-list signup count. Pure presentation; the server dashboard
// resolves url/count and handles the degraded (no-slug) case.

import { useState } from 'react'

export default function HostSignupPageCard({ url, signupCount }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard unavailable (permissions/http) — the URL is visible to
      // select manually, so no error surface needed.
    }
  }

  const btn = 'rounded-lg border border-white/15 text-white/80 text-xs font-semibold px-3 py-1.5 hover:bg-white/10 hover:text-white'

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Your signup page</p>
        <p className="mt-1 text-xs text-white/50 break-all">
          {url}
          {signupCount != null && (
            <span className="text-emerald-300"> · {signupCount} signup{signupCount === 1 ? '' : 's'}</span>
          )}
        </p>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        <button type="button" onClick={copy} className={btn}>{copied ? 'Copied' : 'Copy link'}</button>
        <a href={url} target="_blank" rel="noopener noreferrer" className={btn}>Open</a>
        <a href="/api/host/signup-qr" className={btn}>QR code</a>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire the dashboard**

In `src/app/host/(portal)/page.js`:

Add imports:

```js
import { ensureHostSlug } from '@/lib/hosts'
import { getAppUrl } from '@/lib/app-url'
import HostSignupPageCard from '@/components/host/HostSignupPageCard'
```

After the `revenue` load, resolve the card's data (degrade, never 500 — same posture as the revenue try/catch):

```js
  // "Your signup page" (HOST-GROWTH.A) — lazily ensure the /h/[slug] slug
  // (same derivation the email-domain flow uses) + count mailing-list
  // signups. Any failure degrades to signupUrl=null (card hides).
  let signupUrl = null
  let signupCount = null
  try {
    const { data: hostRow } = await db
      .from('event_hosts')
      .select('id, name, slug')
      .eq('id', session.host.id)
      .maybeSingle()
    if (hostRow) {
      const slug = await ensureHostSlug(db, hostRow)
      signupUrl = `${getAppUrl()}/h/${slug}`
      const { count } = await db
        .from('host_contacts')
        .select('*', { count: 'exact', head: true })
        .eq('host_id', session.host.id)
        .eq('source', 'mailing_list')
      signupCount = count ?? 0
    }
  } catch {
    signupUrl = null
  }
```

Insert the section between the `needsStripe` banner and the Revenue `<section>`:

```jsx
      {signupUrl && (
        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">Grow your list</h2>
          <HostSignupPageCard url={signupUrl} signupCount={signupCount} />
          <p className="mt-2 text-xs text-white/40">
            Share this link or QR anywhere — signups land in your Contacts and can be emailed from Emails.
          </p>
        </section>
      )}
```

- [ ] **Step 3: Verify**

Run: `npm run lint && npm run build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/components/host/HostSignupPageCard.jsx 'src/app/host/(portal)/page.js'
git commit -m "HOST-GROWTH.4 — 'Your signup page' dashboard card: link, copy, QR, signup count"
```

### Task A5: Separation regression test

**Files:**
- Test: `src/lib/postmark.audience-scope.test.js` (create)

- [ ] **Step 1: Write the test**

Documents the invariant that keeps host leads out of UN1T marketing: every audience query is pinned to exactly one location, so contacts at a host anchor location can never match a UN1T broadcast built for a real location.

```js
import { describe, it, expect, vi } from 'vitest'
import { buildAudienceQuery } from './postmark'

// SEPARATION INVARIANT (HOST-GROWTH spec): host mailing-list signups live at
// the host's anchor location (locations.is_host_anchor=true). UN1T campaign
// audiences must therefore ALWAYS be pinned .eq('location_id', <location>) —
// if that filter is ever dropped, host leads leak into gym marketing.
function chainRecorder() {
  const calls = []
  const chain = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'calls') return calls
      return (...args) => { calls.push([prop, args]); return chain }
    },
  })
  return chain
}

describe('buildAudienceQuery location pinning', () => {
  it('always applies .eq(location_id, <given location>)', () => {
    const db = { from: vi.fn(() => chainRecorder()) }
    const q = buildAudienceQuery(db, {}, 'real-location-uuid')
    const eqCalls = q.calls.filter(([m]) => m === 'eq')
    expect(eqCalls).toContainEqual(['eq', ['location_id', 'real-location-uuid']])
  })
})
```

- [ ] **Step 2: Run**

Run: `npx vitest run src/lib/postmark.audience-scope.test.js`
Expected: PASS (the pin already exists at `src/lib/postmark.js:466`). If the chain shape doesn't match (e.g. `buildAudienceQuery` starts with `.select()` options), adapt the recorder — the assertion (an `eq('location_id', …)` call happened) is the contract.

- [ ] **Step 3: Commit**

```bash
git add src/lib/postmark.audience-scope.test.js
git commit -m "HOST-GROWTH.5 — regression test: UN1T audience queries stay location-pinned (host-lead separation)"
```

### Task A6: PR A — full CI mirror + ship

- [ ] **Step 1: Full local CI mirror + build**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build`
Expected: all green (~6150+ tests).

- [ ] **Step 2: Visual spot-check (dev server)**

Run `npm run dev`, sign in as a host (or admin view-as-host from Settings→Hosts), verify: nav on all three pages with correct active state; Create event button; signup card link opens `/h/[slug]`; QR downloads a scannable PNG; copy works.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/host-portal-nav-signup
gh pr create --base main --title "HOST-GROWTH.A — host portal nav + signup-page card" --body "$(cat <<'EOF'
Persistent host-portal header nav (Dashboard / Contacts / Emails + prominent
"+ Create event" CTA) replacing the tiny dashboard pills, plus a "Grow your
list" card surfacing the existing /h/[slug] mailing-list page: copy link,
open, printable QR (new GET /api/host/signup-qr), and live signup count.
ensureHostSlug extracted to src/lib/hosts.js (was private to the
email-domain route) so the dashboard can lazily provision the slug.
Includes a regression test pinning the audience-query location filter that
keeps host leads out of UN1T marketing. No schema changes.

Spec: docs/superpowers/specs/2026-07-30-host-portal-nav-signup-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR B — customisation + audience option (branch `feat/host-list-customise` off PR A's branch once merged, or stacked; PR title "HOST-GROWTH.B — host-customisable signup page + mailing-list audience")

> If PR A has merged, branch off fresh `origin/main`. If stacking, remember the repo trap: deleting a stacked PR's base branch closes the PR.

### Task B1: Migration 460 (re-check the next free number at apply time)

**Files:**
- Create: `supabase/migrations/460_host_list_copy_and_audience_kind.sql`

- [ ] **Step 1: Write the migration**

```sql
-- HOST-GROWTH.B — host-customisable /h/[slug] signup-page copy + a
-- 'mailing_list' audience for host campaigns.
--
-- Copy columns are nullable; NULL renders the built-in default wording
-- (operator-editable-copy rule: settings field + default fallback — the
-- host is the operator of their own page).
alter table event_hosts
  add column if not exists list_headline text,
  add column if not exists list_blurb text,
  add column if not exists list_button_label text,
  add column if not exists list_success_message text;

comment on column event_hosts.list_headline is 'HOST-GROWTH.B — /h/[slug] headline override; NULL = host name.';
comment on column event_hosts.list_blurb is 'HOST-GROWTH.B — /h/[slug] blurb override; NULL = default copy.';
comment on column event_hosts.list_button_label is 'HOST-GROWTH.B — /h/[slug] submit button label; NULL = "Join the list".';
comment on column event_hosts.list_success_message is 'HOST-GROWTH.B — /h/[slug] post-signup message; NULL = default copy.';

-- audience_event_id is a uuid FK, so the mailing-list audience needs its own
-- discriminator. Backfill BEFORE the check constraint so legacy per-event
-- drafts satisfy it.
alter table host_campaigns
  add column if not exists audience_kind text not null default 'all';

update host_campaigns set audience_kind = 'event' where audience_event_id is not null;

alter table host_campaigns
  add constraint host_campaigns_audience_kind_check
  check (audience_kind in ('all', 'event', 'mailing_list'));

comment on column host_campaigns.audience_kind is
  'HOST-GROWTH.B — all | event (uses audience_event_id) | mailing_list (host_contacts.source=mailing_list only).';
```

- [ ] **Step 2: Apply via Supabase MCP**

Apply with `apply_migration` against project `iyvtbjjxdggiadzwwvdj` (confirm via `list_projects` — NOT the sentinel project), name `460_host_list_copy_and_audience_kind`. Then run `get_advisors` (type=security) — expect no new findings (no RLS change, no view).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/460_host_list_copy_and_audience_kind.sql
git commit -m "HOST-GROWTH.6 — mig 460: host list-page copy columns + host_campaigns.audience_kind"
```

### Task B2: `PATCH /api/host/list-page` + `GET` (TDD)

**Files:**
- Create: `src/app/api/host/list-page/route.js`
- Test: `src/app/api/host/list-page/route.test.js`

- [ ] **Step 1: Write the failing tests**

Mirror the mocking style of `src/app/api/host/emails/[id]/send/route.test.js` (vi.mock `@/lib/host-auth` and `@/lib/supabase`). Test at minimum:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ getCurrentHost: vi.fn(), createServerClient: vi.fn() }))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: mocks.getCurrentHost }))
vi.mock('@/lib/supabase', () => ({ createServerClient: mocks.createServerClient }))

import { GET, PATCH } from './route'

function dbWith({ row = {}, updateError = null } = {}) {
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: updateError })) }))
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: row })) })) })),
      update,
    })),
    _update: update,
  }
}

function req(body) {
  return new Request('http://x/api/host/list-page', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

beforeEach(() => vi.clearAllMocks())

describe('PATCH /api/host/list-page', () => {
  it('401s without a host session', async () => {
    mocks.getCurrentHost.mockResolvedValue(null)
    const res = await PATCH(req({ list_headline: 'Hi' }))
    expect(res.status).toBe(401)
  })

  it('rejects over-cap fields with issues', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    mocks.createServerClient.mockReturnValue(dbWith({}))
    const res = await PATCH(req({ list_headline: 'x'.repeat(121) }))
    expect(res.status).toBe(400)
  })

  it('trims, converts empty strings to null, and updates only the host row', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    const db = dbWith({})
    mocks.createServerClient.mockReturnValue(db)
    const res = await PATCH(req({ list_headline: '  Hello  ', list_blurb: '' }))
    expect(res.status).toBe(200)
    expect(db._update).toHaveBeenCalledWith({ list_headline: 'Hello', list_blurb: null })
  })
})

describe('GET /api/host/list-page', () => {
  it('returns the four copy fields + slug for the session host', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    mocks.createServerClient.mockReturnValue(dbWith({ row: { slug: 'acme', list_headline: 'Hi', list_blurb: null, list_button_label: null, list_success_message: null } }))
    const res = await GET()
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.list_headline).toBe('Hi')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/host/list-page/route.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

```js
// GET/PATCH /api/host/list-page — the host's own /h/[slug] page copy
// (HOST-GROWTH.B). Host session; PATCH updates only the four copy columns
// for session.host.id (empty string → NULL → default copy on the public
// page). Partial updates: only supplied keys are written.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const COLS = 'slug, list_headline, list_blurb, list_button_label, list_success_message'

const field = (max) => z.string().trim().max(max).optional()
const ListPageSchema = z.object({
  list_headline: field(120),
  list_blurb: field(500),
  list_button_label: field(40),
  list_success_message: field(500),
}).strict()

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const { data, error } = await db.from('event_hosts').select(COLS).eq('id', session.host.id).maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || {} })
}

export async function PATCH(request) {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = ListPageSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
  }

  const patch = {}
  for (const [k, v] of Object.entries(parsed.data)) patch[k] = v === '' ? null : v
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ success: false, error: 'Nothing to update' }, { status: 400 })
  }

  const db = createServerClient()
  const { error } = await db.from('event_hosts').update(patch).eq('id', session.host.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: patch })
}
```

- [ ] **Step 4: Run tests + guards**

Run: `npx vitest run src/app/api/host/list-page/route.test.js && npm run check:route-guards`
Expected: PASS / green.

- [ ] **Step 5: Register in `src/lib/openapi.js`**

Follow the existing host-route entries' pattern (find the `/api/host/emails` registration and add a sibling): path `/api/host/list-page`, GET + PATCH, request schema mirroring `ListPageSchema`, standard `{ success, data }` response.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/host/list-page/ src/lib/openapi.js
git commit -m "HOST-GROWTH.7 — GET/PATCH /api/host/list-page (host-editable signup-page copy)"
```

### Task B3: Public page renders the custom copy

**Files:**
- Modify: `src/app/h/[slug]/page.js` (select + props)
- Modify: `src/components/HostListSignup.jsx` (props + fallbacks)

- [ ] **Step 1: Widen the page query and pass props**

In `src/app/h/[slug]/page.js`, change the select to:

```js
    .select('id, name, slug, list_headline, list_blurb, list_button_label, list_success_message')
```

and render:

```jsx
      <HostListSignup
        slug={host.slug}
        hostName={host.name}
        headline={host.list_headline}
        blurb={host.list_blurb}
        buttonLabel={host.list_button_label}
        successMessage={host.list_success_message}
      />
```

Also use the custom copy in `generateMetadata` (widen its select to `name, list_blurb` and use `list_blurb ||` the current default description).

- [ ] **Step 2: Per-field fallbacks in the component**

In `src/components/HostListSignup.jsx`, change the signature and the four render points (all plain text nodes — no HTML injection surface):

```jsx
export default function HostListSignup({ slug, hostName, headline, blurb, buttonLabel, successMessage }) {
```

- `<h1>` (form state): `{headline || hostName}`
- Intro `<p>`: `{blurb || `Get emails about ${hostName}'s events. Unsubscribe anytime.`}`
- Submit button: `{submitting ? 'Joining…' : (buttonLabel || 'Join the list')}`
- Success `<p>`: `{successMessage || `We'll email you about ${hostName}'s upcoming events. You can unsubscribe anytime from any email.`}` — keep the unsubscribe promise in the DEFAULT; hosts may replace it, the footer unsubscribe link in every email is the binding mechanism.

- [ ] **Step 3: Verify**

Run: `npm run lint && npm run build`
Expected: green. Dev-server check: `/h/[slug]` unchanged for a host with NULL copy.

- [ ] **Step 4: Commit**

```bash
git add 'src/app/h/[slug]/page.js' src/components/HostListSignup.jsx
git commit -m "HOST-GROWTH.8 — /h/[slug] renders host-customised copy with per-field defaults"
```

### Task B4: Customise editor on the dashboard card

**Files:**
- Create: `src/components/host/HostListPageEditor.jsx`
- Modify: `src/components/host/HostSignupPageCard.jsx` (add Customise button + mount editor)
- Modify: `src/app/host/(portal)/page.js` (pass current copy values to the card)

- [ ] **Step 1: Create the editor**

Inline expanding panel (not a modal — simpler, no portal/focus traps), fetches current values from `GET /api/host/list-page` on open, saves via PATCH:

```jsx
'use client'

// Signup-page copy editor (HOST-GROWTH.B). Collapsible panel under the
// "Your signup page" card: four capped text fields, per-field default
// placeholders, save via PATCH /api/host/list-page. Empty field = use the
// default (stored as NULL).

import { useState } from 'react'

const FIELDS = [
  { key: 'list_headline', label: 'Headline', max: 120, multiline: false, placeholder: 'Default: your host name' },
  { key: 'list_blurb', label: 'Intro text', max: 500, multiline: true, placeholder: 'Default: "Get emails about your events. Unsubscribe anytime."' },
  { key: 'list_button_label', label: 'Button label', max: 40, multiline: false, placeholder: 'Default: "Join the list"' },
  { key: 'list_success_message', label: 'Success message', max: 500, multiline: true, placeholder: 'Default: "We\'ll email you about upcoming events…"' },
]

const INPUT = 'w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/40'

export default function HostListPageEditor({ initial, previewUrl, onClose, onSaved }) {
  const [values, setValues] = useState(() => {
    const v = {}
    for (const f of FIELDS) v[f.key] = initial?.[f.key] || ''
    return v
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/host/list-page', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || 'Could not save — try again.')
      onSaved(values)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
      {FIELDS.map((f) => (
        <div key={f.key}>
          <label htmlFor={`lp-${f.key}`} className="block text-xs text-white/50 mb-1">
            {f.label} <span className="text-white/30">({(values[f.key] || '').length}/{f.max})</span>
          </label>
          {f.multiline ? (
            <textarea id={`lp-${f.key}`} rows={3} maxLength={f.max} value={values[f.key]} placeholder={f.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className={INPUT} />
          ) : (
            <input id={`lp-${f.key}`} maxLength={f.max} value={values[f.key]} placeholder={f.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className={INPUT} />
          )}
        </div>
      ))}
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={save} disabled={saving}
          className="rounded-lg bg-white text-black text-xs font-semibold px-4 py-2 hover:bg-white/90 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onClose} className="text-xs text-white/50 hover:text-white px-2 py-2">Cancel</button>
        <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="ml-auto text-xs text-white/40 hover:text-white">
          Preview →
        </a>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Mount from the card**

`HostSignupPageCard.jsx` gains a `Customise` button (same `btn` class, after `QR code`) toggling `const [editing, setEditing] = useState(false)`, and props `copyValues` (the four current values, passed from the server dashboard) so the editor opens pre-filled without a fetch:

```jsx
        <button type="button" onClick={() => setEditing((v) => !v)} className={btn}>Customise</button>
```

```jsx
      {editing && (
        <div className="w-full">
          <HostListPageEditor
            initial={copyValues}
            previewUrl={url}
            onClose={() => setEditing(false)}
            onSaved={() => setEditing(false)}
          />
        </div>
      )}
```

In `src/app/host/(portal)/page.js`, widen the card's host query select to include the four copy columns and pass `copyValues={{ list_headline: hostRow.list_headline, list_blurb: hostRow.list_blurb, list_button_label: hostRow.list_button_label, list_success_message: hostRow.list_success_message }}`.

(The editor's `GET /api/host/list-page` stays useful for other clients; the card path doesn't need it. If you prefer the fetch-on-open shape, either works — pick one and delete the other path.)

- [ ] **Step 3: Verify**

Run: `npm run lint && npm run build`; dev-server: edit copy → save → `/h/[slug]` shows it; clear a field → default returns.

- [ ] **Step 4: Commit**

```bash
git add src/components/host/HostListPageEditor.jsx src/components/host/HostSignupPageCard.jsx 'src/app/host/(portal)/page.js'
git commit -m "HOST-GROWTH.9 — Customise editor for the signup page on the dashboard card"
```

### Task B5: `resolveHostRecipients` mailing-list branch (TDD)

**Files:**
- Modify: `src/lib/host-campaign-email.js:186` (`resolveHostRecipients`)
- Test: `src/lib/host-campaign-email.test.js` (extend)

- [ ] **Step 1: Write the failing test**

Follow the file's existing mock style (it already tests `resolveHostRecipients` — extend with):

```js
it('mailingListOnly restricts the host_contacts query to source=mailing_list', async () => {
  // Arrange the existing mock db so the host_contacts select chain records
  // .eq calls; assert ['source', 'mailing_list'] is among them, and that a
  // source='event' row is absent from the result while a mailing_list row
  // with full consent is present.
})
```

(Adapt to the file's established fixtures — the existing tests already fabricate `host_contacts` pages with consent flags; add `source` to the fixtures.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/host-campaign-email.test.js`
Expected: new test FAILS (option not implemented).

- [ ] **Step 3: Implement**

In `resolveHostRecipients`, extend the signature and the `host_contacts` query:

```js
export async function resolveHostRecipients(db, hostId, { audienceEventId = null, emailType = 'marketing', mailingListOnly = false } = {}) {
```

```js
    let query = db
      .from('host_contacts')
      .select(`
        contact_id,
        contact:contacts!contact_id ( id, email, email_marketing, email_administrative, email_status, email_suppressed_at )
      `)
      .eq('host_id', hostId)
    if (mailingListOnly) query = query.eq('source', 'mailing_list')
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, from + PAGE - 1)
```

(All send-time consent/suppression gates downstream are untouched.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/host-campaign-email.test.js`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/host-campaign-email.js src/lib/host-campaign-email.test.js
git commit -m "HOST-GROWTH.10 — resolveHostRecipients mailingListOnly option"
```

### Task B6: Audience kind through create / update / send / audiences routes (TDD)

**Files:**
- Modify: `src/app/api/host/emails/route.js` (POST schema + insert + list select)
- Modify: `src/app/api/host/emails/[id]/route.js` (PATCH schema + update + GET select)
- Modify: `src/app/api/host/emails/[id]/send/route.js` (resolution branch)
- Modify: `src/app/api/host/emails/audiences/route.js` (`mailing_list_count`)
- Test: `src/app/api/host/emails/[id]/send/route.test.js` (extend)

- [ ] **Step 1: Write the failing send-route test**

Extend the existing send-route test file with a campaign row `{ audience_kind: 'mailing_list', audience_event_id: null }` and assert `resolveHostRecipients` (mocked) is called with `{ mailingListOnly: true, audienceEventId: null, emailType: 'marketing' }`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run 'src/app/api/host/emails/[id]/send/route.test.js'`
Expected: new test FAILS.

- [ ] **Step 3: Implement across the four routes**

`route.js` (POST) — schema gains:

```js
  audience_kind: z.enum(['all', 'event', 'mailing_list']).optional(),
```

Derive + validate before insert (after the existing `assertAudienceEventOwned` call, which now only runs for the event kind):

```js
  // audience_kind defaults from the legacy field: an audience_event_id
  // implies 'event'; otherwise 'all'. kind='event' REQUIRES the event id;
  // the other kinds null it out.
  const kind = parsed.data.audience_kind || (parsed.data.audience_event_id ? 'event' : 'all')
  const audienceEventId = kind === 'event' ? parsed.data.audience_event_id || null : null
  if (kind === 'event' && !audienceEventId) {
    return NextResponse.json({ success: false, error: 'Pick an event for a per-event audience.' }, { status: 400 })
  }
  if (audienceEventId) {
    const audienceErr = await assertAudienceEventOwned(db, session.host.id, audienceEventId)
    if (audienceErr) return NextResponse.json({ success: false, error: audienceErr }, { status: 404 })
  }
```

Insert `audience_kind: kind, audience_event_id: audienceEventId`; add `audience_kind` to both list/detail selects (`route.js:38`, `route.js:74`, `[id]/route.js:35`).

`[id]/route.js` (PATCH) — same schema addition + same derive/validate block before the update; update writes both columns.

`send/route.js` — select `audience_kind` (line 41) and change the resolution call:

```js
    recipients = await resolveHostRecipients(db, session.host.id, {
      audienceEventId: campaign.audience_kind === 'event' ? campaign.audience_event_id || null : null,
      mailingListOnly: campaign.audience_kind === 'mailing_list',
      emailType: campaign.email_type === 'utility' ? 'utility' : 'marketing',
    })
```

`audiences/route.js` — after `all_count`:

```js
  const { count: mailingListCount } = await db
    .from('host_contacts')
    .select('*', { count: 'exact', head: true })
    .eq('host_id', session.host.id)
    .eq('source', 'mailing_list')
```

and include `mailing_list_count: mailingListCount || 0` in the response `data`.

- [ ] **Step 4: Run tests + guards**

Run: `npx vitest run 'src/app/api/host/emails/[id]/send/route.test.js' && npm run check:route-guards`
Expected: PASS / green.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/host/emails/
git commit -m "HOST-GROWTH.11 — audience_kind through host-campaign create/update/send + mailing_list_count"
```

### Task B7: Composer dropdown option

**Files:**
- Modify: `src/components/host/HostEmails.jsx` (state ~line 44, fetch 71, resume 160, payload 198, label 221, select 305-315, resend 450)

- [ ] **Step 1: Implement**

The select currently binds `audienceEventId` ('' = everyone, uuid = event). Introduce the sentinel `'__mailing_list__'` at the component boundary only (the API speaks `audience_kind`):

- Option list gains, right after Everyone:

```jsx
                <option value="__mailing_list__">
                  Mailing list signups{audiences.mailing_list_count != null ? ` (${audiences.mailing_list_count})` : ''}
                </option>
```

- Save/send payload (line ~198) becomes:

```js
        audience_kind: audienceEventId === '__mailing_list__' ? 'mailing_list' : (audienceEventId ? 'event' : 'all'),
        audience_event_id: audienceEventId && audienceEventId !== '__mailing_list__' ? audienceEventId : null,
```

- Draft resume (line ~160): `setAudienceEventId(c.audience_kind === 'mailing_list' ? '__mailing_list__' : (c.audience_event_id || ''))` — and the resend handler at ~450 gets the same mapping.
- `audienceLabel` gains a branch: `if (id === '__mailing_list__') return audiences.mailing_list_count == null ? 'your mailing-list signups' : \`your ${audiences.mailing_list_count} mailing-list signups (where emailable)\``.

- [ ] **Step 2: Verify**

Run: `npm run lint && npm run build`; dev-server: compose → pick "Mailing list signups (N)" → save draft → reload → selection survives → send confirm names the audience → recipients = form signups only.

- [ ] **Step 3: Commit**

```bash
git add src/components/host/HostEmails.jsx
git commit -m "HOST-GROWTH.12 — 'Mailing list signups' audience option in the host composer"
```

### Task B8: PR B — full CI mirror + ship

- [ ] **Step 1: Full local CI mirror + build**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build`
Expected: all green.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "HOST-GROWTH.B — host-customisable signup page + mailing-list audience" --body "$(cat <<'EOF'
Mig 460: four nullable copy columns on event_hosts + host_campaigns.audience_kind
(all|event|mailing_list, backfilled from audience_event_id). Hosts customise
their /h/[slug] page (headline / intro / button / success message, per-field
defaults, GET+PATCH /api/host/list-page) from a Customise editor on the
dashboard card. The email composer gains a "Mailing list signups (N)" audience
(resolveHostRecipients mailingListOnly — all send-time consent gates unchanged),
and "All contacts" continues to include form signups.

Spec: docs/superpowers/specs/2026-07-30-host-portal-nav-signup-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (already applied)

- Spec coverage: A1 (nav) ✓, A4 (card: link/copy/QR/count) ✓, A2 (slug provisioning) ✓, A5 (separation regression test) ✓, B1-B4 (customisation) ✓, B5-B7 (audience option; "everyone" count already includes signups via existing `all_count`) ✓, out-of-scope items untouched ✓.
- `audience_kind` is a planning-time addition (uuid FK can't carry a sentinel) — flagged at top, same spec intent.
- Type consistency: `ensureHostSlug(db, host)` used identically in A2/A3/A4; `mailingListOnly` option name consistent across B5/B6; `'__mailing_list__'` sentinel confined to `HostEmails.jsx` (B7).
