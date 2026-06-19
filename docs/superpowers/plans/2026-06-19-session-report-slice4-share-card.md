# Session Report Slice 4 — shareable post-class card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member taps Share on a finished session and gets a public link whose preview is a distinctive, on-brand card (hardest-zone colour band + their real HR trace) — opt-in, revocable, built on the existing report data.

**Architecture:** `heart_rate_sessions.share_token` (mig 294) minted on opt-in. champ-app gets: pure card helpers, a `loadShareCard(serviceClient, token)` IO loader (reuses `loadSessionReport`), a customer-self mint/revoke endpoint, public `/share/[token]` page + `opengraph-image` (`next/og` `ImageResponse`, zero new deps), the middleware allowlist, and a client Share button on the session view. The public CTA reuses Slice 3's operator-editable booking/membership URLs.

**Tech Stack:** Next.js 14.2 App Router (champ-app), `next/og`, Supabase, Vitest. Repos: champ-app (feature) + un1t-crm (mig 294 + docs).

**Spec:** `docs/superpowers/specs/2026-06-19-session-report-slice4-share-card-design.md`

---

## File structure

**un1t-crm — create:** `supabase/migrations/294_hr_session_share_token.sql`.

**champ-app — create:**
- `src/lib/share-card.js` — pure helpers: `dominantZone`, `tracePolyline`, `shortName`, `cardModel`, `traceSvg`.
- `src/lib/share-card.test.js` — unit tests.
- `src/lib/load-share-card.js` — `loadShareCard(serviceSupabase, token)` IO (reuses `loadSessionReport`).
- `src/lib/load-share-card.test.js` — IO test (stub client).
- `src/app/api/sessions/[id]/share/route.js` — `POST` mint / `DELETE` revoke (customer-self).
- `src/app/api/sessions/[id]/share/route.test.js` — route tests.
- `src/app/share/[token]/opengraph-image.jsx` — the card PNG (`ImageResponse`) + the `SessionCard` JSX.
- `src/app/share/[token]/page.jsx` — public viewer (embeds the card image + CTA) + `generateMetadata`.
- `src/components/ShareSessionButton.jsx` — `'use client'` Share button.

**champ-app — modify:**
- `src/middleware.js` — add `/share` to `PUBLIC_PATHS`.
- `src/app/sessions/[id]/page.jsx` — render `<ShareSessionButton sessionId={session.id} />`.

---

### Task 1: Migration — `heart_rate_sessions.share_token`

**Files:** Create `un1t-crm/supabase/migrations/294_hr_session_share_token.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 294: SESSION-REPORT.4 — opt-in shareable post-class card. A member mints an
-- unguessable token to make ONE session's card publicly viewable at
-- /share/<token> (champ-app). Public reads go through the service client keyed
-- by this token (capability-token pattern, like deposit/race public pages), so
-- no RLS policy change is needed. Nullable + revocable (set back to NULL).
ALTER TABLE public.heart_rate_sessions ADD COLUMN IF NOT EXISTS share_token text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_sessions_share_token
  ON public.heart_rate_sessions (share_token) WHERE share_token IS NOT NULL;

COMMENT ON COLUMN public.heart_rate_sessions.share_token IS
  'SESSION-REPORT.4 (mig 294): unguessable opt-in token for the public shareable card at champ-app /share/<token>. NULL = not shared. Minted/cleared via POST/DELETE /api/sessions/[id]/share.';
```

- [ ] **Step 2: Commit** (on the `session-report-slice4-share-card` branch)

```bash
cd /Users/richardivers/code/un1t-crm
git add 'supabase/migrations/294_hr_session_share_token.sql'
git commit -m "SESSION-REPORT.4 — mig 294: heart_rate_sessions.share_token

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(Applied to prod in Task 7, before merge.)

---

### Task 2: Pure card helpers

**Files:** Create `champ-app/src/lib/share-card.js` + `src/lib/share-card.test.js`

- [ ] **Step 1: Create the champ-app branch**

```bash
cd /Users/richardivers/code/champ-app
git checkout main && git pull origin main
git checkout -b session-report-slice4-share-card
```

- [ ] **Step 2: Write the failing tests**

`champ-app/src/lib/share-card.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { dominantZone, tracePolyline, shortName, cardModel } from './share-card.js'

