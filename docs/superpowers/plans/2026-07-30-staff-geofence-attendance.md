# Staff Geofence Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Passive staff attendance — the CRM mobile app auto-stamps shift arrivals when a staff phone enters a geofence around the gym, with a mandatory background-location permission gate for staff.

**Architecture:** A new `source='geofence'` feeds the existing `staff_attendance_events` + `shift_assignments.start_time_override` stamping pipeline (shared `matchArrivalToShift` etc. from `src/lib/staff-attendance.js`). Config lives in `locations.settings.geofence` (FREQ-CAP.1 blob shape). Mobile registers OS geofences via `expo-location` + `expo-task-manager` (native → runtimeVersion 2.2.0, NOT OTA-able) and blocks the tab tree behind a `LocationGate` until background permission is granted.

**Tech Stack:** Next.js 16 App Router routes, Supabase (service-role client), Zod, Vitest; Expo SDK 57 (expo-location, expo-task-manager, expo-secure-store).

**Spec:** `docs/superpowers/specs/2026-07-30-staff-geofence-attendance-design.md`
**Worktree/branch:** `~/code/un1t-crm-geofence` on `feat/geofence-attendance`

**Rules that bind every task** (from CLAUDE.md — violating these fails audit):
- supabase-js builders: `try/await/catch`, never `.catch()`; every `.insert()/.update()` awaited.
- No `new Date(\`${d}T${t}Z\`)`; no `new Date().toISOString().slice(...)` for a business "today".
- Response shape `{ success, data?, error? }`; detail routes 404 not 403; `type="button"` on non-submit buttons.
- Mobile never imports `src/lib`; mobile API calls only via `api()`/`authHeaders()` from `mobile/lib/api.js`.
- Status chips `bg-<c>-500/10 text-<c>-700` (or the SourceBadges `bg-*-50 text-*-800` house shape).
- Commit after each task: `GEO-ATT.<n> — <summary>`.

---

### Task 1: Migration 460 — geofence source + exempt flag

**Files:**
- Create: `supabase/migrations/460_geofence_attendance.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 460_geofence_attendance.sql
-- GEO-ATT.1 — passive staff attendance via mobile geofencing.
--
-- 1. staff_attendance_events.source gains 'geofence' (third auto
--    pipeline besides unifi_access / protect; manual stays).
--    The CHECK was written inline in mig 120 so Postgres auto-named
--    it staff_attendance_events_source_check (precedent: mig 120's
--    webhook_events_provider_check recreate, cited by mig 122).
-- 2. profile_locations.geofence_exempt — per-assignment opt-out.
--    Exempt staff are never permission-gated in the mobile app and
--    never stamped by geofence (phoneless staff, contractors, the
--    Apple review account, GDPR objections).
--
-- Location-level config (enabled/lat/lng/radius/gate_copy) lives in
-- locations.settings.geofence (JSONB) — no DDL needed for it.

ALTER TABLE public.staff_attendance_events
  DROP CONSTRAINT IF EXISTS staff_attendance_events_source_check;
ALTER TABLE public.staff_attendance_events
  ADD CONSTRAINT staff_attendance_events_source_check
  CHECK (source IN ('unifi_access', 'protect', 'manual', 'geofence'));

ALTER TABLE public.profile_locations
  ADD COLUMN IF NOT EXISTS geofence_exempt boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profile_locations.geofence_exempt IS
  'GEO-ATT (mig 460): true = this staff member is excluded from mobile geofence attendance at this location — never permission-gated, never auto-stamped by source=geofence.';
```

- [ ] **Step 2: Sanity-check numbering** — `ls supabase/migrations | sort -n | tail -3` must show 459 as the previous latest and no other 460.
- [ ] **Step 3: Commit** — `git add supabase/migrations/460_geofence_attendance.sql && git commit -m "GEO-ATT.1 — mig 460: geofence attendance source + profile_locations.geofence_exempt"`

**Do NOT apply the migration** — the supervisor applies it via Supabase MCP against `iyvtbjjxdggiadzwwvdj` before merge (forward-only invariant), then runs `get_advisors`.

---

### Task 2: `src/lib/geofence-attendance.js` — settings reader (TDD)

**Files:**
- Create: `src/lib/geofence-attendance.js`
- Create: `src/lib/geofence-attendance.test.js`

Model: `frequencyCapFromLocationSettings` in `src/lib/frequency-cap.js`.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/geofence-attendance.test.js
import { describe, it, expect } from 'vitest'
import {
  geofenceFromLocationSettings,
  geofenceIsConfigured,
  DEFAULT_GATE_COPY,
  GEOFENCE_MIN_RADIUS_M,
  GEOFENCE_MAX_RADIUS_M,
} from './geofence-attendance.js'

describe('geofenceFromLocationSettings', () => {
  it('returns disabled defaults for null/missing settings', () => {
    for (const s of [null, undefined, {}, { geofence: null }]) {
      expect(geofenceFromLocationSettings(s)).toEqual({
        enabled: false, latitude: null, longitude: null,
        radiusM: 150, gateCopy: DEFAULT_GATE_COPY,
      })
    }
  })

  it('reads a fully-configured blob', () => {
    const g = geofenceFromLocationSettings({
      geofence: { enabled: true, latitude: 53.2905, longitude: -6.1988, radius_m: 200, gate_copy: 'Custom copy' },
    })
    expect(g).toEqual({ enabled: true, latitude: 53.2905, longitude: -6.1988, radiusM: 200, gateCopy: 'Custom copy' })
  })

  it('clamps radius into [GEOFENCE_MIN_RADIUS_M, GEOFENCE_MAX_RADIUS_M]', () => {
    expect(geofenceFromLocationSettings({ geofence: { radius_m: 5 } }).radiusM).toBe(GEOFENCE_MIN_RADIUS_M)
    expect(geofenceFromLocationSettings({ geofence: { radius_m: 99999 } }).radiusM).toBe(GEOFENCE_MAX_RADIUS_M)
  })

  it('rejects non-finite coordinates back to null', () => {
    const g = geofenceFromLocationSettings({ geofence: { enabled: true, latitude: 'x', longitude: Infinity } })
    expect(g.latitude).toBeNull()
    expect(g.longitude).toBeNull()
  })

  it('blank gate_copy falls back to the default', () => {
    expect(geofenceFromLocationSettings({ geofence: { gate_copy: '   ' } }).gateCopy).toBe(DEFAULT_GATE_COPY)
  })
})

