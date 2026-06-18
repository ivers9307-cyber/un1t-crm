# Session Report (Slice 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One pure, versioned `buildSessionReport()` payload — rendered by the champ-app session view, a customer-self report API, and the un1t-crm post-class email — so post-class analytics live in one surface-agnostic data contract.

**Architecture:** A pure builder assembles the *existing* HR helpers (`summariseSession`/`zoneBreakdown` + `buildSessionAnalytics`) into a versioned report object with `null` slots for later slices (`vs_category`, `next_action`, `class.category`). It's authored in **champ-app** (canon — matching the existing `heart-rate.js`/`hr-analytics.js` convention; this refines the spec's "un1t-crm canonical" wording for consistency) and copied verbatim into un1t-crm for the email. champ-app gains a `loadSessionReport()` data-loader behind both a report API route and the session view; the email refactors to consume the same builder.

**Tech Stack:** Two Next.js apps (champ-app `app.champfitness.ie`, un1t-crm `crm.un1tdublin.com`) sharing one Supabase project; Vitest; pure-lib test convention (co-located `*.test.js`). No migration.

**Repos / working dirs:**
- champ-app: `/Users/richardivers/code/champ-app` — Tasks 1–4. Branch: `git -C /Users/richardivers/code/champ-app checkout main && git -C /Users/richardivers/code/champ-app pull && git -C /Users/richardivers/code/champ-app checkout -b session-report`
- un1t-crm: `/Users/richardivers/code/un1t-crm` — Task 5. Branch: `git -C /Users/richardivers/code/un1t-crm checkout main && git -C /Users/richardivers/code/un1t-crm pull && git -C /Users/richardivers/code/un1t-crm checkout -b session-report`

**Testing posture:** the **builder + loader are the units** (pure / mockable) and carry the coverage; the API route + the session view + the email are thin renderers verified by `npm run build` + the existing email test. champ-app has no component-test harness — don't add one.

## File structure

| File | Repo | Responsibility |
|---|---|---|
| `src/lib/hr-analytics.js` (+ `.test.js`) | champ-app | **Copied verbatim** from un1t-crm (currently missing). Dep of the builder. |
| `src/lib/hr-session-report.js` (+ `.test.js`) | champ-app **then** un1t-crm | The versioned `buildSessionReport()` contract. Authored in champ-app, copied to un1t-crm. |
| `src/lib/__fixtures__/session-report.fixture.json` | both | Shared input fixture both repos' tests build from. |
| `src/lib/load-session-report.js` (+ `.test.js`) | champ-app | `loadSessionReport(supabase, id)` — RLS-scoped data load → builder. |
| `src/app/api/sessions/[id]/report/route.js` | champ-app | Customer-self `GET` → JSON payload. |
| `src/app/sessions/[id]/page.jsx` | champ-app | Adds the comparison + highlight section. |
| `src/lib/hr-post-class-email.js` | un1t-crm | `composeEmail` refactored onto the builder. |

---

### Task 1: Bring `hr-analytics.js` into champ-app (the missing dep)

The builder needs `buildSessionAnalytics`; champ-app has `heart-rate.js` but not `hr-analytics.js`.

**Files:**
- Create: `champ-app/src/lib/hr-analytics.js` (copy of `un1t-crm/src/lib/hr-analytics.js`)
- Create: `champ-app/src/lib/hr-analytics.test.js` (copy of `un1t-crm/src/lib/hr-analytics.test.js`)

- [ ] **Step 1: Copy both files verbatim**

```bash
cp /Users/richardivers/code/un1t-crm/src/lib/hr-analytics.js /Users/richardivers/code/champ-app/src/lib/hr-analytics.js
cp /Users/richardivers/code/un1t-crm/src/lib/hr-analytics.test.js /Users/richardivers/code/champ-app/src/lib/hr-analytics.test.js
```

- [ ] **Step 2: Add a sync-note to the champ-app copy's header**

In `champ-app/src/lib/hr-analytics.js`, add as the first comment line:
```js
// KEEP IN SYNC with un1t-crm/src/lib/hr-analytics.js (verbatim copy).
```