const zones = (secs) => [
  { id: 1, name: 'Warm-up', color: '#9CA3AF', seconds: secs[0], percent: 0 },
  { id: 2, name: 'Easy', color: '#3B82F6', seconds: secs[1], percent: 0 },
  { id: 3, name: 'Aerobic', color: '#10B981', seconds: secs[2], percent: 0 },
  { id: 4, name: 'Threshold', color: '#F59E0B', seconds: secs[3], percent: 0 },
  { id: 5, name: 'Max', color: '#EF4444', seconds: secs[4], percent: 0 },
]

describe('dominantZone', () => {
  it('picks the highest-intensity zone with a real share of time', () => {
    // total 1000s; Z4 has 340 (>10% + >30s), Z5 has 200 → highest real = Z5
    expect(dominantZone(zones([60, 110, 290, 340, 200])).id).toBe(5)
  })
  it('ignores a trivially-small top zone (<10% and <30s)', () => {
    // Z5 only 10s → not "real"; Z4 340 is the highest real
    expect(dominantZone(zones([60, 200, 390, 340, 10])).id).toBe(4)
  })
  it('falls back to a brand accent (not flat grey) for a warm-up-only session', () => {
    const d = dominantZone(zones([600, 0, 0, 0, 0]))
    expect(d.color).toBe('#0B0B0C')
  })
  it('handles all-zero (no data) with the brand accent', () => {
    expect(dominantZone(zones([0, 0, 0, 0, 0])).color).toBe('#0B0B0C')
  })
})

describe('tracePolyline', () => {
  it('maps samples to points filling the box, normalised to their own range', () => {
    const s = [{ bpm: 100 }, { bpm: 150 }, { bpm: 125 }].map((x, i) => ({ recorded_at: `2026-06-19T10:00:0${i}Z`, ...x }))
    const out = tracePolyline(s, { width: 100, height: 100 })
    expect(out).toMatch(/^0\.0,100\.0 /)      // first point: x=0, lowest bpm → y=height
    expect(out).toMatch(/100\.0,50\.0$/)       // last point: x=width, mid bpm
  })
  it('returns null for <2 valid samples', () => {
    expect(tracePolyline([], {})).toBeNull()
    expect(tracePolyline([{ bpm: 100, recorded_at: 'x' }], {})).toBeNull()
  })
})

describe('shortName', () => {
  it('first name + last initial', () => {
    expect(shortName('Sarah Brennan')).toBe('Sarah B.')
  })
  it('single name passes through; blank → Member', () => {
    expect(shortName('Sarah')).toBe('Sarah')
    expect(shortName('')).toBe('Member')
    expect(shortName(null)).toBe('Member')
  })
})

