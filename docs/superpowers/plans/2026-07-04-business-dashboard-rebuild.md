# Business Dashboard Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/dashboard/business` as a streamed command centre: briefing line + KPI 4-up, funnel/ads/membership/today blocks, and a "Needs you" action rail — all live per load.

**Architecture:** Pure helpers in `shared/` (briefing sentence, metric shaping — mobile-reusable, unit-tested), block fetchers added to `shared/dashboard-data.js` (paginated sums, single-aggregate counts), a web-only rail assembler in `src/lib/dashboard/business-rail.js` (needs the approvals registry + churn radar from `src/lib`), presentational components in `src/components/dashboard/BusinessBlocks.jsx`, and a page rewrite where each block is an async server component inside its own `<Suspense>` with per-block try/catch. No migration expected.

**Tech Stack:** Next.js 16 App Router (server components + Suspense streaming), supabase-js (service role), Tailwind `un1t-*` tokens, existing `@/components/dashboard/Cards` primitives, Vitest `--pool=threads`.

**Spec:** `docs/superpowers/specs/2026-07-04-business-dashboard-rebuild-design.md`
**Branch:** `feat/business-dashboard-rebuild` (current)
**Models (Richard's instruction):** implementer subagents run on **Opus 4.8** (`model: "opus"`); spec/quality reviewers on sonnet; final whole-branch review on the session default.

---

## Read-first invariants

- supabase-js: builders awaited; ≤1000-row cap — any sum over rows paginates with `.range()` + `.order()`; `.select()` `head`/`count` options only on the FIRST select after `.from()`.
- `shared/` is pure ESM, no `src/lib` imports (mobile seam). Web-only logic (approvals registry, churn radar) stays in `src/lib`.
- Dublin wall-clock: use the file's existing `isoDate`/`startOfMonth` helpers for date windows; NEVER `new Date().toISOString().slice(...)` for a business "today" (guardrails-linted) — in `src/` use `dublinTodayStr()` from `@/lib/dublin-time`; in `shared/` reuse `isoDate(new Date())` exactly as the existing fetchers in the same file already do.
- Status chips `bg-<c>-500/10 text-<c>-700`; every non-submit button `type="button"`.
- `glofox_invoices`: revenue = `status='PAID'` rows only; arrears = `status='PAST_DUE'` rows (the daily reconcile cron keeps that set honest — cite mig 324 in a comment). NEVER compute anything from non-PAID/PAST_DUE rows.
- Funnel: stage slugs `new_lead, first_class, second_class, trial_done, converted` (mig 350); entered-this-month uses `joined_at` (NOT `lead_created_at` — import-poisoned); conversions use `converted_at`.
- `ad_insights_daily` stores campaign AND adset AND ad rows — always filter `level = 'campaign'` or spend triple-counts.
- Verify every anchor by reading the file first; content match beats line match. Quote `[id]` paths in zsh.
- Run `npm run` commands ONE AT A TIME (concurrent npm runs have hung agents in this environment).

---

### Task D1: Briefing sentence builder (`shared/business-briefing.js`)

**Files:** Create `shared/business-briefing.js` · Test `shared/business-briefing.test.js`

- [ ] **Step 1: failing test**

```javascript
// shared/business-briefing.test.js
import { describe, it, expect } from 'vitest'
import { buildBusinessBriefing } from './business-briefing.js'

const base = {
  revenue: { totalCents: 3840000, deltaPct: 6 },
  members: { count: 312, netChange: 9 },
  attention: [
    { label: '5 in arrears (€1,240)' },
    { label: '2 going quiet' },
    { label: '1 approval waiting' },
  ],
}

describe('buildBusinessBriefing', () => {
  it('positive deltas → upbeat opener with revenue, delta, members', () => {
    const s = buildBusinessBriefing(base)
    expect(s).toContain('€38,400')
    expect(s).toContain('+6%')
    expect(s).toContain('312 members')
    expect(s).toContain('+9')
    expect(s.startsWith('Solid')).toBe(true)
  })

  it('lists at most three attention items after "Watch:"', () => {
    const s = buildBusinessBriefing({
      ...base,
      attention: [
        { label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' },
      ],
    })
    expect(s).toContain('Watch: a, b, c.')
    expect(s).not.toContain('d')
  })

  it('negative revenue delta → steadier opener', () => {
    const s = buildBusinessBriefing({
      ...base,
      revenue: { totalCents: 3840000, deltaPct: -4 },
    })
    expect(s.startsWith('Mixed')).toBe(true)
    expect(s).toContain('-4%')
  })

  it('no attention items → "Nothing urgent." closer', () => {
    const s = buildBusinessBriefing({ ...base, attention: [] })
    expect(s).toContain('Nothing urgent.')
  })

  it('null deltas render without the delta clause and never throw', () => {
    const s = buildBusinessBriefing({
      revenue: { totalCents: 0, deltaPct: null },
      members: { count: 0, netChange: null },
      attention: [],
    })
    expect(typeof s).toBe('string')
    expect(s).not.toContain('null')
    expect(s).not.toContain('NaN')
  })
})
```

- [ ] **Step 2:** Run `npx vitest run shared/business-briefing.test.js --pool=threads` — expect FAIL (module not found).

- [ ] **Step 3: implementation**

```javascript
// shared/business-briefing.js
//
// DASH-REBUILD — deterministic one-line briefing for the Business
// dashboard. Pure template over already-fetched block values: no AI
// call, no randomness, no DB. Shared so mobile can render the same
// sentence later.
//
// buildBusinessBriefing({ revenue, members, attention }) → string
//   revenue:   { totalCents, deltaPct|null }   (MTD, vs same window last month)
//   members:   { count, netChange|null }
//   attention: [{ label }] — pre-ordered; first three are used.

function euro(cents) {
  const n = Math.round((cents || 0) / 100)
  return `€${n.toLocaleString('en-IE')}`
}

function pct(deltaPct) {
  if (deltaPct == null || Number.isNaN(deltaPct)) return null
  const r = Math.round(deltaPct)
  return `${r >= 0 ? '+' : ''}${r}%`
}

export function buildBusinessBriefing({ revenue = {}, members = {}, attention = [] } = {}) {
  const delta = pct(revenue.deltaPct)
  const opener = revenue.deltaPct != null && revenue.deltaPct < 0 ? 'Mixed month so far' : 'Solid month so far'

  const revClause = delta
    ? `${euro(revenue.totalCents)} MTD (${delta})`
    : `${euro(revenue.totalCents)} MTD`

  const net = members.netChange
  const memClause = net != null && net !== 0
    ? `${members.count || 0} members (${net > 0 ? '+' : ''}${net})`
    : `${members.count || 0} members`

  const watch = (attention || []).slice(0, 3).map(a => a.label).filter(Boolean)
  const closer = watch.length ? `Watch: ${watch.join(', ')}.` : 'Nothing urgent.'

  return `${opener}: ${revClause}, ${memClause}. ${closer}`
}
```

- [ ] **Step 4:** Run the test again — expect 5/5 PASS.
- [ ] **Step 5:** `git add shared/business-briefing.js shared/business-briefing.test.js && git commit -m "DASH-REBUILD.1 — deterministic business briefing sentence (shared, tested)"`

---

### Task D2: Metric shaping helpers (`shared/dashboard-metrics.js`)

**Files:** Create `shared/dashboard-metrics.js` · Test `shared/dashboard-metrics.test.js`

- [ ] **Step 1: failing test**

```javascript
// shared/dashboard-metrics.test.js
import { describe, it, expect } from 'vitest'
import { pctDelta, sumCampaignRows, shapeFunnel, FUNNEL_SLUGS } from './dashboard-metrics.js'

describe('pctDelta', () => {
  it('computes percent change', () => { expect(pctDelta(110, 100)).toBeCloseTo(10) })
  it('null when previous is 0 or missing', () => {
    expect(pctDelta(50, 0)).toBe(null)
    expect(pctDelta(50, null)).toBe(null)
  })
})

describe('sumCampaignRows', () => {
  const rows = [
    { level: 'campaign', spend: '10.50', results: 3 },
    { level: 'campaign', spend: '4.50', results: 1 },
    { level: 'ad', spend: '99', results: 99 },
  ]
  it('sums spend and results at campaign level only', () => {
    expect(sumCampaignRows(rows)).toEqual({ spend: 15, results: 4 })
  })
  it('handles empty input', () => {
    expect(sumCampaignRows([])).toEqual({ spend: 0, results: 0 })
  })
})

describe('shapeFunnel', () => {
  it('orders counts by the canonical slug order and computes conversion', () => {
    const shaped = shapeFunnel(
      { new_lead: 30, first_class: 12, second_class: 8, trial_done: 6, converted: 5 },
      { entered: 61, converted: 10 },
    )
    expect(shaped.stages.map(s => s.slug)).toEqual([...FUNNEL_SLUGS])
    expect(shaped.stages[0].count).toBe(30)
    expect(shaped.conversionPct).toBe(16)
  })
  it('null conversion when nothing entered', () => {
    expect(shapeFunnel({}, { entered: 0, converted: 0 }).conversionPct).toBe(null)
  })
})
```

- [ ] **Step 2:** `npx vitest run shared/dashboard-metrics.test.js --pool=threads` — FAIL.

- [ ] **Step 3: implementation**

```javascript
// shared/dashboard-metrics.js
//
// DASH-REBUILD — pure shaping helpers for the Business dashboard
// blocks. No DB, no platform imports.

export const FUNNEL_SLUGS = Object.freeze([
  'new_lead', 'first_class', 'second_class', 'trial_done', 'converted',
])

export function pctDelta(current, previous) {
  if (!previous || previous <= 0) return null
  return ((current - previous) / previous) * 100
}

// ad_insights_daily stores campaign AND adset AND ad rows for the same
// day — summing without a level filter triple-counts spend.
export function sumCampaignRows(rows = []) {
  let spend = 0
  let results = 0
  for (const r of rows) {
    if (r.level !== 'campaign') continue
    spend += Number(r.spend) || 0
    results += Number(r.results) || 0
  }
  return { spend, results }
}

export function shapeFunnel(countsBySlug = {}, month = { entered: 0, converted: 0 }) {
  const stages = FUNNEL_SLUGS.map(slug => ({ slug, count: countsBySlug[slug] || 0 }))
  const conversionPct = month.entered > 0
    ? Math.round((month.converted / month.entered) * 100)
    : null
  return { stages, entered: month.entered || 0, converted: month.converted || 0, conversionPct }
}
```

- [ ] **Step 4:** Run the test — PASS.
- [ ] **Step 5:** `git add shared/dashboard-metrics.js shared/dashboard-metrics.test.js && git commit -m "DASH-REBUILD.2 — pure metric shaping helpers (funnel, ads level guard, deltas)"`

---

### Task D3: Block fetchers in `shared/dashboard-data.js`

**Files:** Modify `shared/dashboard-data.js` (append after `fetchBusinessDashboardData`, ~line 560; REUSE the file's existing `isoDate`, `startOfMonth`, `startOfWeek`, `endOfWeek`, `fetchDashboardShifts`, `shiftDurationHours`, `hourlyRateFor` — read them first).

- [ ] **Step 1:** Read the file top-to-bottom once (exports, helpers, house query style — `{ success, data } | { success:false, error }` return shape).

- [ ] **Step 2: append the fetchers** (adapt table/column names ONLY if a read of the cited migrations contradicts them — then report the divergence):

```javascript
// ---------------------------------------------------------------------------
// DASH-REBUILD — Business dashboard block fetchers. Each is independently
// callable so the page can stream blocks and mobile can adopt them later.
// Sums paginate (1k-row select cap); counts use head:true single aggregates.

import { pctDelta, sumCampaignRows, shapeFunnel, FUNNEL_SLUGS } from './dashboard-metrics.js'

async function paginatedSumCents(supabase, filters) {
  // filters: fn(query) → query. Sums amount_cents over all matching rows.
  let from = 0
  const page = 1000
  let total = 0
  let count = 0
  for (;;) {
    let q = supabase.from('glofox_invoices').select('amount_cents').order('id', { ascending: true }).range(from, from + page - 1)
    q = filters(q)
    const { data, error } = await q
    if (error) return { error }
    for (const r of data || []) total += r.amount_cents || 0
    count += (data || []).length
    if (!data || data.length < page) break
    from += page
  }
  return { totalCents: total, rows: count }
}

// Revenue MTD from PAID invoices only (glofox_invoices is stale for
// anything else — mig 324's daily reconcile keeps statuses honest).
// Delta compares against the same day-window of last month.
export async function fetchRevenueMTD(supabase, locationId, now = new Date()) {
  const monthStart = startOfMonth(now)
  const lastMonthStart = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1))
  const lastMonthSameDay = new Date(lastMonthStart)
  lastMonthSameDay.setDate(lastMonthSameDay.getDate() + (now.getDate() - 1))
  lastMonthSameDay.setHours(23, 59, 59, 999)

  const cur = await paginatedSumCents(supabase, q => q
    .eq('location_id', locationId).eq('status', 'PAID')
    .gte('invoice_date', monthStart.toISOString()))
  if (cur.error) return { success: false, error: cur.error.message }

  const prev = await paginatedSumCents(supabase, q => q
    .eq('location_id', locationId).eq('status', 'PAID')
    .gte('invoice_date', lastMonthStart.toISOString())
    .lte('invoice_date', lastMonthSameDay.toISOString()))
  if (prev.error) return { success: false, error: prev.error.message }

  return {
    success: true,
    data: {
      totalCents: cur.totalCents,
      paidCount: cur.rows,
      deltaPct: pctDelta(cur.totalCents, prev.totalCents),
    },
  }
}

// Arrears = PAST_DUE rows as of the last daily reconcile (mig 324) —
// never derived from raw invoice math.
export async function fetchArrearsSummary(supabase, locationId) {
  let from = 0
  const page = 1000
  let totalCents = 0
  const contacts = new Set()
  for (;;) {
    const { data, error } = await supabase.from('glofox_invoices')
      .select('amount_cents, contact_id')
      .eq('location_id', locationId).eq('status', 'PAST_DUE')
      .order('id', { ascending: true }).range(from, from + page - 1)
    if (error) return { success: false, error: error.message }
    for (const r of data || []) {
      totalCents += r.amount_cents || 0
      if (r.contact_id) contacts.add(r.contact_id)
    }
    if (!data || data.length < page) break
    from += page
  }
  return { success: true, data: { totalCents, memberCount: contacts.size } }
}

// Current funnel stage counts + this-month entered/converted.
// entered uses joined_at (lead_created_at is import-poisoned);
// conversions use converted_at (mig 350).
export async function fetchFunnelCounts(supabase, locationId, now = new Date()) {
  const monthStartIso = startOfMonth(now).toISOString()
  const stageCounts = {}
  for (const slug of FUNNEL_SLUGS) {
    const { count, error } = await supabase.from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId).eq('pipeline_stage_slug', slug)
    if (error) return { success: false, error: error.message }
    stageCounts[slug] = count || 0
  }
  const { count: entered, error: e1 } = await supabase.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId).gte('joined_at', monthStartIso)
  if (e1) return { success: false, error: e1.message }
  const { count: converted, error: e2 } = await supabase.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId).gte('converted_at', monthStartIso)
  if (e2) return { success: false, error: e2.message }
  return { success: true, data: shapeFunnel(stageCounts, { entered: entered || 0, converted: converted || 0 }) }
}

// Last-7-days ad performance. level='campaign' only (see dashboard-metrics).
export async function fetchAdsSummary(supabase, locationId, now = new Date()) {
  const since = new Date(now); since.setDate(since.getDate() - 7)
  const sinceIso = isoDate(since)
  const { data, error } = await supabase.from('ad_insights_daily')
    .select('level, spend, results')
    .eq('location_id', locationId).gte('date', sinceIso)
    .limit(1000)
  if (error) return { success: false, error: error.message }
  const { spend, results } = sumCampaignRows(data || [])
  const { count: attributed, error: e2 } = await supabase.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .not('ad_provider', 'is', null)
    .gte('attributed_at', since.toISOString())
  if (e2) return { success: false, error: e2.message }
  return {
    success: true,
    data: {
      spend, results,
      costPerResult: results > 0 ? spend / results : null,
      attributedContacts: attributed || 0,
    },
  }
}

// Today's operations strip. Labour reuses the existing week window.
export async function fetchTodayOps(supabase, locationId, now = new Date()) {
  const todayIso = isoDate(now)
  const { count: bookedToday, error: e1 } = await supabase.from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId).eq('booking_date', todayIso)
    .neq('status', 'cancelled')
  if (e1) return { success: false, error: e1.message }

  const { count: classesToday, error: e2 } = await supabase.from('class_occurrences')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId).eq('class_date', todayIso)
  if (e2) return { success: false, error: e2.message }

  const { data: blocks, error: e3 } = await supabase.from('shift_blocks')
    .select('id, shift_assignments(profile_id)')
    .eq('location_id', locationId).eq('block_date', todayIso)
    .limit(200)
  if (e3) return { success: false, error: e3.message }
  const staffToday = new Set()
  for (const b of blocks || []) for (const a of b.shift_assignments || []) if (a.profile_id) staffToday.add(a.profile_id)

  const weekStart = startOfWeek(now)
  const weekEnd = endOfWeek(now)
  const { data: weekShifts, error: e4 } = await fetchDashboardShifts(supabase, {
    locationId, startDate: isoDate(weekStart), endDate: isoDate(weekEnd), withProfiles: true,
  })
  if (e4) return { success: false, error: e4.message }
  let labourCents = 0
  let hours = 0
  for (const s of weekShifts || []) {
    const h = shiftDurationHours(s)
    hours += h
    labourCents += Math.round(h * (hourlyRateFor(s.profiles) || 0) * 100)
  }

  return {
    success: true,
    data: {
      bookedToday: bookedToday || 0,
      classesToday: classesToday || 0,
      staffToday: staffToday.size,
      labourWeekCents: labourCents,
      hoursWeek: Math.round(hours),
    },
  }
}
```

IMPORTANT adaptations to verify by reading before committing (report each in your task report):
1. `class_occurrences` date column — read the mig that created it (`grep -l class_occurrences supabase/migrations/*.sql`); the code above assumes `class_date`. Use the real column; also confirm cancelled occurrences carry `cancelled_at` (mig 344) and exclude them: `.is('cancelled_at', null)` if the column exists.
2. `bookings.status` values — grep how other code excludes cancelled bookings (`grep -rn "eq('booking_date'" src/lib src/app | head`) and mirror the exact status filter used there.
3. `fetchDashboardShifts` return contract (`{ data, error }`) and the profiles embed key (`s.profiles`) — mirror `fetchBusinessDashboardData`'s own usage a few lines above.
4. Module import placement: `shared/dashboard-data.js` may already import from sibling files — put the new `import` at the top with the existing ones.

- [ ] **Step 3:** `npm run lint` then `npx vitest run shared/ --pool=threads` (all existing shared tests must stay green) then `npm run check:mobile-imports`.
- [ ] **Step 4:** `git add shared/dashboard-data.js && git commit -m "DASH-REBUILD.3 — block fetchers: revenue MTD, arrears, funnel, ads, today ops"`

---

### Task D4: Needs-you rail assembler (`src/lib/dashboard/business-rail.js`)

**Files:** Create `src/lib/dashboard/business-rail.js`. Read first: `src/lib/approvals/registry.js` (`getPendingApprovalsCount(db, user)`), `src/lib/churn-radar-data.js` (`churn_radar_snapshots` usage), `src/lib/dublin-time.js` (`dublinTodayStr`), and how `lead_radar_actions` rows record contact actions (`grep -rn "lead_radar_actions" src/lib | head`).

- [ ] **Step 1: implementation**

```javascript
// src/lib/dashboard/business-rail.js
//
// DASH-REBUILD — assembles the Business dashboard "Needs you" rail.
// Fixed category order: approvals, failed, arrears, churn, leads.
// Categories with zero items are omitted. Web-only (imports the
// approvals registry + radar snapshots), so it lives in src/lib, not
// shared/. Every row: { key, chip, tone, text, href }.
// tone ∈ 'purple' | 'red' | 'amber' | 'teal' — mapped to chip classes
// in the component, not here.

import { getPendingApprovalsCount } from '@/lib/approvals/registry'
import { fetchArrearsSummary } from '@shared/dashboard-data'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export async function buildNeedsYouRail(db, user, locationId, now = new Date()) {
  const rows = []

  // 1. Pending approvals — registry total across visible providers.
  try {
    const count = await getPendingApprovalsCount(db, user)
    if (count > 0) {
      rows.push({
        key: 'approvals', chip: 'Approval', tone: 'purple',
        text: `${count} pending approval${count === 1 ? '' : 's'}`,
        href: '/approvals',
      })
    }
  } catch { /* row omitted on failure */ }

  // 2. Failed agent executions, last 7 days. No dismiss in v1 — rows
  // age out of the window (spec).
  try {
    const sinceIso = new Date(now.getTime() - WEEK_MS).toISOString()
    const { data } = await db.from('agent_membership_requests')
      .select('id, kind, conversation_id, channel, contacts(first_name, name)')
      .eq('location_id', locationId).eq('status', 'failed')
      .gte('decided_at', sinceIso)
      .order('decided_at', { ascending: false }).limit(20)
    if (data && data.length) {
      const first = data[0]
      const who = first.contacts?.first_name || first.contacts?.name || 'a member'
      const more = data.length > 1 ? ` (+${data.length - 1} more)` : ''
      const href = first.conversation_id
        ? `/communications/inbox?c=${first.conversation_id}&ch=${first.channel === 'instagram' ? 'ig' : 'wa'}`
        : '/settings/customer-agent/requests'
      rows.push({
        key: 'failed', chip: 'Failed', tone: 'red',
        text: `Glofox action failed for ${who}${more}`,
        href,
      })
    }
  } catch { /* omitted */ }

  // 3. Arrears — same source as the KPI card (PAST_DUE post-reconcile).
  try {
    const res = await fetchArrearsSummary(db, locationId)
    if (res.success && res.data.memberCount > 0) {
      rows.push({
        key: 'arrears', chip: 'Arrears', tone: 'amber',
        text: `${res.data.memberCount} member${res.data.memberCount === 1 ? '' : 's'} — €${Math.round(res.data.totalCents / 100).toLocaleString('en-IE')} owed`,
        href: '/dashboard/churn-radar',
      })
    }
  } catch { /* omitted */ }

  // 4. Churn — latest snapshot count (cheap; the KPI card carries the
  // live radar number, this row is the pointer).
  try {
    const { data } = await db.from('churn_radar_snapshots')
      .select('high_risk, captured_at')
      .eq('location_id', locationId)
      .order('captured_at', { ascending: false }).limit(1)
    const hi = data?.[0]?.high_risk || 0
    if (hi > 0) {
      rows.push({
        key: 'churn', chip: 'Churn', tone: 'amber',
        text: `${hi} member${hi === 1 ? '' : 's'} at high risk`,
        href: '/dashboard/churn-radar',
      })
    }
  } catch { /* omitted */ }

  // 5. Uncontacted new leads older than 24h: still in new_lead, joined
  // >24h ago, no contacted/outreach action recorded.
  try {
    const cutoffIso = new Date(now.getTime() - DAY_MS).toISOString()
    const { data: leads } = await db.from('contacts')
      .select('id')
      .eq('location_id', locationId).eq('pipeline_stage_slug', 'new_lead')
      .lte('joined_at', cutoffIso)
      .limit(100)
    const ids = (leads || []).map(l => l.id)
    let uncontacted = ids.length
    if (ids.length) {
      const { data: actions } = await db.from('lead_radar_actions')
        .select('contact_id')
        .in('contact_id', ids)
        .in('action', ['contacted', 'outreach_sent'])
        .limit(1000)
      const touched = new Set((actions || []).map(a => a.contact_id))
      uncontacted = ids.filter(id => !touched.has(id)).length
    }
    if (uncontacted > 0) {
      rows.push({
        key: 'leads', chip: 'Leads', tone: 'teal',
        text: `${uncontacted} lead${uncontacted === 1 ? '' : 's'} uncontacted > 24h`,
        href: '/dashboard/lead-radar',
      })
    }
  } catch { /* omitted */ }

  return rows
}
```

Verify while implementing (report divergences): `lead_radar_actions` column names + action values (mirror what lead-radar code writes); `churn_radar_snapshots.high_risk` column (mig 198); the approvals hub route (`/approvals` — confirm it exists as a page). Adjust hrefs/filters to reality.

- [ ] **Step 2:** `npm run lint` — clean on the new file.
- [ ] **Step 3:** `git add src/lib/dashboard/business-rail.js && git commit -m "DASH-REBUILD.4 — Needs-you rail assembler (approvals, failed, arrears, churn, leads)"`

---

### Task D5: Presentational components (`src/components/dashboard/BusinessBlocks.jsx`)

**Files:** Create `src/components/dashboard/BusinessBlocks.jsx`. Read first: `src/components/dashboard/Cards.jsx` (KpiCard/KpiRow/SectionHeader/formatCurrency/formatPercent) and one existing page using `un1t-*` tokens for spacing idiom.

- [ ] **Step 1: implementation** (server-safe — no 'use client', no hooks; pure render):

```jsx
// src/components/dashboard/BusinessBlocks.jsx
//
// DASH-REBUILD — presentational pieces for the rebuilt Business
// dashboard. Server-component-safe (no state). Data shapes come from
// shared/dashboard-data.js fetchers + src/lib/dashboard/business-rail.
import Link from 'next/link'

export function BriefingLine({ text }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3 text-sm text-un1t-text mb-4">
      {text}
    </div>
  )
}

export function FunnelMini({ funnel }) {
  const max = Math.max(1, ...funnel.stages.map(s => s.count))
  const LABELS = { new_lead: 'New', first_class: '1st', second_class: '2nd', trial_done: 'Trial', converted: 'Won' }
  return (
    <div>
      <div className="flex items-end gap-1.5 h-20">
        {funnel.stages.map(s => (
          <div key={s.slug} className="flex-1 flex flex-col justify-end items-center gap-1">
            <span className="text-[10px] text-un1t-muted">{s.count}</span>
            <div
              className="w-full rounded-t bg-purple-500/60"
              style={{ height: `${Math.max(6, (s.count / max) * 60)}px` }}
            />
            <span className="text-[10px] text-un1t-subtle">{LABELS[s.slug] || s.slug}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-un1t-muted mt-2">
        {funnel.entered} entered this month → {funnel.converted} converted
        {funnel.conversionPct != null ? ` · ${funnel.conversionPct}%` : ''}
      </p>
    </div>
  )
}

export function AdsSummaryPanel({ ads }) {
  return (
    <div>
      <p className="text-lg font-semibold text-un1t-text">
        €{Math.round(ads.spend).toLocaleString('en-IE')} spend · {ads.results} results
      </p>
      <p className="text-xs text-un1t-muted mt-1">
        {ads.costPerResult != null ? `€${ads.costPerResult.toFixed(2)} per result` : 'no results yet'}
        {' · '}{ads.attributedContacts} contact{ads.attributedContacts === 1 ? '' : 's'} attributed (7d)
      </p>
      <Link href="/dashboard/ads" className="text-xs text-un1t-muted underline hover:text-un1t-text mt-2 inline-block">
        Full ads report
      </Link>
    </div>
  )
}

export function TodayStrip({ ops, locationName }) {
  const items = [
    [String(ops.bookedToday), `booked · ${ops.classesToday} classes`],
    [String(ops.staffToday), 'staff on'],
    [`€${Math.round(ops.labourWeekCents / 100).toLocaleString('en-IE')}`, `labour this week · ${ops.hoursWeek}h`],
  ]
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1">
      <span className="text-xs text-un1t-muted">Today{locationName ? ` at ${locationName}` : ''}</span>
      {items.map(([v, label]) => (
        <span key={label} className="text-sm text-un1t-text">
          <span className="font-semibold">{v}</span>{' '}
          <span className="text-un1t-subtle">{label}</span>
        </span>
      ))}
    </div>
  )
}

const RAIL_TONES = {
  purple: 'bg-purple-500/10 text-purple-700',
  red: 'bg-red-500/10 text-red-700',
  amber: 'bg-amber-500/10 text-amber-700',
  teal: 'bg-teal-500/10 text-teal-700',
}

export function NeedsYouRail({ rows }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg px-3 py-3">
      <p className="text-xs font-semibold text-un1t-muted mb-1">
        Needs you{rows.length ? ` · ${rows.length}` : ''}
      </p>
      {rows.length === 0 && (
        <p className="text-sm text-un1t-subtle py-2">Nothing waiting on you.</p>
      )}
      {rows.map(row => (
        <Link
          key={row.key}
          href={row.href}
          className="flex items-start gap-2 border-t border-un1t-border/50 py-2 text-sm text-un1t-text hover:bg-un1t-border/10 -mx-1 px-1 rounded"
        >
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 mt-0.5 ${RAIL_TONES[row.tone] || RAIL_TONES.purple}`}>
            {row.chip}
          </span>
          <span>{row.text}</span>
        </Link>
      ))}
    </div>
  )
}

