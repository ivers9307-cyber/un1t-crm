# Public Events Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). **Work from the worktree `/Users/richardivers/code/un1t-crm-ab` on branch `feat/public-events-page`** — every command `cd` there first; first step of every task is the branch guard (`git branch --show-current` → `feat/public-events-page`).

**Goal:** A public events listing at `/[location]/events` (canonical `/welcome/[location]/events`), styled like un1tdublin.com, listing a studio's upcoming events as cards that link to the existing `/event/[slug]` booking.

**Architecture:** Server-rendered page under the `/welcome` marketing layer (inherits Poppins + public chrome). Pure, tested view-model helpers + a presentational cards component. No new API, no migration, no permission, no mobile. Booking flow reused untouched.

**Tech Stack:** Next.js 16 App Router, React (server components), Tailwind (`un1t-*` + `lp-*` marketing classes), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-16-public-events-page-design.md`.

---

## Verified facts (don't re-derive)
- **Location resolver:** `loadByPath(path)` in `src/app/welcome/[location]/page.js` reads `landing_page_settings.select('*, locations:location_id ( id, name )').eq('public_path', path).maybeSingle()`; the page 404s if `!row || !isPubliclyVisible(row.publish_state)` (`isPubliclyVisible` from `@/lib/landing-page-visibility`). `row.locations.id` = location_id, `row.locations.name` = studio name, `row.public_path` = the slug.
- **Layout:** `/welcome/layout.js` provides Poppins (`--font-body`) + `#lp-shell`; anything under `/welcome` inherits it. The landing page mounts `<RevealArmScript/>` + `<RevealManager/>` itself to drive `lp-reveal`.
- **Marketing components:** `import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'`; `RevealManager` from `@/components/landing-page/RevealManager`; `RevealArmScript` from `@/components/landing-page/reveal-arm`. `SiteHeader({ ... })` renders a logo + a single `lp-btn` CTA (no multi-link nav today; line ~768).
- **Pretty paths are explicit per-studio rewrites** in `next.config.js` (`{ source:'/stillorgan', destination:'/welcome/stillorgan' }`, `{ source:'/hatch-street', destination:'/welcome/hatch-street' }`). Add events siblings the same way. `/welcome` + `/stillorgan` etc. are already public (prefix match) in `proxy.js`/AppShell.
- **`shared/events.js`:** `EVENT_KINDS` (`race|workshop|seminar|open_day|masterclass|lead_gen`), `eventKindLabel(kind)`, `eventKindTone(kind)`, `isRaceKind(kind)`, `todayIsoDublin()`, `orderEventsForBrowse(events, today)`.
- **`race_events` public-safe columns:** `slug, name, description, kind, race_date, start_time, capacity_mode, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, members_only`. Raw `capacity` is NEVER rendered. Waves live in `race_waves(id, capacity, ...)`; registrations in `race_registrations(status, wave_id, team:teams(size))`.
- **Sold-out logic (mirror from `src/app/api/public/events/[slug]/route.js` ~L40-96):** per wave with `capacity != null`, count **confirmed** registrations (capacity_mode `'people'` → sum of team sizes; else → count of registrations); `is_full = count >= capacity`. Event is full when there is ≥1 capped wave, **no** uncapped wave, and every capped wave is full. Registration state: `registration_opens_at` future → not-yet-open; `registration_closes_at` past → closed.

---

## Task 1: Pure view-model helpers + tests

**Files:** Create `src/lib/public-events.js` + `src/lib/public-events.test.js`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/public-events.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { formatEventDate, eventPriceLabel, isEventSoldOut, toBrowseCard } from './public-events.js'

describe('formatEventDate', () => {
  it('formats an ISO date as "Sat 12 Jul" (noon-UTC anchored, TZ-safe)', () => {
    expect(formatEventDate('2026-07-12')).toBe('Sun 12 Jul') // 2026-07-12 is a Sunday
  })
  it('returns empty string for missing date', () => {
    expect(formatEventDate(null)).toBe('')
  })
})

