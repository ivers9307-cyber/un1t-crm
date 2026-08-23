# Home Physical-Location Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Home becomes a geofence-aware surface (on-site → that studio's controls + today's roster; offsite → your 7-day cross-studio shifts), today's dashboards move to a new Dashboard tab, and every device-control screen grows an always-visible detected/manual location pill with a per-visit override.

**Architecture:** Two location contexts — the existing `activeLocation` (never written by this work) and a new physical location resolved on focus from the attendance geofence regions. Pure logic lives in vitest-covered `mobile/lib/*.js` modules with zero native imports (the `geofence-permission.js` pattern); one thin hook wraps `expo-location`. Control screens resolve `loc param (manual override) ?? physical (detected) ?? activeLocation (manual)` and pass that id to their existing explicit-`locationId` wire layers. One additive server field (`all_regions` on geofence-config).

**Tech Stack:** Expo / React Native + expo-router + NativeWind, `expo-location` (already a native dep — no `runtimeVersion` bump), vitest from repo root, Next.js API routes.

**Spec:** `docs/superpowers/specs/2026-08-23-home-physical-location-design.md`

**Worktree/branch:** `.claude/worktrees/home-physical-location`, branch `home-physical-location` off `origin/main` (`c0d18f0a`). Commit prefix: `HOME-LOC.<n>`.

**Repo invariants that bite here:**
- Run vitest from the REPO ROOT (`npx vitest run <path>`), not from `mobile/`.
- `mobile/lib` modules under test must have NO native imports — vitest runs them in Node.
- `shared/dublin-time.js` and pair-synced files: we don't touch any; don't add imports into `shared/`.
- Absent is not zero: type-gate before coercing anything numeric (`Number.isFinite`).
- Never compare a client `Date.now()` to a server timestamp to decide UI state (we only compare client-to-client here: position timestamps).
- Merging publishes an OTA at 100% to the 2.3.0 public lane (`mobile/**` + `shared/**` trigger). A partial rollout would block the next publish — leave rollout at 100%.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/app/api/attendance/geofence-config/route.js` | Modify | Additive `all_regions` field (exemption-blind) |
| `src/app/api/attendance/geofence-config/route.test.js` | Modify | Cover `all_regions` vs `regions` split |
| `mobile/lib/physical-location.js` | Create | Pure: haversine, point-in-region resolution, position-source pick |
| `mobile/lib/physical-location.test.js` | Create | Tests for the above |
| `mobile/lib/control-location.js` | Create | Pure: `override ?? detected ?? active` resolution + picker eligibility |
| `mobile/lib/control-location.test.js` | Create | Tests for the above |
| `mobile/lib/home-logic.js` | Create | Pure: 7-day window, shift grouping/labels, tile list builder |
| `mobile/lib/home-logic.test.js` | Create | Tests for the above |
| `mobile/lib/use-physical-location.js` | Create | Thin hook: expo-location + config fetch (cached) → resolver. No tests (native imports) |
| `mobile/components/LocationPill.jsx` | Create | Detected/manual pill + Alert-based picker |
| `mobile/components/ChoiceCard.jsx` | Create | Extracted from studio.jsx (DRY: hub + Home + controls launcher) |
| `mobile/app/(staff)/(tabs)/dashboard.jsx` | Create (git mv from index.jsx) | Today's Home content, unchanged behaviour |
| `mobile/app/(staff)/(tabs)/index.jsx` | Rewrite | New Home (three states) |
| `mobile/app/(staff)/(tabs)/_layout.jsx` | Modify | Dashboard tab registration + gating |
| `mobile/app/(staff)/(tabs)/studio.jsx` | Modify | Import shared ChoiceCard (no behaviour change) |
| `mobile/lib/notification-nav.js` (+ test) | Modify | Swap notifications repoint `/(tabs)` → `/(tabs)/dashboard` |
| `mobile/app/(staff)/controls/_layout.jsx` | Create | Stack header for the manual controls launcher |
| `mobile/app/(staff)/controls/index.jsx` | Create | Manual controls launcher (`?loc=` required) |
| `mobile/app/(staff)/sonos/index.jsx` | Modify | Pill + control-location resolution |
| `mobile/app/(staff)/shelly/index.jsx` | Modify | Pill + control-location resolution |
| `mobile/app/(staff)/doors/index.jsx` | Modify | Pill + control-location resolution |
| `mobile/app/(staff)/ac/index.jsx` | Modify | Pill + control-location resolution |
| `docs/CHANGELOG.md` | Modify | One row |

---

### Task 1: `all_regions` on the geofence-config route

**Files:**
- Modify: `src/app/api/attendance/geofence-config/route.js`
- Test: `src/app/api/attendance/geofence-config/route.test.js`

The route currently builds `regions` only from non-exempt assignments (correct for attendance registration). Home's on-site detection must work for exempt staff too, so add `all_regions`: same shape, all assigned locations with a configured geofence, exemption ignored. `regions`, `required`, `gate_copy` semantics unchanged.

- [ ] **Step 1: Read the existing route test to match its harness conventions**

Read `src/app/api/attendance/geofence-config/route.test.js` fully. New tests must use the same mock/db-stub pattern it already uses (do not invent a new harness).

- [ ] **Step 2: Write the failing tests**

Add to `route.test.js`, following its existing arrange helpers (adjust helper names to what the file actually uses):

```js
it('includes exempt locations in all_regions but not regions', async () => {
  // links: locA (exempt:false, geofence configured), locB (exempt:true, geofence configured)
  // ...arrange with the file's existing stubbing pattern...
  const res = await GET()
  const body = await res.json()
  expect(body.data.regions.map(r => r.location_id)).toEqual(['locA'])
  expect(body.data.all_regions.map(r => r.location_id).sort()).toEqual(['locA', 'locB'])
  expect(body.data.required).toBe(true) // still driven by non-exempt regions only
})