export function BlockSkeleton({ lines = 3 }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3 animate-pulse">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-3 bg-un1t-border/40 rounded my-2" style={{ width: `${80 - i * 15}%` }} />
      ))}
    </div>
  )
}

export function BlockError({ label }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3">
      <p className="text-xs text-un1t-muted">{label} couldn&apos;t load — refresh to retry.</p>
    </div>
  )
}
```

- [ ] **Step 2:** `npm run lint` then `npm run check:guardrails` (chip tones must pass `no-low-contrast-chip`).
- [ ] **Step 3:** `git add src/components/dashboard/BusinessBlocks.jsx && git commit -m "DASH-REBUILD.5 — Business dashboard presentational blocks"`

---

### Task D6: Page rewrite with Suspense streaming

**Files:** Rewrite `src/app/dashboard/business/page.js` (full replacement of the render; keep auth lines). Read first: the current page (what you're replacing), `src/lib/membership-snapshot.js` (`computeMembershipCounts`, `fetchMembershipTrend`), `src/lib/churn-radar-data.js` (`loadRadar` — return shape `{ summary: { highRiskCount } }`), `src/components/dashboard/MembershipPanel.jsx` props.

- [ ] **Step 1: implementation**

```jsx
// /dashboard/business — DASH-REBUILD command centre. Each block is an
// async server component in its own Suspense boundary: the shell paints
// immediately, blocks stream as their live queries settle, and one
// failing block renders a compact error cell instead of blanking the
// page (the old all-or-nothing fetch is gone). All-live by design
// (Richard, 2026-07-04) — streaming is the perf counterweight.
import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import {
  fetchRevenueMTD, fetchArrearsSummary, fetchFunnelCounts, fetchAdsSummary, fetchTodayOps,
} from '@shared/dashboard-data'
import { buildBusinessBriefing } from '@shared/business-briefing'
import { buildNeedsYouRail } from '@/lib/dashboard/business-rail'
import { computeMembershipCounts, fetchMembershipTrend } from '@/lib/membership-snapshot'
import { loadRadar } from '@/lib/churn-radar-data'
import { KpiCard, KpiRow, SectionHeader, formatCurrency } from '@/components/dashboard/Cards'
import { MembershipPanel } from '@/components/dashboard/MembershipPanel'
import {
  BriefingLine, FunnelMini, AdsSummaryPanel, TodayStrip, NeedsYouRail, BlockSkeleton, BlockError,
} from '@/components/dashboard/BusinessBlocks'