describe('eventPriceLabel', () => {
  it('free when non_member_fee_cents is null', () => {
    expect(eventPriceLabel({ non_member_fee_cents: null })).toBe('Free')
  })
  it('single price when no member pricing', () => {
    expect(eventPriceLabel({ member_pricing_enabled: false, non_member_fee_cents: 2500 })).toBe('€25')
  })
  it('"From €X" (the cheaper of member/non-member) when member pricing on', () => {
    expect(eventPriceLabel({ member_pricing_enabled: true, member_fee_cents: 1500, non_member_fee_cents: 2500 })).toBe('From €15')
  })
  it('drops the .00 but keeps real cents', () => {
    expect(eventPriceLabel({ non_member_fee_cents: 2550 })).toBe('€25.50')
  })
})

describe('isEventSoldOut', () => {
  const wave = (id, capacity) => ({ id, capacity })
  const reg = (wave_id, size = 1, status = 'confirmed') => ({ wave_id, status, team: { size } })

  it('teams mode: all capped waves full, no uncapped → sold out', () => {
    const waves = [wave('w1', 2)]
    const regs = [reg('w1'), reg('w1')]
    expect(isEventSoldOut(waves, regs, 'teams')).toBe(true)
  })
  it('teams mode: a free slot remains → not sold out', () => {
    expect(isEventSoldOut([wave('w1', 2)], [reg('w1')], 'teams')).toBe(false)
  })
  it('people mode: counts team sizes', () => {
    const waves = [wave('w1', 4)]
    const regs = [reg('w1', 2), reg('w1', 2)] // 4 people
    expect(isEventSoldOut(waves, regs, 'people')).toBe(true)
  })
  it('an uncapped wave keeps it open even if capped waves are full', () => {
    const waves = [wave('w1', 1), wave('w2', null)]
    expect(isEventSoldOut(waves, [reg('w1')], 'teams')).toBe(false)
  })
  it('ignores non-confirmed registrations', () => {
    expect(isEventSoldOut([wave('w1', 1)], [reg('w1', 1, 'pending_payment')], 'teams')).toBe(false)
  })
  it('no capped waves → not sold out', () => {
    expect(isEventSoldOut([wave('w1', null)], [], 'teams')).toBe(false)
    expect(isEventSoldOut([], [], 'teams')).toBe(false)
  })
})

describe('toBrowseCard', () => {
  const base = { slug: 'hyrox', name: 'Hyrox Sim', kind: 'race', race_date: '2026-07-12', non_member_fee_cents: 2500 }
  const NOW = Date.parse('2026-07-01T12:00:00Z')

  it('maps the core card fields', () => {
    const c = toBrowseCard(base, { soldOut: false, now: NOW })
    expect(c).toMatchObject({ slug: 'hyrox', title: 'Hyrox Sim', kindLabel: 'Race', dateLabel: 'Sun 12 Jul', priceLabel: '€25', badge: null })
  })
  it('badge "Opens …" when registration_opens_at is in the future', () => {
    const c = toBrowseCard({ ...base, registration_opens_at: '2026-07-05T09:00:00Z' }, { soldOut: false, now: NOW })
    expect(c.badge).toBe('Opens 5 Jul')
  })
  it('badge "Sold out" when soldOut + already open', () => {
    expect(toBrowseCard(base, { soldOut: true, now: NOW }).badge).toBe('Sold out')
  })
  it('"Opens" takes precedence over sold-out', () => {
    const c = toBrowseCard({ ...base, registration_opens_at: '2026-07-05T09:00:00Z' }, { soldOut: true, now: NOW })
    expect(c.badge).toBe('Opens 5 Jul')
  })
})
```
(If `2026-07-12`'s weekday assertion is off, adjust the expected string to the real weekday — compute it; don't fight the test.)

- [ ] **Step 2: Run — expect FAIL** (`cd /Users/richardivers/code/un1t-crm-ab && npx vitest run src/lib/public-events.test.js`).

- [ ] **Step 3: Implement `src/lib/public-events.js`**

```js
// Pure view-model helpers for the public events listing (/[location]/events).
// No IO — the page does the Supabase read and hands rows in. Sold-out logic
// mirrors src/app/api/public/events/[slug]/route.js (capacity stays server-side;
// only a boolean leaves).
import { eventKindLabel } from '../../shared/events.js'

