# HR booking-first routing + test mode + unmapped display + class-aware lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a registered HR strap map to the member's *booked* class, let staff test straps any time (time-boxed), show every broadcasting strap on the TV by number with no pairing, and keep one session per member per class (rejoin across drop-outs, one email at class end).

**Architecture:** Pure decision helpers (booking pick, label mask, lifecycle close/create decisions) are extracted and unit-tested with no DB; thin IO wrappers in `bridge-samples.js` / `class-bookings.js` / the stale-close cron call them. One migration adds a time-boxed `ble_bridges.test_mode_until`. Two display surfaces (public TV feed + coach `/live`) gain unpaired-strap tiles and a test-mode toggle.

**Tech Stack:** Next.js 16 App Router (route handlers), Supabase service-role client, Vitest (pure-lib tests, mocked DB), Tailwind.

**Working directory:** `~/code/un1t-crm-hr` (branch `hr-booking-first-routing`, off `origin/main`).

**Spec:** `docs/superpowers/specs/2026-06-27-hr-booking-first-routing-design.md`

**Conventions (from repo CLAUDE.md):**
- `.update()/.insert()` must be `await`ed. Builders are thenables — wrap awaits in `try/catch`, never `.catch()`.
- Service-role routes get NO RLS — guard with `getCurrentUser()` + role check + location scope. Return 404/403 explicitly.
- Run the CI mirror before any push: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`
- Migrations forward-only; applied via Supabase MCP against project `iyvtbjjxdggiadzwwvdj`, then `get_advisors`.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/321_hr_bridge_test_mode.sql` | + `ble_bridges.test_mode_until timestamptz` |
| `src/lib/hr-session-lifecycle.js` *(new)* | Pure: `classSessionAction`, `shouldCloseStaleSession`, lifecycle constants |
| `src/lib/hr-session-lifecycle.test.js` *(new)* | Unit tests for the pure lifecycle helpers |
| `src/lib/class-bookings.js` | + `pickNearestBookedOccurrence` (pure) + `resolveBookedOccurrenceForMember` (IO) |
| `src/lib/class-bookings.test.js` | + tests for the booking picker |
| `src/lib/bridge-samples.js` | + `maskStrapLabel` (pure); rewire `findOrCreateAutoSession` (booking-first → presence → test-mode, class-keyed dedup); thread `testModeActive` through `resolveStrapsForBatch` |
| `src/lib/bridge-samples.test.js` | + tests: mask, booking-first, reopen/skip, test-mode |
| `src/lib/live-class.js` | `pairOverride` class stamp via booking-first helper |
| `src/app/api/cron/auto-end-stale-hr-sessions/route.js` | defer closing class-linked sessions via `shouldCloseStaleSession` |
| `src/app/api/cron/auto-end-stale-hr-sessions/route.test.js` | + deferral tests |
| `src/app/api/live/[locationId]/test-mode/route.js` *(new)* | POST/DELETE test mode (manager+) |
| `src/app/api/live/[locationId]/route.js` | surface `test_mode_until` in GET |
| `src/app/api/public/live/[locationId]/route.js` | + `available_straps` (privacy-masked) |
| `src/app/tv/[locationId]/LiveTvClient.jsx` | render unpaired number tiles |
| `src/app/live/[locationId]/LiveClassClient.jsx` | test-mode toggle + countdown banner |
| `src/lib/openapi.js` | register the test-mode route |
| `docs/CHANGELOG.md` | Done entry |

---

## Task 1: Migration — `ble_bridges.test_mode_until`

**Files:**
- Create: `supabase/migrations/321_hr_bridge_test_mode.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 321_hr_bridge_test_mode.sql
-- Time-boxed staff "HR test mode" per bridge. While test_mode_until is in the
-- future, a registered strap auto-routes to its member's session any time
-- (no live class required). Self-expiring so it can't be left on permanently.
ALTER TABLE public.ble_bridges
  ADD COLUMN IF NOT EXISTS test_mode_until timestamptz;

COMMENT ON COLUMN public.ble_bridges.test_mode_until IS
  'Staff HR test mode: while > now(), a registered strap creates a presence-less session any time. Self-expiring (mig 321).';
```

- [ ] **Step 2: Apply via Supabase MCP**

Apply with `apply_migration` (name `hr_bridge_test_mode`) against project `iyvtbjjxdggiadzwwvdj` (confirm it is the un1t-crm project via `list_projects`, NOT sentinel `tpttqakxmyxrwnqjepfm`). Then run `get_advisors` (type=security) — expect no new findings (a nullable column on an existing table adds no RLS/policy surface).

> NOTE for the executor: migration application is delegated to the human operator (Richard) per project policy. If you cannot call the Supabase MCP, STOP and ask them to apply `321_hr_bridge_test_mode.sql`, then continue.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/321_hr_bridge_test_mode.sql
git commit -m "HR-ROUTE.1 — mig 321: ble_bridges.test_mode_until (time-boxed staff HR test mode)"
```

---

## Task 2: Pure helper — `maskStrapLabel`

Privacy-safe label for an unpaired strap on the public TV: ANT+ shows the device number; BLE is masked to the last 4 hex of the MAC (never the full MAC).

**Files:**
- Modify: `src/lib/bridge-samples.js` (add export near `parseDeviceKey`)
- Test: `src/lib/bridge-samples.test.js`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/bridge-samples.test.js` (import `maskStrapLabel` in the existing top import block):

```js
describe('maskStrapLabel', () => {
  it('shows the ANT+ device number', () => {
    expect(maskStrapLabel('ant:12511')).toBe('Strap 12511')
  })
  it('masks a BLE MAC to the last 4 hex', () => {
    expect(maskStrapLabel('ble:AA:BB:CC:DD:EE:FF')).toBe('Strap ••EEFF')
  })
  it('falls back to a generic label on a bad key', () => {
    expect(maskStrapLabel('garbage')).toBe('Strap')
    expect(maskStrapLabel(null)).toBe('Strap')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/bridge-samples.test.js -t maskStrapLabel`
Expected: FAIL — `maskStrapLabel is not a function`.

- [ ] **Step 3: Implement**

Add to `src/lib/bridge-samples.js` immediately after `parseDeviceKey`:

```js
/**
 * A privacy-safe display label for an unpaired strap on the PUBLIC TV.
 * ANT+ → the device number (not PII). BLE → last 4 hex of the MAC, masked
 * (never the full MAC on a public screen). Bad key → a generic 'Strap'.
 *
 * @param {string} deviceKey
 * @returns {string}
 */
export function maskStrapLabel(deviceKey) {
  const parsed = parseDeviceKey(deviceKey)
  if (!parsed) return 'Strap'
  if (parsed.protocol === 'ant') return `Strap ${parsed.deviceId}`
  const hex = String(parsed.deviceId).replace(/[^0-9A-Fa-f]/g, '')
  return hex.length >= 4 ? `Strap ••${hex.slice(-4).toUpperCase()}` : 'Strap'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/bridge-samples.test.js -t maskStrapLabel`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bridge-samples.js src/lib/bridge-samples.test.js