export const dynamic = 'force-dynamic'

async function KpiBriefingBlock({ user, locationId }) {
  const db = createServerClient()
  try {
    const [revenue, arrears, membershipLive, radar, rail] = await Promise.all([
      fetchRevenueMTD(db, locationId),
      fetchArrearsSummary(db, locationId),
      computeMembershipCounts(db, locationId),
      loadRadar(db, locationId).catch(() => null),
      buildNeedsYouRail(db, user, locationId),
    ])
    if (!revenue.success) throw new Error(revenue.error)
    const arrearsData = arrears.success ? arrears.data : { totalCents: 0, memberCount: 0 }
    const memberCount = membershipLive?.active_recurring ?? membershipLive?.monthly_recurring ?? 0
    const churnCount = radar?.summary?.highRiskCount ?? null

    const briefing = buildBusinessBriefing({
      revenue: { totalCents: revenue.data.totalCents, deltaPct: revenue.data.deltaPct },
      members: { count: memberCount, netChange: null },
      attention: rail.map(r => ({ label: r.text })),
    })

    return (
      <>
        <BriefingLine text={briefing} />
        <KpiRow>
          <KpiCard label="Revenue MTD" value={formatCurrency(revenue.data.totalCents / 100)}
            sublabel={revenue.data.deltaPct != null ? `${revenue.data.deltaPct >= 0 ? '+' : ''}${Math.round(revenue.data.deltaPct)}% vs last month` : `${revenue.data.paidCount} payments`} />
          <KpiCard label="Members" value={memberCount} sublabel="active recurring" href="/contacts" />
          <KpiCard label="Churn risk" value={churnCount ?? '—'}
            sublabel={churnCount != null ? 'high-risk members' : 'radar unavailable'}
            accent={churnCount ? 'text-amber-700' : undefined} href="/dashboard/churn-radar" />
          <KpiCard label="In arrears" value={formatCurrency(arrearsData.totalCents / 100)}
            sublabel={`${arrearsData.memberCount} member${arrearsData.memberCount === 1 ? '' : 's'}`}
            accent={arrearsData.memberCount > 0 ? 'text-red-700' : undefined} href="/dashboard/churn-radar" />
        </KpiRow>
      </>
    )
  } catch {
    return <BlockError label="Headline numbers" />
  }
}