describe('cardModel', () => {
  const report = {
    session: { started_at: '2026-06-19T10:00:00Z', duration_seconds: 1800, class: { name: 'RIDE' } },
    summary: { effort_points: 312, avg_hr_bpm: 148, peak_hr_bpm: 181, zones: zones([60, 110, 290, 340, 200]) },
    comparisons: { vs_category: { category: 'cardio', percentile: 0.82, sample_size: 9 } },
    highlight: { message: 'Personal best for RIDE.' },
    next_action: { type: 'book_class', label: 'Book your next class', url: 'https://b' },
  }
  it('shapes the report + extras into card fields', () => {
    const m = cardModel(report, { name: 'Sarah Brennan', tracePoints: '0,0 1,1' })
    expect(m).toMatchObject({
      name: 'Sarah B.', className: 'RIDE', points: 312, avgHr: 148, peakHr: 181, minutes: 30,
      tracePoints: '0,0 1,1', highlight: 'Personal best for RIDE.', nextAction: { url: 'https://b' },
    })
    expect(m.dominant.id).toBe(5)
    expect(m.categoryLine).toBe('Top 18% of your cardio classes')
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/share-card.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the helpers**

`champ-app/src/lib/share-card.js`:
```js
// SESSION-REPORT.4 — pure helpers for the shareable post-class card. No IO.
// The card image (ImageResponse) + the share page render from cardModel().

const BRAND_ACCENT = '#0B0B0C' // near-black: the "no vivid zone" fallback band

/**
 * The session's hardest zone with a real share of time → drives the card colour.
 * Highest-id zone with seconds >= max(30, 10% of total); else the max-seconds
 * zone; Z1/warm-up or no data → brand accent (never a flat grey card).
 * @param {Array<{id,name,color,seconds}>} zones (from zoneBreakdown)
 */
export function dominantZone(zones) {
  const list = zones || []
  const total = list.reduce((a, z) => a + (Number(z.seconds) || 0), 0)
  let pick = null
  if (total > 0) {
    const threshold = Math.max(30, total * 0.1)
    const real = list.filter((z) => (Number(z.seconds) || 0) >= threshold)
    pick = real.length ? real[real.length - 1] : list.reduce((m, z) => ((Number(z.seconds) || 0) > (Number(m?.seconds) || 0) ? z : m), null)
  }
  if (!pick || pick.id === 1) {
    return { id: pick?.id ?? 0, name: pick?.name ?? 'Session', color: BRAND_ACCENT }
  }
  return { id: pick.id, name: pick.name, color: pick.color }
}

/**
 * Downsample HR samples (~80 pts) → SVG polyline points, normalised to their
 * own min/max so the line fills the box. Returns null for <2 valid samples.
 */
export function tracePolyline(samples, { width = 600, height = 140, points = 80 } = {}) {
  const arr = (samples || []).filter((s) => Number.isFinite(s?.bpm))
  if (arr.length < 2) return null
  const stride = Math.max(1, Math.ceil(arr.length / points))
  const ds = arr.filter((_, i) => i % stride === 0)
  if (ds[ds.length - 1] !== arr[arr.length - 1]) ds.push(arr[arr.length - 1])
  const bpms = ds.map((s) => s.bpm)
  const lo = Math.min(...bpms)
  const span = Math.max(1, Math.max(...bpms) - lo)
  const n = ds.length
  return ds
    .map((s, i) => {
      const x = (n === 1 ? 0 : (i / (n - 1)) * width)
      const y = height - ((s.bpm - lo) / span) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/** A full SVG markup string for the trace (for an ImageResponse data-URI <img>). */
export function traceSvg(points, { width = 600, height = 140, stroke = '#FFFFFF', strokeWidth = 4 } = {}) {
  if (!points) return null
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/></svg>`
}

/** First name + last initial (privacy on a public URL). Blank → "Member". */
export function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'Member'
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}

function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat('en-IE', { day: 'numeric', month: 'short', timeZone: 'Europe/Dublin' }).format(new Date(iso))
  } catch { return '' }
}

/**
 * Report payload + extras → the flat field set the card JSX + page render.
 * Pure.
 */