git commit -m "HR-ROUTE.2 — maskStrapLabel: privacy-safe unpaired-strap label"
```

---

## Task 3: Booking-first occurrence resolver

`pickNearestBookedOccurrence` (pure) selects the member's nearest non-cancelled booking whose occurrence is live in a window; `resolveBookedOccurrenceForMember` (IO) loads the rows and calls it.

**Files:**
- Modify: `src/lib/class-bookings.js`
- Test: `src/lib/class-bookings.test.js`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/class-bookings.test.js` (import `pickNearestBookedOccurrence`):

```js
describe('pickNearestBookedOccurrence', () => {
  const NOW = Date.parse('2026-06-27T07:45:00Z')
  const occ8 = { glofox_event_id: 'e8', name: 'TEMPO', starts_at: '2026-06-27T08:00:00Z', ends_at: '2026-06-27T09:00:00Z' }
  const occ7 = { glofox_event_id: 'e7', name: 'RIDE',  starts_at: '2026-06-27T07:00:00Z', ends_at: '2026-06-27T08:00:00Z' }
  const occByEvent = (occs) => new Map(occs.map((o) => [o.glofox_event_id, o]))
  const W = { preMs: 45 * 60000, postMs: 30 * 60000 }

  it('maps an early arrival to the upcoming booked class even when a previous class still overlaps', () => {
    const bookings = [
      { glofox_event_id: 'e8', status: 'BOOKED', starts_at: occ8.starts_at },
      { glofox_event_id: 'e7', status: 'BOOKED', starts_at: occ7.starts_at },
    ]
    const out = pickNearestBookedOccurrence(bookings, occByEvent([occ7, occ8]), NOW, W)
    expect(out).toEqual({ glofox_event_id: 'e8', class_name: 'TEMPO' })
  })

  it('ignores cancelled bookings', () => {
    const bookings = [{ glofox_event_id: 'e8', status: 'CANCELLED', starts_at: occ8.starts_at }]
    expect(pickNearestBookedOccurrence(bookings, occByEvent([occ8]), NOW, W)).toBeNull()
  })

  it('returns null when the booked occurrence is outside the window', () => {
    const far = { glofox_event_id: 'eX', name: 'LATE', starts_at: '2026-06-27T12:00:00Z', ends_at: '2026-06-27T13:00:00Z' }
    const bookings = [{ glofox_event_id: 'eX', status: 'BOOKED', starts_at: far.starts_at }]
    expect(pickNearestBookedOccurrence(bookings, occByEvent([far]), NOW, W)).toBeNull()
  })

  it('returns null with no bookings', () => {
    expect(pickNearestBookedOccurrence([], new Map(), NOW, W)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/class-bookings.test.js -t pickNearestBookedOccurrence`
Expected: FAIL — `pickNearestBookedOccurrence is not a function`.

- [ ] **Step 3: Implement the pure picker**

In `src/lib/class-bookings.js`, extend the import from class-occurrences to include `occurrenceIsLive`, then add:

```js
// at top — existing import becomes:
import { toMillis, occurrenceIsLive, resolveCurrentOccurrence } from '@/lib/class-occurrences'
```

```js
/**
 * Pure: from a member's booking rows + a map of their occurrences, pick the
 * occurrence nearest to now whose window (preMs/postMs around start/end) is live
 * and whose booking is not cancelled. Returns { glofox_event_id, class_name } | null.
 *
 * @param {Array<{glofox_event_id:string, status:string|null, starts_at:string|null}>} bookingRows
 * @param {Map<string, {glofox_event_id:string, name:string|null, starts_at:string, ends_at:string|null}>} occByEventId
 * @param {number} nowMs
 * @param {{preMs:number, postMs:number}} window
 */
export function pickNearestBookedOccurrence(bookingRows, occByEventId, nowMs, { preMs, postMs }) {
  let best = null
  let bestDist = Infinity
  for (const b of bookingRows || []) {
    if (String(b?.status || '').toUpperCase() === 'CANCELLED') continue
    const occ = occByEventId.get(b.glofox_event_id)
    if (!occ) continue
    if (!occurrenceIsLive(occ, nowMs, { preMs, postMs })) continue
    const startMs = new Date(occ.starts_at).getTime()
    const dist = Math.abs(startMs - nowMs)
    if (dist < bestDist) {
      bestDist = dist
      best = { glofox_event_id: occ.glofox_event_id, class_name: occ.name || null }
    }
  }
  return best
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/class-bookings.test.js -t pickNearestBookedOccurrence`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement the IO wrapper**

Add to `src/lib/class-bookings.js`:

```js
/**
 * IO: the occurrence the member is booked into around now (booking-first class
 * selection for a registered strap). Loads the member's non-cancelled bookings
 * near now, joins their occurrences for ends_at, and picks the nearest live one.
 * Returns { glofox_event_id, class_name } | null. Fast-null when no glofoxMemberId.
 *
 * @param {object} db service-role client
 * @param {{ locationId:string, glofoxMemberId:string|null, nowMs?:number, preMs:number, postMs:number }} opts
 */
export async function resolveBookedOccurrenceForMember(db, { locationId, glofoxMemberId, nowMs = Date.now(), preMs, postMs }) {
  if (!db || !locationId || !glofoxMemberId) return null
  const sinceIso = new Date(nowMs - 3 * 60 * 60_000).toISOString()
  const untilIso = new Date(nowMs + preMs).toISOString()
  const { data: bookings } = await db
    .from('class_bookings')
    .select('glofox_event_id, status, starts_at')
    .eq('location_id', locationId)
    .eq('glofox_member_id', glofoxMemberId)
    .gte('starts_at', sinceIso)
    .lte('starts_at', untilIso)
  if (!bookings || bookings.length === 0) return null

  const eventIds = [...new Set(bookings.map((b) => b.glofox_event_id).filter(Boolean))]
  const { data: occs } = await db
    .from('class_occurrences')
    .select('glofox_event_id, name, starts_at, ends_at')
    .eq('location_id', locationId)
    .in('glofox_event_id', eventIds)
  const occByEventId = new Map((occs || []).map((o) => [o.glofox_event_id, o]))
  return pickNearestBookedOccurrence(bookings, occByEventId, nowMs, { preMs, postMs })
}
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/class-bookings.js src/lib/class-bookings.test.js
git commit -m "HR-ROUTE.3 — booking-first occurrence resolver (pickNearestBookedOccurrence + IO)"
```