- [ ] **Step 3: Run the copied tests**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/hr-analytics.test.js`
Expected: PASS (same suite that passes in un1t-crm — pure functions, no imports beyond JS built-ins).

- [ ] **Step 4: Commit**

```bash
cd /Users/richardivers/code/champ-app
git add src/lib/hr-analytics.js src/lib/hr-analytics.test.js
git commit -m "chore(hr): vendor hr-analytics.js into champ-app (dep for session report)"
```

---

### Task 2: The `buildSessionReport` contract (champ-app, canon)

**Files:**
- Create: `champ-app/src/lib/__fixtures__/session-report.fixture.json`
- Create: `champ-app/src/lib/hr-session-report.js`
- Test: `champ-app/src/lib/hr-session-report.test.js`

- [ ] **Step 1: Create the shared input fixture**

Create `champ-app/src/lib/__fixtures__/session-report.fixture.json`:

```json
{
  "nowMs": 1781784000000,
  "ctx": {
    "eventTypeName": "RIDE",
    "session": {
      "id": "s-now",
      "started_at": "2026-06-18T11:00:00.000Z",
      "ended_at": "2026-06-18T11:30:00.000Z",
      "source": "ble_bridge",
      "effort_points": 300, "avg_hr_bpm": 150, "peak_hr_bpm": 180, "max_hr_used": 190,
      "zones_seconds": { "1": 60, "2": 240, "3": 600, "4": 600, "5": 300 }
    },
    "thisSession": {
      "id": "s-now", "started_at": "2026-06-18T11:00:00.000Z", "event_type_id": "et-ride",
      "effort_points": 300, "peak_hr_bpm": 180, "avg_hr_bpm": 150,
      "zones_seconds": { "1": 60, "2": 240, "3": 600, "4": 600, "5": 300 }
    },
    "history": [
      { "id": "r1", "started_at": "2026-06-10T11:00:00.000Z", "event_type_id": "et-ride", "effort_points": 200, "peak_hr_bpm": 170, "avg_hr_bpm": 145, "zones_seconds": { "1": 600, "2": 600, "3": 600, "4": 0, "5": 0 } },
      { "id": "r2", "started_at": "2026-06-03T11:00:00.000Z", "event_type_id": "et-ride", "effort_points": 250, "peak_hr_bpm": 175, "avg_hr_bpm": 148, "zones_seconds": { "1": 300, "2": 600, "3": 600, "4": 300, "5": 0 } },
      { "id": "r3", "started_at": "2026-05-27T11:00:00.000Z", "event_type_id": "et-ride", "effort_points": 260, "peak_hr_bpm": 178, "avg_hr_bpm": 149, "zones_seconds": { "1": 300, "2": 600, "3": 600, "4": 300, "5": 0 } },
      { "id": "p1", "started_at": "2026-05-05T11:00:00.000Z", "event_type_id": "et-ride", "effort_points": 180, "peak_hr_bpm": 165, "avg_hr_bpm": 140, "zones_seconds": { "1": 600, "2": 600, "3": 300, "4": 0, "5": 0 } },
      { "id": "p2", "started_at": "2026-04-28T11:00:00.000Z", "event_type_id": "et-ride", "effort_points": 200, "peak_hr_bpm": 168, "avg_hr_bpm": 142, "zones_seconds": { "1": 600, "2": 600, "3": 300, "4": 0, "5": 0 } }
    ],
    "achievements": [
      { "slug": "first_red", "name": "Into the Red", "icon": "Flame", "earned_at": "2026-06-18T11:30:05.000Z" }
    ]
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `champ-app/src/lib/hr-session-report.test.js`:

```js
import { describe, it, expect } from 'vitest'
import fixture from './__fixtures__/session-report.fixture.json'
import { buildSessionReport, SESSION_REPORT_VERSION } from './hr-session-report.js'

describe('buildSessionReport', () => {
  const report = buildSessionReport(fixture.ctx, { nowMs: fixture.nowMs })

  it('stamps the version envelope', () => {
    expect(SESSION_REPORT_VERSION).toBe(1)
    expect(report.version).toBe(1)
  })

  it('builds the session block with duration + class', () => {
    expect(report.session.id).toBe('s-now')
    expect(report.session.duration_seconds).toBe(1800)
    expect(report.session.source).toBe('ble_bridge')
    expect(report.session.class).toEqual({ event_type_id: 'et-ride', name: 'RIDE', category: null })
  })

  it('summarises points + zones (5 zones, percents sum to ~1)', () => {
    expect(report.summary.effort_points).toBe(300)
    expect(report.summary.max_hr_used).toBe(190)
    expect(report.summary.zones).toHaveLength(5)
    expect(report.summary.zones[2]).toMatchObject({ id: 3, name: 'Aerobic' })
    const pctSum = report.summary.zones.reduce((a, z) => a + z.percent, 0)
    expect(pctSum).toBeCloseTo(1, 5)
  })

  it('maps the recent + peak trends (both up, enough data)', () => {
    expect(report.comparisons.vs_recent).toMatchObject({ field: 'effort_points', direction: 'up', has_enough_data: true })
    expect(report.comparisons.vs_recent_peak).toMatchObject({ field: 'peak_hr_bpm', has_enough_data: true })
  })

  it('maps the this-class comparison', () => {
    expect(report.comparisons.vs_this_class).toEqual({
      event_type_name: 'RIDE', mean_points: 237, percentile: 1, sample_size: 3,
    })
  })

  it('picks the highlight (first time in Z5)', () => {
    expect(report.highlight.id).toBe('first_z5')
    expect(report.highlight.message).toMatch(/red zone/i)
  })

  it('maps achievements', () => {
    expect(report.achievements).toEqual([
      { slug: 'first_red', name: 'Into the Red', icon: 'Flame', earned_at: '2026-06-18T11:30:05.000Z' },
    ])
  })

  it('leaves the later-slice slots null', () => {
    expect(report.comparisons.vs_category).toBeNull()
    expect(report.next_action).toBeNull()
  })

  it('is JSON-serialisable (surface-agnostic)', () => {
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow()
  })

  it('degrades safely with no history (first ever)', () => {
    const r = buildSessionReport(
      { ...fixture.ctx, history: [], achievements: [] },
      { nowMs: fixture.nowMs },
    )
    expect(r.comparisons.vs_recent.has_enough_data).toBe(false)
    expect(r.comparisons.vs_this_class.sample_size).toBe(0)
    expect(r.achievements).toEqual([])
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/hr-session-report.test.js`
Expected: FAIL — `Failed to resolve import "./hr-session-report.js"`.

- [ ] **Step 4: Write the implementation**

Create `champ-app/src/lib/hr-session-report.js`:

```js
// Canonical, versioned post-class "Session Report" — the single
// surface-agnostic payload rendered by the champ-app session view,
// the champ-app report API (future native app + cards), and the
// un1t-crm post-class email.
//
// Pure: no IO, no Date.now() unless nowMs is passed. It ASSEMBLES the
// existing HR helpers (it re-implements none of the maths) and adds
// the version envelope + the null slots for later slices.
//
// KEEP IN SYNC with un1t-crm/src/lib/hr-session-report.js. Both repos
// assert against src/lib/__fixtures__/session-report.fixture.json.

import { zoneBreakdown } from './heart-rate.js'
import { buildSessionAnalytics } from './hr-analytics.js'

export const SESSION_REPORT_VERSION = 1

function durationSeconds(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null
}

function mapTrend(trend, field) {
  if (!trend) {
    return { field, direction: 'flat', delta_pct: null, recent_mean: null, prior_mean: null, has_enough_data: false }
  }
  return {
    field,
    direction: trend.direction || 'flat',
    delta_pct: Number.isFinite(trend.deltaPct) ? trend.deltaPct : null,
    recent_mean: Number.isFinite(trend.recentMean) ? Math.round(trend.recentMean) : null,
    prior_mean: Number.isFinite(trend.priorMean) ? Math.round(trend.priorMean) : null,
    has_enough_data: Boolean(trend.hasEnoughData),
  }
}

function mapAchievements(achievements) {
  return (achievements || [])
    .map((a) => ({
      slug: a.slug ?? a.rule?.slug ?? null,
      name: a.name ?? a.rule?.name ?? null,
      icon: a.icon ?? a.rule?.icon ?? null,
      earned_at: a.earned_at ?? null,
    }))
    .filter((a) => a.slug && a.name)
}

/**
 * @param {object} ctx
 *   session       heart_rate_sessions row (zones_seconds, effort_points, avg/peak/max, started/ended, source)
 *   thisSession   analytics shape (see hr-analytics.js) — includes event_type_id
 *   history       array of analytics-shape rows (90-day window)
 *   eventTypeName string | null
 *   achievements? rows ({slug,name,icon,earned_at} or {rule:{...},earned_at})
 * @param {{nowMs?: number}} opts
 */
export function buildSessionReport(ctx, { nowMs = Date.now() } = {}) {
  const { session, thisSession, history, eventTypeName } = ctx
  const analytics = buildSessionAnalytics({ thisSession, history, eventTypeName, nowMs })
  const ct = analytics.classType || {}
  const zones = zoneBreakdown(session.zones_seconds).map((z) => ({
    id: z.id, name: z.name, color: z.color, seconds: z.seconds, percent: z.percent,
  }))

  return {
    version: SESSION_REPORT_VERSION,
    session: {
      id: session.id,
      started_at: session.started_at || null,
      ended_at: session.ended_at || null,
      duration_seconds: durationSeconds(session.started_at, session.ended_at),
      source: session.source || null,
      class: {
        event_type_id: thisSession?.event_type_id ?? null,
        name: eventTypeName || null,
        category: null, // Slice 2
      },
    },
    summary: {
      effort_points: Number.isFinite(session.effort_points) ? session.effort_points : 0,
      avg_hr_bpm: Number.isFinite(session.avg_hr_bpm) ? session.avg_hr_bpm : null,
      peak_hr_bpm: Number.isFinite(session.peak_hr_bpm) ? session.peak_hr_bpm : null,
      max_hr_used: Number.isFinite(session.max_hr_used) ? session.max_hr_used : null,
      zones,
    },
    comparisons: {
      vs_recent: mapTrend(analytics.overall?.pointsTrend, 'effort_points'),
      vs_recent_peak: mapTrend(analytics.overall?.peakTrend, 'peak_hr_bpm'),
      vs_this_class: {
        event_type_name: ct.eventTypeName ?? eventTypeName ?? null,
        mean_points: Number.isFinite(ct.meanPoints) ? ct.meanPoints : null,
        percentile: Number.isFinite(ct.percentile) ? ct.percentile : null,
        sample_size: Number.isFinite(ct.recentCount) ? ct.recentCount : 0,
      },
      vs_category: null, // Slice 2
    },
    highlight: analytics.highlight || null,
    achievements: mapAchievements(ctx.achievements),
    next_action: null, // Slice 3
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/hr-session-report.test.js`
Expected: PASS (all cases). If `vs_this_class.mean_points` is off by a rounding unit, confirm `meanField` rounding — the expected is `Math.round(236.67) = 237`.

- [ ] **Step 6: Commit**

```bash
cd /Users/richardivers/code/champ-app
git add src/lib/hr-session-report.js src/lib/hr-session-report.test.js src/lib/__fixtures__/session-report.fixture.json
git commit -m "feat(hr): versioned buildSessionReport contract (champ-app canon)"
```

---

### Task 3: `loadSessionReport` + the customer-self report API (champ-app)

**Files:**
- Create: `champ-app/src/lib/load-session-report.js`
- Test: `champ-app/src/lib/load-session-report.test.js`
- Create: `champ-app/src/app/api/sessions/[id]/report/route.js`

- [ ] **Step 1: Write the failing loader test (mock Supabase client)**

Create `champ-app/src/lib/load-session-report.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { loadSessionReport } from './load-session-report.js'

// Minimal chainable Supabase stub. Each .from(table) returns a thenable
// builder; the terminal (.maybeSingle() or awaiting the builder) yields
// the canned rows for that table.
function makeSupabase({ session, history, achievements }) {
  const tableData = {
    heart_rate_sessions__single: session,
    heart_rate_sessions__list: history,
    contact_achievements: achievements,
  }
  return {
    from(table) {
      const b = {
        _table: table, _single: false,
        select() { return b },
        eq() { return b },
        gte() { return b },
        not() { return b },
        order() { return b },
        maybeSingle() { b._single = true; return Promise.resolve({ data: tableData.heart_rate_sessions__single, error: null }) },
        then(resolve) {
          const data = table === 'heart_rate_sessions' ? tableData.heart_rate_sessions__list : tableData[table]
          return Promise.resolve({ data, error: null }).then(resolve)
        },
      }
      return b
    },
  }
}

const baseSession = {
  id: 's1', contact_id: 'c1', started_at: '2026-06-18T11:00:00.000Z',
  ended_at: '2026-06-18T11:30:00.000Z', source: 'ble_bridge',
  effort_points: 300, avg_hr_bpm: 150, peak_hr_bpm: 180, max_hr_used: 190,
  zones_seconds: { 1: 60, 2: 240, 3: 600, 4: 600, 5: 300 },
  booking: { event_type: { id: 'et-ride', name: 'RIDE' } },
}

describe('loadSessionReport', () => {
  it('returns ok:false when the session is not found', async () => {
    const out = await loadSessionReport(makeSupabase({ session: null }), 's1')
    expect(out.ok).toBe(false)
  })

  it('returns ok:false when the session has not ended', async () => {
    const out = await loadSessionReport(makeSupabase({ session: { ...baseSession, ended_at: null } }), 's1')
    expect(out.ok).toBe(false)
  })

  it('builds a versioned report from the loaded rows', async () => {
    const supabase = makeSupabase({
      session: baseSession,
      history: [{ id: 'r1', started_at: '2026-06-10T11:00:00.000Z', effort_points: 200, peak_hr_bpm: 170, avg_hr_bpm: 145, zones_seconds: { 1: 600, 2: 600, 3: 600 }, booking: { event_type_id: 'et-ride' } }],
      achievements: [{ earned_at: '2026-06-18T11:30:05.000Z', rule: { slug: 'first_red', name: 'Into the Red', icon: 'Flame' } }],
    })
    const out = await loadSessionReport(supabase, 's1', { nowMs: 1781784000000 })
    expect(out.ok).toBe(true)
    expect(out.report.version).toBe(1)
    expect(out.report.session.class.name).toBe('RIDE')
    expect(out.report.summary.effort_points).toBe(300)
    expect(out.report.achievements[0].slug).toBe('first_red')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/load-session-report.test.js`
Expected: FAIL — unresolved import `./load-session-report.js`.

- [ ] **Step 3: Write the loader**

Create `champ-app/src/lib/load-session-report.js`:

```js
// Loads everything buildSessionReport needs for one session, scoped by
// the caller's Supabase client (RLS customer-self), then assembles the
// report. Used by BOTH the report API route and the session-detail page
// so the two never diverge. The `supabase` arg is injected so this is
// unit-testable with a stub.

import { buildSessionReport } from './hr-session-report.js'

const HISTORY_LOOKBACK_DAYS = 90

export async function loadSessionReport(supabase, sessionId, { nowMs = Date.now() } = {}) {
  const { data: session, error } = await supabase
    .from('heart_rate_sessions')
    .select(`
      id, contact_id, started_at, ended_at, source,
      avg_hr_bpm, peak_hr_bpm, max_hr_used, zones_seconds, effort_points,
      booking:bookings!heart_rate_sessions_booking_id_fkey (
        event_type:event_types!bookings_event_type_id_fkey ( id, name )
      )
    `)
    .eq('id', sessionId)
    .maybeSingle()

  if (error || !session) return { ok: false, error: 'not-found' }
  if (!session.ended_at) return { ok: false, error: 'not-ended' }

  const eventType = session.booking?.event_type || null
  const sinceIso = new Date(nowMs - HISTORY_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString()

  const { data: historyRows } = await supabase
    .from('heart_rate_sessions')
    .select(`id, started_at, effort_points, peak_hr_bpm, avg_hr_bpm, zones_seconds,
             booking:bookings!heart_rate_sessions_booking_id_fkey ( event_type_id )`)
    .eq('contact_id', session.contact_id)
    .gte('started_at', sinceIso)
    .not('ended_at', 'is', null)

  const { data: achRows } = await supabase
    .from('contact_achievements')
    .select('earned_at, rule:achievement_rules(slug, name, icon)')
    .eq('source_session_id', sessionId)
    .order('earned_at', { ascending: true })

  const history = (historyRows || []).map((r) => ({
    id: r.id, started_at: r.started_at,
    event_type_id: r.booking?.event_type_id || null,
    effort_points: r.effort_points, peak_hr_bpm: r.peak_hr_bpm,
    avg_hr_bpm: r.avg_hr_bpm, zones_seconds: r.zones_seconds,
  }))

  const thisSession = {
    id: session.id, started_at: session.started_at,
    event_type_id: eventType?.id || null,
    effort_points: session.effort_points, peak_hr_bpm: session.peak_hr_bpm,
    avg_hr_bpm: session.avg_hr_bpm, zones_seconds: session.zones_seconds,
  }

  const report = buildSessionReport(
    { session, thisSession, history, eventTypeName: eventType?.name || null, achievements: achRows || [] },
    { nowMs },
  )
  return { ok: true, report }
}
```

- [ ] **Step 4: Run the loader test to verify it passes**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/load-session-report.test.js`
Expected: PASS (3 cases).

- [ ] **Step 5: Write the API route**

Create `champ-app/src/app/api/sessions/[id]/report/route.js`:

```js
// GET /api/sessions/[id]/report
//
// Customer-self post-class report payload. RLS (createServerClient)
// returns the session only if it belongs to the signed-in member, so
// an unknown / other-member id yields not-found → 404 (no enumeration).
// The future native app + shareable-card renderer consume this.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase-server'
import { loadSessionReport } from '@/lib/load-session-report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, { params }) {
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })

  const out = await loadSessionReport(supabase, params.id)
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 404 })
  return NextResponse.json({ report: out.report })
}
```

- [ ] **Step 6: Verify build + commit**

Run: `cd /Users/richardivers/code/champ-app && npm run build`
Expected: build succeeds; the new route compiles.

```bash
cd /Users/richardivers/code/champ-app
git add src/lib/load-session-report.js src/lib/load-session-report.test.js "src/app/api/sessions/[id]/report/route.js"
git commit -m "feat(hr): loadSessionReport + customer-self GET /api/sessions/[id]/report"
```

---

### Task 4: Render the comparison + highlight layer in the session view (champ-app)

The view already shows stats / HR chart / zone breakdown / achievements. Add the highlight hero line + the comparisons it currently lacks, built via `loadSessionReport`.

**Files:**
- Modify: `champ-app/src/app/sessions/[id]/page.jsx`

- [ ] **Step 1: Load the report alongside the existing data**

In `SessionDetailPage`, add the import near the top (after the existing `zoneBreakdown` import on line 15):
```js
import { loadSessionReport } from '@/lib/load-session-report'
```

Then, immediately after the `if (error || !session) notFound()` line (around line 39), add:
```js
  const reportOut = await loadSessionReport(supabase, params.id)
  const report = reportOut.ok ? reportOut.report : null