describe('geofenceIsConfigured', () => {
  it('true only when enabled with finite lat+lng', () => {
    expect(geofenceIsConfigured({ enabled: true, latitude: 53.29, longitude: -6.19, radiusM: 150 })).toBe(true)
    expect(geofenceIsConfigured({ enabled: false, latitude: 53.29, longitude: -6.19, radiusM: 150 })).toBe(false)
    expect(geofenceIsConfigured({ enabled: true, latitude: null, longitude: -6.19, radiusM: 150 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/geofence-attendance.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement**

```js
// src/lib/geofence-attendance.js
//
// GEO-ATT (mig 460) — passive staff attendance via mobile geofencing.
// Location config lives in locations.settings.geofence:
//   { enabled, latitude, longitude, radius_m, gate_copy }
// This module owns defaults + normalisation (the FREQ-CAP.1 shape).

export const GEOFENCE_MIN_RADIUS_M = 50
export const GEOFENCE_MAX_RADIUS_M = 1000
const DEFAULT_RADIUS_M = 150

export const DEFAULT_GATE_COPY =
  'This app records when you arrive at the gym so your shift attendance is logged automatically. ' +
  'Only your arrival at the gym is detected — the app never tracks where you are anywhere else. ' +
  'To use the app, allow location access set to "Always".'

function finiteOrNull(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * Normalise locations.settings.geofence into a fully-defaulted object.
 * Never throws; garbage in → disabled defaults out.
 * @param {object|null} settings  the locations.settings JSONB value
 * @returns {{enabled: boolean, latitude: number|null, longitude: number|null, radiusM: number, gateCopy: string}}
 */
export function geofenceFromLocationSettings(settings) {
  const g = (settings && typeof settings === 'object' && settings.geofence && typeof settings.geofence === 'object')
    ? settings.geofence : {}
  const radiusRaw = finiteOrNull(g.radius_m)
  const radiusM = radiusRaw === null
    ? DEFAULT_RADIUS_M
    : Math.min(GEOFENCE_MAX_RADIUS_M, Math.max(GEOFENCE_MIN_RADIUS_M, Math.round(radiusRaw)))
  const gateCopy = (typeof g.gate_copy === 'string' && g.gate_copy.trim()) ? g.gate_copy.trim() : DEFAULT_GATE_COPY
  return {
    enabled: g.enabled === true,
    latitude: finiteOrNull(g.latitude),
    longitude: finiteOrNull(g.longitude),
    radiusM,
    gateCopy,
  }
}

/** A location only participates when enabled AND has real coordinates. */
export function geofenceIsConfigured(g) {
  return !!g && g.enabled === true && g.latitude !== null && g.longitude !== null
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/geofence-attendance.test.js` → all PASS.
- [ ] **Step 5: Commit** — `git commit -am "GEO-ATT.2 — geofence settings reader lib"`

---

### Task 3: `GET /api/attendance/geofence-config` (TDD)

**Files:**
- Create: `src/app/api/attendance/geofence-config/route.js`
- Create: `src/app/api/attendance/geofence-config/route.test.js`
- Modify: `src/lib/openapi.js` (append near the FREQ-CAP entries, `registry.registerPath` block)

Contract: for the **current user**, return every assigned location that is geofence-configured and where they are not exempt.

- [ ] **Step 1: Write the failing tests** (mocking pattern copied from `src/app/api/settings/scoring/route.test.js` — `vi.importActual` keeps the real `assertLocationAccess`):

```js
// src/app/api/attendance/geofence-config/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { DEFAULT_GATE_COPY } from '@/lib/geofence-attendance'

beforeEach(() => vi.clearAllMocks())

const req = () => new Request('http://x/api/attendance/geofence-config')
const staff = { id: 'prof-1', role: 'staff', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }] }

const GEO = { enabled: true, latitude: 53.2905, longitude: -6.1988, radius_m: 200 }

// profile_locations rows + locations rows behind one from() switch
function mockDb({ links, locs }) {
  createServerClient.mockReturnValue({
    from: (table) => ({
      select: () => ({
        eq: () => table === 'profile_locations'
          ? Promise.resolve({ data: links, error: null })
          : { in: () => Promise.resolve({ data: locs, error: null }) },
        in: () => Promise.resolve({ data: locs, error: null }),
      }),
    }),
  })
}

it('401 when unauthenticated', async () => {
  getCurrentUser.mockResolvedValue(null)
  expect((await GET(req())).status).toBe(401)
})

it('required=true with a region for an enabled, non-exempt assignment', async () => {
  getCurrentUser.mockResolvedValue(staff)
  mockDb({
    links: [{ location_id: 'loc1', geofence_exempt: false }],
    locs: [{ id: 'loc1', settings: { geofence: GEO } }],
  })
  const body = await (await GET(req())).json()
  expect(body.success).toBe(true)
  expect(body.data.required).toBe(true)
  expect(body.data.regions).toEqual([
    { location_id: 'loc1', latitude: 53.2905, longitude: -6.1988, radius_m: 200 },
  ])
  expect(body.data.gate_copy).toBe(DEFAULT_GATE_COPY)
})

it('required=false when exempt', async () => {
  getCurrentUser.mockResolvedValue(staff)
  mockDb({
    links: [{ location_id: 'loc1', geofence_exempt: true }],
    locs: [{ id: 'loc1', settings: { geofence: GEO } }],
  })
  const body = await (await GET(req())).json()
  expect(body.data.required).toBe(false)
  expect(body.data.regions).toEqual([])
})

it('required=false when the location blob is disabled or missing coords', async () => {
  getCurrentUser.mockResolvedValue(staff)
  mockDb({
    links: [{ location_id: 'loc1', geofence_exempt: false }],
    locs: [{ id: 'loc1', settings: { geofence: { ...GEO, enabled: false } } }],
  })
  expect((await (await GET(req())).json()).data.required).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/app/api/attendance/geofence-config/route.test.js` → FAIL.
- [ ] **Step 3: Implement**

```js
// GET /api/attendance/geofence-config
//
// GEO-ATT.3 — the mobile app calls this after auth bootstrap (and on
// foreground) to learn which geofence regions to register and whether
// the background-location permission gate applies to this user.
// Scoped to the caller's own assignments — no params, no IDOR surface.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { geofenceFromLocationSettings, geofenceIsConfigured } from '@/lib/geofence-attendance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: links, error: linkErr } = await db
    .from('profile_locations')
    .select('location_id, geofence_exempt')
    .eq('profile_id', user.id)
  if (linkErr) return NextResponse.json({ success: false, error: linkErr.message }, { status: 400 })

  const eligibleIds = (links || []).filter(l => !l.geofence_exempt).map(l => l.location_id)
  let regions = []
  let gateCopy = null
  if (eligibleIds.length > 0) {
    const { data: locs, error: locErr } = await db
      .from('locations')
      .select('id, settings')
      .in('id', eligibleIds)
    if (locErr) return NextResponse.json({ success: false, error: locErr.message }, { status: 400 })
    for (const loc of locs || []) {
      const g = geofenceFromLocationSettings(loc.settings)
      if (!geofenceIsConfigured(g)) continue
      regions.push({ location_id: loc.id, latitude: g.latitude, longitude: g.longitude, radius_m: g.radiusM })
      if (!gateCopy) gateCopy = g.gateCopy
    }
  }
  // iOS caps region monitoring at 20 per app — keep headroom.
  regions = regions.slice(0, 15)

  const { DEFAULT_GATE_COPY } = await import('@/lib/geofence-attendance')
  return NextResponse.json({
    success: true,
    data: { required: regions.length > 0, gate_copy: gateCopy || DEFAULT_GATE_COPY, regions },
  })
}
```

(Import `DEFAULT_GATE_COPY` statically at the top alongside the other named imports rather than the dynamic import shown — one import line: `import { geofenceFromLocationSettings, geofenceIsConfigured, DEFAULT_GATE_COPY } from '@/lib/geofence-attendance'`.)

- [ ] **Step 4: Run tests** → PASS. Also run `npm run check:route-guards` — the route must pass (it calls `getCurrentUser`).
- [ ] **Step 5: Register in openapi.js** — append after the comms-frequency-cap entries:

```js
// Geofence attendance (GEO-ATT, mig 460)
registry.registerPath({
  method: 'get',
  path: '/api/attendance/geofence-config',
  tags: ['Attendance'],
  security: [{ CookieAuth: [] }],
  summary: 'Geofence regions + permission-gate flag for the current user',
  description: 'Returns { required, gate_copy, regions:[{location_id,latitude,longitude,radius_m}] } for the caller\'s non-exempt assignments at geofence-enabled locations (locations.settings.geofence, mig 460). Mobile registers OS geofences from this and gates the app on background-location permission when required=true.',
  responses: { 200: { description: 'Config for the current user' } },
})
```

- [ ] **Step 6: Commit** — `git commit -am "GEO-ATT.3 — geofence-config endpoint for mobile"`

---

### Task 4: `POST /api/attendance/geofence-checkin` (TDD)

**Files:**
- Create: `src/app/api/attendance/geofence-checkin/route.js`
- Create: `src/app/api/attendance/geofence-checkin/route.test.js`
- Modify: `src/lib/openapi.js`

This is the core route. It mirrors the stamping block of `src/app/api/webhooks/unifi-access/route.js:267-343` exactly (shift query shape, race-guarded update, post-update verify, audit insert).

- [ ] **Step 1: Write the failing tests**

```js
// src/app/api/attendance/geofence-checkin/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => vi.clearAllMocks())

const staff = { id: 'prof-1', role: 'staff', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }] }
const GEO = { enabled: true, latitude: 53.2905, longitude: -6.1988, radius_m: 200 }

function postReq(body) {
  return new Request('http://x/api/attendance/geofence-checkin', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
const validBody = () => ({ location_id: 'a0000000-0000-0000-0000-000000000001', entered_at: new Date().toISOString() })

// Configurable fake DB. Tables: locations, profile_locations,
// staff_attendance_events (dedup select + insert), shift_assignments
// (select candidates + race-guarded update + post-update verify).
function mockDb({
  geo = GEO, exempt = false, recentGeofenceEvent = null,
  shiftRows = [], updateError = null, postUpdateStamp = undefined,
} = {}) {
  const inserted = []
  let updated = null
  createServerClient.mockReturnValue({
    from: (table) => {
      if (table === 'locations') return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({
          data: { id: 'a0000000-0000-0000-0000-000000000001', timezone: 'Europe/Dublin', settings: { geofence: geo } }, error: null }) }) }),
      }
      if (table === 'profile_locations') return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({
          data: { geofence_exempt: exempt }, error: null }) }) }) }),
      }
      if (table === 'staff_attendance_events') return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ gte: () => ({ limit: () => Promise.resolve({
          data: recentGeofenceEvent ? [recentGeofenceEvent] : [], error: null }) }) }) }) }) }),
        insert: (row) => { inserted.push(row); return Promise.resolve({ error: null }) },
      }
      if (table === 'shift_assignments') return {
        select: (cols) => cols.includes('block:')
          ? { eq: () => ({ is: () => ({ neq: () => ({ gte: () => ({ lte: () => ({ eq: () =>
              Promise.resolve({ data: shiftRows, error: null }) }) }) }) }) }) }
          : { eq: () => ({ single: () => Promise.resolve({ data: { start_time_override: postUpdateStamp }, error: null }) }) },
        update: (patch) => { updated = patch; return { eq: () => ({ is: () => Promise.resolve({ error: updateError }) }) } },
      }
      throw new Error(`unexpected table ${table}`)
    },
  })
  return { inserted: () => inserted, updated: () => updated }
}

// One shift starting 10 minutes ago, today, at loc1 (Dublin wall clock).
function nearbyShiftRow() {
  const now = new Date()
  const dub = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now.getTime() - 10 * 60000))
  const get = (t) => dub.find(p => p.type === t).value
  return {
    id: 'assign-1', profile_id: 'prof-1', status: 'scheduled', start_time_override: null,
    block: { id: 'blk-1', location_id: 'a0000000-0000-0000-0000-000000000001',
      block_date: `${get('year')}-${get('month')}-${get('day')}`,
      start_time: `${get('hour')}:${get('minute')}:00`, end_time: '23:59:00' },
  }
}

it('401 when unauthenticated', async () => {
  getCurrentUser.mockResolvedValue(null)
  expect((await POST(postReq(validBody()))).status).toBe(401)
})

it('400 on a malformed body', async () => {
  getCurrentUser.mockResolvedValue(staff)
  expect((await POST(postReq({ location_id: 'nope' }))).status).toBe(400)
})

it('404 when the location has geofencing disabled', async () => {
  getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
  mockDb({ geo: { ...GEO, enabled: false } })
  expect((await POST(postReq(validBody()))).status).toBe(404)
})

it('exempt staff → success with outcome geofence_exempt, no audit row', async () => {
  getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
  const db = mockDb({ exempt: true })
  const res = await POST(postReq(validBody()))
  const body = await res.json()
  expect(body.success).toBe(true)
  expect(body.data.match_outcome).toBe('geofence_exempt')
  expect(db.inserted().length).toBe(0)
})

it('dedups a second ping within 10 minutes (no new audit row)', async () => {
  getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
  const db = mockDb({ recentGeofenceEvent: { id: 'ev-1' } })
  const body = await (await POST(postReq(validBody()))).json()
  expect(body.data.match_outcome).toBe('duplicate')
  expect(db.inserted().length).toBe(0)
})

it('stamps a matching shift and logs matched', async () => {
  getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
  const db = mockDb({ shiftRows: [nearbyShiftRow()] })
  // post-update verify: the route reads back start_time_override and
  // expects its own stamp — make the mock echo whatever was written.
  const origMock = createServerClient.getMockImplementation()
  // simpler: run once to capture the stamp, assert insert shape
  const body = await (await POST(postReq(validBody()))).json()
  expect(body.success).toBe(true)
  expect(['matched', 'already_stamped']).toContain(body.data.match_outcome)
  expect(db.inserted().length).toBe(1)
  expect(db.inserted()[0].source).toBe('geofence')
  expect(db.inserted()[0].match_outcome).toBe(body.data.match_outcome)
})

it('no shift in window → no_shift_in_window, audit row still written', async () => {
  getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
  const db = mockDb({ shiftRows: [] })
  const body = await (await POST(postReq(validBody()))).json()
  expect(body.data.match_outcome).toBe('no_shift_in_window')
  expect(db.inserted().length).toBe(1)
})

it('clamps a client entered_at more than 5 min in the past to server now', async () => {
  getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
  const db = mockDb({ shiftRows: [] })
  const stale = new Date(Date.now() - 60 * 60000).toISOString()
  await POST(postReq({ ...validBody(), entered_at: stale }))
  const ev = db.inserted()[0]
  const delta = Math.abs(new Date(ev.event_at).getTime() - Date.now())
  expect(delta).toBeLessThan(10_000)
  expect(ev.payload.clamped).toBe(true)
})
```

For the `matched` verify path: in `mockDb`, make the post-update `single()` return `{ start_time_override: '<whatever update() wrote>.start_time_override' }` by capturing `updated` — i.e. `single: () => Promise.resolve({ data: { start_time_override: updated?.start_time_override ?? postUpdateStamp }, error: null })`. Then the first stamp test can assert `body.data.match_outcome === 'matched'` exactly. Implement it that way (the sketch above shows intent; wire `updated` into the verify leaf).

- [ ] **Step 2: Run to verify failure** → FAIL (module not found).
- [ ] **Step 3: Implement**

```js
// POST /api/attendance/geofence-checkin
//
// GEO-ATT.4 — the mobile app's geofence ENTER handler calls this.
// Mirrors the stamping pipeline of /api/webhooks/unifi-access (mig 120)
// with source='geofence' (mig 460). The caller can only stamp
// THEMSELVES (profile from the JWT) at a location they're assigned to,
// so unknown_user / wrong_location can't occur here.
//
// Outcomes returned (data.match_outcome):
//   matched | already_stamped | no_shift_in_window   → audit row written
//   duplicate (10-min flap dedup) | geofence_exempt  → NO audit row

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { geofenceFromLocationSettings, geofenceIsConfigured } from '@/lib/geofence-attendance'
import { resolveScheduledAt, matchArrivalToShift, arrivalToTimeOnly } from '@/lib/staff-attendance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CLOCK_SKEW_MS = 5 * 60_000   // trust client entered_at within ±5 min
const DEDUP_WINDOW_MS = 10 * 60_000 // one geofence event per profile+location per 10 min

const GeofenceCheckinSchema = z.object({
  location_id: uuidLike,
  entered_at: z.string().datetime({ offset: true }),
  device_name: z.string().max(80).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, GeofenceCheckinSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard

  const db = createServerClient()

  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, timezone, settings')
    .eq('id', body.location_id)
    .single()
  if (locErr || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  const geo = geofenceFromLocationSettings(location.settings)
  if (!geofenceIsConfigured(geo)) {
    // 404 not 403 — don't advertise which locations have the feature.
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  const locationTz = location.timezone || 'Europe/Dublin'

  const { data: link, error: linkErr } = await db
    .from('profile_locations')
    .select('geofence_exempt')
    .eq('profile_id', user.id)
    .eq('location_id', location.id)
    .maybeSingle()
  if (linkErr) return NextResponse.json({ success: false, error: linkErr.message }, { status: 400 })
  if (!link) return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  if (link.geofence_exempt) {
    return NextResponse.json({ success: true, data: { match_outcome: 'geofence_exempt' } })
  }

  // Clamp the client timestamp — phone clocks and queued retries are
  // untrusted; anything outside ±5 min becomes "now".
  const nowMs = Date.now()
  const clientMs = new Date(body.entered_at).getTime()
  const clamped = !Number.isFinite(clientMs) || Math.abs(nowMs - clientMs) > CLOCK_SKEW_MS
  const eventAt = clamped ? new Date(nowMs) : new Date(clientMs)

  // Region-flap dedup: one geofence event per profile+location per window.
  const sinceIso = new Date(eventAt.getTime() - DEDUP_WINDOW_MS).toISOString()
  const { data: recent, error: dupErr } = await db
    .from('staff_attendance_events')
    .select('id')
    .eq('profile_id', user.id)
    .eq('location_id', location.id)
    .eq('source', 'geofence')
    .gte('event_at', sinceIso)
    .limit(1)
  if (dupErr) return NextResponse.json({ success: false, error: dupErr.message }, { status: 400 })
  if (recent && recent.length > 0) {
    return NextResponse.json({ success: true, data: { match_outcome: 'duplicate' } })
  }

  // ── Shift match + race-guarded stamp (mirrors unifi-access) ──────
  let matchOutcome = 'no_shift_in_window'
  let matchedAssignmentId = null

  const dayBefore = new Date(eventAt.getTime() - 24 * 3600_000).toISOString().slice(0, 10)
  const dayAfter  = new Date(eventAt.getTime() + 24 * 3600_000).toISOString().slice(0, 10)

  const { data: rows } = await db
    .from('shift_assignments')
    .select(`
      id, profile_id, status, start_time_override,
      block:shift_blocks!inner ( id, location_id, block_date, start_time, end_time )
    `)
    .eq('profile_id', user.id)
    .is('start_time_override', null)
    .neq('status', 'cancelled')
    .gte('block.block_date', dayBefore)
    .lte('block.block_date', dayAfter)
    .eq('block.location_id', location.id)

  const shifts = (rows || [])
    .map((r) => {
      if (!r.block) return null
      const scheduledAt    = resolveScheduledAt(r.block.block_date, r.block.start_time, locationTz)
      const scheduledEndAt = resolveScheduledAt(r.block.block_date, r.block.end_time,   locationTz)
      return scheduledAt ? { id: r.id, scheduledAt, scheduledEndAt } : null
    })
    .filter(Boolean)

  const best = matchArrivalToShift(eventAt, shifts)
  if (best) {
    const stamp = arrivalToTimeOnly(eventAt, locationTz)
    const { error: updErr } = await db
      .from('shift_assignments')
      .update({ start_time_override: stamp })
      .eq('id', best.shift.id)
      .is('start_time_override', null)
    if (!updErr) {
      const { data: post } = await db
        .from('shift_assignments')
        .select('start_time_override')
        .eq('id', best.shift.id)
        .single()
      if (post && post.start_time_override === stamp) {
        matchedAssignmentId = best.shift.id
        matchOutcome = 'matched'
      } else {
        matchedAssignmentId = best.shift.id
        matchOutcome = 'already_stamped'
      }
    }
  }

  const { error: insErr } = await db
    .from('staff_attendance_events')
    .insert({
      profile_id: user.id,
      location_id: location.id,
      source: 'geofence',
      event_at: eventAt.toISOString(),
      matched_assignment_id: matchedAssignmentId,
      match_outcome: matchOutcome,
      payload: {
        device_name: body.device_name || null,
        client_entered_at: body.entered_at,
        clamped,
      },
    })
  if (insErr) return NextResponse.json({ success: false, error: insErr.message }, { status: 400 })

  return NextResponse.json({ success: true, data: { match_outcome: matchOutcome } })
}
```

Note on `.toISOString().slice(0, 10)`: takes an *argument* `new Date(x)` so the `no-utc-today` guardrail does not fire — and it's the exact day-band pattern the unifi-access webhook uses (±24h band makes TZ drift irrelevant).

- [ ] **Step 4: Run tests** → PASS. Run `npm run check:route-guards` and `npm run check:guardrails` → clean.
- [ ] **Step 5: Register in openapi.js** (after the geofence-config entry):

```js
registry.registerPath({
  method: 'post',
  path: '/api/attendance/geofence-checkin',
  tags: ['Attendance'],
  security: [{ CookieAuth: [] }],
  summary: 'Mobile geofence-entry check-in (stamps own shift)',
  description: 'Called by the mobile background geofence task on region ENTER. Stamps the caller\'s nearest unstamped shift at the location (±4h window, race-guarded) and writes a staff_attendance_events row with source=geofence (mig 460). Outcomes: matched | already_stamped | no_shift_in_window | duplicate | geofence_exempt.',
  request: {
    body: { content: { 'application/json': { schema: z.object({
      location_id: uuidLike,
      entered_at: z.string().datetime({ offset: true }),
      device_name: z.string().max(80).optional(),
    }).openapi('GeofenceCheckin') } } },
  },
  responses: {
    200: { description: '{ match_outcome }' },
    404: { description: 'Location not found / geofencing not enabled', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 6: Commit** — `git commit -am "GEO-ATT.4 — geofence-checkin stamping route"`

---

### Task 5: Location settings card (operator config UI)

**Files:**
- Create: `src/app/api/locations/[id]/geofence-attendance/route.js` (GET/PUT, clone the shape of `src/app/api/locations/[id]/comms-frequency-cap/route.js` quoted below)
- Create: `src/app/api/locations/[id]/geofence-attendance/route.test.js`
- Create: `src/components/settings/GeofenceAttendanceCard.jsx` (model: `src/components/settings/CommsFrequencyCapCard.jsx`)
- Modify: `src/app/settings/locations/[id]/page.js` — mount the card in the same section as `CommsFrequencyCapCard`
- Modify: `src/lib/openapi.js`

- [ ] **Step 1: Write failing route tests** — clone `src/app/api/settings/scoring/route.test.js` boilerplate. Required cases: 401 unauthenticated; 403 for `staff`/`head_coach`/`manager` (owner + master only — same `canEdit` as frequency-cap); 200 GET returns defaulted blob for empty settings; PUT merge-writes without clobbering sibling settings keys (seed `{ unifi: { host: 'x' } }` and assert it survives); PUT rejects latitude 91 / longitude 181 / radius 20 (400).
- [ ] **Step 2: Implement the route.** Schema:

```js
const GeofenceSettingsSchema = z.object({
  enabled: z.boolean(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  radius_m: z.number().int().min(GEOFENCE_MIN_RADIUS_M).max(GEOFENCE_MAX_RADIUS_M),
  gate_copy: z.string().max(2000).nullable(),
}).refine(v => !v.enabled || (v.latitude !== null && v.longitude !== null), {
  message: 'Latitude and longitude are required when geofencing is enabled',
})
```

GET returns `shape(location.settings)` = the normalised blob from `geofenceFromLocationSettings` plus `can_edit`. PUT merge-writes `settings.geofence = { enabled, latitude, longitude, radius_m, gate_copy }` exactly like the frequency-cap route's `updatedSettings` spread (`...(location.settings || {})`). Auth: `getCurrentUser` → owner/master `canEdit` → `validateBody` → `assertLocationAccess` → merge-write.
- [ ] **Step 3: Run route tests** → PASS.
- [ ] **Step 4: Build the card.** Copy `CommsFrequencyCapCard.jsx`'s fetch-on-mount → local state → dirty-check → PUT pattern. Fields: enabled toggle; latitude + longitude numeric inputs (step `0.000001`, placeholder `53.290500` / `-6.198800`, helper text "Find these in Google Maps → right-click the gym → copy coordinates"); radius number input (m); gate copy `<textarea>` with helper "Shown to staff when the app asks for Always location. Leave blank for the default." Every non-submit button gets `type="button"`. Save button disabled until dirty; on save show the returned normalised state.
- [ ] **Step 5: Mount it** in `src/app/settings/locations/[id]/page.js` directly below `CommsFrequencyCapCard` in the same `?section=` block, passing the same props shape that card receives (`locationId`).
- [ ] **Step 6: Register GET+PUT in openapi.js** (tags `['Attendance']`, same style as Task 3's entry, PUT body schema `.openapi('GeofenceSettingsSave')`).
- [ ] **Step 7: `npm run check:guardrails && npm run lint`** → clean. **Commit** — `git commit -am "GEO-ATT.5 — per-location geofence settings route + card"`

---

### Task 6: `geofence_exempt` end-to-end (schema → write path → StaffForm)

**Files:**
- Modify: `src/lib/schemas.js` — `assignmentSchema` (line ~107): add `geofence_exempt: z.boolean().optional(),` after `protect_face_id`.
- Modify: `src/lib/staff-write.js` (line ~194) — mirror the `protect_face_id` optional-key semantics exactly:

```js
    ...(Object.prototype.hasOwnProperty.call(a, 'geofence_exempt')
      ? { geofence_exempt: a.geofence_exempt === true } : {}),
```

- Modify: `src/components/StaffForm.jsx` — payload map (line ~404): add `geofence_exempt: !!a.geofence_exempt,` after `protect_face_id`; add a pill-switch toggle after the `ProtectFacePicker` block, cloning the Door Access toggle at lines 633–658:

```jsx
              {/* GEO-ATT (mig 460) — exclude this staff member from
                  mobile geofence attendance at this location: never
                  permission-gated in the app, never auto-stamped.
                  Keep ON for the Apple review account. */}
              {isEdit && (
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-sm">Geofence exempt</div>
                    <div className="text-xs text-un1t-subtle">
                      Skip auto attendance + the location permission requirement on mobile
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => updateAssignment(a.location_id, { geofence_exempt: !a.geofence_exempt })}
                    className={`w-10 h-5 rounded-full transition-colors shrink-0 ${
                      a.geofence_exempt ? 'bg-green-500' : 'bg-un1t-border'
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white transition-transform ${
                      a.geofence_exempt ? 'translate-x-5' : 'translate-x-0.5'
                    }`} />
                  </button>
                </div>
              )}
```

Also ensure the assignment state initialiser (where `unifi_user_id`/`protect_face_id` are seeded from the loaded staff row) seeds `geofence_exempt: !!l.geofence_exempt`.

- Test: extend the existing staff-write tests (`src/lib/staff-write.test.js` — find the `protect_face_id` optional-key cases and clone them): sends `geofence_exempt: true` → row gets `true`; omits the key → key absent from the row patch.

- [ ] **Step 1:** Write the two failing staff-write test cases. **Step 2:** run → FAIL. **Step 3:** make the three source edits. **Step 4:** run `npx vitest run src/lib/staff-write.test.js` → PASS; `npm test` → green. **Step 5: Commit** — `git commit -am "GEO-ATT.6 — geofence_exempt assignment flag + StaffForm toggle"`

---

### Task 7: Attendance report badge

**Files:**
- Modify: `src/components/AttendanceReportClient.jsx` — `SourceBadges` meta map (line ~237): add

```js
    geofence:     { label: 'Geofence', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200', title: 'Phone arrived at the gym (mobile geofence)' },
```

No API change — `/api/attendance` already returns all sources generically, and unknown sources already render via the fallback. This just gives it a proper label/colour (`bg-*-50 text-*-800` is the house-safe chip ramp).

- [ ] **Step 1:** Make the edit. **Step 2:** `npm run check:guardrails && npm run lint` → clean. **Step 3: Commit** — `git commit -am "GEO-ATT.7 — Geofence source badge on the attendance report"`

---

### Task 8: Mobile — native deps + config (runtimeVersion 2.2.0)

**Files:**
- Modify: `mobile/package.json` — add `"expo-location"` and `"expo-task-manager"` to dependencies. Use the SDK-57-pinned versions: run `cd mobile && npx expo install expo-location expo-task-manager` (expo install picks the SDK-compatible versions; do NOT hand-pick).
- Modify: `mobile/app.config.js`:
  - `version: '2.1.0'` → `'2.2.0'`
  - `runtimeVersion: '2.0.0'` → `'2.2.0'`, appending to the running comment log above it (mirror the existing entries' voice):

```js
  // 2.2.0 — GEO-ATT adds expo-location + expo-task-manager (native:
  // background geofencing for staff attendance). New lane: 2.0.x
  // installs stop receiving OTAs (frozen, NOT crashed) until users
  // install the 2.2.0 binary. Merge only as part of the 2.2.0 store
  // release.
```

  - plugins array — add:

```js
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Repset detects when you arrive at the gym so your shift attendance is logged automatically.',
        locationAlwaysAndWhenInUsePermission:
          'Allow "Always" so arrival is detected even when the app is closed. Only gym arrival is detected — never your location elsewhere.',
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
      },
    ],
```

  - iOS `infoPlist.UIBackgroundModes`: `['remote-notification']` → `['remote-notification', 'location']`.
- [ ] **Step 1:** `cd mobile && npx expo install expo-location expo-task-manager` (updates package.json + lock together). **Step 2:** make the app.config.js edits. **Step 3:** `cd mobile && npm install --package-lock-only` (lock re-sync invariant; verify the `"shared": "file:../shared"` `link: true` entry survived). **Step 4:** `npm run check:mobile-imports` from the repo root → clean. **Step 5: Commit** — `git commit -am "GEO-ATT.8 — expo-location/task-manager + 2.2.0 native lane config"`

---

### Task 9: Mobile — geofence task, queue, and region sync

**Files:**
- Create: `mobile/lib/geofence.js`

```js
// mobile/lib/geofence.js
//
// GEO-ATT — passive attendance. Three responsibilities:
//   1. The background geofence task (module top-level defineTask so it
//      exists on headless relaunch — imported from app/_layout.jsx).
//   2. A SecureStore-backed retry queue: ENTER events enqueue first,
//      then flush; failed posts survive until the next foreground.
//   3. syncGeofences(): fetch /api/attendance/geofence-config and
//      (re)register OS regions when the set changed.
//
// The task fires with the app killed: it can rely on module-level
// imports (supabase session restores from SecureStore inside api())
// but NOT on React state or AuthContext.

import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import * as SecureStore from 'expo-secure-store'
import { api } from './api'

export const GEOFENCE_TASK = 'geo-att-region-enter'
const QUEUE_KEY = 'geo_att_queue_v1'
const REGIONS_KEY = 'geo_att_regions_v1'
const QUEUE_MAX = 10

async function readQueue() {
  try {
    const raw = await SecureStore.getItemAsync(QUEUE_KEY)
    const q = raw ? JSON.parse(raw) : []
    return Array.isArray(q) ? q : []
  } catch { return [] }
}

async function writeQueue(q) {
  try { await SecureStore.setItemAsync(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX))) } catch {}
}

export async function enqueueCheckin(locationId) {
  const q = await readQueue()
  q.push({ location_id: locationId, entered_at: new Date().toISOString() })
  await writeQueue(q)
}

/** POST every queued check-in; keep whatever still fails. */
export async function flushQueue() {
  const q = await readQueue()
  if (q.length === 0) return
  const remaining = []
  for (const item of q) {
    try {
      const res = await api('/api/attendance/geofence-checkin', {
        method: 'POST',
        locationId: item.location_id,
        body: item,
      })
      // Server-rejected (4xx → success:false with a real error) is
      // terminal — retrying an exempt/disabled ping forever is noise.
      // Only network-shaped failures stay queued.
      if (!res.success && /^Network error/.test(res.error || '')) remaining.push(item)
    } catch { remaining.push(item) }
  }
  await writeQueue(remaining)
}

// ── Background task — MUST be at module top level ──────────────────
TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data) return
  const { eventType, region } = data
  if (eventType !== Location.GeofencingEventType.Enter) return
  if (!region?.identifier) return
  // identifier carries the CRM location_id (set in syncGeofences).
  await enqueueCheckin(region.identifier)
  await flushQueue()
})

/**
 * Fetch config and (re)register regions. Call after auth bootstrap and
 * on foreground. Safe to call repeatedly — no-ops when nothing changed.
 * Returns the config so callers (the gate) can reuse it.
 */
export async function syncGeofences() {
  const res = await api('/api/attendance/geofence-config')
  if (!res.success || !res.data) return null
  const { required, regions } = res.data

  let granted = false
  try {
    const bg = await Location.getBackgroundPermissionsAsync()
    granted = bg.status === 'granted'
  } catch { granted = false }

  const fingerprint = JSON.stringify(
    (regions || []).map(r => [r.location_id, r.latitude, r.longitude, r.radius_m]).sort()
  )
  let prev = null
  try { prev = await SecureStore.getItemAsync(REGIONS_KEY) } catch {}

  try {
    if (!required || !granted || (regions || []).length === 0) {
      const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)
      if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK)
      await SecureStore.setItemAsync(REGIONS_KEY, '')
    } else if (fingerprint !== prev) {
      await Location.startGeofencingAsync(GEOFENCE_TASK, regions.map(r => ({
        identifier: r.location_id,
        latitude: r.latitude,
        longitude: r.longitude,
        radius: r.radius_m,
        notifyOnEnter: true,
        notifyOnExit: false,
      })))
      await SecureStore.setItemAsync(REGIONS_KEY, fingerprint)
    }
  } catch {
    // Geofencing registration must never crash the app shell.
  }
  return res.data
}
```

- [ ] **Step 1:** Write the file. **Step 2:** `npm run check:mobile-imports` → clean (all imports are installed packages + `./api`). **Step 3: Commit** — `git commit -am "GEO-ATT.9 — mobile geofence task, retry queue, region sync"`

---

### Task 10: Mobile — LocationGate + wiring

**Files:**
- Create: `mobile/components/LocationGate.jsx`
- Modify: `mobile/app/_layout.jsx` — add `import '../lib/geofence'` with the other imports (registers the task on headless launch) and render `<GeofenceSync />` as a sibling of `SplashGate` / `NotificationRouter` (side-effect-only component — the file's header comment forbids reading `useAuth()` in the component that renders `<Stack>`).
- Modify: `mobile/app/(tabs)/_layout.jsx` — wrap the returned tab tree.

- [ ] **Step 1: Write `LocationGate.jsx`**

```jsx
// mobile/components/LocationGate.jsx
//
// GEO-ATT — hard gate (Richard, 2026-07-30): staff with geofence
// attendance enabled at any of their locations must grant background
// ("Always") location before they can use the app. Exempt staff and
// users at non-geofence locations get required=false and never see
// this. Re-checks on every foreground so returning from Settings
// unblocks without a relaunch.