---

## Task 4: Pure lifecycle helpers — `classSessionAction` + `shouldCloseStaleSession`

**Files:**
- Create: `src/lib/hr-session-lifecycle.js`
- Test: `src/lib/hr-session-lifecycle.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/hr-session-lifecycle.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  classSessionAction,
  shouldCloseStaleSession,
  CLASS_END_GRACE_MS,
  STALE_AFTER_MS,
  MAX_SESSION_LENGTH_MS,
} from './hr-session-lifecycle.js'

const occ = { ends_at: '2026-06-27T09:00:00Z' }
const duringClass = Date.parse('2026-06-27T08:30:00Z')
const justAfter = Date.parse('2026-06-27T09:05:00Z')   // within +10m grace
const wellAfter = Date.parse('2026-06-27T09:30:00Z')   // past +10m grace

describe('classSessionAction', () => {
  it('creates when there is no prior session', () => {
    expect(classSessionAction({ existing: null, occ, nowMs: duringClass })).toBe('create')
  })
  it('returns an already-open session (rejoin)', () => {
    expect(classSessionAction({ existing: { id: 's', ended_at: null }, occ, nowMs: duringClass })).toBe('return')
  })
  it('reopens a closed session while the class is still live', () => {
    expect(classSessionAction({ existing: { id: 's', ended_at: '2026-06-27T08:36:00Z' }, occ, nowMs: justAfter })).toBe('reopen')
  })
  it('skips (no new session) when the class has ended', () => {
    expect(classSessionAction({ existing: { id: 's', ended_at: '2026-06-27T08:36:00Z' }, occ, nowMs: wellAfter })).toBe('skip')
  })
})

describe('shouldCloseStaleSession', () => {
  const base = { started_at: '2026-06-27T08:00:00Z' }
  const silentMin = (m) => new Date(duringClass - m * 60000).toISOString()

  it('keeps a class session open while silent but the class is still live', () => {
    const s = { ...base, glofox_event_id: 'e', last_sample_at: silentMin(10) }
    expect(shouldCloseStaleSession({ session: s, occ, nowMs: duringClass })).toBe(false)
  })
  it('closes a class session once silent AND the class has ended + grace', () => {
    const s = { ...base, glofox_event_id: 'e', last_sample_at: '2026-06-27T08:30:00Z' }
    expect(shouldCloseStaleSession({ session: s, occ, nowMs: wellAfter })).toBe(true)
  })
  it('does not close a still-streaming class session past scheduled end', () => {
    const s = { ...base, glofox_event_id: 'e', last_sample_at: new Date(wellAfter - 10000).toISOString() }
    expect(shouldCloseStaleSession({ session: s, occ, nowMs: wellAfter })).toBe(false)
  })
  it('closes a non-class session on 5-min silence (unchanged)', () => {
    const s = { ...base, glofox_event_id: null, last_sample_at: silentMin(6) }
    expect(shouldCloseStaleSession({ session: s, occ: null, nowMs: duringClass })).toBe(true)
  })
  it('closes any session past the 4h backstop regardless of silence', () => {
    const s = { started_at: new Date(duringClass - 5 * 3600_000).toISOString(), glofox_event_id: 'e', last_sample_at: new Date(duringClass - 10000).toISOString() }
    expect(shouldCloseStaleSession({ session: s, occ, nowMs: duringClass })).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/hr-session-lifecycle.test.js`
Expected: FAIL — cannot find module `./hr-session-lifecycle.js`.

- [ ] **Step 3: Implement**

Create `src/lib/hr-session-lifecycle.js`:

```js
// Pure session-lifecycle decisions for the in-studio HR feature. No DB — the
// cron (auto-end-stale-hr-sessions) and bridge ingest (findOrCreateAutoSession)
// load rows then call these. Keeps "one session per member per class, rejoin
// across drop-outs, one email at class end" testable in isolation.

export const STALE_AFTER_MS = 5 * 60 * 1000          // strap silent → close (non-class)
export const MAX_SESSION_LENGTH_MS = 4 * 3600 * 1000 // defensive cap
export const CLASS_END_GRACE_MS = 10 * 60 * 1000     // cooldown buffer after class end

/**
 * What to do with the most-recent session for a (member, class) when a sample
 * arrives and the member is mapped to occurrence `occ`. Open sessions are
 * handled before this is called, so `existing` here is the class-keyed lookup.
 *
 * @returns {'create'|'return'|'reopen'|'skip'}
 */
export function classSessionAction({ existing, occ, nowMs, classEndGraceMs = CLASS_END_GRACE_MS }) {
  if (!existing) return 'create'
  if (!existing.ended_at) return 'return'
  const endMs = occ?.ends_at ? new Date(occ.ends_at).getTime() : null
  if (endMs != null && nowMs <= endMs + classEndGraceMs) return 'reopen'
  return 'skip'
}

/**
 * Should the stale-close cron finalise this open session now?
 * - 4h backstop → always close.
 * - still streaming (not silent) → keep open.
 * - silent + class-linked + class not yet ended+grace → defer (rejoinable).
 * - silent + non-class (or class ended) → close.
 *
 * @param {{ session:{started_at:string,last_sample_at:string|null,glofox_event_id:string|null}, occ:{ends_at:string|null}|null, nowMs:number, staleMs?:number, classEndGraceMs?:number, maxLenMs?:number }} args
 */
export function shouldCloseStaleSession({
  session, occ, nowMs,
  staleMs = STALE_AFTER_MS, classEndGraceMs = CLASS_END_GRACE_MS, maxLenMs = MAX_SESSION_LENGTH_MS,
}) {
  const startedMs = session?.started_at ? new Date(session.started_at).getTime() : null
  if (startedMs != null && Number.isFinite(startedMs) && nowMs - startedMs > maxLenMs) return true

  const lastMs = session?.last_sample_at ? new Date(session.last_sample_at).getTime() : null
  const silent = lastMs != null && nowMs - lastMs > staleMs
  if (!silent) return false

  if (session?.glofox_event_id) {
    const endMs = occ?.ends_at ? new Date(occ.ends_at).getTime() : null
    if (endMs != null && nowMs <= endMs + classEndGraceMs) return false // defer — rejoinable
    return true
  }
  return true // non-class silent → close (unchanged)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/hr-session-lifecycle.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hr-session-lifecycle.js src/lib/hr-session-lifecycle.test.js
git commit -m "HR-ROUTE.4 — pure session-lifecycle helpers (classSessionAction, shouldCloseStaleSession)"
```

---

## Task 5: Rewire `findOrCreateAutoSession` (booking-first → presence → test-mode, class-keyed)

