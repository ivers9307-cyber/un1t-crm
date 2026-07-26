# BATHROOM-CLIMATE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second automations-hub automation (`bathroom_climate`) that turns the bathroom AC units ON 45 minutes after each Glofox class starts and OFF on a 30-minute timer, configured independently of the gym floor's `class_climate` automation.

**Architecture:** Clone the proven class-climate three-layer shape — pure planner lib → IO runner → cron route — with different timing semantics (delayed start relative to class *start*; class end irrelevant). Reuse `slotKey`/`classMatchesFilter` from `@/lib/class-climate`, the `ac-devices` vendor dispatcher, `ac_sessions` + the existing `ac-auto-off` cron for the OFF, and `automation_fire_log` (keyed by `automation_key`) for idempotency. New card on `/automations`; generic `[key]` routes get the new key allow-listed.

**Tech Stack:** Next.js 16 App Router (JS, no TS), Supabase service-role client, Vitest (mocked, no DB), Vercel cron.

**Spec:** `docs/superpowers/specs/2026-07-26-bathroom-climate-design.md`
**Worktree/branch:** `/Users/richardivers/code/un1t-crm-bathroom-climate`, branch `bathroom-climate` (already created off fresh `origin/main`; spec committed as `BATHROOM-CLIMATE.0`).

**Repo invariants that bite here** (from `CLAUDE.md` — the executor must respect these):
- Every cron needs: Bearer `CRON_SECRET` auth, a `vercel.json` entry, a `cron_heartbeats` row in a migration, and `stampHeartbeat()` on success.
- Migrations are forward-only, applied via Supabase MCP against project `iyvtbjjxdggiadzwwvdj` at ship time (NOT by the executor mid-task) — `get_advisors` (security) after applying.
- Audit events: never put a device UUID in `target.id` (FK → profiles); device identity rides in `target.resource`.
- supabase-js builders are thenables (no `.catch`; always `await` inserts/updates).
- Every non-submit `<button>` inside the card gets `type="button"`.
- CI mirror before pushing: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`, plus `npm run build` locally (new route + imports).

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/bathroom-climate.js` | Create | Pure planner: config resolve, window maths, auto-off anchor. No DB/vendor imports. |
| `src/lib/bathroom-climate.test.js` | Create | Table tests for the planner. |
| `src/lib/bathroom-climate-runner.js` | Create | IO runtime shared by cron + run-now. |
| `src/lib/bathroom-climate-runner.test.js` | Create | Runner tests on the in-memory Supabase fake. |
| `src/app/api/cron/bathroom-climate/route.js` | Create | 5-min Vercel cron. |
| `supabase/migrations/447_bathroom_climate.sql` | Create | `cron_heartbeats` row (verify 447 still free at PR time). |
| `vercel.json` | Modify (~line 143) | Cron entry. |
| `src/lib/automations/registry.js` | Modify | New definition + status branch. |
| `src/app/api/automations/[key]/run-now/route.js` | Modify | Runner dispatch by key. |
| `src/app/api/automations/[key]/schedule/route.js` | Modify (~line 23) | Extend key allowlist. |
| `src/components/automations/BathroomClimateCard.jsx` | Create | Operator card. |
| `src/app/automations/page.js` | Modify | Load + render the new card. |
| `docs/CHANGELOG.md` | Modify | Done-log entry. |

Not touched: `src/lib/openapi.js` (the sibling class-climate cron/automation routes are not registered there today — stay consistent; the openapi backfill is a separately-tracked task), `ClassClimateCard.jsx`, anything under `mobile/` (web-only feature; no new `WEB_PERMISSIONS` key — the card reuses the existing automations-page gating exactly as the class card does).

---

### Task 1: Pure planner — `src/lib/bathroom-climate.js`

**Files:**
- Create: `src/lib/bathroom-climate.js`
- Test: `src/lib/bathroom-climate.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/bathroom-climate.test.js`:

```js
// BATHROOM-CLIMATE.1 — table tests for the pure bathroom-climate planner.
// Mirrors class-climate.test.js. All times UTC ISO; slot exclusion goes
// through the shared Dublin slotKey.

import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig, planBathroomClimate, autoOffAtFor } from './bathroom-climate.js'
import { slotKey } from './class-climate.js'

// A class starting 10:00 UTC. delay 45 + duration 30 → window 10:45–11:15 UTC.
const START = '2026-07-27T10:00:00.000Z'
const occ = (over = {}) => ({ glofox_event_id: 'ev1', name: 'DR1VE', starts_at: START, ends_at: '2026-07-27T10:50:00.000Z', ...over })
const CFG = resolveConfig({ device_ids: ['d1'], delay_after_start_min: 45, run_duration_min: 30 })
const at = (iso) => Date.parse(iso)

describe('resolveConfig', () => {
  it('applies defaults on empty/garbage input', () => {
    for (const input of [null, undefined, 'nope', 42, {}]) {
      const c = resolveConfig(input)
      expect(c.delay_after_start_min).toBe(DEFAULT_CONFIG.delay_after_start_min)
      expect(c.run_duration_min).toBe(DEFAULT_CONFIG.run_duration_min)
      expect(c.device_ids).toEqual([])
      expect(c.class_filter).toEqual([])
      expect(c.excluded_slots).toEqual([])
    }
  })
  it('coerces strings, floors delay at 0 and duration at 1', () => {
    const c = resolveConfig({ delay_after_start_min: '20', run_duration_min: '0' })
    expect(c.delay_after_start_min).toBe(20)
    expect(c.run_duration_min).toBe(1)
    expect(resolveConfig({ delay_after_start_min: -5 }).delay_after_start_min).toBe(0)
    expect(resolveConfig({ run_duration_min: -5 }).run_duration_min).toBe(1)
  })
  it('lowercases class_filter and drops falsy entries', () => {
    expect(resolveConfig({ class_filter: ['DR1VE', '', null] }).class_filter).toEqual(['dr1ve'])
  })
})

describe('planBathroomClimate window maths', () => {
  it.each([
    ['before window opens', '2026-07-27T10:44:00.000Z', 0],
    ['at window open (start+45)', '2026-07-27T10:45:00.000Z', 1],
    ['inside window', '2026-07-27T11:00:00.000Z', 1],
    ['at window close (start+75)', '2026-07-27T11:15:00.000Z', 1],
    ['after window closes', '2026-07-27T11:16:00.000Z', 0],
  ])('%s → %i planned', (_label, nowIso, count) => {
    const out = planBathroomClimate({ occurrences: [occ()], config: CFG, nowMs: at(nowIso) })
    expect(out).toHaveLength(count)
    if (count) expect(out[0].glofox_event_id).toBe('ev1')
  })

  it('ignores ends_at entirely — a 20-min class still fires at start+45', () => {
    const short = occ({ ends_at: '2026-07-27T10:20:00.000Z' })
    const out = planBathroomClimate({ occurrences: [short], config: CFG, nowMs: at('2026-07-27T10:50:00.000Z') })
    expect(out).toHaveLength(1)
  })

  it('drops occurrences with missing/bad starts_at or missing event id', () => {
    const bad = [occ({ starts_at: null }), occ({ starts_at: 'not-a-date' }), occ({ glofox_event_id: null })]
    expect(planBathroomClimate({ occurrences: bad, config: CFG, nowMs: at('2026-07-27T11:00:00.000Z') })).toEqual([])
  })

  it('respects class_filter (name-contains, case-insensitive)', () => {
    const cfg = resolveConfig({ ...CFG, class_filter: ['tempo'] })
    const now = at('2026-07-27T11:00:00.000Z')
    expect(planBathroomClimate({ occurrences: [occ()], config: cfg, nowMs: now })).toEqual([])
    expect(planBathroomClimate({ occurrences: [occ({ name: 'TEMPO 45' })], config: cfg, nowMs: now })).toHaveLength(1)
  })

  it('skips excluded weekly slots (keyed on class START, not on-time)', () => {
    const cfg = resolveConfig({ ...CFG, excluded_slots: [slotKey(START)] })
    expect(planBathroomClimate({ occurrences: [occ()], config: cfg, nowMs: at('2026-07-27T11:00:00.000Z') })).toEqual([])
  })
})

describe('autoOffAtFor', () => {
  it('anchors to the class schedule: start + delay + duration', () => {
    const iso = autoOffAtFor(occ(), CFG, at('2026-07-27T10:46:00.000Z'))
    expect(iso).toBe('2026-07-27T11:15:00.000Z')
  })
  it('a late cron tick still switches off at the same wall-clock time', () => {
    const iso = autoOffAtFor(occ(), CFG, at('2026-07-27T11:05:00.000Z'))
    expect(iso).toBe('2026-07-27T11:15:00.000Z')
  })
  it('never returns a past time (clamps to now + 60s)', () => {
    const now = at('2026-07-27T11:14:30.000Z')
    expect(Date.parse(autoOffAtFor(occ(), CFG, now))).toBe(now + 60_000)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/bathroom-climate.test.js`
Expected: FAIL — `Cannot find module './bathroom-climate.js'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `src/lib/bathroom-climate.js`:

```js
// BATHROOM-CLIMATE.1 — pure scheduling logic for the bathroom-climate
// automation. No DB / no vendor calls (safe to import from client
// components). The IO lives in bathroom-climate-runner.js.
//
// Timing model (deliberately different from class-climate): the bathroom
// units come on a fixed delay AFTER a class STARTS — when people hit the
// showers — and run on a fixed timer. Class END time is irrelevant.

import { slotKey, classMatchesFilter } from '@/lib/class-climate'

export const DEFAULT_CONFIG = Object.freeze({
  device_ids: [],
  delay_after_start_min: 45, // turn AC on this many minutes AFTER class start
  run_duration_min: 30,      // off timer — minutes from the scheduled on-time
  class_filter: [],          // [] = all classes; else only names containing one of these (case-insensitive)
  excluded_slots: [],        // recurring "<weekday> HH:MM" (Dublin) slots to skip, e.g. "Thu 06:00"
})

/**
 * Merge a stored config blob over the defaults, coercing types so a
 * hand-edited JSONB can't crash the runner. run_duration_min floors at 1 —
 * a 0-minute run would put auto_off_at at/before the on-time.
 */
export function resolveConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    device_ids: Array.isArray(c.device_ids) ? c.device_ids.filter(Boolean) : [],
    delay_after_start_min: Math.max(0, num(c.delay_after_start_min, DEFAULT_CONFIG.delay_after_start_min)),
    run_duration_min: Math.max(1, num(c.run_duration_min, DEFAULT_CONFIG.run_duration_min)),
    class_filter: Array.isArray(c.class_filter)
      ? c.class_filter.filter(Boolean).map((s) => String(s).toLowerCase())
      : [],
    excluded_slots: Array.isArray(c.excluded_slots)
      ? c.excluded_slots.filter(Boolean).map((s) => String(s))
      : [],
  }
}