```

- [ ] **Step 2: Render the highlight + comparisons section**

In the returned JSX, immediately after the closing `</header>` (around line 90, before the `{/* Stat row */}` block), insert:

```jsx
      {report?.highlight && (
        <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
          ★ {report.highlight.message}
        </p>
      )}

      {report && (
        <section className="mt-6 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">How this compares</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {report.comparisons.vs_this_class.percentile != null && report.comparisons.vs_this_class.sample_size >= 2 && (
              <li className="text-neutral-700 dark:text-neutral-300">
                {(() => {
                  const c = report.comparisons.vs_this_class
                  const pct = Math.round(c.percentile * 100)
                  const cls = c.event_type_name || 'this class'
                  return pct >= 50
                    ? `Top ${100 - pct}% of your last ${c.sample_size} ${cls} sessions.`
                    : `Below your usual for ${cls} (avg ${c.mean_points} pts over your last ${c.sample_size}).`
                })()}
              </li>
            )}
            {report.comparisons.vs_recent.has_enough_data && Number.isFinite(report.comparisons.vs_recent.delta_pct) && (
              <li className="text-neutral-700 dark:text-neutral-300">
                {(() => {
                  const t = report.comparisons.vs_recent
                  const pct = Math.round(Math.abs(t.delta_pct) * 100)
                  if (t.direction === 'up') return `UN1T Points up ${pct}% vs your previous 4 weeks.`
                  if (t.direction === 'down') return `UN1T Points down ${pct}% vs your previous 4 weeks.`
                  return 'UN1T Points steady vs your previous 4 weeks.'
                })()}
              </li>
            )}
            {!report.comparisons.vs_recent.has_enough_data && (
              <li className="text-neutral-500">Keep training — comparisons unlock once you have a few more sessions.</li>
            )}
          </ul>
        </section>
      )}