Replaces the create logic in `findOrCreateAutoSession`. Selection order: (a) existing open session (rejoin, class-link backfill booking-first) → resolve occ booking-first then presence → class-keyed create/reopen/skip → test-mode presence-less → native-booking fallback.

**Files:**
- Modify: `src/lib/bridge-samples.js` (`findOrCreateAutoSession`, signature + body; and `resolveStrapsForBatch` to thread `testModeActive` + fetch bridge flag)
- Test: `src/lib/bridge-samples.test.js`

- [ ] **Step 1: Add imports + window constants**

At the top of `src/lib/bridge-samples.js`, extend the class-bookings import and add booking-first window constants near the existing `BOOKING_WINDOW_MS`:

```js
// existing import — add resolveBookedOccurrenceForMember:
import { lookupBookedMember, resolveClassLinkSource, resolveBookedOccurrenceForMember } from '@/lib/class-bookings'
import { classSessionAction } from '@/lib/hr-session-lifecycle'
```

```js
// Booking-first grace: a registered, BOOKED member's strap routes this wide
// around their class (warmup/cooldown). Only behind a confirmed booking — the
// presence fallback below stays at the tight OCC_PRE/POST window.
const BOOKED_PRE_MS = 45 * 60_000
const BOOKED_POST_MS = 30 * 60_000
```

- [ ] **Step 2: Write the failing tests**

Add a new describe block to `src/lib/bridge-samples.test.js`. This mock covers the registered (auto) path end-to-end:

```js
describe('resolveStrapsForBatch: registered booking-first + test mode', () => {
  const NOW = Date.parse('2026-06-27T07:45:00Z')
  const occ8 = { glofox_event_id: 'e8', name: 'TEMPO', starts_at: '2026-06-27T08:00:00Z', ends_at: '2026-06-27T09:00:00Z' }

  // Configurable mock: one registered device for contact c1; controllable
  // bookings / occurrences / existing sessions / bridge test mode.
  function makeDb({ bookings = [], occs = [], existingOpen = null, existingClass = null, testModeUntil = null, captureInsert, captureUpdate } = {}) {
    return {
      from: vi.fn((table) => {
        if (table === 'ble_bridges') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: { test_mode_until: testModeUntil } })) })) })) }
        }
        if (table === 'strap_assignments') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ is: vi.fn(() => ({ not: vi.fn(() => Promise.resolve({ data: [] })) })) })) })) }
        }
        if (table === 'contact_devices') {
          return { select: vi.fn(() => ({ in: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [{ identifier: 'ant:12511', contact_id: 'c1', contacts: { id: 'c1', location_id: 'loc1' } }], error: null })) })) })) })) }
        }
        if (table === 'class_bookings') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ gte: vi.fn(() => ({ lte: vi.fn(() => Promise.resolve({ data: bookings })) })) })) })) })) }
        }
        if (table === 'class_occurrences') {
          // resolveBookedOccurrenceForMember uses .in(); resolveCurrentOccurrence uses gte/lte/order.
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                in: vi.fn(() => Promise.resolve({ data: occs })),
                gte: vi.fn(() => ({ lte: vi.fn(() => ({ order: vi.fn(() => Promise.resolve({ data: [] })) })) })),
              })),
            })),
          }
        }
        if (table === 'contacts') {
          return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { glofox_member_id: 'g1', max_hr_override: null, dob: null } })) })) })) }
        }
        if (table === 'heart_rate_sessions') {
          return {
            select: vi.fn((cols) => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  // open-session lookup (is ended_at null) and class-keyed lookup both land here;
                  // we disambiguate by returning existingOpen for the .is(...) chain.
                  is: vi.fn(() => ({ order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: existingOpen })) })) })) })),
                  order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: existingClass })) })) })),
                })),
              })),
            })),
            insert: vi.fn((row) => { if (captureInsert) captureInsert(row); return { select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: 'new-1' }, error: null })) })) } }),
            update: vi.fn((patch) => { if (captureUpdate) captureUpdate(patch); return { eq: vi.fn(() => Promise.resolve({ error: null })) } }),
          }
        }
        throw new Error(`unexpected ${table}`)
      }),
    }
  }

  it('maps a booked member to their booked class (booking-first, label=booked)', async () => {
    let inserted = null
    const db = makeDb({ bookings: [{ glofox_event_id: 'e8', status: 'BOOKED', starts_at: occ8.starts_at }], occs: [occ8], captureInsert: (r) => { inserted = r } })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: NOW })
    expect(map.get('ant:12511')).toMatchObject({ sessionId: 'new-1', contactId: 'c1', via: 'auto' })
    expect(inserted).toMatchObject({ glofox_event_id: 'e8', class_link_source: 'booked', device_identifier: 'ant:12511' })
  })

  it('creates nothing for an unbooked member with no live class and test mode off', async () => {
    const db = makeDb({ bookings: [], occs: [] })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: NOW })
    expect(map.has('ant:12511')).toBe(false)
  })

  it('creates a presence-less session when the bridge is in test mode', async () => {
    let inserted = null
    const db = makeDb({ bookings: [], occs: [], testModeUntil: new Date(NOW + 3600_000).toISOString(), captureInsert: (r) => { inserted = r } })
    const map = await resolveStrapsForBatch(db, { bridgeId: 'b', locationId: 'loc1', deviceKeys: ['ant:12511'], nowMs: NOW })
    expect(map.get('ant:12511')).toMatchObject({ sessionId: 'new-1', via: 'auto' })
    expect(inserted).toMatchObject({ device_identifier: 'ant:12511', glofox_event_id: null, class_link_source: null })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/bridge-samples.test.js -t "booking-first"`
Expected: FAIL (booking-first not wired; test-mode flag not read).

- [ ] **Step 4: Thread `testModeActive` in `resolveStrapsForBatch`**

In `resolveStrapsForBatch`, before the auto-path loop that calls `findOrCreateAutoSession`, read the bridge flag once and pass it down. Replace the loop in section (2):