export function cardModel(report, { name, tracePoints = null } = {}) {
  const s = report.summary || {}
  const vc = report.comparisons?.vs_category
  const categoryLine = (vc && vc.percentile != null && vc.sample_size >= 2)
    ? (Math.round(vc.percentile * 100) >= 50
        ? `Top ${100 - Math.round(vc.percentile * 100)}% of your ${vc.category} classes`
        : `Building your ${vc.category} base`)
    : null
  return {
    name: shortName(name),
    className: report.session?.class?.name || null,
    dateLabel: report.session?.started_at ? formatDate(report.session.started_at) : '',
    points: Number.isFinite(s.effort_points) ? s.effort_points : 0,
    avgHr: Number.isFinite(s.avg_hr_bpm) ? s.avg_hr_bpm : null,
    peakHr: Number.isFinite(s.peak_hr_bpm) ? s.peak_hr_bpm : null,
    minutes: report.session?.duration_seconds ? Math.round(report.session.duration_seconds / 60) : null,
    zones: s.zones || [],
    dominant: dominantZone(s.zones || []),
    tracePoints,
    highlight: report.highlight?.message || null,
    categoryLine,
    nextAction: report.next_action || null,
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/share-card.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/richardivers/code/champ-app
git add src/lib/share-card.js src/lib/share-card.test.js
git commit -m "SESSION-REPORT.4 — pure share-card helpers (dominantZone/tracePolyline/cardModel)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `loadShareCard` IO loader

**Files:** Create `champ-app/src/lib/load-share-card.js` + `src/lib/load-share-card.test.js`

- [ ] **Step 1: Write the failing test**

`champ-app/src/lib/load-share-card.test.js`:
```js
import { describe, it, expect, vi } from 'vitest'

vi.mock('./load-session-report.js', () => ({
  loadSessionReport: vi.fn(async () => ({
    ok: true,
    report: {
      session: { started_at: '2026-06-19T10:00:00Z', duration_seconds: 1800, class: { name: 'RIDE' } },
      summary: { effort_points: 312, avg_hr_bpm: 148, peak_hr_bpm: 181, zones: [{ id: 5, name: 'Max', color: '#EF4444', seconds: 600 }] },
      comparisons: {}, highlight: null, next_action: null,
    },
  })),
}))

import { loadShareCard } from './load-share-card.js'

// Minimal thenable builder fake.
function makeDb(handlers) {
  const b = (table) => {
    const ctx = { table }
    const builder = {
      select(c) { ctx.cols = c; return builder },
      eq(k, v) { ctx[k] = v; return builder },
      order() { return builder },
      limit() { return builder },
      maybeSingle() { return Promise.resolve(handlers(ctx, 'one')) },
      then(res) { res(handlers(ctx, 'many')) },
    }
    return builder
  }
  return { from: b }
}

describe('loadShareCard', () => {
  it('404s on unknown token', async () => {
    const db = makeDb(() => ({ data: null, error: null }))
    expect(await loadShareCard(db, 'nope')).toEqual({ ok: false, error: 'not-found' })
  })
  it('resolves token → card model', async () => {
    const db = makeDb((ctx, kind) => {
      if (ctx.table === 'heart_rate_sessions') return { data: { id: 's1', contact_id: 'c1', contact: { name: 'Sarah Brennan' } }, error: null }
      if (ctx.table === 'hr_samples') return { data: [{ recorded_at: 'a', bpm: 120 }, { recorded_at: 'b', bpm: 160 }], error: null }
      return { data: null, error: null }
    })
    const out = await loadShareCard(db, 'tok')
    expect(out.ok).toBe(true)
    expect(out.card).toMatchObject({ name: 'Sarah B.', className: 'RIDE', points: 312 })
    expect(out.card.dominant.id).toBe(5)
    expect(typeof out.card.tracePoints).toBe('string')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/load-share-card.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`champ-app/src/lib/load-share-card.js`:
```js
// SESSION-REPORT.4 — resolve a public share token → the card model. Service-role
// only (the public routes are unauthenticated; the token is the capability).
// Reuses loadSessionReport for the stats/zones/highlight/next_action, then adds
// the member name + HR trace.

import { loadSessionReport } from './load-session-report.js'
import { cardModel, tracePolyline } from './share-card.js'

export async function loadShareCard(serviceSupabase, token) {
  if (!token) return { ok: false, error: 'no-token' }

  const { data: row } = await serviceSupabase
    .from('heart_rate_sessions')
    .select('id, contact_id, contact:contacts!heart_rate_sessions_contact_id_fkey(name)')
    .eq('share_token', token)
    .maybeSingle()
  if (!row) return { ok: false, error: 'not-found' }

  const out = await loadSessionReport(serviceSupabase, row.id, { serviceSupabase })
  if (!out.ok) return { ok: false, error: out.error }

  const { data: samples } = await serviceSupabase
    .from('hr_samples')
    .select('recorded_at, bpm')
    .eq('session_id', row.id)
    .order('recorded_at', { ascending: true })
    .limit(3600)

  const card = cardModel(out.report, { name: row.contact?.name, tracePoints: tracePolyline(samples || [], {}) })
  return { ok: true, card }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/load-share-card.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/richardivers/code/champ-app
git add src/lib/load-share-card.js src/lib/load-share-card.test.js
git commit -m "SESSION-REPORT.4 — loadShareCard (token → card model, service-role)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Mint / revoke endpoint

**Files:** Create `champ-app/src/app/api/sessions/[id]/share/route.js` + `route.test.js`

- [ ] **Step 1: Write the failing test**

`champ-app/src/app/api/sessions/[id]/share/route.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-server', () => ({ createServerClient: vi.fn(), createServiceClient: vi.fn() }))

import { POST, DELETE } from './route'
import { createServerClient, createServiceClient } from '@/lib/supabase-server'

beforeEach(() => vi.clearAllMocks())
const props = { params: { id: 's1' } }
const req = (method) => new Request('http://app.champfitness.ie/api/sessions/s1/share', { method })

function rlsClient(sessionRow) {
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: sessionRow, error: null }) }) }) }), auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }
}

describe('POST /api/sessions/[id]/share', () => {
  it('401 without a user', async () => {
    createServerClient.mockReturnValue({ auth: { getUser: async () => ({ data: { user: null } }) } })
    expect((await POST(req('POST'), props)).status).toBe(401)
  })
  it('404 when the session is not the caller\'s (RLS returns nothing)', async () => {
    createServerClient.mockReturnValue(rlsClient(null))
    expect((await POST(req('POST'), props)).status).toBe(404)
  })
  it('mints a token + returns the public url', async () => {
    createServerClient.mockReturnValue(rlsClient({ id: 's1', share_token: null }))
    let updated = null
    createServiceClient.mockReturnValue({ from: () => ({ update: (p) => { updated = p; return { eq: () => Promise.resolve({ error: null }) } } }) })
    const res = await POST(req('POST'), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.url).toMatch(/\/share\//)
    expect(typeof updated.share_token).toBe('string')
  })
  it('reuses an existing token (idempotent)', async () => {
    createServerClient.mockReturnValue(rlsClient({ id: 's1', share_token: 'existing' }))
    createServiceClient.mockReturnValue({ from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }) })
    const res = await POST(req('POST'), props)
    const json = await res.json()
    expect(json.url).toContain('existing')
  })
})

describe('DELETE /api/sessions/[id]/share', () => {
  it('nulls the token for the owner', async () => {
    createServerClient.mockReturnValue(rlsClient({ id: 's1', share_token: 'x' }))
    let updated = null
    createServiceClient.mockReturnValue({ from: () => ({ update: (p) => { updated = p; return { eq: () => Promise.resolve({ error: null }) } } }) })
    const res = await DELETE(req('DELETE'), props)
    expect(res.status).toBe(200)
    expect(updated.share_token).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run 'src/app/api/sessions/[id]/share/route.test.js'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

`champ-app/src/app/api/sessions/[id]/share/route.js`:
```js
// POST   /api/sessions/[id]/share  — mint (opt-in) the public share token
// DELETE /api/sessions/[id]/share  — revoke (stop sharing)
//
// SESSION-REPORT.4. Customer-self: the RLS client confirms the session belongs
// to the signed-in member (RLS returns nothing otherwise → 404). The token write
// goes through the service client (heart_rate_sessions writes are service-role).

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServerClient, createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function publicShareUrl(request, token) {
  const base = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin
  return `${base.replace(/\/$/, '')}/share/${token}`
}

async function ownedSession(request, sessionId) {
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'unauthorised' }, { status: 401 }) }
  const { data: session } = await supabase
    .from('heart_rate_sessions')
    .select('id, share_token')
    .eq('id', sessionId)
    .maybeSingle()
  if (!session) return { error: NextResponse.json({ error: 'not-found' }, { status: 404 }) }
  return { session }
}