async function FunnelAdsBlock({ locationId }) {
  const db = createServerClient()
  try {
    const [funnel, ads] = await Promise.all([
      fetchFunnelCounts(db, locationId),
      fetchAdsSummary(db, locationId),
    ])
    return (
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3">
          <p className="text-xs text-un1t-muted mb-2">Acquisition funnel · this month</p>
          {funnel.success ? <FunnelMini funnel={funnel.data} /> : <BlockError label="Funnel" />}
        </div>
        <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3">
          <p className="text-xs text-un1t-muted mb-2">Ads · last 7 days</p>
          {ads.success ? <AdsSummaryPanel ads={ads.data} /> : <BlockError label="Ads" />}
        </div>
      </div>
    )
  } catch {
    return <BlockError label="Funnel and ads" />
  }
}

async function MembershipBlock({ locationId }) {
  const db = createServerClient()
  try {
    const [live, trend] = await Promise.all([
      computeMembershipCounts(db, locationId),
      fetchMembershipTrend(db, locationId, 12),
    ])
    if (!live) return null
    return <MembershipPanel live={live} trend={trend} />
  } catch {
    return <BlockError label="Membership trend" />
  }
}

async function TodayBlock({ locationId, locationName }) {
  const db = createServerClient()
  try {
    const ops = await fetchTodayOps(db, locationId)
    if (!ops.success) throw new Error(ops.error)
    return <TodayStrip ops={ops.data} locationName={locationName} />
  } catch {
    return <BlockError label="Today's operations" />
  }
}