```js
  // (2) Auto path: contact_devices for the remaining device_keys.
  const remaining = uniqueKeys.filter((k) => !map.has(k))
  if (remaining.length === 0) return map

  const { data: deviceRows, error: devErr } = await db
    .from('contact_devices')
    .select('identifier, contact_id, label, contacts!inner(id, location_id)')
    .in('identifier', remaining)
    .eq('is_active', true)
    .eq('contacts.location_id', locationId)

  if (devErr) {
    logWarn('bridge-samples', 'contact_devices lookup failed', { err: devErr, locationId })
    return map
  }

  // Staff HR test mode (mig 321) — registered straps route any time while active.
  let testModeActive = false
  if (deviceRows && deviceRows.length > 0) {
    const { data: bridge } = await db
      .from('ble_bridges').select('test_mode_until').eq('id', bridgeId).maybeSingle()
    testModeActive = !!bridge?.test_mode_until && new Date(bridge.test_mode_until).getTime() > nowMs
  }

  for (const dev of deviceRows || []) {
    const sessionId = await findOrCreateAutoSession(db, {
      contactId: dev.contact_id,
      locationId,
      deviceKey: dev.identifier,
      nowMs,
      testModeActive,
    })
    if (sessionId) {
      map.set(canonicaliseDeviceKey(dev.identifier) || dev.identifier, {
        sessionId,
        contactId: dev.contact_id,
        via: 'auto',
      })
    }
  }
```

- [ ] **Step 5: Rewrite `findOrCreateAutoSession`**

Replace the whole `findOrCreateAutoSession` function body with:

```js
async function findOrCreateAutoSession(db, { contactId, locationId, deviceKey, nowMs, testModeActive = false }) {
  // (a) Any existing OPEN session for this contact? Return it (rejoin across a
  // mid-class drop-out works because the stale-close cron defers closing
  // class-linked sessions until class end). Backfill the class link booking-first.
  const { data: existing } = await db
    .from('heart_rate_sessions')
    .select('id, glofox_event_id')
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Contact's max HR + glofox id (used by backfill + create paths).
  const { data: contact } = await db
    .from('contacts')
    .select('max_hr_override, dob, glofox_member_id')
    .eq('id', contactId)
    .single()

  // Resolve the class for this member NOW: booking-first (wide), then presence (tight).
  const bookedOcc = await resolveBookedOccurrenceForMember(db, {
    locationId, glofoxMemberId: contact?.glofox_member_id, nowMs, preMs: BOOKED_PRE_MS, postMs: BOOKED_POST_MS,
  })
  const occ = bookedOcc || await resolveCurrentOccurrence(db, { locationId, nowMs })
  const linkSource = occ
    ? (bookedOcc ? 'booked' : resolveClassLinkSource({
        liveClass: occ,
        booked: await lookupBookedMember(db, { locationId, glofoxEventId: occ.glofox_event_id, glofoxMemberId: contact?.glofox_member_id }),
      }))
    : null

  if (existing?.id) {
    if (!existing.glofox_event_id && occ) {
      await db.from('heart_rate_sessions')
        .update({ glofox_event_id: occ.glofox_event_id, class_name: occ.class_name, class_link_source: linkSource })
        .eq('id', existing.id)
    }
    return existing.id
  }

  const maxHr = resolveMaxHrForBridgeInsert(contact)
  const nowIso = new Date(nowMs).toISOString()

  // (b) Class-linked create (booking-first or presence). One session per
  // (member, class): reopen a closed one while the class is still live; skip
  // (no new session, no duplicate email) once the class has ended.
  if (occ) {
    const { data: priorForClass } = await db
      .from('heart_rate_sessions')
      .select('id, ended_at')
      .eq('contact_id', contactId)
      .eq('glofox_event_id', occ.glofox_event_id)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const action = classSessionAction({ existing: priorForClass || null, occ, nowMs })
    if (action === 'return') return priorForClass.id
    if (action === 'skip') return null
    if (action === 'reopen') {
      await db.from('heart_rate_sessions').update({ ended_at: null }).eq('id', priorForClass.id)
      return priorForClass.id
    }
    const { data: created, error: createErr } = await db
      .from('heart_rate_sessions')
      .insert({
        contact_id: contactId, location_id: locationId, booking_id: null, source: 'ble_bridge',
        device_identifier: deviceKey, started_at: nowIso, max_hr_used: maxHr,
        glofox_event_id: occ.glofox_event_id, class_name: occ.class_name, class_link_source: linkSource,
      })
      .select('id').single()
    if (createErr) {
      logWarn('bridge-samples', 'auto-create (class) session failed', { err: createErr, contactId, glofox_event_id: occ.glofox_event_id })
      return null
    }
    return created?.id || null
  }

  // (c) Test mode — presence-less session any time (no class, no booking).
  if (testModeActive) {
    const { data: created, error: tErr } = await db
      .from('heart_rate_sessions')
      .insert({
        contact_id: contactId, location_id: locationId, booking_id: null, source: 'ble_bridge',
        device_identifier: deviceKey, started_at: nowIso, max_hr_used: maxHr,
        glofox_event_id: null, class_name: null, class_link_source: null,
      })
      .select('id').single()
    if (tErr) {
      logWarn('bridge-samples', 'auto-create (test mode) session failed', { err: tErr, contactId })
      return null
    }
    return created?.id || null
  }

  // (d) FALLBACK: an in-progress native CRM booking (consultation / PT).
  const yesterdayIso = new Date(nowMs - 24 * 3600_000).toISOString().slice(0, 10)
  const tomorrowIso = new Date(nowMs + 24 * 3600_000).toISOString().slice(0, 10)
  const { data: bookings } = await db
    .from('bookings')
    .select('id, booking_date, start_time, event_type_id, status')
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .in('status', ['confirmed', 'attended'])
    .gte('booking_date', yesterdayIso)
    .lte('booking_date', tomorrowIso)

  let activeBooking = null
  for (const b of bookings || []) {
    if (!b.booking_date || !b.start_time) continue
    const bookingMs = dublinWallClockToMs(b.booking_date, b.start_time)
    if (!Number.isFinite(bookingMs)) continue
    const lo = nowMs - BOOKING_WINDOW_MS
    const hi = nowMs + BOOKING_PRE_GRACE_MS
    if (bookingMs >= lo && bookingMs <= hi) {
      if (!activeBooking || Math.abs(bookingMs - nowMs) < Math.abs(activeBooking.bookingMs - nowMs)) {
        activeBooking = { ...b, bookingMs }
      }
    }
  }
  if (!activeBooking) return null

  const { data: created, error: createErr } = await db
    .from('heart_rate_sessions')
    .insert({
      contact_id: contactId, location_id: locationId, booking_id: activeBooking.id, source: 'ble_bridge',
      device_identifier: deviceKey, started_at: nowIso, max_hr_used: maxHr,
    })
    .select('id').single()
  if (createErr) {
    logWarn('bridge-samples', 'auto-create session failed', { err: createErr, contactId, bookingId: activeBooking.id })
    return null
  }
  return created?.id || null
}
```

> NOTE: `resolveCurrentOccurrence` returns `{ glofox_event_id, class_name }`. `resolveBookedOccurrenceForMember` returns the same shape, so `occ.class_name` / `occ.glofox_event_id` are valid in both branches.

- [ ] **Step 6: Run the new + existing bridge tests**