import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable, AppState, Linking, Platform } from 'react-native'
import * as Location from 'expo-location'
import { useAuth } from '../lib/auth-context'
import { api } from '../lib/api'
import { syncGeofences } from '../lib/geofence'

export default function LocationGate({ children }) {
  const { session } = useAuth()
  // null = unknown (render children — never block on a fetch failure);
  // {required, gate_copy} once the config has loaded.
  const [config, setConfig] = useState(null)
  const [granted, setGranted] = useState(null)
  const [denied, setDenied] = useState(false) // permanently denied → Settings

  const check = useCallback(async () => {
    try {
      const bg = await Location.getBackgroundPermissionsAsync()
      setGranted(bg.status === 'granted')
      setDenied(bg.status === 'denied' && !bg.canAskAgain)
    } catch { setGranted(true) } // never brick the app on a permission API error
  }, [])

  useEffect(() => {
    if (!session) return
    api('/api/attendance/geofence-config').then(r => {
      if (r.success && r.data) setConfig(r.data)
    })
    check()
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') { check(); syncGeofences() }
    })
    return () => sub.remove()
  }, [session, check])

  // Once granted, make sure regions are registered.
  useEffect(() => { if (granted && config?.required) syncGeofences() }, [granted, config])

  const request = useCallback(async () => {
    try {
      const fg = await Location.requestForegroundPermissionsAsync()
      if (fg.status !== 'granted') { await check(); return }
      if (Platform.OS === 'android') {
        // Android 11+: background must be granted from the app's
        // settings screen — requestBackground opens the right UI.
        await Location.requestBackgroundPermissionsAsync()
      } else {
        await Location.requestBackgroundPermissionsAsync()
      }
      await check()
    } catch { await check() }
  }, [check])

  const blocked = config?.required === true && granted === false
  if (!blocked) return children

  return (
    <View className="flex-1 items-center justify-center bg-white px-8">
      <Text className="text-2xl font-poppins-bold text-center mb-4">Location required</Text>
      <Text className="text-base text-neutral-600 text-center mb-8">{config.gate_copy}</Text>
      <Pressable
        onPress={denied ? () => Linking.openSettings() : request}
        className="bg-black rounded-full px-8 py-4"
      >
        <Text className="text-white font-poppins-semibold">
          {denied ? 'Open Settings' : 'Allow location access'}
        </Text>
      </Pressable>
      <Text className="text-xs text-neutral-400 text-center mt-6">
        Set location to “Always” so arrival is detected with the app closed.
      </Text>
    </View>
  )
}
```

(Match the app's actual styling system — if sibling screens use NativeWind classes like above, keep them; if they use StyleSheet objects, convert to match. Check `mobile/app/(auth)/login.jsx` for the house style and mirror it, including the Poppins font-class names actually used.)

- [ ] **Step 2: Write `GeofenceSync`** — inline in `mobile/app/_layout.jsx` next to `SplashGate` (same side-effect-only pattern):

```jsx
// GEO-ATT — registers/refreshes geofence regions once auth is ready.
// Side-effect only; must NOT live in the component that renders <Stack>.
function GeofenceSync() {
  const { session, loading } = useAuth()
  useEffect(() => {
    if (!loading && session) syncGeofences()
  }, [loading, session])
  return null
}
```

with `import { syncGeofences } from '../lib/geofence'` (this import also registers the background task at module load — add a comment saying so). Render `<GeofenceSync />` next to `<NotificationRouter />`.

- [ ] **Step 3: Wire the gate** in `mobile/app/(tabs)/_layout.jsx`: after the `if (!session) return <Redirect …/>` guard, wrap the returned JSX: `return <LocationGate>{/* existing tabs tree */}</LocationGate>`.
- [ ] **Step 4:** `npm run check:mobile-imports && npm run check:mobile-parity` → clean.
- [ ] **Step 5: Commit** — `git commit -am "GEO-ATT.10 — LocationGate + geofence sync wiring"`

---

### Task 11: Docs + full CI mirror + build

- [ ] **Step 1:** Append a `### Phase 3 — mobile geofence (mig 460)` section to `docs/staff-attendance.md`: one paragraph (architecture pointer to the spec), the outcome taxonomy additions (`duplicate`, `geofence_exempt` — response-only, never stored), operator runbook (settings card fields; exempt toggle; **review account must be exempt** — cross-reference the review-login runbook), and the 2.2.0 native-lane note.
- [ ] **Step 2:** Add a `docs/CHANGELOG.md` entry (next number): `GEO-ATT — passive staff attendance via mobile geofencing (mig 460, native lane 2.2.0): geofence source + config blob + exempt flag + LocationGate. PR #<fill at PR time>.`
- [ ] **Step 3:** Full CI mirror from repo root: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails` → all green.
- [ ] **Step 4:** `npm run build` → passes (new routes/imports).
- [ ] **Step 5: Commit** — `git commit -am "GEO-ATT.11 — docs + changelog"`

---

## Supervisor-only steps (NOT for subagents)

1. Code-review audit of the full diff (superpowers:requesting-code-review): IDOR pass on both new routes ("what filters this if RLS is gone?" — answer must be `user.id` scoping + `assertLocationAccess`), builder-thenable scan, awaited writes, chip-contrast, `type="button"`.
2. Apply mig 460 via Supabase MCP (`apply_migration`, project `iyvtbjjxdggiadzwwvdj`) → `get_advisors` (security) → confirm no new findings.
3. Push branch + open PR (base main) — report URL to Richard. **Do not merge**: server side deploys on merge (dark — no location enabled), mobile needs the 2.2.0 EAS store build which Richard triggers.
4. Post-merge checklist for Richard (include in PR body): enable + set coords on Stillorgan's settings card; set the Apple review account's assignment to Geofence-exempt BEFORE submitting the 2.2.0 binary; App Review notes paragraph (employee-only app, attendance is core functionality); Play Console background-location declaration; staff-handbook line.

## Verification tour (supervisor, after implementation)

- `npx vitest run src/lib/geofence-attendance.test.js src/app/api/attendance` — feature tests green.
- Manual trace: POST body with a spoofed 2-hour-old `entered_at` → audit row's `event_at` ≈ now, `payload.clamped=true`.
- Grep audit: `grep -rn "\.catch(" src/app/api/attendance src/lib/geofence-attendance.js` → nothing on builders; `grep -n "console.log" <new files>` → none.