export async function POST(request, { params }) {
  const { error, session } = await ownedSession(request, params.id)
  if (error) return error

  let token = session.share_token
  if (!token) {
    token = randomUUID()
    const svc = createServiceClient()
    const { error: upErr } = await svc.from('heart_rate_sessions').update({ share_token: token }).eq('id', params.id)
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 400 })
  }
  return NextResponse.json({ ok: true, url: publicShareUrl(request, token) })
}

export async function DELETE(request, { params }) {
  const { error } = await ownedSession(request, params.id)
  if (error) return error
  const svc = createServiceClient()
  const { error: upErr } = await svc.from('heart_rate_sessions').update({ share_token: null }).eq('id', params.id)
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run 'src/app/api/sessions/[id]/share/route.test.js'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/richardivers/code/champ-app
noglob git add 'src/app/api/sessions/[id]/share/route.js' 'src/app/api/sessions/[id]/share/route.test.js'
git commit -m "SESSION-REPORT.4 — mint/revoke share token endpoint (customer-self)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Public routes — card image + viewer page + middleware

**Files:**
- Create: `champ-app/src/app/share/[token]/opengraph-image.jsx`
- Create: `champ-app/src/app/share/[token]/page.jsx`
- Modify: `champ-app/src/middleware.js`

- [ ] **Step 1: Allowlist `/share` in middleware**

In `champ-app/src/middleware.js`, change:
```js
const PUBLIC_PATHS = ['/login', '/auth/callback']
```
to:
```js
const PUBLIC_PATHS = ['/login', '/auth/callback', '/share']
```
(The existing `.some(p => pathname === p || pathname.startsWith(p + '/'))` then lets `/share/<token>` + `/share/<token>/opengraph-image` through unauthenticated.)

- [ ] **Step 2: The card image (`ImageResponse`)**

`champ-app/src/app/share/[token]/opengraph-image.jsx`:
```jsx
import { ImageResponse } from 'next/og'
import { createServiceClient } from '@/lib/supabase-server'
import { loadShareCard } from '@/lib/load-share-card'
import { traceSvg } from '@/lib/share-card'

export const runtime = 'nodejs'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function Image({ params }) {
  let card = null
  try {
    const out = await loadShareCard(createServiceClient(), params.token)
    card = out.ok ? out.card : null
  } catch { card = null }

  if (!card) {
    return new ImageResponse(
      (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0B0B0C', color: '#fff', fontSize: 48, letterSpacing: 8 }}>
          UN1T
        </div>
      ),
      { ...size },
    )
  }

  const band = card.dominant.color
  const svg = traceSvg(card.tracePoints, { stroke: '#FFFFFF' })
  const traceImg = svg ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` : null
  const meta = [card.name, card.className, card.dateLabel].filter(Boolean).join('  ·  ')

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#FFFFFF', color: '#0B0B0C' }}>
        {/* colour band: hardest zone + HR trace hero */}
        <div style={{ height: 302, background: band, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '28px 36px', position: 'relative' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: 8, color: '#FFFFFF' }}>UN1T</span>
            <span style={{ fontSize: 18, color: 'rgba(255,255,255,0.85)' }}>{meta}</span>
          </div>
          {traceImg ? (
            <img src={traceImg} width={1128} height={130} style={{ width: '100%', height: 130 }} />
          ) : (
            <div style={{ display: 'flex', height: 130 }} />
          )}
        </div>
        {/* stats */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '26px 36px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <span style={{ fontSize: 92, fontWeight: 700, lineHeight: 1 }}>{card.points}</span>
              <span style={{ fontSize: 20, color: '#6B6B6B', marginLeft: 12, marginBottom: 12 }}>UN1T pts</span>
            </div>
            <div style={{ display: 'flex' }}>
              {[['AVG', card.avgHr], ['PEAK', card.peakHr], ['MIN', card.minutes]].map(([l, v]) => (
                <div key={l} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginLeft: 34 }}>
                  <span style={{ fontSize: 30, fontWeight: 600 }}>{v ?? '—'}</span>
                  <span style={{ fontSize: 15, color: '#9A9A9A' }}>{l}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', width: '100%', height: 14, borderRadius: 7, overflow: 'hidden' }}>
              {card.zones.map((z) => (
                <div key={z.id} style={{ width: `${Math.round((z.percent || 0) * 100)}%`, background: z.color }} />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <span style={{ fontSize: 18, fontWeight: 600, color: '#0B0B0C' }}>{card.highlight ? `★ ${card.highlight}` : (card.className || 'Session complete')}</span>
              {card.categoryLine ? <span style={{ fontSize: 15, color: '#9A9A9A' }}>{card.categoryLine}</span> : <span />}
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  )
}
```

(Note: `card.zones` percents come from `zoneBreakdown` via the report `summary.zones`; widths sum to ~100. `next/og` supports flexbox + `<img>` data-URIs. Font is the bundled default — no `fonts:` option needed for v1.)

- [ ] **Step 3: The viewer page + OG metadata**

`champ-app/src/app/share/[token]/page.jsx`:
```jsx
import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase-server'
import { loadShareCard } from '@/lib/load-share-card'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }) {
  let card = null
  try { const out = await loadShareCard(createServiceClient(), params.token); card = out.ok ? out.card : null } catch { card = null }
  if (!card) return { title: 'UN1T' }
  const title = `${card.name} · ${card.points} UN1T Points${card.className ? ` · ${card.className}` : ''}`
  return {
    title,
    description: card.highlight || `A session at UN1T.`,
    twitter: { card: 'summary_large_image' },
    // og:image is auto-wired from opengraph-image.jsx in this segment.
  }
}

export default async function SharePage({ params }) {
  let out = { ok: false }
  try { out = await loadShareCard(createServiceClient(), params.token) } catch { out = { ok: false } }
  if (!out.ok) notFound()
  const card = out.card
  const cta = card.nextAction

  return (
    <main className="mx-auto max-w-2xl p-6 sm:p-10">
      <div className="overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/share/${params.token}/opengraph-image`} alt={`${card.name} — ${card.points} UN1T Points`} className="w-full" />
      </div>
      {cta && (
        <div className="mt-6 text-center">
          <a href={cta.url} target="_blank" rel="noreferrer" className="inline-block rounded-xl bg-neutral-900 px-6 py-3 text-sm font-semibold text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900">
            {cta.label}
          </a>
        </div>
      )}
      <p className="mt-6 text-center text-sm text-neutral-500">Tracked with heart-rate at UN1T.</p>
    </main>
  )
}
```

- [ ] **Step 4: Build (catches ImageResponse/JSX + the new routes)**

Run: `cd /Users/richardivers/code/champ-app && npm run build`
Expected: compiles; `/share/[token]` + its `opengraph-image` appear in the route list.

- [ ] **Step 5: Commit**

```bash
cd /Users/richardivers/code/champ-app
noglob git add 'src/app/share/[token]/opengraph-image.jsx' 'src/app/share/[token]/page.jsx' src/middleware.js
git commit -m "SESSION-REPORT.4 — public /share/[token] card image + viewer page + middleware allowlist

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Share button on the session view

**Files:**
- Create: `champ-app/src/components/ShareSessionButton.jsx`
- Modify: `champ-app/src/app/sessions/[id]/page.jsx`

- [ ] **Step 1: The client Share button**

`champ-app/src/components/ShareSessionButton.jsx`:
```jsx
'use client'

import { useState } from 'react'

export default function ShareSessionButton({ sessionId }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null) // 'shared' | 'copied'
  const [error, setError] = useState(null)

  async function share() {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/sessions/${sessionId}/share`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.url) throw new Error(json.error || 'Could not create your share link')
      if (navigator.share) {
        await navigator.share({ title: 'My UN1T session', url: json.url })
        setDone('shared')
      } else {
        await navigator.clipboard.writeText(json.url)
        setDone('copied')
      }
    } catch (e) {
      // navigator.share throws on user-cancel — don't surface that as an error
      if (e?.name !== 'AbortError') setError(e.message || 'Share failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 text-center">
      <button
        type="button"
        onClick={share}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-xl border border-neutral-300 px-5 py-3 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-800"
      >
        {busy ? 'Creating link…' : 'Share my session'}
      </button>
      {done === 'copied' && <p className="mt-2 text-xs text-neutral-500">Link copied to clipboard.</p>}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Wire it into the session page**

In `champ-app/src/app/sessions/[id]/page.jsx`:

(a) Add the import (with the other imports):
```js
import ShareSessionButton from '@/components/ShareSessionButton'
```

(b) Immediately AFTER the `{report?.next_action && (...)}` `</section>` block and BEFORE the closing `</main>`, add:
```jsx
      <ShareSessionButton sessionId={session.id} />
```

- [ ] **Step 3: Build**

Run: `cd /Users/richardivers/code/champ-app && npm run build`
Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/richardivers/code/champ-app
noglob git add src/components/ShareSessionButton.jsx 'src/app/sessions/[id]/page.jsx'
git commit -m "SESSION-REPORT.4 — Share button on the session view (mint + native share/copy)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Ship — apply migration, CI both repos, PRs, merge

**Files:** none (release).

- [ ] **Step 1: Apply mig 294 to prod (before merge)**

Apply `un1t-crm/supabase/migrations/294_hr_session_share_token.sql` via the Supabase MCP `apply_migration` tool (project `iyvtbjjxdggiadzwwvdj`). Additive column + partial unique index; safe pre-merge.

- [ ] **Step 2: Security advisor**

`get_advisors` (type=security). Expected: no new ERROR (the column adds no RLS surface; public reads are service-role by capability token). The existing `heart_rate_sessions` policies are unchanged.

- [ ] **Step 3: un1t-crm CI (migration-only branch)**

```bash
cd /Users/richardivers/code/un1t-crm
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards
```
Expected: green (no app code changed; the migration is inert to tests). `next build` not required for a migration-only change.

- [ ] **Step 4: champ-app full checks + build**

```bash
cd /Users/richardivers/code/champ-app && npm test && npm run lint && npm run build
```
Expected: green (share-card + load-share-card + share route tests pass; build renders the new routes).

- [ ] **Step 5: Push + open both PRs (base=main)**

```bash
cd /Users/richardivers/code/un1t-crm && git push -u origin session-report-slice4-share-card
gh pr create --base main --head session-report-slice4-share-card \
  --title "SESSION-REPORT.4 — shareable card (mig 294: share_token)" \
  --body "Adds heart_rate_sessions.share_token (opt-in, revocable) for the champ-app public shareable post-class card. Migration + spec/plan only; all feature code is in the paired champ-app PR. No RLS change (public reads are service-role by capability token).

Spec/plan: docs/superpowers/{specs,plans}/2026-06-19-session-report-slice4-share-card*

🤖 Generated with [Claude Code](https://claude.com/claude-code)"

cd /Users/richardivers/code/champ-app && git push -u origin session-report-slice4-share-card
gh pr create --base main --head session-report-slice4-share-card \
  --title "SESSION-REPORT.4 — shareable post-class card" \
  --body "A member opts into sharing a session → public /share/[token] page + link-preview card (next/og ImageResponse, zero new deps). The card is the approved B+C hybrid: hardest-zone colour band + the member's real HR trace as the hero, big points/stats/zone-bar/highlight, first name + last initial. Mint/revoke is customer-self; public reads resolve the token via the service client; middleware allowlists /share. The share-page CTA reuses Slice 3's operator-editable booking/membership URLs. Pairs with un1t-crm mig 294.

Verified: champ-app vitest (share-card + load-share-card + share route) + next build green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 6: Watch CI, then merge both**

```bash
gh pr checks <un1t-crm#> -R ivers9307-cyber/un1t-crm --watch && gh pr merge <un1t-crm#> -R ivers9307-cyber/un1t-crm --squash
gh pr checks <champ-app#> -R ivers9307-cyber/champ-app --watch && gh pr merge <champ-app#> -R ivers9307-cyber/champ-app --squash
```
Confirm each squash landed on `origin/main`. champ-app auto-deploys to `app.champfitness.ie`. The feature is dormant until a member taps Share.

---

## Self-review notes

- **Spec coverage:** mig 294 share_token (Task 1) ✓; opt-in mint + revoke, customer-self (Task 4) ✓; public `/share/[token]` page + `opengraph-image` + middleware allowlist (Task 5) ✓; B+C hybrid card — dominant-zone band + HR-trace hero + stats/zone-bar/highlight/category, first+initial (Tasks 2,5) ✓; service-client token resolution (Task 3) ✓; share-page CTA reuses Slice 3 editable URLs via `report.next_action` (Tasks 3,5) ✓; Share button native-share/copy (Task 6) ✓; runtime nodejs, zero new deps (Tasks 4-6) ✓; privacy (first+initial, opt-in, revocable, unguessable token) ✓.
- **Type consistency:** `card` shape from `cardModel` (name/className/dateLabel/points/avgHr/peakHr/minutes/zones/dominant/tracePoints/highlight/categoryLine/nextAction) is what the image + page render; `loadShareCard` returns `{ ok, card }`; the mint route returns `{ ok, url }`; `dominant.color` feeds the band; `tracePoints` → `traceSvg` → data-URI `<img>`.
- **Gotchas honoured:** `noglob`/quoted bracket paths; `next build` its own step (catches ImageResponse/JSX); the Share button is a separate `'use client'` component (the page is a Server Component; `navigator.share` is client-only); `navigator.share` user-cancel (`AbortError`) is not surfaced as an error; `next/og` `<img>` uses a URL-encoded data-URI SVG (reliable in satori) rather than relying on inline-SVG support; the contact embed is FK-hinted (`!heart_rate_sessions_contact_id_fkey`, single FK); public reads use the service client (the customer RLS client can't read another member's session — but the card is public-by-token by design).