Run: `npx vitest run src/lib/bridge-samples.test.js`
Expected: PASS — new booking-first/test-mode tests green AND the existing anon-strap + helper tests still green. If an existing test asserted the old null-when-no-class behaviour for a registered device, confirm it still holds (test mode off → still null).

- [ ] **Step 7: Commit**

```bash
git add src/lib/bridge-samples.js src/lib/bridge-samples.test.js
git commit -m "HR-ROUTE.5 — findOrCreateAutoSession: booking-first → presence → test-mode, class-keyed dedup"
```

---

## Task 6: `pairOverride` booking-first class stamp

Manual pair lands the coach-picked member on their booked class (consistent with auto path).

**Files:**
- Modify: `src/lib/live-class.js` (`pairOverride`)
- Test: `src/lib/live-class.test.js` (if present; else skip the test step and rely on the build)

- [ ] **Step 1: Update imports + the occurrence resolution in `pairOverride`**

In `src/lib/live-class.js`, extend the class-bookings import:

```js
import { lookupBookedMember, resolveClassLinkSource, resolveBookedOccurrenceForMember } from '@/lib/class-bookings'
```

Replace the `liveClass` resolution block inside `pairOverride` (the `const liveClass = await resolveCurrentOccurrence(...)` … `linkSource` lines) with booking-first-then-time:

```js
  // Which class is running for THIS member now? Booking-first (wide), then the
  // location-wide live class (presence). Mirrors the bridge auto path.
  const BOOKED_PRE_MS = 45 * 60_000
  const BOOKED_POST_MS = 30 * 60_000
  const bookedOcc = await resolveBookedOccurrenceForMember(db, {
    locationId, glofoxMemberId: contact?.glofox_member_id, nowMs, preMs: BOOKED_PRE_MS, postMs: BOOKED_POST_MS,
  })
  const liveClass = bookedOcc || await resolveCurrentOccurrence(db, { locationId, nowMs })
  const booked = liveClass
    ? (bookedOcc ? true : await lookupBookedMember(db, { locationId, glofoxEventId: liveClass.glofox_event_id, glofoxMemberId: contact?.glofox_member_id }))
    : false
  const linkSource = resolveClassLinkSource({ liveClass, booked }) // 'booked' | 'presence' | null
```

- [ ] **Step 2: Verify the suite + build**

Run: `npx vitest run src/lib/live-class.test.js` (if the file exists) then `npm test`
Expected: PASS — `pairOverride` still inserts/updates a session with a valid `class_link_source`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/live-class.js
git commit -m "HR-ROUTE.6 — pairOverride: booking-first class stamp (parity with bridge auto path)"
```

---

## Task 7: Defer the stale auto-close for in-class sessions

**Files:**
- Modify: `src/app/api/cron/auto-end-stale-hr-sessions/route.js`
- Test: `src/app/api/cron/auto-end-stale-hr-sessions/route.test.js`

- [ ] **Step 1: Write the failing test**

Add to `src/app/api/cron/auto-end-stale-hr-sessions/route.test.js` a unit test of the new filter. First inspect the file's existing harness; this test targets the exported pure decision via the lifecycle lib, plus an integration assertion that a deferred session is not ended. If the route file does not already expose a seam, assert through the lifecycle helper directly (already covered in Task 4) AND add this integration test:

```js
import { describe, it, expect, vi } from 'vitest'

// A class session silent mid-class must NOT be closed; the cron should defer it.
it('defers closing a class-linked session while its class is still live', async () => {
  const nowMs = Date.parse('2026-06-27T08:30:00Z')
  vi.setSystemTime(nowMs)
  const ended = []
  // Mock createServerClient + endSession so we can assert what gets closed.
  vi.doMock('@/lib/supabase', () => ({
    createServerClient: () => ({
      from: (t) => {
        if (t === 'heart_rate_sessions') {
          return {
            select: () => ({
              is: () => ({
                not: () => ({ lt: () => Promise.resolve({ data: [{ id: 's-class', last_sample_at: '2026-06-27T08:20:00Z', started_at: '2026-06-27T08:00:00Z', glofox_event_id: 'e8' }] }) }),
                lt: () => Promise.resolve({ data: [] }),
              }),
              not: () => ({ is: () => ({ not: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [] }) }) }) }) }),
              in: () => Promise.resolve({ data: [{ glofox_event_id: 'e8', ends_at: '2026-06-27T09:00:00Z' }] }),
            }),
          }
        }
        if (t === 'class_occurrences') return { select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: [{ glofox_event_id: 'e8', ends_at: '2026-06-27T09:00:00Z' }] }) }) }) }
        return { select: () => ({}) }
      },
    }),
  }))
  vi.doMock('@/lib/live-class', () => ({ endSession: (_db, id) => { ended.push(id); return Promise.resolve({ ok: true }) } }))
  vi.doMock('@/lib/hr-post-class-email', () => ({ sendPostClassEmail: () => Promise.resolve({ ok: true, skipped: 'no-email' }) }))
  vi.doMock('@/lib/customer-push', () => ({ sendCustomerPush: () => Promise.resolve() }))
  vi.doMock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: () => Promise.resolve() }))
  process.env.CRON_SECRET = 'x'
  const { GET } = await import('./route.js')
  const res = await GET(new Request('http://x', { headers: { authorization: 'Bearer x' } }))
  await res.json()
  expect(ended).not.toContain('s-class')
})
```

> If the existing test harness in this file differs, adapt the mock shape to it — the assertion that matters is `ended` does **not** contain the still-in-class session.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/cron/auto-end-stale-hr-sessions/route.test.js -t "defers closing"`
Expected: FAIL (the session is currently ended on 5-min silence).

- [ ] **Step 3: Implement the deferral**

In `src/app/api/cron/auto-end-stale-hr-sessions/route.js`:

1. Import the lifecycle helper and constants, and drop the local `STALE_AFTER_MS` / `MAX_SESSION_LENGTH_MS` definitions in favour of the shared ones:

```js
import { shouldCloseStaleSession, STALE_AFTER_MS, MAX_SESSION_LENGTH_MS } from '@/lib/hr-session-lifecycle'
```

2. Add `glofox_event_id` to both candidate selects:

```js
  const [{ data: silentRows }, { data: longRows }] = await Promise.all([
    db.from('heart_rate_sessions')
      .select('id, last_sample_at, started_at, glofox_event_id')
      .is('ended_at', null)
      .not('last_sample_at', 'is', null)
      .lt('last_sample_at', staleCutoff),
    db.from('heart_rate_sessions')
      .select('id, last_sample_at, started_at, glofox_event_id')
      .is('ended_at', null)
      .lt('started_at', longCutoff),
  ])
```