const EUR = (cents) => {
  const n = (Number(cents) || 0) / 100
  return Number.isInteger(n) ? `€${n}` : `€${n.toFixed(2)}`
}

/** ISO YYYY-MM-DD → "Sun 12 Jul". Anchored at noon UTC so the weekday/day are
 *  stable in any timezone (the Dublin-wall-clock caveat is about times, not dates). */
export function formatEventDate(iso) {
  if (!iso) return ''
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-IE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d)
}

function formatOpensDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-IE', { day: 'numeric', month: 'short', timeZone: 'Europe/Dublin' }).format(d)
}

/** "Free" | "€25" | "From €15" (cheaper of member/non-member when member pricing on). */
export function eventPriceLabel(e) {
  if (e?.non_member_fee_cents == null) return 'Free'
  if (e?.member_pricing_enabled && e?.member_fee_cents != null) {
    return `From ${EUR(Math.min(e.member_fee_cents, e.non_member_fee_cents))}`
  }
  return EUR(e.non_member_fee_cents)
}

/** Mirrors the public route: full = ≥1 capped wave, no uncapped wave, every
 *  capped wave full. people mode counts team sizes; teams mode counts regs.
 *  Only CONFIRMED registrations consume capacity. */
export function isEventSoldOut(waves, registrations, capacityMode) {
  const capped = (waves || []).filter((w) => w.capacity != null)
  if (capped.length === 0) return false
  if ((waves || []).some((w) => w.capacity == null)) return false // an uncapped wave absorbs
  const mode = capacityMode === 'people' ? 'people' : 'teams'
  const confirmed = (registrations || []).filter((r) => r.status === 'confirmed')
  return capped.every((w) => {
    const inWave = confirmed.filter((r) => r.wave_id === w.id)
    const used = mode === 'people'
      ? inWave.reduce((sum, r) => sum + (Number(r.team?.size) || 1), 0)
      : inWave.length
    return used >= w.capacity
  })
}

/** Row → card view-model. `now` injectable for tests. */
export function toBrowseCard(e, { soldOut = false, now = Date.now() } = {}) {
  const opensAt = e?.registration_opens_at ? Date.parse(e.registration_opens_at) : null
  let badge = null
  if (opensAt && now < opensAt) badge = `Opens ${formatOpensDate(e.registration_opens_at)}`
  else if (soldOut) badge = 'Sold out'
  return {
    slug: e.slug,
    title: e.name,
    kindLabel: eventKindLabel(e.kind),
    dateLabel: formatEventDate(e.race_date),
    priceLabel: eventPriceLabel(e),
    badge,
  }
}
```
NOTE: confirm the relative import path to `shared/events.js` from `src/lib/` resolves (it's `../../shared/events.js`). If the repo aliases shared differently (check how another `src/lib` file imports `shared/`), match that. Verify `eventKindLabel('race') === 'Race'` etc. — adjust the test's expected labels to the real output if they differ.

- [ ] **Step 4: Run — expect PASS.** Fix the date-weekday / kind-label expectations to real values if needed. `cd /Users/richardivers/code/un1t-crm-ab && npx vitest run src/lib/public-events.test.js`

- [ ] **Step 5: Commit**
```bash
cd /Users/richardivers/code/un1t-crm-ab
git add src/lib/public-events.js src/lib/public-events.test.js
git commit -m "feat(events): pure view-model helpers for the public events listing (price/date/sold-out/card)"
```

---

## Task 2: The page + cards component + rewrite + header link

**Files:**
- Create: `src/app/welcome/[location]/events/page.js`
- Create: `src/components/landing-page/PublicEventsList.jsx`
- Modify: `next.config.js` (2 rewrites)
- Modify: `src/components/landing-page/BlockRenderers.jsx` (SiteHeader optional `eventsHref` link)
- Modify: `src/app/welcome/[location]/page.js` (pass `eventsHref` to its SiteHeader — discovery)

- [ ] **Step 1: Build the cards component**

Create `src/components/landing-page/PublicEventsList.jsx` (server component — presentational; uses marketing tokens + `lp-*`):
```jsx
// Public events listing body — hero + a grid of upcoming-event cards, each
// linking to the existing /event/[slug] booking. Server component; styled to
// match the un1tdublin.com marketing layer (black bg, white text, lp-reveal).
import Link from 'next/link'