/**
 * Pure: which classes should the bathroom AC be turned ON for right now?
 *
 * Window per occurrence: [start + delay, start + delay + duration]. Fire
 * when now is inside it AND the class passes the include-filter AND its
 * weekly slot isn't excluded. Both-sided check means a cron catching up
 * after downtime never blasts ONs for windows that already closed.
 *
 * The OFF is NOT planned here — the runner sets ac_sessions.auto_off_at
 * via autoOffAtFor and the existing ac-auto-off cron performs it.
 *
 * @param {{ occurrences: Array, config: object, nowMs?: number }} args
 * @returns {Array<{ glofox_event_id: string, occurrence: object }>}
 */
export function planBathroomClimate({ occurrences, config, nowMs = Date.now() }) {
  const excluded = new Set(config.excluded_slots || [])
  const out = []
  for (const occ of occurrences || []) {
    if (!occ?.glofox_event_id || !occ.starts_at) continue
    if (!classMatchesFilter(occ, config.class_filter)) continue
    if (excluded.has(slotKey(occ.starts_at))) continue
    const startMs = new Date(occ.starts_at).getTime()
    if (!Number.isFinite(startMs)) continue
    const windowOpen = startMs + config.delay_after_start_min * 60_000
    const windowClose = windowOpen + config.run_duration_min * 60_000
    if (nowMs >= windowOpen && nowMs <= windowClose) {
      out.push({ glofox_event_id: occ.glofox_event_id, occurrence: occ })
    }
  }
  return out
}

/**
 * Pure: auto_off_at anchored to the class schedule (start + delay +
 * duration) — a late cron tick still switches off at the same wall-clock
 * time. Never returns a past time (clamps to now + 60s).
 */