3. Replace the `toEnd` Map build with: collect candidates, fetch their occurrences' `ends_at`, and filter via `shouldCloseStaleSession`:

```js
  const candidates = new Map()
  for (const r of silentRows || []) candidates.set(r.id, r)
  for (const r of longRows || [])   candidates.set(r.id, candidates.get(r.id) || r)

  // Fetch ends_at for the class-linked candidates so we can defer closing a
  // session whose class is still running (mid-class drop-out is rejoinable).
  const eventIds = [...new Set([...candidates.values()].map((r) => r.glofox_event_id).filter(Boolean))]
  let occByEvent = new Map()
  if (eventIds.length) {
    const { data: occs } = await db
      .from('class_occurrences').select('glofox_event_id, ends_at').in('glofox_event_id', eventIds)
    occByEvent = new Map((occs || []).map((o) => [o.glofox_event_id, o]))
  }

  const toEnd = new Map()
  for (const [id, r] of candidates) {
    const occ = r.glofox_event_id ? occByEvent.get(r.glofox_event_id) || null : null
    if (shouldCloseStaleSession({ session: r, occ, nowMs })) toEnd.set(id, r)
  }
```

(The downstream `for (const [sessionId] of toEnd)` loop and Phase 2 emails are unchanged.)

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `npx vitest run src/app/api/cron/auto-end-stale-hr-sessions/route.test.js` then `npm test`
Expected: PASS — the deferral test green; existing close/email tests still green (a non-class silent session still closes).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/auto-end-stale-hr-sessions/route.js src/app/api/cron/auto-end-stale-hr-sessions/route.test.js
git commit -m "HR-ROUTE.7 — defer stale-close for in-class sessions (rejoin + one email at class end)"
```

---

## Task 8: Test-mode route + surface in `/api/live` GET

**Files:**
- Create: `src/app/api/live/[locationId]/test-mode/route.js`
- Modify: `src/app/api/live/[locationId]/route.js` (return `test_mode_until`)
- Modify: `src/lib/openapi.js` (register route)

- [ ] **Step 1: Implement the route**

Create `src/app/api/live/[locationId]/test-mode/route.js`:

```js
// POST/DELETE /api/live/[locationId]/test-mode
//
// Staff HR test mode (mig 321): while active, a registered strap routes to its
// member's session any time (no live class). Time-boxed + self-expiring.
// POST body: { minutes?: number }  (default 120, clamped 1..240)
// Auth: master / owner / manager / head_coach at the location.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['owner', 'manager', 'head_coach']
const DEFAULT_MINUTES = 120
const MAX_MINUTES = 240

const Body = z.object({ minutes: z.number().int().positive().optional() })

function guard(user, locationId) {
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (!user.isMaster && !ALLOWED_ROLES.includes(user.role)) return NextResponse.json({ ok: false, error: 'Manager only' }, { status: 403 })
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  return null
}

export async function POST(request, props) {
  const { locationId } = await props.params
  const user = await getCurrentUser()
  const denied = guard(user, locationId)
  if (denied) return denied

  const v = await validateBody(request, Body, { allowEmpty: true })
  if (!v.ok) return v.response
  const minutes = Math.min(MAX_MINUTES, Math.max(1, v.data?.minutes || DEFAULT_MINUTES))
  const until = new Date(Date.now() + minutes * 60_000).toISOString()

  const db = createServerClient()
  const { error } = await db.from('ble_bridges').update({ test_mode_until: until }).eq('location_id', locationId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  logInfo('live-test-mode', 'enabled', { locationId, minutes, by: user.id })
  return NextResponse.json({ ok: true, test_mode_until: until })
}

export async function DELETE(_request, props) {
  const { locationId } = await props.params
  const user = await getCurrentUser()
  const denied = guard(user, locationId)
  if (denied) return denied

  const db = createServerClient()
  const { error } = await db.from('ble_bridges').update({ test_mode_until: null }).eq('location_id', locationId)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, test_mode_until: null })
}
```

- [ ] **Step 2: Surface `test_mode_until` in the live GET**

In `src/app/api/live/[locationId]/route.js`, after the existing `Promise.all`, fetch the soonest active flag and add it to the response. Add this query into the `Promise.all` array (and a binding), or as a follow-up read:

```js
  const { data: bridges } = await db
    .from('ble_bridges').select('test_mode_until').eq('location_id', locationId)
  const testModeUntil = (bridges || [])
    .map((b) => b.test_mode_until).filter(Boolean)
    .map((t) => new Date(t).getTime()).filter((t) => t > Date.now())
    .sort((a, b) => b - a)[0]
```

Add `test_mode_until: testModeUntil ? new Date(testModeUntil).toISOString() : null` to the returned JSON object.

- [ ] **Step 3: Register in openapi.js**

In `src/lib/openapi.js`, add a path entry for `/api/live/{locationId}/test-mode` (POST + DELETE), mirroring the existing `/api/live/{locationId}/pair` entry's shape (path param `locationId`, manager-gated, `{ ok, test_mode_until }` response).

- [ ] **Step 4: Verify route guard + build**

Run: `npm run check:route-guards && npm run build`
Expected: route-guards PASS (the route uses `getCurrentUser` + scope check); build resolves the new route.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/live/[locationId]/test-mode/route.js src/app/api/live/[locationId]/route.js src/lib/openapi.js
git commit -m "HR-ROUTE.8 — /api/live/[id]/test-mode POST/DELETE (manager+) + surface test_mode_until"
```

---

## Task 9: Layer 3 — unmapped straps on the public TV feed

**Files:**
- Modify: `src/app/api/public/live/[locationId]/route.js` (add `available_straps`)
- Modify: `src/app/tv/[locationId]/LiveTvClient.jsx` (render unpaired tiles)

- [ ] **Step 1: Add `available_straps` to the public feed**

In `src/app/api/public/live/[locationId]/route.js`:

1. Import the helpers:

```js
import { getAvailableStraps } from '@/lib/live-class'
import { maskStrapLabel } from '@/lib/bridge-samples'
```

2. After the bridge block, fetch + shape available straps (privacy-masked), and include them in **both** return statements (the early `sessions: []` return and the final return):

```js
  const rawStraps = await getAvailableStraps(db, locationId)
  const availableStraps = (rawStraps || []).map((s) => ({
    key: s.device_key,
    label: maskStrapLabel(s.device_key),
    protocol: s.protocol,
    currentBpm: s.lastBpm ?? null,
  }))
```

Add `available_straps: availableStraps` to each `NextResponse.json({...})` payload.

- [ ] **Step 2: Render unpaired tiles on the TV**

In `src/app/tv/[locationId]/LiveTvClient.jsx`, read `const availableStraps = data?.available_straps || []` next to `const sessions = data?.sessions || []`, and after the sessions grid render a muted "Unpaired" row when `availableStraps.length > 0`:

```jsx
{availableStraps.length > 0 && (
  <div className="mt-6">
    <p className="mb-2 text-xs uppercase tracking-wide text-white/40">Unpaired straps</p>
    <div className="flex flex-wrap gap-3">
      {availableStraps.map((s) => (
        <div key={s.key} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 opacity-70">
          <span className="font-mono text-sm text-white/70">{s.label}</span>
          <span className="text-lg font-semibold tabular-nums text-white">
            {s.currentBpm ?? '—'}<span className="ml-1 text-xs font-normal text-white/40">bpm</span>
          </span>
        </div>
      ))}
    </div>
  </div>
)}
```

> Match the surrounding LiveTvClient styling tokens (it's a black kiosk — `text-white`, `bg-white/5`). Adapt class names to the file's existing palette if it differs.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS — both files resolve; the TV page renders unpaired tiles when present.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/public/live/[locationId]/route.js src/app/tv/[locationId]/LiveTvClient.jsx
git commit -m "HR-ROUTE.9 — show unpaired straps on the TV by number (privacy-masked), no pairing needed"
```

---

## Task 10: Coach `/live` test-mode toggle + countdown banner

**Files:**
- Modify: `src/app/live/[locationId]/LiveClassClient.jsx`

- [ ] **Step 1: Add the control component**

In `src/app/live/[locationId]/LiveClassClient.jsx`, add a `TestModeControl` component and render it near the top of the page body. It reads `test_mode_until` from the polled `/api/live` data (already fetched by this client) and POSTs/DELETEs the new route:

```jsx
function TestModeControl({ locationId, testModeUntil, onChange }) {
  const [busy, setBusy] = useState(false)
  const activeMs = testModeUntil ? new Date(testModeUntil).getTime() : 0
  const active = activeMs > Date.now()
  const minsLeft = active ? Math.max(1, Math.round((activeMs - Date.now()) / 60000)) : 0

  async function enable() {
    setBusy(true)
    try {
      const res = await fetch(`/api/live/${locationId}/test-mode`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes: 120 }),
      })
      const json = await res.json()
      if (json.ok) onChange?.(json.test_mode_until)
    } finally { setBusy(false) }
  }
  async function disable() {
    setBusy(true)
    try {
      const res = await fetch(`/api/live/${locationId}/test-mode`, { method: 'DELETE' })
      const json = await res.json()
      if (json.ok) onChange?.(null)
    } finally { setBusy(false) }
  }

  if (active) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm">
        <span className="font-semibold text-amber-800">HR test mode on</span>
        <span className="text-amber-700">registered straps route for ~{minsLeft} min</span>
        <button type="button" onClick={disable} disabled={busy} className="ml-auto rounded-md bg-amber-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50">Turn off</button>
      </div>
    )
  }
  return (
    <button type="button" onClick={enable} disabled={busy} className="mb-4 rounded-md border border-un1t-border px-3 py-1.5 text-sm font-medium hover:bg-un1t-surface disabled:opacity-50">
      Enable HR test mode (2h)
    </button>
  )
}
```

- [ ] **Step 2: Wire it into the client**

Where the client stores polled data, surface `test_mode_until`. Add local state `const [testModeUntil, setTestModeUntil] = useState(null)`, set it from each poll (`setTestModeUntil(json.test_mode_until || null)`), and render near the top of the returned layout:

```jsx
<TestModeControl locationId={locationId} testModeUntil={testModeUntil} onChange={setTestModeUntil} />
```

> The poll already runs ~2s; the banner countdown updates as data refreshes. No separate timer needed.

- [ ] **Step 3: Verify build + lint**

Run: `npm run build && npx next lint`
Expected: PASS — every non-submit `<button>` has `type="button"` (they do); no `<a>`-for-pages lint.

- [ ] **Step 4: Commit**

```bash
git add src/app/live/[locationId]/LiveClassClient.jsx
git commit -m "HR-ROUTE.10 — coach /live: HR test-mode toggle + active countdown banner (manager+)"
```

---

## Task 11: Docs + full CI mirror + advisors + PR

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Add a CHANGELOG entry**

Append a numbered Done entry to `docs/CHANGELOG.md` summarising HR-ROUTE: booking-first class mapping (45/30 behind a booking; presence stays 20/10), time-boxed staff test mode (mig 321), unpaired straps shown on the TV by number (privacy-masked), and class-aware lifecycle (defer stale-close → rejoin + one email at class end). Cite the spec/plan paths.

- [ ] **Step 2: Run the full CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```
Expected: all green. (No new `WEB_PERMISSIONS` key was added — the test-mode route reuses the live-view staff gate — so mobile-parity needs nothing. If parity flags anything, add a `WEB_ONLY_OK` note explaining the in-route manager gate.)

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: PASS (new routes/pages resolve under Turbopack).

- [ ] **Step 4: Re-run advisors after the migration**

Confirm `get_advisors` (type=security) on project `iyvtbjjxdggiadzwwvdj` shows no new findings from mig 321.

- [ ] **Step 5: Commit + push + PR**

```bash
git add docs/CHANGELOG.md
git commit -m "HR-ROUTE.11 — CHANGELOG: HR booking-first routing + test mode + unpaired display + lifecycle"
git push -u origin HEAD
gh pr create --base main --fill
```
Report the PR URL.

---

## Self-review (completed by plan author)

**Spec coverage:** Layer 1 → Tasks 3, 5, 6. Layer 2 → Tasks 1, 5, 8, 10. Layer 3 → Tasks 2, 9. Layer 4 → Tasks 4, 5 (class-keyed create/reopen/skip), 7 (defer close). Defaults table values are pinned in Tasks 4 (`CLASS_END_GRACE_MS`/`STALE`/`MAX`) and 5 (`BOOKED_PRE/POST_MS`) and 8 (`MAX_MINUTES`). Privacy masking → Task 2/9. Email-once → Tasks 4/7. No spec requirement is unmapped.

**Placeholder scan:** every code step shows real code; the one judgement call ("match LiveTvClient palette") is bounded with the exact tokens to use.

**Type consistency:** `resolveBookedOccurrenceForMember` and `resolveCurrentOccurrence` both return `{ glofox_event_id, class_name }`; `findOrCreateAutoSession` consumes `occ.class_name`/`occ.glofox_event_id` consistently. `classSessionAction` returns the exact set `'create'|'return'|'reopen'|'skip'` consumed in Task 5. `testModeActive` is the same name threaded from `resolveStrapsForBatch` → `findOrCreateAutoSession`. Lifecycle constants are defined once in `hr-session-lifecycle.js` and imported by the cron.