export default function PublicEventsList({ studioName, cards }) {
  return (
    <main className="min-h-screen bg-black text-white px-5 sm:px-8 py-16 sm:py-24">
      <div className="max-w-5xl mx-auto">
        <header className="mb-12 lp-reveal">
          <p className="text-xs uppercase tracking-[0.2em] text-white/45 mb-3">Upcoming events</p>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">What&rsquo;s on at {studioName}</h1>
        </header>

        {(!cards || cards.length === 0) ? (
          <div className="lp-reveal border border-white/15 rounded-2xl p-10 text-center text-white/60">
            <p className="text-lg font-semibold text-white mb-2">No upcoming events right now</p>
            <p className="text-sm">Check back soon — new races, workshops and open days drop regularly.</p>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            {cards.map((c, i) => (
              <Link
                key={c.slug}
                href={`/event/${c.slug}`}
                className={`lp-reveal lp-d${(i % 3) + 1} group block border border-white/15 rounded-2xl p-6 hover:border-white/40 transition-colors`}
              >
                <div className="flex items-center justify-between gap-3 mb-4">
                  <span className="text-[11px] uppercase tracking-wider font-semibold text-white/70 border border-white/20 rounded-full px-2.5 py-1">{c.kindLabel}</span>
                  {c.badge && (
                    <span className={`text-[11px] font-semibold rounded-full px-2.5 py-1 ${c.badge === 'Sold out' ? 'bg-white/10 text-white/50' : 'bg-white/15 text-white'}`}>{c.badge}</span>
                  )}
                </div>
                <p className="text-xs text-white/55 mb-1">{c.dateLabel}</p>
                <h2 className="text-xl font-semibold mb-4 group-hover:translate-x-0.5 transition-transform">{c.title}</h2>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/70">{c.priceLabel}</span>
                  <span className="text-sm font-semibold inline-flex items-center gap-1">View &amp; book <span aria-hidden className="group-hover:translate-x-1 transition-transform">→</span></span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
```

- [ ] **Step 2: Build the page**

Create `src/app/welcome/[location]/events/page.js`. Read `src/app/welcome/[location]/page.js` first to copy its `loadByPath` helper + `isPubliclyVisible` import + the SiteHeader/SiteFooter/RevealManager/RevealArmScript wiring verbatim, then:
```jsx
// /welcome/[location]/events — public events listing for a studio.
// Surfaced as /[location]/events via next.config rewrites. Inherits the
// /welcome layout (Poppins + #lp-shell). Lists active, upcoming race_events
// for the studio; cards link to the existing /event/[slug] booking.
import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import { isPubliclyVisible } from '@/lib/landing-page-visibility'
import { orderEventsForBrowse, todayIsoDublin } from '../../../../shared/events.js'
import { isEventSoldOut, toBrowseCard } from '@/lib/public-events'
import PublicEventsList from '@/components/landing-page/PublicEventsList'

export const dynamic = 'force-dynamic'

async function loadByPath(path) {
  try {
    const db = createServerClient()
    const { data, error } = await db
      .from('landing_page_settings')
      .select('public_path, publish_state, locations:location_id ( id, name )')
      .eq('public_path', path)
      .maybeSingle()
    if (error) return null
    return data || null
  } catch { return null }
}

export async function generateMetadata(props) {
  const params = await props.params
  const row = await loadByPath(params.location)
  const name = row?.locations?.name || 'UN1T Dublin'
  const title = `Events — ${name}`
  const description = `Upcoming races, workshops and open days at ${name}. Book your spot.`
  return { title, description, openGraph: { title, description, siteName: 'UN1T Dublin', type: 'website' } }
}

export default async function StudioEventsPage(props) {
  const params = await props.params
  const row = await loadByPath(params.location)
  if (!row || !isPubliclyVisible(row.publish_state)) notFound()

  const locationId = row.locations?.id
  const studioName = row.locations?.name || 'UN1T Dublin'
  const today = todayIsoDublin()
  const nowMs = Date.now()

  const db = createServerClient()
  // Public-safe SELECT, hard-scoped to this studio's active upcoming events.
  // Embeds waves + registrations ONLY to compute a coy sold-out boolean — raw
  // capacity/counts are never rendered.
  const { data: rows } = await db
    .from('race_events')
    .select('slug, name, kind, race_date, start_time, capacity_mode, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, waves:race_waves ( id, capacity ), registrations:race_registrations ( status, wave_id, team:teams ( size ) )')
    .or(`location_id.eq.${locationId},shared.eq.true`)
    .eq('active', true)
    .gte('race_date', today)

  // Drop events whose registration window has closed; order nearest-first.
  const open = (rows || []).filter((e) => {
    const closesAt = e.registration_closes_at ? Date.parse(e.registration_closes_at) : null
    return !(closesAt && nowMs > closesAt)
  })
  const ordered = orderEventsForBrowse(open, today)
  const cards = ordered.map((e) =>
    toBrowseCard(e, { soldOut: isEventSoldOut(e.waves, e.registrations, e.capacity_mode), now: nowMs })
  )

  const eventsHref = `/${row.public_path}/events`

  return (
    <>
      <RevealArmScript />
      <SiteHeader eventsHref={eventsHref} />
      <PublicEventsList studioName={studioName} cards={cards} />
      <SiteFooter />
      <RevealManager />
    </>
  )
}
```
NOTE — verify against the real files + adjust:
- `loadByPath`: match the SELECT shape the real page uses (it selects `*`; the narrowed select above is fine as long as `public_path`, `publish_state`, `locations(id,name)` come back — confirm column names).
- `<SiteHeader .../>`: read its real required props in `BlockRenderers.jsx` (the landing page passes more than `eventsHref` — e.g. ctaHref/ctaLabel/logo). Pass whatever it REQUIRES so it renders (a logo + CTA). If SiteHeader needs a CTA, pass a sensible default (e.g. the studio's primary path) — match how `welcome/[location]/page.js` constructs it. Don't break the header.
- `RevealArmScript` / `RevealManager` import names + usage: copy EXACTLY from `welcome/[location]/page.js` (default vs named export).
- `shared/events.js` relative path from this page: compute the correct `../` depth (the page is at `src/app/welcome/[location]/events/` → shared is at repo-root `shared/`). Verify and fix.
- Confirm `race_events` has a `shared` column (the staff `/events` query filters on it). If not, drop the `.or()` and just use `.eq('location_id', locationId)`.

- [ ] **Step 3: Add the `eventsHref` link to SiteHeader**

In `src/components/landing-page/BlockRenderers.jsx` `SiteHeader(...)`: add an optional `eventsHref` prop; when present, render an "Events" link next to the CTA (desktop). Read the SiteHeader render (~L768-810) and add, next to the existing `<a ... className="lp-btn ...">CTA</a>`:
```jsx
{eventsHref && (
  <Link href={eventsHref} className="text-white/80 hover:text-white transition-colors text-sm font-medium shrink-0">Events</Link>
)}
```
(Use `Link` if the file imports it; otherwise a plain `<a>` — but internal links should be `<Link>`; check the file's existing imports. Place it BEFORE the CTA button so the CTA stays the rightmost element. Keep it from breaking the existing layout — it's an additive sibling.)

- [ ] **Step 4: Pass `eventsHref` from the landing page (discovery)**

In `src/app/welcome/[location]/page.js`, where it renders `<SiteHeader .../>`, add `eventsHref={\`/${row.public_path}/events\`}` to the props (so every studio landing page links to its events page). `row.public_path` is already loaded there. Don't change anything else.

- [ ] **Step 5: Add the pretty-path rewrites**

In `next.config.js` `rewrites()`, next to the existing `/stillorgan` + `/hatch-street` entries, add:
```js
{ source: '/stillorgan/events',   destination: '/welcome/stillorgan/events' },
{ source: '/hatch-street/events', destination: '/welcome/hatch-street/events' },
```
(Explicit per-studio, mirroring the existing pattern. The canonical `/welcome/[location]/events` works regardless; these just give the pretty URL.)

- [ ] **Step 6: Verify + commit**

Run: `cd /Users/richardivers/code/un1t-crm-ab && npx eslint src/app/welcome/'[location]'/events/page.js src/components/landing-page/PublicEventsList.jsx src/components/landing-page/BlockRenderers.jsx src/app/welcome/'[location]'/page.js next.config.js` — no errors. Run `npx next lint 2>&1 | tail -15` if the worktree allows (catches `no-html-link-for-pages`); else rely on Vercel.
Run: `npx vitest run src/lib/public-events.test.js` → PASS.

```bash
cd /Users/richardivers/code/un1t-crm-ab
git add -A
git commit -m "feat(events): public /[location]/events listing — styled cards, scoped query, rewrite + SiteHeader link"
```

- [ ] **Step 7: Full CI mirror** (you may fix small failures on your diff)
```bash
cd /Users/richardivers/code/un1t-crm-ab
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards
```
Report each. (`npm run build` not run — worktree symlink blocks Turbopack; Vercel PR check is the build gate, and it's the real test that the new page + imports + rewrite resolve.)

---

## Definition of done
All CI-mirror steps green. No migration, no `shared/permissions.js` change (public page, no permission key) → parity unaffected. **Vercel PR check = build gate** (new route + rewrite + new component imports). Manual visual confirmation deferred to the operator (auth-free page — they can open `/stillorgan/events` after deploy).

**What this delivers:** `un1tdublin.com/stillorgan/events` (+ hatch-street) shows the studio's upcoming events as on-brand cards (kind chip, date, title, price, opens/sold-out badge), each linking to the existing booking flow — and every studio landing page links to it via an "Events" header link.

---

## Self-review
- **Spec coverage:** listing under the marketing layer (Task 2 page in `/welcome`), styled cards (PublicEventsList + lp-*), upcoming-only scoped query (active + race_date>=today + closed filtered), price/date/sold-out via the pure tested helper (Task 1), reuse `/event/[slug]` (card links), pretty path (rewrite), discovery (SiteHeader link). ✓
- **Placeholders:** none — helper + component + page are complete; the "verify against real file" notes are concrete checks (resolver SELECT, SiteHeader props, import depths, `shared` column) with the fallback stated for each.
- **Safety:** public service-role read is hard-scoped (location + active + upcoming) + selects only public-safe columns; capacity/counts reduced to a boolean, never rendered — matches the existing public API's coy-capacity rule.
- **Consistency:** sold-out logic mirrors the documented route rule (capped+no-uncapped+all-full, confirmed-only, people=sum-sizes/teams=count); date/price formatting tested; `eventsHref` added once to SiteHeader + passed from both the landing page and the events page.
- **Risk note:** the few "match the real file" items (SiteHeader required props, `shared` column existence, shared-import depth) are the only places the implementer must reconcile with reality — all have a stated fallback so none can silently break the header or the query.