it('all-exempt user gets all_regions but required:false and empty regions', async () => {
  // links: locA (exempt:true, geofence configured)
  const res = await GET()
  const body = await res.json()
  expect(body.data.regions).toEqual([])
  expect(body.data.required).toBe(false)
  expect(body.data.all_regions.map(r => r.location_id)).toEqual(['locA'])
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/app/api/attendance/geofence-config/route.test.js`
Expected: the two new tests FAIL (`all_regions` undefined); existing tests PASS.

- [ ] **Step 4: Implement**

Replace the region-building block in `route.js` (currently: compute `eligibleIds`, query only those, build `regions`) with:

```js
  const allIds = (links || []).map(l => l.location_id)
  const eligible = new Set((links || []).filter(l => !l.geofence_exempt).map(l => l.location_id))
  let regions = []
  let allRegions = []
  let gateCopy = null
  if (allIds.length > 0) {
    const { data: locs, error: locErr } = await db
      .from('locations')
      .select('id, settings')
      .in('id', allIds)
      .order('id')
    if (locErr) return NextResponse.json({ success: false, error: locErr.message }, { status: 400 })
    for (const loc of locs || []) {
      const g = geofenceFromLocationSettings(loc.settings)
      if (!geofenceIsConfigured(g)) continue
      const region = { location_id: loc.id, latitude: g.latitude, longitude: g.longitude, radius_m: g.radiusM }
      allRegions.push(region)
      if (eligible.has(loc.id)) {
        regions.push(region)
        if (!gateCopy) gateCopy = g.gateCopy
      }
    }
  }
  // iOS caps region monitoring at 20 per app — keep headroom.
  regions = regions.slice(0, 15)
  allRegions = allRegions.slice(0, 15)

  return NextResponse.json({
    success: true,
    data: {
      required: regions.length > 0,
      gate_copy: gateCopy || DEFAULT_GATE_COPY,
      regions,
      // HOME-LOC.1 — exemption-blind copy for the Home/on-site resolver.
      // `regions` stays the attendance-registration list (exempt filtered).
      all_regions: allRegions,
    },
  })
```

Note the behaviour delta: an all-exempt user now triggers the `locations` query (previously skipped). That is intended.

- [ ] **Step 5: Run the route tests**

Run: `npx vitest run src/app/api/attendance/geofence-config/route.test.js`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/attendance/geofence-config/route.js src/app/api/attendance/geofence-config/route.test.js
git commit -m "HOME-LOC.1 — geofence-config grows all_regions: exemption-blind regions for the Home on-site resolver"
```

---

### Task 2: `physical-location.js` — the pure resolver

**Files:**
- Create: `mobile/lib/physical-location.js`
- Test: `mobile/lib/physical-location.test.js`

Pure module, NO native imports. Region shape is the route's: `{ location_id, latitude, longitude, radius_m }`. Position shape is expo-location's: `{ coords: { latitude, longitude }, timestamp }`.

- [ ] **Step 1: Write the failing tests**

```js
// mobile/lib/physical-location.test.js
import { describe, it, expect } from 'vitest'
import { haversineMeters, resolvePhysicalLocation, pickPosition } from './physical-location'

const STILLORGAN = { latitude: 53.2887, longitude: -6.1970 }
const HATCH = { latitude: 53.3331, longitude: -6.2542 }
const REGIONS = [
  { location_id: 'loc-still', latitude: STILLORGAN.latitude, longitude: STILLORGAN.longitude, radius_m: 150 },
  { location_id: 'loc-hatch', latitude: HATCH.latitude, longitude: HATCH.longitude, radius_m: 150 },
]
const LOCATIONS = [{ id: 'loc-still', name: 'Stillorgan' }, { id: 'loc-hatch', name: 'Hatch Street' }]
const at = (coords) => ({ coords, timestamp: 1000 })

describe('haversineMeters', () => {
  it('is ~0 for identical points and ~7km Stillorgan↔Hatch', () => {
    expect(haversineMeters(STILLORGAN, STILLORGAN)).toBeLessThan(1)
    const d = haversineMeters(STILLORGAN, HATCH)
    expect(d).toBeGreaterThan(5000)
    expect(d).toBeLessThan(9000)
  })
})

describe('resolvePhysicalLocation', () => {
  it('at_studio inside a region, with the matching location object', () => {
    const r = resolvePhysicalLocation({ position: at(HATCH), regions: REGIONS, locations: LOCATIONS })
    expect(r.status).toBe('at_studio')
    expect(r.location.id).toBe('loc-hatch')
  })
  it('offsite when inside no region', () => {
    const r = resolvePhysicalLocation({ position: at({ latitude: 53.30, longitude: -6.22 }), regions: REGIONS, locations: LOCATIONS })
    expect(r).toEqual({ status: 'offsite', location: null })
  })
  it('unknown with no position or no regions', () => {
    expect(resolvePhysicalLocation({ position: null, regions: REGIONS, locations: LOCATIONS }).status).toBe('unknown')
    expect(resolvePhysicalLocation({ position: at(HATCH), regions: [], locations: LOCATIONS }).status).toBe('unknown')
  })
  it('unknown when overlapping regions of DIFFERENT locations both match (never guess)', () => {
    const overlapping = [
      { location_id: 'a', latitude: HATCH.latitude, longitude: HATCH.longitude, radius_m: 500 },
      { location_id: 'b', latitude: HATCH.latitude, longitude: HATCH.longitude, radius_m: 500 },
    ]
    const locs = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
    expect(resolvePhysicalLocation({ position: at(HATCH), regions: overlapping, locations: locs }).status).toBe('unknown')
  })
  it('two regions of the SAME location are fine', () => {
    const twin = [
      { location_id: 'loc-hatch', latitude: HATCH.latitude, longitude: HATCH.longitude, radius_m: 100 },
      { location_id: 'loc-hatch', latitude: HATCH.latitude, longitude: HATCH.longitude, radius_m: 300 },
    ]
    expect(resolvePhysicalLocation({ position: at(HATCH), regions: twin, locations: LOCATIONS }).status).toBe('at_studio')
  })
  it('offsite when the matched region belongs to a location not in my assignments', () => {
    const r = resolvePhysicalLocation({ position: at(HATCH), regions: REGIONS, locations: [LOCATIONS[0]] })
    expect(r).toEqual({ status: 'offsite', location: null })
  })
  it('skips malformed regions instead of coercing (absent is not zero)', () => {
    const bad = [{ location_id: 'x', latitude: null, longitude: undefined, radius_m: '150' }]
    expect(resolvePhysicalLocation({ position: at(HATCH), regions: bad, locations: LOCATIONS }).status).toBe('offsite')
  })
})

describe('pickPosition', () => {
  it('prefers a current read', () => {
    const current = at(HATCH)
    expect(pickPosition({ current, lastKnown: at(STILLORGAN), nowMs: 10_000 })).toBe(current)
  })
  it('falls back to a fresh-enough lastKnown', () => {
    const lastKnown = { coords: STILLORGAN, timestamp: 9_000 }
    expect(pickPosition({ current: null, lastKnown, nowMs: 10_000 })).toBe(lastKnown)
  })
  it('rejects a stale lastKnown (the morning-at-Stillorgan trap)', () => {
    const lastKnown = { coords: STILLORGAN, timestamp: 0 }
    expect(pickPosition({ current: null, lastKnown, nowMs: 10 * 60 * 1000 })).toBe(null)
  })
  it('rejects a lastKnown with a non-finite timestamp', () => {
    expect(pickPosition({ current: null, lastKnown: { coords: STILLORGAN, timestamp: null }, nowMs: 1000 })).toBe(null)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run mobile/lib/physical-location.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// mobile/lib/physical-location.js
//
// HOME-LOC.2 — pure resolution of "which studio is this phone standing in".
// NO native imports — vitest runs this in Node (the geofence-permission.js
// rule). The hook in use-physical-location.js feeds it expo-location reads
// and the geofence-config regions.
//
// Region shape: { location_id, latitude, longitude, radius_m } — the
// geofence-config route's `all_regions` (exemption-blind; the attendance
// `regions` list would silently exclude geofence_exempt staff).
// Position shape: expo-location's { coords: { latitude, longitude }, timestamp }.

const EARTH_RADIUS_M = 6371000

export function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s))
}

/**
 * @returns {{ status: 'unknown'|'offsite'|'at_studio', location: object|null }}
 *
 * 'unknown'  — cannot tell (no position, no regions): render the offsite
 *              layout, never an error.
 * 'offsite'  — position resolved, inside no assigned studio's region.
 * 'at_studio'— inside exactly ONE assigned location's region(s). Overlapping
 *              regions of DIFFERENT locations resolve to 'unknown' — a wrong
 *              guess here is the exact bug this feature exists to kill.
 */
export function resolvePhysicalLocation({ position, regions, locations }) {
  if (!position?.coords || !Array.isArray(regions) || regions.length === 0) {
    return { status: 'unknown', location: null }
  }
  const hitIds = new Set()
  for (const r of regions) {
    // Absent is not zero — a null latitude must skip the region, not
    // coerce to the Gulf of Guinea.
    if (!Number.isFinite(r?.latitude) || !Number.isFinite(r?.longitude) || !Number.isFinite(r?.radius_m)) continue
    if (haversineMeters(position.coords, r) <= r.radius_m) hitIds.add(r.location_id)
  }
  if (hitIds.size === 0) return { status: 'offsite', location: null }
  if (hitIds.size > 1) return { status: 'unknown', location: null }
  const id = hitIds.values().next().value
  const location = (locations || []).find((l) => l.id === id) || null
  if (!location) return { status: 'offsite', location: null }
  return { status: 'at_studio', location }
}

const LAST_KNOWN_MAX_AGE_MS = 5 * 60 * 1000

/**
 * Prefer a fresh read; fall back to lastKnown only when recent. A stale
 * lastKnown is worse than none: this morning's studio must not paint as
 * "detected" this afternoon.
 */
export function pickPosition({ current, lastKnown, nowMs, maxAgeMs = LAST_KNOWN_MAX_AGE_MS }) {
  if (current?.coords) return current
  if (
    lastKnown?.coords &&
    Number.isFinite(lastKnown.timestamp) &&
    nowMs - lastKnown.timestamp <= maxAgeMs
  ) {
    return lastKnown
  }
  return null
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run mobile/lib/physical-location.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/physical-location.js mobile/lib/physical-location.test.js
git commit -m "HOME-LOC.2 — pure physical-location resolver (haversine, point-in-region, position-source pick)"
```

---

### Task 3: `control-location.js` — resolution order + picker eligibility

**Files:**
- Create: `mobile/lib/control-location.js`
- Test: `mobile/lib/control-location.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// mobile/lib/control-location.test.js
import { describe, it, expect } from 'vitest'
import { resolveControlLocation, pickerLocations } from './control-location'

const STILL = { id: 'loc-still', name: 'Stillorgan' }
const HATCH = { id: 'loc-hatch', name: 'Hatch Street' }
const LOCATIONS = [STILL, HATCH]

describe('resolveControlLocation', () => {
  it('an explicit override wins, labelled manual', () => {
    const r = resolveControlLocation({
      overrideId: 'loc-still',
      physical: { status: 'at_studio', location: HATCH },
      activeLocation: HATCH,
      locations: LOCATIONS,
    })
    expect(r).toEqual({ location: STILL, source: 'manual' })
  })
  it('an override id not in my locations is IGNORED (deep-link hardening)', () => {
    const r = resolveControlLocation({
      overrideId: 'loc-evil',
      physical: { status: 'at_studio', location: HATCH },
      activeLocation: STILL,
      locations: LOCATIONS,
    })
    expect(r).toEqual({ location: HATCH, source: 'detected' })
  })
  it('detected physical location beats activeLocation', () => {
    const r = resolveControlLocation({
      overrideId: null,
      physical: { status: 'at_studio', location: HATCH },
      activeLocation: STILL,
      locations: LOCATIONS,
    })
    expect(r).toEqual({ location: HATCH, source: 'detected' })
  })
  it('offsite/unknown/loading fall back to activeLocation, labelled manual', () => {
    for (const status of ['offsite', 'unknown', 'loading']) {
      const r = resolveControlLocation({
        overrideId: null,
        physical: { status, location: null },
        activeLocation: STILL,
        locations: LOCATIONS,
      })
      expect(r).toEqual({ location: STILL, source: 'manual' })
    }
  })
  it('nothing at all → null location, manual', () => {
    const r = resolveControlLocation({ overrideId: null, physical: { status: 'unknown', location: null }, activeLocation: null, locations: [] })
    expect(r).toEqual({ location: null, source: 'manual' })
  })
})

describe('pickerLocations', () => {
  it('filters to locations where the perm key resolves true', () => {
    // master short-circuits canMobile to true everywhere — cheapest real fixture.
    const master = { role: 'master', permissions: {} }
    expect(pickerLocations(master, LOCATIONS, 'device_control').map(l => l.id)).toEqual(['loc-still', 'loc-hatch'])
    expect(pickerLocations(null, LOCATIONS, 'device_control')).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run mobile/lib/control-location.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// mobile/lib/control-location.js
//
// HOME-LOC.3 — the ONE place that decides which studio a device-control
// screen commands, and which locations its pill's picker may offer.
//
//   controlLocation = explicit override (this visit's ?loc= param)
//                  ?? physical location (when at_studio)
//                  ?? activeLocation
//
// The override must be one of the caller's own locations — a hand-typed
// deep-link id outside the assignment list is ignored, not honoured (the
// server would 403 it anyway; this keeps the pill honest too).
// Pure module — no native imports; permissions.js is already Node-safe.

import { canMobile } from './permissions'

export function resolveControlLocation({ overrideId, physical, activeLocation, locations }) {
  if (overrideId) {
    const loc = (locations || []).find((l) => l.id === overrideId)
    if (loc) return { location: loc, source: 'manual' }
  }
  if (physical?.status === 'at_studio' && physical.location) {
    return { location: physical.location, source: 'detected' }
  }
  return { location: activeLocation || null, source: 'manual' }
}

/** Locations this user may pick in a control screen's pill, by that screen's perm key. */
export function pickerLocations(profile, locations, permKey) {
  if (!profile) return []
  return (locations || []).filter((l) => canMobile(profile, permKey, l))
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run mobile/lib/control-location.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/control-location.js mobile/lib/control-location.test.js
git commit -m "HOME-LOC.3 — control-location resolution (override ?? detected ?? active) + picker eligibility"
```

---

### Task 4: `home-logic.js` — shift window, grouping, tiles

**Files:**
- Create: `mobile/lib/home-logic.js`
- Test: `mobile/lib/home-logic.test.js`

Shift rows are the `/api/schedule/shifts` shape: `{ shift_date, start_time_override, end_time_override, shift_templates: { name, start_time, end_time }, locations: { id, name }, location_id, profile_id }` (see `mobile/lib/schedule-team.js` header comment).

- [ ] **Step 1: Write the failing tests**

```js
// mobile/lib/home-logic.test.js
import { describe, it, expect } from 'vitest'
import { shiftWindow, shiftTimeLabel, groupShiftsByDay, homeTiles } from './home-logic'

const shift = (date, start, name = 'Open') => ({
  shift_date: date,
  shift_templates: { name, start_time: start, end_time: '17:00:00' },
})

describe('shiftWindow', () => {
  it('returns today..today+6 as ISO dates', () => {
    const w = shiftWindow(new Date(2026, 7, 23)) // 23 Aug 2026, local
    expect(w).toEqual({ startDate: '2026-08-23', endDate: '2026-08-29' })
  })
})

describe('shiftTimeLabel', () => {
  it('prefers overrides over template times and trims seconds', () => {
    expect(shiftTimeLabel({ start_time_override: '10:30:00', shift_templates: { start_time: '06:00:00', end_time: '14:00:00' } })).toBe('10:30–14:00')
  })
  it('empty when nothing is set', () => {
    expect(shiftTimeLabel({})).toBe('')
  })
})

describe('groupShiftsByDay', () => {
  it('groups into ordered days, drops empty days, sorts within a day, labels Today/Tomorrow', () => {
    const groups = groupShiftsByDay(
      [shift('2026-08-25', '09:00:00'), shift('2026-08-23', '14:00:00', 'PM'), shift('2026-08-23', '06:00:00', 'AM')],
      '2026-08-23'
    )
    expect(groups.map(g => g.iso)).toEqual(['2026-08-23', '2026-08-25'])
    expect(groups[0].label).toBe('Today')
    expect(groups[0].shifts.map(s => s.shift_templates.name)).toEqual(['AM', 'PM'])
    expect(groups[1].label).not.toBe('Tomorrow') // day 3 gets a date label
  })
  it('labels day 2 Tomorrow and ignores shifts outside the window', () => {
    const groups = groupShiftsByDay([shift('2026-08-24', '09:00:00'), shift('2026-09-20', '09:00:00')], '2026-08-23')
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Tomorrow')
  })
})

describe('homeTiles', () => {
  it('builds the full list for a master and nothing without a location', () => {
    const master = { role: 'master', permissions: {} }
    const loc = { id: 'loc-hatch', name: 'Hatch Street' }
    const keys = homeTiles(master, loc).map(t => t.key)
    expect(keys).toEqual(['sonos', 'shelly', 'ac', 'doors', 'timer', 'tv'])
    expect(homeTiles(master, null)).toEqual([])
    expect(homeTiles(null, loc)).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run mobile/lib/home-logic.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// mobile/lib/home-logic.js
//
// HOME-LOC.4 — pure logic for the Home surface: the 7-day shift window,
// agenda grouping, and the on-site tile list. No native imports.
//
// Tile gates mirror the Studio hub EXACTLY (studio.jsx): AC + doors on
// `studio_management`, timer on `class_timer`, TV on `tv_displays`, music +
// plugs on the ONE `device_control` key — deliberately the same resolution,
// not parallel checks that could drift.

import { isoDate, addDays, parseIsoDate, shortDate } from './dates'
import { canMobile } from './permissions'

export function shiftWindow(now = new Date()) {
  return { startDate: isoDate(now), endDate: isoDate(addDays(now, 6)) }
}

export function shiftTimeLabel(shift) {
  const start = (shift?.start_time_override || shift?.shift_templates?.start_time || '').slice(0, 5)
  const end = (shift?.end_time_override || shift?.shift_templates?.end_time || '').slice(0, 5)
  if (start && end) return `${start}–${end}`
  return start || ''
}

/** Agenda groups for the next `days` days from todayIso; empty days dropped. */
export function groupShiftsByDay(shifts, todayIso, days = 7) {
  const start = parseIsoDate(todayIso)
  const out = []
  for (let i = 0; i < days; i++) {
    const iso = isoDate(addDays(start, i))
    const dayShifts = (shifts || []).filter((s) => s?.shift_date === iso)
    if (dayShifts.length === 0) continue
    dayShifts.sort((a, b) => shiftTimeLabel(a).localeCompare(shiftTimeLabel(b)))
    out.push({
      iso,
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : shortDate(addDays(start, i)),
      shifts: dayShifts,
    })
  }
  return out
}

const TILES = [
  { key: 'sonos',  href: '/sonos',  perm: 'device_control',    icon: 'musical-notes-outline', tint: '#F59E0B', title: 'Studio music',     subtitle: 'Play, pause, volume, favourites' },
  { key: 'shelly', href: '/shelly', perm: 'device_control',    icon: 'flash-outline',         tint: '#EF4444', title: 'Smart plugs',      subtitle: 'Switch adopted plugs on or off' },
  { key: 'ac',     href: '/ac',     perm: 'studio_management', icon: 'snow-outline',          tint: '#2563EB', title: 'Air conditioning', subtitle: 'Sensibo gym floor + LG ThinQ units' },
  { key: 'doors',  href: '/doors',  perm: 'studio_management', icon: 'key-outline',           tint: '#A855F7', title: 'Door unlock',      subtitle: 'UniFi Access doors' },
  { key: 'timer',  href: '/timer',  perm: 'class_timer',       icon: 'stopwatch-outline',     tint: '#10B981', title: 'Class timer',      subtitle: 'Interval timer on the TV' },
  { key: 'tv',     href: '/tv',     perm: 'tv_displays',       icon: 'tv-outline',            tint: '#0EA5E9', title: 'TV displays',      subtitle: "What's on the studio TVs" },
]

export function homeTiles(profile, location) {
  if (!profile || !location) return []
  return TILES.filter((t) => canMobile(profile, t.perm, location))
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run mobile/lib/home-logic.test.js`
Expected: ALL PASS. If `shortDate`'s output format makes an assertion brittle, assert on structure (not exact string) — but check `mobile/lib/dates.js` first and use its real behaviour.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/home-logic.js mobile/lib/home-logic.test.js
git commit -m "HOME-LOC.4 — Home pure logic: shift window, agenda grouping, on-site tile list"
```

---

### Task 5: `use-physical-location.js` — the hook

**Files:**
- Create: `mobile/lib/use-physical-location.js`

Native imports (`expo-location`) → NO test file; every decision it makes is already covered by Task 2's pure functions. Keep it thin.

- [ ] **Step 1: Implement**

```js
// mobile/lib/use-physical-location.js
//
// HOME-LOC.5 — "which studio is this phone standing in", resolved ONCE per
// screen focus and then FROZEN for the visit (a GPS wobble must never swap
// which studio a thumb is about to command mid-screen). All decisions live
// in physical-location.js (pure, tested); this file only does IO.
//
// Never REQUESTS location permission — it reads the existing grant. The
// attendance gate owns the permission ask; a denied user simply never gets
// the on-site flip and Home renders its offsite layout (which needs no
// location at all).
//
// Status: 'loading' → exactly one of 'at_studio' | 'offsite' | 'unknown'.

import { useCallback, useRef, useState } from 'react'
import * as Location from 'expo-location'
import { useFocusEffect } from 'expo-router'
import { api } from './api'
import { useAuth } from './auth-context'
import { resolvePhysicalLocation, pickPosition } from './physical-location'

const CONFIG_TTL_MS = 5 * 60 * 1000
const POSITION_TIMEOUT_MS = 8000

// Module-level config cache: five screens resolve on focus; the regions
// change ~never. Kept on failure — a blip must not blind detection.
let regionsCache = { at: 0, regions: null }

async function fetchRegions() {
  const now = Date.now()
  if (regionsCache.regions && now - regionsCache.at <= CONFIG_TTL_MS) return regionsCache.regions
  try {
    const res = await api('/api/attendance/geofence-config')
    if (res?.success) {
      // all_regions is exemption-blind (HOME-LOC.1); `regions` fallback only
      // covers a stale server during the deploy window.
      const regions = res.data?.all_regions ?? res.data?.regions ?? []
      regionsCache = { at: now, regions }
      return regions
    }
  } catch { /* fall through to last good */ }
  return regionsCache.regions || []
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('position timeout')), ms)),
  ])
}

