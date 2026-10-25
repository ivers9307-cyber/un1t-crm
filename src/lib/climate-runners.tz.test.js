// climate-runners.tz.test.js — TZ.10. The class- and bathroom-climate runners
// match excluded weekly slots ("Sun 06:00") in each studio's own zone, read
// once per run; a location whose zone cannot be read (and which needs it) is
// skipped for the tick, logged, with no AC switched. The vendor, device loader
// and audit are mocked; a small in-memory Supabase fake stands in for the DB.
process.env.TZ = 'America/Los_Angeles' // host zone is none of the zones under test
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(() => Promise.resolve()) }))
const vendorTurnOn = vi.fn()
const loadDeviceWithLocation = vi.fn()
vi.mock('@/lib/ac-devices', async (importOriginal) => ({
  ...(await importOriginal()),
  vendorTurnOn: (...a) => vendorTurnOn(...a),
  loadDeviceWithLocation: (...a) => loadDeviceWithLocation(...a),
}))

const { runClassClimate, runClassClimateForLocation } = await import('./class-climate-runner.js')
const { runBathroomClimate } = await import('./bathroom-climate-runner.js')
const { resetLocationZoneCache } = await import('./location-time.js')
const { logWarn } = await import('@/lib/log')

const NY_LOC = 'a0000000-0000-0000-0000-0000000000a1'
const DUB_LOC = 'a0000000-0000-0000-0000-0000000000d1'
const ZONES = { [NY_LOC]: 'America/New_York', [DUB_LOC]: 'Europe/Dublin' }

// Sun 8 Mar 2026, 10:00Z: 06:00 EDT in New York (the morning DST began), 10:00 GMT in Dublin.
const START = '2026-03-08T10:00:00.000Z'
const occFor = (loc, id) => ({ glofox_event_id: id, location_id: loc, name: 'HIIT', starts_at: START, ends_at: '2026-03-08T10:45:00.000Z', cancelled_at: null })

function makeDb(tables, { locationsError = null } = {}) {
  const store = { automation_fire_log: [], ac_sessions: [], class_occurrences: [], location_automations: [], ...tables }
  const reads = { locations: 0 }
  function builder(table) {
    const filters = []
    let op = 'select'
    let payload = null
    const rows = () => (store[table] || []).filter((r) => filters.every(([k, c, v]) => {
      if (k === 'eq') return r[c] === v
      if (k === 'gte') return r[c] >= v
      if (k === 'lte') return r[c] <= v
      if (k === 'in') return v.includes(r[c])
      if (k === 'is') return v === null ? r[c] == null : r[c] === v
      return true
    }))
    const result = () => {
      if (table === 'locations') {
        reads.locations++
        if (locationsError) return { data: null, error: locationsError }
      }
      if (op === 'insert') { store[table].push(...[].concat(payload)); return { data: payload, error: null } }
      if (op !== 'select') return { data: null, error: null }
      return { data: rows(), error: null }
    }
    const chain = {
      select() { return chain },
      eq(c, v) { filters.push(['eq', c, v]); return chain },
      gte(c, v) { filters.push(['gte', c, v]); return chain },
      lte(c, v) { filters.push(['lte', c, v]); return chain },
      in(c, v) { filters.push(['in', c, v]); return chain },
      is(c, v) { filters.push(['is', c, v]); return chain },
      order() { return chain },
      limit() { return chain },
      insert(p) { op = 'insert'; payload = p; return chain },
      upsert(p) { op = 'upsert'; payload = p; return chain },
      update(p) { op = 'update'; payload = p; return chain },
      maybeSingle() { const r = result(); return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: null }) },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject) },
    }
    return chain
  }
  return { from: (t) => builder(t), _store: store, reads }
}

const locationsTable = Object.entries(ZONES).map(([id, timezone]) => ({ id, timezone }))
const classCfg = (excluded) => ({ device_ids: ['dev1'], offset_on_min: 15, offset_off_min: 5, class_filter: [], excluded_slots: excluded })
const bathCfg = (excluded) => ({ device_ids: ['dev1'], delay_after_start_min: 0, run_duration_min: 30, class_filter: [], excluded_slots: excluded })

beforeEach(() => {
  resetLocationZoneCache()
  vendorTurnOn.mockReset().mockResolvedValue({ ok: true, observed: {} })
  loadDeviceWithLocation.mockReset().mockImplementation(async (id, _db) => ({
    ok: true, device: { id, location_id: loadDeviceWithLocation.locationId, label: 'AC', provider: 'sensibo', provider_device_id: 'pod' }, location: { id: loadDeviceWithLocation.locationId },
  }))
  logWarn.mockClear()
})