```

- [ ] **Step 3: Verify build + commit**

Run: `cd /Users/richardivers/code/champ-app && npm run build`
Expected: build succeeds; `/sessions/[id]` compiles.

```bash
cd /Users/richardivers/code/champ-app
git add "src/app/sessions/[id]/page.jsx"
git commit -m "feat(hr): show highlight + comparison layer on the session view"
```

- [ ] **Step 4: Full champ-app test + build gate**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run && npm run build`
Expected: all tests pass, build clean.

---

### Task 5: Adopt the contract in the un1t-crm post-class email

Vendor the builder into un1t-crm and refactor `composeEmail` to assemble from it. **Behaviour-preserving** — the existing `hr-post-class-email.test.js` is the gate.

**Files:**
- Create: `un1t-crm/src/lib/hr-session-report.js` + `un1t-crm/src/lib/hr-session-report.test.js` + `un1t-crm/src/lib/__fixtures__/session-report.fixture.json` (copies of the champ-app canon)
- Modify: `un1t-crm/src/lib/hr-post-class-email.js`

- [ ] **Step 1: Copy the builder + fixture + test from champ-app**

```bash
mkdir -p /Users/richardivers/code/un1t-crm/src/lib/__fixtures__
cp /Users/richardivers/code/champ-app/src/lib/hr-session-report.js /Users/richardivers/code/un1t-crm/src/lib/hr-session-report.js
cp /Users/richardivers/code/champ-app/src/lib/hr-session-report.test.js /Users/richardivers/code/un1t-crm/src/lib/hr-session-report.test.js
cp /Users/richardivers/code/champ-app/src/lib/__fixtures__/session-report.fixture.json /Users/richardivers/code/un1t-crm/src/lib/__fixtures__/session-report.fixture.json
```