async function RailBlock({ user, locationId }) {
  const db = createServerClient()
  try {
    const rows = await buildNeedsYouRail(db, user, locationId)
    return <NeedsYouRail rows={rows} />
  } catch {
    return <BlockError label="Needs you" />
  }
}

export default async function BusinessDashboardPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'dashboard_business')) redirect('/dashboard')
  const locationId = user.activeLocation?.id
  const locationName = user.activeLocation?.name

  return (
    <>
      <Suspense fallback={<BlockSkeleton lines={4} />}>
        <KpiBriefingBlock user={user} locationId={locationId} />
      </Suspense>
      <div className="grid xl:grid-cols-3 gap-4 mt-4">
        <div className="xl:col-span-2 space-y-4">
          <Suspense fallback={<BlockSkeleton lines={4} />}>
            <FunnelAdsBlock locationId={locationId} />
          </Suspense>
          <Suspense fallback={<BlockSkeleton lines={5} />}>
            <MembershipBlock locationId={locationId} />
          </Suspense>
          <Suspense fallback={<BlockSkeleton lines={2} />}>
            <TodayBlock locationId={locationId} locationName={locationName} />
          </Suspense>
        </div>
        <div className="xl:order-none order-first">
          <Suspense fallback={<BlockSkeleton lines={6} />}>
            <RailBlock user={user} locationId={locationId} />
          </Suspense>
        </div>
      </div>
    </>
  )
}
```

Verify while implementing (report divergences): `computeMembershipCounts` return keys (the member-count line — mirror what `MembershipPanel` reads); `loadRadar(db, locationId)` exact signature (explorer noted `(db, locationId, nowMs)`); `KpiCard` value prop accepts numbers/strings; `formatCurrency` expects euros not cents (read it — adjust the `/100`s to match). NOTE the deliberate spec deviations to keep: KPI briefing derives `netChange: null` in v1 (members net-change needs a snapshot diff — dropped from the sentence rather than shipping a wrong number; the KPI sublabel says "active recurring"); the rail renders order-first on small screens via `order-first`.

- [ ] **Step 2:** `npm run lint` → `npm run check:guardrails` → `npm run build` (one at a time; build is mandatory — new imports).
- [ ] **Step 3:** `git add 'src/app/dashboard/business/page.js' && git commit -m "DASH-REBUILD.6 — streamed command-centre Business dashboard"`

---

### Task D7: CI mirror, changelog, PR

- [ ] **Step 1:** Full CI mirror + build, ONE command at a time: `npm test` → `npm run lint` → `npm run check:mobile-parity` → `npm run check:mobile-imports` → `npm run check:route-guards` → `npm run check:guardrails` → `npm run build`. Any failure → STOP and report BLOCKED.
- [ ] **Step 2:** Append the next-numbered entry to `docs/CHANGELOG.md` (read its tail for format): Business dashboard rebuilt as a streamed command centre — briefing line, KPI 4-up (revenue MTD from PAID invoices, members, live churn radar, post-reconcile arrears), funnel + ads + membership-trend + today's-ops blocks, "Needs you" rail (approvals, failed agent executions — resolving where 'failed' surfaces — arrears, churn, stale leads); per-block Suspense isolation; deal KPIs retired to /pipeline. Commit `DASH-REBUILD.7 — changelog entry`.
- [ ] **Step 3:** `git push -u origin HEAD` then `gh pr create --base main` titled "DASH-REBUILD — Business dashboard command centre" with a body covering: spec + plan paths; all-live + streaming rationale; data-honesty rules applied (PAID-only revenue, post-reconcile arrears, joined_at funnel, campaign-level ads); failed-execution surfacing decision; what was removed (deal KPIs, old all-or-nothing fetch); no migration; manual smoke items (open /dashboard/business as owner, watch blocks stream, click every deep link, confirm one block failing doesn't blank the page). Do NOT merge.

---

## Deployment / verification (orchestrator)

No migration. After merge: manual smoke on prod per the PR body; watch Vercel Speed Insights for the page (the PERF.1 redirect work already fixed the route chain — block streaming should keep FCP flat).

## Known non-goals (v1)

Members net-change in the briefing (needs snapshot-diff plumbing — follow-up); churn "new this week" delta (same); mobile adoption of new blocks; block customisation; realtime refresh.