export function usePhysicalLocation() {
  const { locations } = useAuth()
  const [result, setResult] = useState({ status: 'loading', location: null })
  const visitRef = useRef(0)

  useFocusEffect(
    useCallback(() => {
      const visit = ++visitRef.current
      let active = true
      const fresh = () => active && visitRef.current === visit

      async function resolve() {
        let next = { status: 'unknown', location: null }
        try {
          const [perm, regions] = await Promise.all([
            Location.getForegroundPermissionsAsync().catch(() => null),
            fetchRegions(),
          ])
          if (perm?.status === 'granted' && regions.length > 0) {
            let current = null
            try {
              current = await withTimeout(
                Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
                POSITION_TIMEOUT_MS
              )
            } catch { /* fall back to lastKnown below */ }
            const lastKnown = current ? null : await Location.getLastKnownPositionAsync().catch(() => null)
            const position = pickPosition({ current, lastKnown, nowMs: Date.now() })
            next = resolvePhysicalLocation({ position, regions, locations })
          }
        } catch { /* stays unknown */ }
        if (fresh()) setResult(next)
      }

      setResult({ status: 'loading', location: null })
      resolve()
      return () => { active = false }
    }, [locations])
  )

  return result
}
```

- [ ] **Step 2: Parse-check and run the mobile lib suite (no regressions)**

Run: `node mobile/parse-check.mjs` (if the script errors on usage, read its header for invocation) and `npx vitest run mobile/lib`
Expected: parse clean; existing tests PASS.

- [ ] **Step 3: Commit**

```bash
git add mobile/lib/use-physical-location.js
git commit -m "HOME-LOC.5 — usePhysicalLocation hook: resolve on focus, frozen per visit, cached regions"
```

---

### Task 6: `LocationPill` + extracted `ChoiceCard`

**Files:**
- Create: `mobile/components/LocationPill.jsx`
- Create: `mobile/components/ChoiceCard.jsx`
- Modify: `mobile/app/(staff)/(tabs)/studio.jsx` (import the extracted card; delete the local copy — no behaviour change)

- [ ] **Step 1: Create `ChoiceCard.jsx`**

Move the `ChoiceCard` function from `studio.jsx` verbatim into its own file:

```jsx
// mobile/components/ChoiceCard.jsx
// Extracted from the Studio hub (HOME-LOC.6) — now shared by the hub, the
// new Home tiles, and the manual controls launcher.
import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export default function ChoiceCard({ icon, tint, title, subtitle, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 flex-row items-center active:opacity-70"
    >
      <View className="w-12 h-12 rounded-full items-center justify-center mr-4" style={{ backgroundColor: `${tint}1A` }}>
        <Ionicons name={icon} size={24} color={tint} />
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-un1t-text">{title}</Text>
        <Text className="text-sm text-un1t-subtle mt-0.5">{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
    </Pressable>
  )
}
```

In `studio.jsx`: delete the local `ChoiceCard`, add `import ChoiceCard from '../../../components/ChoiceCard'`, and remove the now-unused `Pressable`/`Ionicons` imports ONLY if nothing else in the file uses them (check — the hub uses `Ionicons` nowhere else but `Pressable` may appear; verify before removing).

- [ ] **Step 2: Create `LocationPill.jsx`**

```jsx
// mobile/components/LocationPill.jsx
//
// HOME-LOC.6 — the always-visible answer to "which studio am I commanding?".
// Two visual states: detected (green, from the geofence resolution) and
// manual (amber — activeLocation fallback or an explicit pick). Tapping
// opens an Alert picker over `pickable` (the caller filters by its screen's
// perm key via pickerLocations); picking calls onPick(locationId), which
// screens wire to router.setParams({ loc }) — per-visit by construction.
import { View, Text, Pressable, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export default function LocationPill({ location, source, pickable = [], onPick }) {
  const detected = source === 'detected'
  const name = location?.name || 'No location'
  const canPick = typeof onPick === 'function' && pickable.length > 1

  function openPicker() {
    if (!canPick) return
    Alert.alert('Control which studio?', 'Commands go to the studio you pick.', [
      ...pickable.map((l) => ({
        text: l.name + (l.id === location?.id ? '  ✓' : ''),
        onPress: () => onPick(l.id),
      })),
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const fg = detected ? '#047857' : '#B45309'
  return (
    <Pressable
      onPress={openPicker}
      accessibilityRole="button"
      accessibilityLabel={`Controlling ${name}, ${detected ? 'detected' : 'manual'}`}
      className="self-start mb-4"
    >
      <View
        className={`flex-row items-center rounded-full px-3 py-1.5 border ${
          detected ? 'bg-emerald-500/20 border-emerald-600/30' : 'bg-amber-500/20 border-amber-600/30'
        }`}
      >
        <Ionicons name={detected ? 'navigate' : 'hand-left-outline'} size={12} color={fg} />
        <Text className={`text-xs font-semibold ml-1.5 ${detected ? 'text-emerald-700' : 'text-amber-700'}`}>
          {name} · {detected ? 'detected' : 'manual'}
        </Text>
        {canPick ? <Ionicons name="chevron-down" size={12} color={fg} style={{ marginLeft: 4 }} /> : null}
      </View>
    </Pressable>
  )
}
```

- [ ] **Step 3: Verify**

Run: `node mobile/parse-check.mjs` and `npx vitest run mobile/lib`
Expected: clean; PASS (the studio.jsx refactor is behaviour-neutral).

- [ ] **Step 4: Commit**

```bash
git add mobile/components/LocationPill.jsx mobile/components/ChoiceCard.jsx 'mobile/app/(staff)/(tabs)/studio.jsx'
git commit -m "HOME-LOC.6 — LocationPill (detected/manual + picker) and ChoiceCard extracted from the Studio hub"
```

---

### Task 7: Tab restructure — Dashboard tab + notification repoints

**Files:**
- Create: `mobile/app/(staff)/(tabs)/dashboard.jsx` (via `git mv` of `index.jsx`)
- Modify: `mobile/app/(staff)/(tabs)/_layout.jsx`
- Modify: `mobile/lib/notification-nav.js` (+ its test file if one exists — check for `mobile/lib/notification-nav.test.js`)

- [ ] **Step 1: Move the file**

```bash
git mv 'mobile/app/(staff)/(tabs)/index.jsx' 'mobile/app/(staff)/(tabs)/dashboard.jsx'
```

Then edit `dashboard.jsx`'s top comment first line from `// Home tab — segmented control hosting up to three dashboards:` to `// Dashboard tab — segmented control hosting up to three dashboards (was the Home tab until HOME-LOC.7):`. **No other change to this file** — the `hasAnyMobileFeature` nudge block inside it moves to the NEW Home in Task 8 and is DELETED from dashboard.jsx there (Task 8 Step 3), not here, so the app never has a commit without the nudge.

Note: after this step the app has no `index.jsx` — expo-router will 404 the default route until Task 8 lands. That is fine mid-branch (tasks 7+8 land in adjacent commits and CI runs vitest, not the app), but do NOT stop the branch between Tasks 7 and 8.

- [ ] **Step 2: Register the Dashboard tab in `_layout.jsx`**

Import `canDashboard` alongside `canMobile`:

```js
import { canMobile, canDashboard } from '../../../lib/permissions'
```

After the `const { bar, more } = resolveLayoutForUser(...)` block, add:

```js
  // HOME-LOC.7 — the old Home (segmented dashboards) is now its own tab.
  // Same gate that used to decide whether Home rendered any segments.
  const hasDashboard = ['dashboard_personal', 'dashboard_studio', 'dashboard_business']
    .some((k) => canDashboard(profile, k, activeLocation))
```

Directly after the existing `index` `<Tabs.Screen>`, add:

```jsx
        <Tabs.Screen
          name="dashboard"
          options={{
            title: 'Dashboard',
            // href:null removes it from the bar AND makes it non-navigable
            // for users with no dashboard permission (expo-router contract).
            href: hasDashboard ? '/(tabs)/dashboard' : null,
            tabBarIcon: ({ color, size }) => (<Ionicons name="stats-chart-outline" size={size} color={color} />),
          }}
        />
```

- [ ] **Step 3: Repoint swap notifications**

In `mobile/lib/notification-nav.js`, the `swap_inbound` / `swap_claimed` / `swap_accepted` / `swap_withdrawn` / `swap_declined` block returns `'/(tabs)'` ("respond on the dashboard" — which is now the Dashboard tab). Change that return to `'/(tabs)/dashboard'`. Then:

```bash
grep -n "'/(tabs)'" mobile/lib/notification-nav.js
```

For each remaining hit, decide: does this notification target the *personal dashboard content* (→ `'/(tabs)/dashboard'`) or is it a generic "open the app" landing (→ leave as `'/(tabs)'`, which is now the new Home — a fine landing)? Record the decision per case in the commit message. Update `notification-nav.test.js` expectations to match if the file exists.

- [ ] **Step 4: Verify**

Run: `npx vitest run mobile/lib` and `node mobile/parse-check.mjs`
Expected: PASS (including any updated notification-nav tests).

- [ ] **Step 5: Commit**

```bash
git add -A 'mobile/app/(staff)/(tabs)/' mobile/lib/notification-nav.js mobile/lib/notification-nav.test.js 2>/dev/null || git add -A 'mobile/app/(staff)/(tabs)/' mobile/lib/notification-nav.js
git commit -m "HOME-LOC.7 — dashboards move to their own tab; swap notifications follow them"
```

---

### Task 8: The new Home screen

**Files:**
- Rewrite: `mobile/app/(staff)/(tabs)/index.jsx`
- Modify: `mobile/app/(staff)/(tabs)/dashboard.jsx` (delete the `hasAnyMobileFeature` nudge block that Home now owns)

- [ ] **Step 1: Write the new Home**

```jsx
// mobile/app/(staff)/(tabs)/index.jsx
//
// HOME-LOC.8 — Home is the PHYSICAL surface: "your work life, here and now".
//   at_studio        → that studio's name + control tiles + today's roster
//   offsite/unknown  → your next-7-days shifts across ALL your studios
//                      (one /api/schedule/shifts call, no location_id →
//                      the route fans out to every assignment) + a demoted
//                      "Studio controls" manual entry
//   loading          → spinner
//
// The offsite layout needs NO location permission — a denied user gets a
// fully useful Home, and the on-site flip simply never fires for them.
// activeLocation is never read for CONTENT here (only as the picker's
// fallback inside pushed screens) and is NEVER written.
// Dashboards live on the Dashboard tab since HOME-LOC.7.

import { useState, useCallback, useRef } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable, RefreshControl, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { hasAnyMobileFeature } from '../../../lib/permissions'
import { usePhysicalLocation } from '../../../lib/use-physical-location'
import { pickerLocations } from '../../../lib/control-location'
import { shiftWindow, shiftTimeLabel, groupShiftsByDay, homeTiles } from '../../../lib/home-logic'
import { getMyShifts, getTeamShifts } from '../../../lib/schedule-api'
import { isoDate } from '../../../lib/dates'
import { pickLocationColor } from 'shared/location-colors'
import ChoiceCard from '../../../components/ChoiceCard'
import LocationPill from '../../../components/LocationPill'

export default function Home() {
  const { profile, activeLocation, locations } = useAuth()
  const router = useRouter()
  const phys = usePhysicalLocation()

  const [myShifts, setMyShifts] = useState(null)   // null = loading
  const [shiftsError, setShiftsError] = useState(null)
  const [roster, setRoster] = useState([])         // on-site: today's team at the detected studio
  const [refreshing, setRefreshing] = useState(false)
  // Keep the last painted list through a transport blip (api() tags its two
  // self-minted envelopes transport:true — SONOSMOB.4c).
  const paintedRef = useRef(false)

  const loadShifts = useCallback(async (isActive) => {
    if (!profile) return
    try {
      const { startDate, endDate } = shiftWindow()
      // No locationId → the route fans out to all my locations; rows embed
      // locations(name) for the studio chips.
      const res = await getMyShifts({ profileId: profile.id, startDate, endDate })
      if (!isActive()) return
      if (!res.success) {
        if (!(res.transport && paintedRef.current)) setShiftsError(res.error || 'Could not load your shifts')
        return
      }
      setShiftsError(null)
      setMyShifts(res.data || [])
      paintedRef.current = true
    } catch (e) {
      if (isActive()) setShiftsError(e?.message || 'Could not load your shifts')
    }
  }, [profile])

  const loadRoster = useCallback(async (isActive, locationId) => {
    if (!locationId) { setRoster([]); return }
    const today = isoDate(new Date())
    try {
      const res = await getTeamShifts({ locationId, startDate: today, endDate: today })
      if (isActive()) setRoster(res.success ? (res.data || []) : [])
    } catch {
      if (isActive()) setRoster([]) // roster is a garnish — never an error state
    }
  }, [])

  useFocusEffect(useCallback(() => {
    let active = true
    loadShifts(() => active)
    return () => { active = false }
  }, [loadShifts]))

  // Roster follows the DETECTED location (re-runs when detection lands).
  useFocusEffect(useCallback(() => {
    let active = true
    if (phys.status === 'at_studio') loadRoster(() => active, phys.location?.id)
    return () => { active = false }
  }, [phys.status, phys.location?.id, loadRoster]))

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await loadShifts(() => true)
    if (phys.status === 'at_studio') await loadRoster(() => true, phys.location?.id)
    setRefreshing(false)
  }, [loadShifts, loadRoster, phys.status, phys.location?.id])

  if (!profile) return null
  const firstName = profile.full_name?.split(' ')[0] || 'there'

  // Moved here from the old Home: the all-features-off onboarding nudge.
  if (!hasAnyMobileFeature(profile, activeLocation)) {
    return (
      <ScrollView className="flex-1 bg-un1t-bg" contentContainerClassName="p-6">
        <Text className="text-3xl font-bold text-un1t-text mb-1">Hi {firstName}</Text>
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mt-4">
          <Text className="text-base font-semibold text-un1t-text mb-1">Mobile features off</Text>
          <Text className="text-sm text-un1t-subtle">
            An admin hasn&apos;t enabled any mobile features for your account yet. Ask the gym
            manager to turn on Schedule, Pipeline, or WhatsApp from your profile in the web app.
          </Text>
        </View>
      </ScrollView>
    )
  }

  const controlsPickable = pickerLocations(profile, locations, 'device_control')

  function openManualControls() {
    if (controlsPickable.length === 0) return
    if (controlsPickable.length === 1) {
      router.push({ pathname: '/controls', params: { loc: controlsPickable[0].id } })
      return
    }
    Alert.alert('Control which studio?', 'Commands go to the studio you pick.', [
      ...controlsPickable.map((l) => ({
        text: l.name,
        onPress: () => router.push({ pathname: '/controls', params: { loc: l.id } }),
      })),
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const onSite = phys.status === 'at_studio'
  const tiles = onSite ? homeTiles(profile, phys.location) : []
  const groups = groupShiftsByDay(myShifts || [], isoDate(new Date()))
  const showChips = (locations || []).length > 1

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerClassName="px-4 pt-4 pb-24"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
    >
      <Text className="text-3xl font-bold text-un1t-text">Hi {firstName}</Text>

      {phys.status === 'loading' ? (
        <View className="py-10 items-center"><ActivityIndicator color="#94A3B8" /></View>
      ) : onSite ? (
        <>
          {/* ON-SITE — the studio you are standing in, unmissable. */}
          <View className="flex-row items-center mt-1 mb-1">
            <Text className="text-xl font-semibold text-un1t-text">{phys.location.name}</Text>
          </View>
          <LocationPill location={phys.location} source="detected" />

          {tiles.length > 0 ? (
            <View className="gap-3">
              {tiles.map((t) => (
                <ChoiceCard key={t.key} icon={t.icon} tint={t.tint} title={t.title} subtitle={t.subtitle}
                  onPress={() => router.push(t.href)} />
              ))}
            </View>
          ) : (
            <Text className="text-sm text-un1t-subtle">No studio controls are enabled for you here.</Text>
          )}

          {roster.length > 0 && (
            <>
              <Text className="text-base font-semibold text-un1t-text mt-6 mb-2">Today at {phys.location.name}</Text>
              <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-1">
                {roster.map((s, i) => (
                  <View key={s.id || i} className={`flex-row items-center justify-between py-2.5 ${i > 0 ? 'border-t border-un1t-border' : ''}`}>
                    <Text className="text-sm text-un1t-text">{s.profiles?.full_name || 'Coach'}</Text>
                    <Text className="text-xs text-un1t-subtle">{shiftTimeLabel(s)}</Text>
                  </View>
                ))}
              </View>
            </>
          )}
        </>
      ) : (
        <>
          {/* OFFSITE / UNKNOWN — when you're next in, and where. */}
          <Text className="text-sm text-un1t-subtle mb-4">Your next 7 days</Text>

          {shiftsError ? (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4">
              <Text className="text-xs text-red-700">{shiftsError}</Text>
            </View>
          ) : myShifts === null ? (
            <View className="py-6 items-center"><ActivityIndicator color="#94A3B8" /></View>
          ) : groups.length === 0 ? (
            <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-4">
              <Text className="text-sm text-un1t-subtle">No shifts this week.</Text>
            </View>
          ) : (
            groups.map((g) => (
              <View key={g.iso} className="mb-4">
                <Text className="text-xs font-semibold text-un1t-subtle uppercase mb-1.5">{g.label}</Text>
                <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-1">
                  {g.shifts.map((s, i) => {
                    const c = showChips && (s.locations?.id || s.location_id)
                      ? pickLocationColor(s.locations?.id || s.location_id) : null
                    return (
                      <View key={s.id || i} className={`flex-row items-center justify-between py-2.5 ${i > 0 ? 'border-t border-un1t-border' : ''}`}>
                        <View className="flex-1 mr-2">
                          <Text className="text-sm font-medium text-un1t-text">{s.shift_templates?.name || 'Shift'}</Text>
                          <Text className="text-xs text-un1t-subtle mt-0.5">{shiftTimeLabel(s)}</Text>
                        </View>
                        {c && s.locations?.name ? (
                          <View className={`rounded-full px-2 py-0.5 ${c.bg}`}>
                            <Text className={`text-[10px] font-semibold ${c.text}`}>{s.locations.name}</Text>
                          </View>
                        ) : null}
                      </View>
                    )
                  })}
                </View>
              </View>
            ))
          )}

          {controlsPickable.length > 0 && (
            <Pressable onPress={openManualControls} accessibilityRole="button"
              className="flex-row items-center bg-un1t-surface border border-un1t-border rounded-2xl p-4 mt-2 active:opacity-70">
              <Ionicons name="options-outline" size={18} color="#94A3B8" />
              <Text className="text-sm text-un1t-text ml-3 flex-1">Studio controls</Text>
              <Text className="text-xs text-un1t-subtle mr-1">remote</Text>
              <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
            </Pressable>
          )}
        </>
      )}
    </ScrollView>
  )
}
```

Check `pickLocationColor`'s real return shape in `shared/location-colors.js` (`{ bg, text }` Tailwind classes) and adjust the chip render if it differs.

- [ ] **Step 2: Verify against the wire shapes**

Confirm the roster rows embed `profiles(full_name)` (the `getTeamShifts` comment in `mobile/lib/schedule-api.js` says they do) and my-shift rows embed `locations`. If a field differs, fix the render, not the API.

- [ ] **Step 3: Delete the nudge block from `dashboard.jsx`**

Home owns the `hasAnyMobileFeature` nudge now. In `dashboard.jsx`, delete that early-return block (and its now-unused import if `hasAnyMobileFeature` isn't referenced elsewhere in the file). The "no dashboard permissions" stub in `dashboard.jsx` is now unreachable for real users (the tab is hidden without dashboard perms) but keep it — defence in depth for deep links, matching repo convention.

- [ ] **Step 4: Verify**

Run: `node mobile/parse-check.mjs` and `npx vitest run mobile/lib`
Expected: clean; PASS.

- [ ] **Step 5: Commit**

```bash
git add 'mobile/app/(staff)/(tabs)/index.jsx' 'mobile/app/(staff)/(tabs)/dashboard.jsx'
git commit -m "HOME-LOC.8 — new Home: on-site controls + roster / offsite 7-day cross-studio shifts"
```

---

### Task 9: Manual controls launcher (`/controls?loc=`)

**Files:**
- Create: `mobile/app/(staff)/controls/_layout.jsx`
- Create: `mobile/app/(staff)/controls/index.jsx`

Stack screen (params die on pop → per-visit by construction). Mirrors the doors/sonos `_layout` pattern.

- [ ] **Step 1: `_layout.jsx`**

```jsx
// HOME-LOC.9 — Studio controls launcher stack (manual/remote entry from Home).
import { Stack } from 'expo-router'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function ControlsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#111827',
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: 'Studio controls', headerLeft: () => <BackHeaderLeft label="Home" fallbackHref="/" /> }}
      />
    </Stack>
  )
}
```

Check `BackHeaderLeft`'s props against `mobile/app/(staff)/sonos/_layout.jsx` (label + fallbackHref) and match exactly.

- [ ] **Step 2: `index.jsx`**

```jsx
// mobile/app/(staff)/controls/index.jsx
//
// HOME-LOC.9 — manual "Studio controls" launcher: the offsite/remote entry
// from Home. Renders the same tile list Home shows on-site, but for the
// EXPLICITLY PICKED location (?loc=), labelled manual, and forwards ?loc= to
// every control screen so their pills agree with this screen's header.
import { View, Text, ScrollView, Pressable } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { pickerLocations } from '../../../lib/control-location'
import { homeTiles } from '../../../lib/home-logic'
import ChoiceCard from '../../../components/ChoiceCard'
import LocationPill from '../../../components/LocationPill'

export default function ControlsLauncher() {
  const { profile, locations } = useAuth()
  const router = useRouter()
  const params = useLocalSearchParams()
  const locId = typeof params.loc === 'string' ? params.loc : null
  const location = (locations || []).find((l) => l.id === locId) || null
  const pickable = pickerLocations(profile, locations, 'device_control')
  const tiles = homeTiles(profile, location)

  if (!location || tiles.length === 0) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Text className="text-sm text-un1t-subtle text-center">
          Studio controls aren&apos;t available{location ? ` for you at ${location.name}` : ' here'}.
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      <LocationPill
        location={location}
        source="manual"
        pickable={pickable}
        onPick={(id) => router.setParams({ loc: id })}
      />
      <View className="gap-3">
        {tiles.map((t) => (
          <ChoiceCard key={t.key} icon={t.icon} tint={t.tint} title={t.title} subtitle={t.subtitle}
            onPress={() => router.push({ pathname: t.href, params: { loc: location.id } })} />
        ))}
      </View>
    </ScrollView>
  )
}
```

- [ ] **Step 3: Verify + commit**

Run: `node mobile/parse-check.mjs`
Expected: clean.

```bash
git add 'mobile/app/(staff)/controls/'
git commit -m "HOME-LOC.9 — manual Studio controls launcher (?loc=), the remote entry from Home"
```

---

### Task 10: Pills + resolution on the four control screens

**Files:**
- Modify: `mobile/app/(staff)/sonos/index.jsx`
- Modify: `mobile/app/(staff)/shelly/index.jsx`
- Modify: `mobile/app/(staff)/doors/index.jsx`
- Modify: `mobile/app/(staff)/ac/index.jsx`

Same recipe on all four. Perm keys: sonos + shelly → `device_control`; doors + ac → `studio_management`. Shown in full for sonos; apply identically to the others (their `locationId` is a prop/variable already — doors passes `locationId={activeLocation?.id}` to `DoorsCard`, ac to `AcDeviceList`).

- [ ] **Step 1: Sonos — swap the location source**

In `mobile/app/(staff)/sonos/index.jsx` replace:

```js
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const locationId = activeLocation?.id
  const allowed = canMobile(profile, 'device_control', activeLocation)
```

with:

```js
  const { profile, activeLocation, locations } = useAuth()
  const router = useRouter()
  const params = useLocalSearchParams()
  const phys = usePhysicalLocation()
  // HOME-LOC.10 — override (this visit's ?loc=) ?? detected ?? activeLocation.
  // The pill below always names what the calls command; the two derive from
  // the SAME resolved value, so what you see is what you send.
  const { location: controlLocation, source } = resolveControlLocation({
    overrideId: typeof params.loc === 'string' ? params.loc : null,
    physical: phys,
    activeLocation,
    locations,
  })
  const locationId = controlLocation?.id
  const allowed = canMobile(profile, 'device_control', controlLocation)
  const pickable = pickerLocations(profile, locations, 'device_control')
```

Add imports:

```js
import { useLocalSearchParams } from 'expo-router'   // extend the existing expo-router import line
import { usePhysicalLocation } from '../../../lib/use-physical-location'
import { resolveControlLocation, pickerLocations } from '../../../lib/control-location'
import LocationPill from '../../../components/LocationPill'
```

- [ ] **Step 2: Sonos — render the pill**

The pill renders in BOTH branches so a user denied at the resolved location can still switch to a permitted one:

In the `!allowed` early-return, above the message text, insert:

```jsx
        <LocationPill location={controlLocation} source={source} pickable={pickable}
          onPick={(id) => router.setParams({ loc: id })} />
```

In the main `<ScrollView>` return, as the FIRST child, insert the same `<LocationPill …/>` element.

Guard: while `phys.status === 'loading'` and there is no override, the resolution falls back to `activeLocation` labelled manual, and may flip to detected a beat later — that is the loading tick, before any command is sent; acceptable and matches "resolve on focus". The existing `useEffect` on `[locationId]` already resets the card list to a spinner on any flip, so no stale-location cards can paint (the `listLocationRef` pattern).

- [ ] **Step 3: Repeat for shelly, doors, ac**

Apply Steps 1–2 identically to:
- `shelly/index.jsx` — same `device_control` key; it has the same `listLocationRef` pattern.
- `doors/index.jsx` — key `studio_management`; change `DoorsCard`'s prop to `locationId={locationId}` and update the subtitle line to `Unlock doors at {controlLocation?.name || 'your studio'}.`; keep the existing `scopeKey` remount key working off the new `locationId`.
- `ac/index.jsx` — key `studio_management`; change `AcDeviceList`'s prop to `locationId={locationId}`; pill above the list.

In doors/ac, verify how `scopeKey` (doors) is derived and keep its remount-on-location-change behaviour intact with the new id.

- [ ] **Step 4: Verify**

Run: `node mobile/parse-check.mjs` and `npx vitest run mobile/lib`
Expected: clean; PASS.

- [ ] **Step 5: Commit**

```bash
git add 'mobile/app/(staff)/sonos/index.jsx' 'mobile/app/(staff)/shelly/index.jsx' 'mobile/app/(staff)/doors/index.jsx' 'mobile/app/(staff)/ac/index.jsx'
git commit -m "HOME-LOC.10 — control screens resolve override ?? detected ?? active and wear the location pill"
```

---

### Task 11: Changelog + full verification

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Changelog row**

Read the last row of `docs/CHANGELOG.md`, take the next number (572 unless main moved), and append one row in the file's established format summarising: Dashboard tab split, physical-location Home, control-screen pills, `all_regions`.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: ALL PASS (~16.9k tests). Pay attention to `tests/shared-pair-sync.test.js` (we touched nothing in `shared/`, so it must pass untouched) and any snapshot of the tabs layout.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `next build` completes with no errors (works locally per repo memory; the 8GB machine may need other apps closed).

- [ ] **Step 4: Mobile parse check**

Run: `node mobile/parse-check.mjs`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add docs/CHANGELOG.md
git commit -m "HOME-LOC.11 — changelog"
```

---

## Post-merge / out-of-band (for the session driver, not the implementer)

- PR from `home-physical-location` → `origin/main`; merging publishes the OTA at 100% to the 2.3.0 public lane (`mobile/**` trigger) and deploys the `all_regions` route change together — no ordering gap.
- Phone QA (no local DB — CLAUDE.md): after OTA, at a studio: Home flips on-site with the right name; music/plugs/doors/ac pills say "detected + correct studio"; offsite: 7-day shifts render cross-studio with chips; pill picker overrides for one visit only; swap notifications land on the Dashboard tab.
- The original incident's regression check: stand in Hatch Street with `activeLocation` stuck on Stillorgan → open Studio music from anywhere → the pill must say "Hatch Street · detected" and commands must hit Hatch Street.