describe('TZ.10 class-climate: excluded slots are the studio\'s wall clock', () => {
  const nowMs = Date.parse('2026-03-08T09:50:00Z') // inside the 15-min pre-class window

  it('"Sun 06:00" excludes New York\'s 06:00 class; Dublin\'s 10:00 class at the same instant still fires', async () => {
    const db = makeDb({
      locations: locationsTable,
      class_occurrences: [occFor(NY_LOC, 'ny1'), occFor(DUB_LOC, 'dub1')],
      location_automations: [
        { location_id: NY_LOC, automation_key: 'class_climate', enabled: true, config: classCfg(['Sun 06:00']) },
        { location_id: DUB_LOC, automation_key: 'class_climate', enabled: true, config: classCfg(['Sun 06:00']) },
      ],
    })
    loadDeviceWithLocation.locationId = DUB_LOC
    const out = await runClassClimate(db, { nowMs })
    const byLoc = Object.fromEntries(out.locations.map((l) => [l.location_id, l]))
    expect(byLoc[NY_LOC].planned).toEqual([])
    expect(byLoc[DUB_LOC].planned.map((p) => p.glofox_event_id)).toEqual(['dub1'])
    expect(vendorTurnOn).toHaveBeenCalledTimes(1)
    // ONE zone read for the run (the per-location lookups hit the warmed cache).
    expect(db.reads.locations).toBe(1)
  })

  it('a Dublin studio excluding "Sun 10:00" is unchanged', async () => {
    const db = makeDb({ locations: locationsTable, class_occurrences: [occFor(DUB_LOC, 'dub1')] })
    const out = await runClassClimateForLocation(db, { location_id: DUB_LOC, config: classCfg(['Sun 10:00']) }, { nowMs, dryRun: true })
    expect(out.planned).toEqual([])
  })

  it('an unreadable zone skips the location that needs it, logged, with NO AC switched; one that excludes nothing still runs', async () => {
    const db = makeDb({
      class_occurrences: [occFor(NY_LOC, 'ny1'), occFor(DUB_LOC, 'dub1')],
      location_automations: [
        { location_id: NY_LOC, automation_key: 'class_climate', enabled: true, config: classCfg(['Sun 06:00']) },
        { location_id: DUB_LOC, automation_key: 'class_climate', enabled: true, config: classCfg([]) },
      ],
    }, { locationsError: { message: 'connection reset' } })
    loadDeviceWithLocation.locationId = DUB_LOC
    const out = await runClassClimate(db, { nowMs })
    const byLoc = Object.fromEntries(out.locations.map((l) => [l.location_id, l]))
    expect(byLoc[NY_LOC]).toMatchObject({ planned: [], actions: [], errors: ['zone_unreadable'] })
    expect(byLoc[DUB_LOC].actions.map((a) => a.status)).toEqual(['fired'])
    expect(loadDeviceWithLocation).toHaveBeenCalledTimes(1)
    expect(vendorTurnOn).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith('class-climate', expect.stringMatching(/timezone unreadable; location skipped/), expect.objectContaining({ locationId: NY_LOC }))
  })

  it('no excluded slots: no zone is read at all', async () => {
    const db = makeDb({ class_occurrences: [occFor(DUB_LOC, 'dub1')] }, { locationsError: { message: 'down' } })
    const out = await runClassClimateForLocation(db, { location_id: DUB_LOC, config: classCfg([]) }, { nowMs, dryRun: true })
    expect(out.planned.map((p) => p.glofox_event_id)).toEqual(['dub1'])
    expect(db.reads.locations).toBe(0)
  })
})

describe('TZ.10 bathroom-climate: the same rule', () => {
  const nowMs = Date.parse('2026-03-08T10:05:00Z')

  it('excludes New York\'s "Sun 06:00" in New York\'s clock', async () => {
    const db = makeDb({
      locations: locationsTable,
      class_occurrences: [occFor(NY_LOC, 'ny1')],
      location_automations: [{ location_id: NY_LOC, automation_key: 'bathroom_climate', enabled: true, config: bathCfg(['Sun 06:00']) }],
    })
    const out = await runBathroomClimate(db, { nowMs, dryRun: true })
    expect(out.locations[0].planned).toEqual([])
  })

  it('an unreadable zone skips the location, logged, with NO AC switched', async () => {
    const db = makeDb({
      class_occurrences: [occFor(NY_LOC, 'ny1')],
      location_automations: [{ location_id: NY_LOC, automation_key: 'bathroom_climate', enabled: true, config: bathCfg(['Sun 06:00']) }],
    }, { locationsError: { message: 'connection reset' } })
    const out = await runBathroomClimate(db, { nowMs })
    expect(out.locations[0]).toMatchObject({ planned: [], actions: [], errors: ['zone_unreadable'] })
    expect(loadDeviceWithLocation).not.toHaveBeenCalled()
    expect(vendorTurnOn).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('bathroom-climate', expect.stringMatching(/timezone unreadable; location skipped/), expect.objectContaining({ locationId: NY_LOC }))
  })
})