- [ ] **Step 2: Run the copied builder test in un1t-crm**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/hr-session-report.test.js`
Expected: PASS (un1t-crm already has `heart-rate.js` + `hr-analytics.js`, the builder's deps).

- [ ] **Step 3: Refactor `composeEmail` onto the builder**

In `un1t-crm/src/lib/hr-post-class-email.js`:

(a) Add the import beside the existing analytics import:
```js
import { buildSessionReport } from '@/lib/hr-session-report'
```

(b) In `composeEmail(ctx, { nowMs })`, replace the two lines:
```js
  const analytics = buildSessionAnalytics({ thisSession, history, eventTypeName, nowMs })
  const breakdown = zoneBreakdown(session.zones_seconds)
```
with:
```js
  const report = buildSessionReport({ session, thisSession, history, eventTypeName }, { nowMs })
  // Adapt the report back to the shapes the existing renderers read, so
  // the email's output is byte-identical while the numbers now flow from
  // the one canonical builder.
  const analytics = {
    highlight: report.highlight,
    classType: {
      eventTypeName: report.comparisons.vs_this_class.event_type_name,
      meanPoints: report.comparisons.vs_this_class.mean_points,
      percentile: report.comparisons.vs_this_class.percentile,
      recentCount: report.comparisons.vs_this_class.sample_size,
      thisPoints: report.summary.effort_points,
    },
    overall: {
      pointsTrend: trendFromReport(report.comparisons.vs_recent),
      peakTrend: trendFromReport(report.comparisons.vs_recent_peak),
    },
  }
  const breakdown = report.summary.zones.map((z) => ({
    id: z.id, name: z.name, label: ZONE_LABELS[z.id], color: z.color,
    seconds: z.seconds, percent: z.percent,
  }))