export function autoOffAtFor(occurrence, config, nowMs = Date.now()) {
  const startMs = new Date(occurrence.starts_at).getTime()
  const off = startMs + (config.delay_after_start_min + config.run_duration_min) * 60_000
  return new Date(Math.max(off, nowMs + 60_000)).toISOString()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/bathroom-climate.test.js`
Expected: PASS, all tests green. Also run the neighbour to prove nothing shared broke: `npx vitest run src/lib/class-climate.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bathroom-climate.js src/lib/bathroom-climate.test.js
git commit -m "BATHROOM-CLIMATE.1 — pure planner for the bathroom AC schedule

Window per class: [start + delay_after_start_min, + run_duration_min]
(defaults 45/30). auto_off_at anchored to the schedule, not the tick.
Reuses slotKey/classMatchesFilter from class-climate."
```

---

### Task 2: Runner — `src/lib/bathroom-climate-runner.js`

**Files:**
- Create: `src/lib/bathroom-climate-runner.js`
- Test: `src/lib/bathroom-climate-runner.test.js`
- Reference: `src/lib/class-climate-runner.js` (the template), `src/lib/class-climate-runner.test.js` (the `makeDb` in-memory Supabase fake lives at its top, between the `const LOC` line and the first `describe`)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/bathroom-climate-runner.test.js`. Copy the mock preamble and the entire `makeDb` helper **verbatim** from `src/lib/class-climate-runner.test.js` (the `vi.mock` blocks for `@/lib/log`, `@/lib/audit`, `@/lib/ac-devices`, plus the `makeDb` function — the `@/lib/glofox` mock and `syncOccurrencesForLocation` import are NOT needed here), then import the new runner and add these tests:

```js
import { runBathroomClimateForLocation } from './bathroom-climate-runner.js'
import { logAuditEvent } from '@/lib/audit'

const LOC = 'a0000000-0000-0000-0000-000000000001'
// Class starts 10:00Z; delay 45 → window 10:45–11:15Z. NOW is inside it.
const NOW = Date.parse('2026-07-27T10:50:00.000Z')
const OCC = {
  location_id: LOC, glofox_event_id: 'ev1', name: 'DR1VE',
  starts_at: '2026-07-27T10:00:00.000Z', ends_at: '2026-07-27T10:50:00.000Z', cancelled_at: null,
}
const ROW = { location_id: LOC, config: { device_ids: ['dev1'], delay_after_start_min: 45, run_duration_min: 30 } }

beforeEach(() => {
  vi.clearAllMocks()
  loadDeviceWithLocation.mockResolvedValue({
    ok: true,
    device: { id: 'dev1', label: 'Bathroom M', provider: 'thinq', provider_device_id: 'lg-1' },
    location: { id: LOC },
  })
  vendorTurnOn.mockResolvedValue({ ok: true, observed: { power: 'on' } })
})

describe('runBathroomClimateForLocation', () => {
  it('errors when no devices configured', async () => {
    const db = makeDb()
    const out = await runBathroomClimateForLocation(db, { location_id: LOC, config: {} }, { nowMs: NOW })
    expect(out.errors).toContain('no_devices_configured')
  })

  it('fires ON inside the window: vendor call + system ac_sessions row + fired log + audit', async () => {
    const db = makeDb({ class_occurrences: [OCC] })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW })
    expect(out.actions).toEqual([expect.objectContaining({ glofox_event_id: 'ev1', device_id: 'dev1', status: 'fired' })])
    expect(vendorTurnOn).toHaveBeenCalledTimes(1)
    const session = db.calls.inserts.find((c) => c.table === 'ac_sessions').rows
    expect(session.started_by).toBeNull()
    expect(session.device_id).toBe('dev1')
    // Anchored off: 10:00 + 45 + 30 = 11:15Z regardless of the 10:50 tick.
    expect(session.auto_off_at).toBe('2026-07-27T11:15:00.000Z')
    const fire = db.calls.upserts.find((c) => c.table === 'automation_fire_log').rows
    expect(fire.automation_key).toBe('bathroom_climate')
    expect(fire.status).toBe('fired')
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'ac.bathroom_auto_on' }))
  })

  it('does nothing before the window opens', async () => {
    const db = makeDb({ class_occurrences: [OCC] })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: Date.parse('2026-07-27T10:30:00.000Z') })
    expect(out.planned).toEqual([])
    expect(vendorTurnOn).not.toHaveBeenCalled()
  })

  it('skips a cancelled class (the .is cancelled_at filter)', async () => {
    const db = makeDb({ class_occurrences: [{ ...OCC, cancelled_at: '2026-07-27T08:00:00.000Z' }] })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW })
    expect(out.planned).toEqual([])
  })

  it('is idempotent — an existing fired log row blocks a re-fire', async () => {
    const db = makeDb({
      class_occurrences: [OCC],
      automation_fire_log: [{ automation_key: 'bathroom_climate', glofox_event_id: 'ev1', device_id: 'dev1', action_step: 'on', status: 'fired' }],
    })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW })
    expect(out.actions).toEqual([])
    expect(vendorTurnOn).not.toHaveBeenCalled()
  })

  it('records skipped (and no vendor call) when the device already has an active session', async () => {
    const db = makeDb({
      class_occurrences: [OCC],
      ac_sessions: [{ id: 's1', device_id: 'dev1', status: 'on' }],
    })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW })
    expect(out.actions).toEqual([expect.objectContaining({ status: 'skipped' })])
    expect(vendorTurnOn).not.toHaveBeenCalled()
  })

  it('records failed on vendor error and surfaces it', async () => {
    vendorTurnOn.mockResolvedValue({ ok: false, error: 'device offline (1209)' })
    const db = makeDb({ class_occurrences: [OCC] })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW })
    expect(out.actions).toEqual([expect.objectContaining({ status: 'failed', error: 'device offline (1209)' })])
  })

  it('dry run plans + reports would_fire without touching vendor or DB writes', async () => {
    const db = makeDb({ class_occurrences: [OCC] })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW, dryRun: true })
    expect(out.actions).toEqual([expect.objectContaining({ status: 'would_fire' })])
    expect(vendorTurnOn).not.toHaveBeenCalled()
    expect(db.calls.inserts).toEqual([])
  })

  it('2h lookback catches a late window (class started 100 min ago, delay 90)', async () => {
    const row = { location_id: LOC, config: { device_ids: ['dev1'], delay_after_start_min: 90, run_duration_min: 30 } }
    const db = makeDb({ class_occurrences: [{ ...OCC, starts_at: '2026-07-27T09:10:00.000Z' }] })
    // now 10:50 → window 10:40–11:10, class start 100 min back (inside 2h lookback).
    const out = await runBathroomClimateForLocation(db, row, { nowMs: NOW })
    expect(out.actions).toEqual([expect.objectContaining({ status: 'fired' })])
  })
})
```

Note for the executor: `makeDb` must expose `db.calls` the same way the class-climate fake does (`return { from: builder, calls }` shape — keep whatever the copied fake returns; if it doesn't expose `calls` on the db object, extend the copy so it does, matching how the class-climate tests assert on it).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/bathroom-climate-runner.test.js`
Expected: FAIL — cannot resolve `./bathroom-climate-runner.js`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/bathroom-climate-runner.js`:

```js
// BATHROOM-CLIMATE.1 — runtime for the bathroom-climate automation. Shared
// by the cron (/api/cron/bathroom-climate) and the operator "Run check
// now" button (/api/automations/bathroom_climate/run-now).
//
// For each location with the automation enabled, turn the configured
// bathroom AC unit(s) ON for any class whose post-start window
// (start + delay .. + duration) is open and which hasn't been actioned
// yet — by writing a system ac_sessions row (started_by NULL) with
// auto_off_at anchored to the class schedule. The existing ac-auto-off
// cron performs the OFF; the external-rule cron sees the active session
// and leaves the unit alone. Idempotency + run history via
// automation_fire_log (keyed bathroom_climate, so the gym floor's
// class_climate history never crosses).

import { vendorTurnOn, loadDeviceWithLocation } from '@/lib/ac-devices'
import { AC_SESSION_STATUS, AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'
import { logAuditEvent } from '@/lib/audit'
import { logWarn } from '@/lib/log'
import { resolveConfig, planBathroomClimate, autoOffAtFor } from '@/lib/bathroom-climate'

export const AUTOMATION_KEY = 'bathroom_climate'
const OCCURRENCE_LOOKAHEAD_MS = 6 * 60 * 60_000 // classes within the next 6h
// Lookback is 2h (not class-climate's 1h): a window opens up to
// delay_after_start_min AFTER a class starts, so a 1h lookback would miss
// e.g. a 06:00 class when the cron ticks at 07:10 with delay 65.
const OCCURRENCE_LOOKBACK_MS = 2 * 60 * 60_000

/**
 * Run the automation for one location's config row.
 * @param {object} db
 * @param {{ location_id: string, config: object }} automationRow
 * @param {{ nowMs?: number, dryRun?: boolean }} opts
 */
export async function runBathroomClimateForLocation(db, automationRow, { nowMs = Date.now(), dryRun = false } = {}) {
  const locationId = automationRow.location_id
  const config = resolveConfig(automationRow.config)
  const result = { location_id: locationId, planned: [], actions: [], errors: [] }

  if (config.device_ids.length === 0) {
    result.errors.push('no_devices_configured')
    return result
  }

  const sinceIso = new Date(nowMs - OCCURRENCE_LOOKBACK_MS).toISOString()
  const untilIso = new Date(nowMs + OCCURRENCE_LOOKAHEAD_MS).toISOString()
  const { data: occurrences, error: occErr } = await db
    .from('class_occurrences')
    .select('glofox_event_id, name, starts_at, ends_at')
    .eq('location_id', locationId)
    .gte('starts_at', sinceIso)
    .lte('starts_at', untilIso)
    .is('cancelled_at', null) // never fire for a cancelled class
    .order('starts_at', { ascending: true })
  if (occErr) {
    result.errors.push(`occurrences_read_failed: ${occErr.message}`)
    return result
  }

  const planned = planBathroomClimate({ occurrences: occurrences || [], config, nowMs })
  result.planned = planned.map((p) => ({
    glofox_event_id: p.glofox_event_id, name: p.occurrence.name, starts_at: p.occurrence.starts_at,
  }))
  if (planned.length === 0) return result

  // What's already been turned on (idempotency)? Only a successful 'fired'
  // row blocks a re-attempt; 'skipped'/'failed' rows get retried (and the
  // upsert updates them in place).
  const eventIds = planned.map((p) => p.glofox_event_id)
  const { data: firedRows } = await db
    .from('automation_fire_log')
    .select('glofox_event_id, device_id, status')
    .eq('automation_key', AUTOMATION_KEY)
    .eq('action_step', 'on')
    .in('glofox_event_id', eventIds)
  const firedSet = new Set(
    (firedRows || []).filter((r) => r.status === 'fired').map((r) => `${r.glofox_event_id}:${r.device_id}`),
  )

  for (const p of planned) {
    for (const deviceId of config.device_ids) {
      if (firedSet.has(`${p.glofox_event_id}:${deviceId}`)) continue

      const action = { glofox_event_id: p.glofox_event_id, class_name: p.occurrence.name, device_id: deviceId }
      if (dryRun) {
        action.status = 'would_fire'
        result.actions.push(action)
        continue
      }
      const out = await fireOn(db, { locationId, deviceId, occurrence: p.occurrence, config, nowMs })
      action.status = out.status
      if (out.error) action.error = out.error
      result.actions.push(action)
    }
  }

  return result
}

/**
 * Turn one device on for one occurrence + record it. Idempotent at the
 * fire-log layer; compatible with the existing AC crons (writes a system
 * ac_sessions row with a schedule-anchored auto_off_at).
 */
async function fireOn(db, { locationId, deviceId, occurrence, config, nowMs }) {
  const eventId = occurrence.glofox_event_id
  const loaded = await loadDeviceWithLocation(deviceId, db)
  if (!loaded.ok) {
    await recordFire(db, { locationId, eventId, deviceId, status: 'failed', detail: { reason: 'device_load_failed', error: loaded.error } })
    return { status: 'failed', error: loaded.error }
  }
  const { device, location } = loaded

  // Already on (operator, the gym automation, or an overlapping window)?
  // Don't double-fire the vendor; record skipped so the timeline shows it
  // (and it gets re-evaluated next tick once the prior session ends).
  const { data: activeRows } = await db
    .from('ac_sessions')
    .select('id')
    .eq('device_id', deviceId)
    .in('status', AC_SESSION_ACTIVE_STATUSES)
    .limit(1)
  if ((activeRows?.length || 0) > 0) {
    await recordFire(db, { locationId, eventId, deviceId, status: 'skipped', detail: { reason: 'already_on' } })
    return { status: 'skipped' }
  }

  const turned = await vendorTurnOn(device, location)
  if (!turned.ok) {
    await recordFire(db, { locationId, eventId, deviceId, status: 'failed', detail: { reason: 'vendor_error', error: turned.error } })
    return { status: 'failed', error: turned.error }
  }

  const autoOffAt = autoOffAtFor(occurrence, config, nowMs)
  const { error: insErr } = await db
    .from('ac_sessions')
    .insert({
      location_id: locationId,
      device_id: deviceId,
      sensibo_pod_id: device.provider === 'sensibo' ? device.provider_device_id : null,
      started_by: null, // system actor
      auto_off_at: autoOffAt,
      status: AC_SESSION_STATUS.ON,
      sensibo_state_snapshot: turned.observed ?? null,
    })
  if (insErr) {
    // Vendor is on but we couldn't record the session. The external-rule
    // cron will cap it; record the fire as failed so a human can notice.
    await recordFire(db, { locationId, eventId, deviceId, status: 'failed', detail: { reason: 'session_insert_failed', error: insErr.message } })
    return { status: 'failed', error: insErr.message }
  }

  await logAuditEvent({
    category: 'business',
    action: 'ac.bathroom_auto_on',
    // No target.id: it maps to audit_events.target_profile_id (FK →
    // profiles), so a device UUID there kills the insert. The device
    // identity rides in target.resource.
    target: { label: device.label, resource: `ac_device/${deviceId}` },
    locationId,
    details: { automation: AUTOMATION_KEY, glofox_event_id: eventId, class_name: occurrence.name, auto_off_at: autoOffAt },
  }).catch(() => {})

  await recordFire(db, { locationId, eventId, deviceId, status: 'fired', detail: { class_name: occurrence.name, auto_off_at: autoOffAt } })
  return { status: 'fired' }
}

async function recordFire(db, { locationId, eventId, deviceId, status, detail }) {
  const { error } = await db
    .from('automation_fire_log')
    .upsert({
      location_id: locationId,
      automation_key: AUTOMATION_KEY,
      glofox_event_id: eventId,
      device_id: deviceId,
      action_step: 'on',
      status,
      detail: detail || null,
      fired_at: new Date().toISOString(),
    }, { onConflict: 'automation_key,glofox_event_id,device_id,action_step' })
  if (error) logWarn('bathroom-climate', 'fire-log write failed', { eventId, deviceId, error: error.message })
}

/**
 * Run for every location that has bathroom_climate enabled (the cron
 * path), or a single location (the run-now path when locationId is given).
 * @param {object} db
 * @param {{ nowMs?: number, dryRun?: boolean, locationId?: string|null }} opts
 */
export async function runBathroomClimate(db, { nowMs = Date.now(), dryRun = false, locationId = null } = {}) {
  let q = db
    .from('location_automations')
    .select('location_id, config, enabled')
    .eq('automation_key', AUTOMATION_KEY)
    .eq('enabled', true)
  if (locationId) q = q.eq('location_id', locationId)
  const { data: rows, error } = await q
  if (error) return { ok: false, error: error.message, locations: [] }

  const locations = []
  for (const row of rows || []) {
    locations.push(await runBathroomClimateForLocation(db, row, { nowMs, dryRun }))
  }
  return { ok: true, locations }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/bathroom-climate-runner.test.js src/lib/class-climate-runner.test.js`
Expected: PASS both files.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bathroom-climate-runner.js src/lib/bathroom-climate-runner.test.js
git commit -m "BATHROOM-CLIMATE.1 — runner for the bathroom AC schedule

Clone of the class-climate runtime keyed bathroom_climate: 2h occurrence
lookback (windows open post-start), schedule-anchored auto_off_at,
ac.bathroom_auto_on audit. Reuses ac-devices dispatcher, ac_sessions +
ac-auto-off for the OFF, automation_fire_log idempotency."
```

---

### Task 3: Cron route + `vercel.json` + heartbeat migration

**Files:**
- Create: `src/app/api/cron/bathroom-climate/route.js`
- Create: `supabase/migrations/447_bathroom_climate.sql`
- Modify: `vercel.json` (crons array, after the `/api/cron/class-climate` entry at ~line 143)

- [ ] **Step 1: Create the cron route**

Create `src/app/api/cron/bathroom-climate/route.js`:

```js
// BATHROOM-CLIMATE.1 — Vercel cron, every 5 min. Turns the configured
// bathroom AC on for any class whose post-start window (start + delay)
// is open, for every location with the bathroom_climate automation
// enabled. The OFF is handled by the existing ac-auto-off cron (we write
// a session with a schedule-anchored auto_off_at). Idempotent via
// automation_fire_log.
//
// Auth: CRON_SECRET.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runBathroomClimate } from '@/lib/bathroom-climate-runner'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const out = await runBathroomClimate(db, {})

  await stampHeartbeat('bathroom-climate').catch((err) =>
    logWarn('cron-bathroom-climate', 'heartbeat failed', { err }))
  return NextResponse.json({ success: out.ok !== false, ...out })
}
```

- [ ] **Step 2: Add the cron schedule**

In `vercel.json`, immediately after the class-climate entry:

```json
    {
      "path": "/api/cron/bathroom-climate",
      "schedule": "*/5 * * * *"
    },
```

Validate: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('ok')"` → `ok`.

- [ ] **Step 3: Write the heartbeat migration**

First verify 447 is still the next free number: `ls supabase/migrations/ | sort -t_ -k1 -n | tail -1` → expect `446_...`. If not, renumber accordingly (forward-only; never reuse).

Create `supabase/migrations/447_bathroom_climate.sql`:

```sql
-- 447: BATHROOM-CLIMATE.1 — heartbeat for the bathroom-climate cron.
-- No schema change: the automation's config rides the existing
-- location_automations (unique location_id+automation_key) row, and
-- fires log to the existing automation_fire_log.
-- bathroom-climate: every 5 min (300s) + 10 min grace (mirrors the
-- class-climate row from mig 284).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
VALUES ('bathroom-climate', 300, 600, NOW())
ON CONFLICT (name) DO NOTHING;
```

Do NOT apply it now — it's applied via Supabase MCP (`apply_migration`, project `iyvtbjjxdggiadzwwvdj`) at ship time, before the Vercel deploy, followed by `get_advisors` (security).

- [ ] **Step 4: Verify the heartbeat guard passes**

Run: `grep -L stampHeartbeat src/app/api/cron/*/route.js`
Expected: only `src/app/api/cron/health-check/route.js` listed (the new route must NOT appear).

Run: `npm run check:route-guards`
Expected: PASS (the route checks `CRON_SECRET`).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/bathroom-climate/route.js supabase/migrations/447_bathroom_climate.sql vercel.json
git commit -m "BATHROOM-CLIMATE.1 — 5-min cron + heartbeat row (mig 447)

Migration is heartbeat-only; config rides location_automations. Apply
via MCP before deploy."
```

---

### Task 4: Registry entry + generic-route dispatch

**Files:**
- Modify: `src/lib/automations/registry.js`
- Modify: `src/app/api/automations/[key]/run-now/route.js`
- Modify: `src/app/api/automations/[key]/schedule/route.js` (~line 23)

- [ ] **Step 1: Add the registry definition**

In `src/lib/automations/registry.js`, append to the `AUTOMATIONS` array after the `class_climate` entry:

```js
  {
    key: 'bathroom_climate',
    label: 'Bathroom climate control',
    description: 'Turn the bathroom AC on after each class starts and off on a timer — automatically, on the class schedule.',
    supportsBackfill: false,
    reviewBase: '/automations',
  },
```

And in `automationStatus`, change the class-climate branch to cover both keys (identical gating — both only need the Glofox schedule source):

```js
  if (key === 'class_climate' || key === 'bathroom_climate') {
    // Needs the Glofox schedule as its trigger source. AC-device presence
    // is surfaced in the dedicated card (which has the device list); here
    // we only gate on the schedule source being connected.
    return { available: glofoxConnected(location), trialConfigured: false }
  }
```

- [ ] **Step 2: Dispatch run-now by key**

In `src/app/api/automations/[key]/run-now/route.js`:

Replace the import line

```js
import { runClassClimate } from '@/lib/class-climate-runner'
```

with

```js
import { runClassClimate } from '@/lib/class-climate-runner'
import { runBathroomClimate } from '@/lib/bathroom-climate-runner'

// Automations that support the operator "Run check now" button, mapped to
// their runner. Both are class-schedule-driven, so both get the
// schedule-refresh-first step below.
const RUNNERS = {
  class_climate: runClassClimate,
  bathroom_climate: runBathroomClimate,
}
```

Replace the key guard

```js
  if (key !== 'class_climate') {
    return NextResponse.json({ success: false, error: 'run-now is not supported for this automation' }, { status: 400 })
  }
```

with

```js
  const runner = RUNNERS[key]
  if (!runner) {
    return NextResponse.json({ success: false, error: 'run-now is not supported for this automation' }, { status: 400 })
  }
```

and replace the invocation

```js
  const out = await runClassClimate(db, { locationId: location_id, dryRun: Boolean(dry_run) })
```

with

```js
  const out = await runner(db, { locationId: location_id, dryRun: Boolean(dry_run) })
```

Also update the top-of-file comment's "Only class_climate supports it today." to "Supported keys are listed in RUNNERS."

- [ ] **Step 3: Extend the schedule route allowlist**

In `src/app/api/automations/[key]/schedule/route.js`, replace

```js
  if (key !== 'class_climate') {
```

with

```js
  if (key !== 'class_climate' && key !== 'bathroom_climate') {
```

and update its "Only class_climate uses it today." comment to name both keys.

- [ ] **Step 4: Run the affected tests + guards**

Run: `npx vitest run "src/app/api/automations" src/lib/automations 2>/dev/null || npm test`
(The `[key]` directory has a `route.test.js`; simplest reliable check is the full `npm test`.)
Expected: PASS — the PUT route works via `getAutomation(key)` with no change, so registry tests (if any) and route tests stay green.

Run: `npm run check:route-guards` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/automations/registry.js "src/app/api/automations/[key]/run-now/route.js" "src/app/api/automations/[key]/schedule/route.js"
git commit -m "BATHROOM-CLIMATE.2 — registry entry + run-now/schedule dispatch for bathroom_climate

PUT already works via getAutomation; run-now gains a key→runner map,
schedule allowlist extended."
```

(zsh: the bracketed paths MUST be quoted or the add silently matches nothing.)

---

### Task 5: Operator card + page wiring

**Files:**
- Create: `src/components/automations/BathroomClimateCard.jsx`
- Modify: `src/app/automations/page.js`
- Reference: `src/components/automations/ClassClimateCard.jsx` (the template)

- [ ] **Step 1: Create the card**

Create `src/components/automations/BathroomClimateCard.jsx` as a copy of `ClassClimateCard.jsx` with exactly these deltas (everything else — schedule list with click-to-exclude, history, run-now/dry-run/test buttons, save plumbing, toggle — stays byte-identical to the template):

1. Header comment:
```js
// BATHROOM-CLIMATE.2 — the dedicated card for the bathroom-climate
// automation. Same skeleton as ClassClimateCard (schedule spine,
// click-to-exclude weekly slots, run-now/test affordances) but the
// timing semantics differ: on at class start + delay, off on a timer.
// Kept as a sibling rather than a parameterised mega-card so each
// card's timing model stays readable on its own. All config lives in
// location_automations.config for key bathroom_climate.
```
2. `const KEY = 'bathroom_climate'`
3. Component name + export: `export default function BathroomClimateCard({ locationId, glofoxConnected, devices, initialEnabled, initialConfig })`
4. Replace the two offset state hooks:
```js
  const [delayMin, setDelayMin] = useState(cfg0.delay_after_start_min ?? 45)
  const [durationMin, setDurationMin] = useState(cfg0.run_duration_min ?? 30)
```
(`offsetOn`/`offsetOff` and their setters disappear entirely.)
5. `buildConfig()` becomes:
```js
  function buildConfig() {
    return {
      device_ids: deviceIds,
      delay_after_start_min: Math.max(0, Number(delayMin) || 0),
      run_duration_min: Math.max(1, Number(durationMin) || 0),
      class_filter: filterText.split(',').map((s) => s.trim()).filter(Boolean),
      excluded_slots: excludedSlots,
    }
  }
```
6. Icon + title block: import `ShowerHead` from `lucide-react` instead of `Snowflake` (keep the other icon imports as used) and render:
```jsx
            <ShowerHead size={16} className="text-blue-500" />
            <h2 className="font-semibold text-un1t-white">Bathroom climate control</h2>
          </div>
          <p className="text-sm text-un1t-light mt-1">
            Turn the bathroom AC on after each class starts and off on a timer — automatically, on the class schedule.
          </p>
```
7. The two numeric config labels become:
```jsx
            <label className="text-xs text-un1t-light">
              Start after class begins (min)
              <input type="number" min="0" value={delayMin} onChange={(e) => setDelayMin(e.target.value)}
                className="ml-2 w-16 rounded border border-un1t-gray bg-un1t-black px-2 py-1 text-un1t-white" />
            </label>
            <label className="text-xs text-un1t-light">
              Run for (min)
              <input type="number" min="1" value={durationMin} onChange={(e) => setDurationMin(e.target.value)}
                className="ml-2 w-16 rounded border border-un1t-gray bg-un1t-black px-2 py-1 text-un1t-white" />
            </label>
```
8. In the schedule-spine intro copy, the `<p>` under "Upcoming classes" keeps its exclude instruction; no other copy changes.

Everything the template does with `slotKey`, `isExcluded`, `toggleSlot`, `runNow`, `testDevices`, warnings, and the enable gate (`glofoxConnected && hasDevices && deviceIds.length > 0`) carries over untouched — the generic `/api/automations/bathroom_climate/*` endpoints resolve by `KEY`.

- [ ] **Step 2: Wire the page**

In `src/app/automations/page.js`:

1. Add the import next to the existing card import:
```js
import BathroomClimateCard from '@/components/automations/BathroomClimateCard'
```
2. Update the comment + filter that hides config-bearing cards from the generic toggle list:
```js
  // class_climate + bathroom_climate are rendered by their own cards (they
  // need config), so they're filtered out of the generic toggle list.
```
```js
    cards = AUTOMATIONS
      .filter((a) => a.key !== 'class_climate' && a.key !== 'bathroom_climate')
```
3. Next to the existing `climate` extraction, add:
```js
    const bathroomRow = byKey['bathroom_climate']
    bathroom = { enabled: Boolean(bathroomRow?.enabled), config: bathroomRow?.config || {} }
```
and declare it alongside the others near the top of the block:
```js
  let bathroom = null
```
4. Render the card directly under `<ClassClimateCard …/>` (same `climateDevices` list — the operator picks the bathroom units from it):
```jsx
          <BathroomClimateCard
            locationId={location?.id || null}
            glofoxConnected={glofoxConnected(location)}
            devices={climateDevices}
            initialEnabled={bathroom?.enabled}
            initialConfig={bathroom?.config}
          />
```

- [ ] **Step 3: Build + lint**

Run: `npm run build`
Expected: compiles clean (this is the only check that catches import-resolution mistakes — required because of the new component + route imports).

Run: `npm run lint && npm run check:guardrails`
Expected: PASS (all copied buttons already carry `type="button"`; chip classes are the compliant `*-700` recipes from the template).

- [ ] **Step 4: Visual sanity check (local)**

Run: `npm run dev`, open `http://localhost:3000/automations`.
Expected: two climate cards stacked — "Class climate control" (unchanged) and "Bathroom climate control" with the 45/30 defaults, device pills, and the synced schedule list. Toggle stays disabled until Glofox is connected and ≥1 device is ticked. (Local env may have stubbed Supabase keys — if the page can't load data locally, note it and rely on the prod visual pass after merge.)

- [ ] **Step 5: Commit**

```bash
git add src/components/automations/BathroomClimateCard.jsx src/app/automations/page.js
git commit -m "BATHROOM-CLIMATE.2 — operator card + /automations wiring

Sibling card to ClassClimateCard with delay/duration semantics
(default 45/30); same schedule spine, exclusions, run-now + history."
```

---

### Task 6: Full verification + changelog + PR

**Files:**
- Modify: `docs/CHANGELOG.md` (append a Done entry, matching the existing numbered format at the end of the file)

- [ ] **Step 1: Run the full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`
Expected: all six PASS. (`check:mobile-parity` passes untouched — no new `WEB_PERMISSIONS` key was added.)

- [ ] **Step 2: Changelog entry**

Append to `docs/CHANGELOG.md` following the existing entry format (numbered, dated), e.g.:

```markdown
- **BATHROOM-CLIMATE (2026-07-26)** — new `bathroom_climate` automation: bathroom AC on at class start + 45 min, off on a 30-min timer (both operator-configurable), own card on /automations, own fire-log key. Cron `/api/cron/bathroom-climate` (*/5), heartbeat mig 447. Reuses ac-devices dispatcher + ac-auto-off; gym-floor `class_climate` untouched.
```

- [ ] **Step 3: Commit + push + PR**

```bash
git add docs/CHANGELOG.md
git commit -m "BATHROOM-CLIMATE.3 — changelog"
git push -u origin HEAD
gh pr create --base main --fill
```

Report the PR URL. **Pushing is not shipping** — the PR is the deliverable of this plan.

- [ ] **Step 4: Ship-time checklist (goes in the PR description, executed at merge)**

1. Apply `supabase/migrations/447_bathroom_climate.sql` via Supabase MCP `apply_migration` against project `iyvtbjjxdggiadzwwvdj` **before** merging (heartbeat row must exist or the new cron reads as stale/unknown).
2. `get_advisors` (type=security) after applying.
3. After deploy: on `/automations` (Stillorgan), tick the two bathroom ThinQ units on the new card, Save, use **Preview only** (dry-run) against the live timetable to confirm expected windows, then enable the toggle.
4. Watch the first real fire in the card history (or `automation_fire_log` where `automation_key='bathroom_climate'`) and confirm the unit turns off ~30 min later via ac-auto-off.

---

## Self-review notes (done at planning time)

- **Spec coverage:** config shape → Task 1; planner semantics incl. anchoring + clamp → Task 1; runner incl. 2h lookback, cancelled-class filter, skip/fail paths, audit event → Task 2; cron + heartbeat + vercel.json → Task 3; registry/status + run-now dispatch + schedule allowlist (verified gaps in both routes at spec time) → Task 4; card + page hard-coded-component branch → Task 5; tests → Tasks 1–2; CI mirror + build → Tasks 5–6. Out-of-scope items (bridging, mobile, sensors) have no tasks, as specced.
- **Type consistency:** `runBathroomClimate(db, { locationId, dryRun })` signature matches its Task 4 call site; planner exports (`DEFAULT_CONFIG`, `resolveConfig`, `planBathroomClimate`, `autoOffAtFor`) match Task 2 imports; config keys (`delay_after_start_min`, `run_duration_min`) are identical across lib, card `buildConfig`, and tests.
- **Known accepted behaviours** (from spec, restated for the executor — do not "fix" these): bathrooms cycle on :45/off :15 with hourly classes; a device ticked in both automations resolves via the active-session skip; closely-spaced classes may leave a short gap between sessions.