```

(c) Add these two small helpers at the bottom of the file (module scope), so the adapter has what the renderers expect (`trendLabel`/`classTypeLabel` read camelCase `deltaPct`/`hasEnoughData`, and the zone rows read `label` = `Z1..Z5`):
```js
const ZONE_LABELS = { 1: 'Z1', 2: 'Z2', 3: 'Z3', 4: 'Z4', 5: 'Z5' }

function trendFromReport(t) {
  return {
    hasEnoughData: t.has_enough_data,
    direction: t.direction,
    deltaPct: t.delta_pct,
    recentMean: t.recent_mean,
    priorMean: t.prior_mean,
  }
}
```

(d) Remove the now-unused imports — `composeEmail` no longer calls `buildSessionAnalytics` or `zoneBreakdown` directly (both run inside `buildSessionReport`). Delete the `buildSessionAnalytics` import (from `@/lib/hr-analytics`) and the `zoneBreakdown` import (from `@/lib/heart-rate`). First confirm nothing else in the file still uses them — `grep -n 'buildSessionAnalytics\|zoneBreakdown' src/lib/hr-post-class-email.js` should, after the edit, point only at the import lines you're removing; if either name appears elsewhere, keep that import. (Unused imports trip `no-unused-vars` in the CI lint step.)

> Why the adapter rather than rewriting `renderText`/`renderHtml`: those helpers (and `pickSubject`/`trendLabel`/`classTypeLabel`) read `analytics.{highlight,classType,overall}` (camelCase) + `breakdown[].{label,name,color,seconds,percent}`. Adapting once keeps the email output identical (the test gate proves it) while making the builder the single source of the numbers. Rewriting the renderers to snake_case is deferrable churn with regression risk and zero output change.

- [ ] **Step 4: Run the email test (the gate) + the builder test**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/hr-post-class-email.test.js src/lib/hr-session-report.test.js`
Expected: PASS — the email test output is unchanged (behaviour-preserving), builder green. If the email test fails on a value, diff the adapter mapping against what the renderer read before (most likely `label` or a rounding difference in `mean_points`/`recent_mean`).

- [ ] **Step 5: Full un1t-crm CI mirror + commit**

Run: `cd /Users/richardivers/code/un1t-crm && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build`
Expected: all green (no new web permission, no new mobile import, the new API route is champ-app's not un1t-crm's so route-guards is unaffected; `next build` clean).

```bash
cd /Users/richardivers/code/un1t-crm
git add src/lib/hr-session-report.js src/lib/hr-session-report.test.js src/lib/__fixtures__/session-report.fixture.json src/lib/hr-post-class-email.js
git commit -m "refactor(hr): post-class email composes from buildSessionReport (one contract)"
```

> **De-risk note:** Task 5 is pure internal consolidation with no new member-visible value — the email already works. If the existing email test proves brittle to the adapter, it is safe to ship Tasks 1–4 (the member-visible win + the contract + API) and land Task 5 as a follow-up; the numbers are identical either way because both paths use the same underlying helpers.

---

### Task 6: Ship

- [ ] **Step 1: Push + PR — champ-app**
```bash
cd /Users/richardivers/code/champ-app && git push -u origin session-report
gh pr create -R ivers9307-cyber/champ-app --base main --head session-report \
  --title "feat(hr): Session Report contract + API + visual comparison view" \
  --body "Slice 1 of post-class member value. Adds the versioned buildSessionReport() contract (champ-app canon) + a customer-self GET /api/sessions/[id]/report + the highlight/comparison layer on the session view. Vendors hr-analytics.js in. Spec: un1t-crm docs/superpowers/specs/2026-06-18-session-report-data-contract-design.md. Verified: vitest + next build green."
```

- [ ] **Step 2: Push + PR — un1t-crm**
```bash
cd /Users/richardivers/code/un1t-crm && git push -u origin session-report
gh pr create -R ivers9307-cyber/un1t-crm --base main --head session-report \
  --title "refactor(hr): post-class email composes from the shared Session Report builder" \
  --body "Slice 1 (un1t-crm side). Vendors buildSessionReport() + shared fixture; refactors composeEmail to assemble from it (behaviour-preserving, existing email test is the gate). Verified: full CI mirror + next build green."
```

- [ ] **Step 3: Merge after CI green on both** (champ-app first — it's the canon source; then un1t-crm).

---

## Notes for the executor

- **Two repos, one feature.** champ-app is canon for the builder (Tasks 1–4); un1t-crm vendors a verbatim copy (Task 5). The shared `session-report.fixture.json` + identical test assertions are what keep them from drifting — if you change the builder in one repo, copy it to the other and both test suites must stay green.
- **No migration, no new permission, no new web route in un1t-crm.** The only new route is champ-app's report API.
- **Deferred (do NOT pull in):** cardio/strength category (`vs_category`/`class.category` stay null — Slice 2), `next_action` book-CTA (Slice 3), native push + shareable card (Slice 4). The payload already has the null slots so those land without reshaping it.
