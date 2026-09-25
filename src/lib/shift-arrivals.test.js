// src/lib/shift-arrivals.test.js
//
// ARRIVALSHOW.1 — what "arrived" means on a coach's own shift, as the phone
// is told it. Every row in the table in the plan
// (docs/superpowers/plans/2026-09-25-scheduler-wave2-3/34-ARRIVALSHOW.1.md)
// is a case here. Fixture names are made up (the repo is public).

import { describe, it, expect, vi } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn() }))
const { annotateOwnArrivals, ownLocationIds } = await import('./shift-arrivals')

const L1 = 'loc-still'
const L2 = 'loc-hatch'
const ME = 'me'

// A toApiShiftRow()-shaped row (src/lib/roster-read.js): only the keys the
// model reads. start/end_time_override are the collapsed EFFECTIVE override.
const row = (id, over = {}) => ({
  id,
  profile_id: ME,
  location_id: L1,
  shift_date: '2026-09-24',
  block_start_time: '07:00:00',
  block_end_time: '08:00:00',
  start_time_override: null,
  end_time_override: null,
  ...over,
})
const stamp = (id, at, source = 'geofence') => [id, { id, arrived_at: at, arrival_source: source }]
const facts = (stamps, over = {}) => ({
  stamps: new Map(stamps),
  timezones: new Map([[L1, 'Europe/Dublin'], [L2, 'Europe/Dublin']]),
  tracked: new Map([[L1, true], [L2, true]]),
  ...over,
})
const arrivalOf = (rows, f, id) => annotateOwnArrivals(rows, f, ME).find((r) => r.id === id).arrival

describe('annotateOwnArrivals — a stamp on this shift', () => {
  it('reads as arrived, with the studio-local time and the effective window (BST)', () => {
    expect(arrivalOf([row('a1')], facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), 'a1')).toEqual({
      at: '2026-09-24T05:52:00.000Z',
      at_local: '06:52',
      at_local_date: '2026-09-24',
      source: 'geofence',
      carried: false,
      tracked: true,
      starts_at: '2026-09-24T06:00:00.000Z',
      ends_at: '2026-09-24T07:00:00.000Z',
    })
  })

  it('an arrival before midnight for a 00:30 shift keeps its own local date', () => {
    const r = row('a1', { shift_date: '2026-09-25', block_start_time: '00:30:00', block_end_time: '01:30:00' })
    const a = arrivalOf([r], facts([stamp('a1', '2026-09-24T22:50:00.000Z')]), 'a1')
    expect(a.at_local).toBe('23:50')
    expect(a.at_local_date).toBe('2026-09-24')
  })

  it('a stamp is shown even where arrivals are no longer tracked (exempted later)', () => {
    const a = arrivalOf([row('a1')], facts([stamp('a1', '2026-09-24T05:52:00.000Z')], { tracked: new Map([[L1, false]]) }), 'a1')
    expect(a.at).toBe('2026-09-24T05:52:00.000Z')
    expect(a.tracked).toBe(false)
  })
})

describe('annotateOwnArrivals — on site from an earlier shift (the report rule, D2)', () => {
  it('a back-to-back shift within 60 minutes of the earlier BLOCK end is on site', () => {
    const rows = [row('a1'), row('a2', { block_start_time: '08:30:00', block_end_time: '09:30:00' })]
    const a = arrivalOf(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), 'a2')
    expect(a).toMatchObject({ at: '2026-09-24T05:52:00.000Z', at_local: '06:52', carried: true, source: null })
  })

  it('61 minutes after is not on site', () => {
    const rows = [row('a1'), row('a2', { block_start_time: '09:01:00', block_end_time: '10:00:00' })]
    const a = arrivalOf(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), 'a2')
    expect(a).toMatchObject({ at: null, at_local: null, carried: false })
  })

  it('another studio the same day is not on site', () => {
    const rows = [row('a1'), row('a2', { location_id: L2, block_start_time: '08:30:00', block_end_time: '09:30:00' })]
    expect(arrivalOf(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), 'a2').carried).toBe(false)
  })

  it('another day is not on site', () => {
    const rows = [row('a1'), row('a2', { shift_date: '2026-09-25' })]
    expect(arrivalOf(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), 'a2').carried).toBe(false)
  })

  it('a carry chains across three back-to-back shifts', () => {
    const rows = [
      row('a1'),
      row('a2', { block_start_time: '08:00:00', block_end_time: '09:00:00' }),
      row('a3', { block_start_time: '09:30:00', block_end_time: '10:30:00' }),
    ]
    const out = annotateOwnArrivals(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), ME)
    expect(out.map((r) => r.arrival.carried)).toEqual([false, true, true])
    expect(out[2].arrival.at_local).toBe('06:52')
  })

  it('order in the payload does not matter', () => {
    const rows = [row('a2', { block_start_time: '08:30:00', block_end_time: '09:30:00' }), row('a1')]
    const out = annotateOwnArrivals(rows, facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), ME)
    expect(out.map((r) => r.id)).toEqual(['a2', 'a1'])
    expect(out[0].arrival.carried).toBe(true)
  })
})

describe('annotateOwnArrivals — the double-stamp shape (D3)', () => {
  it('the same instant on two shifts reads the second as on site, not a second arrival', () => {
    const rows = [row('a1'), row('a2', { block_start_time: '07:30:00', block_end_time: '08:30:00' })]
    const f = facts([stamp('a1', '2026-09-24T05:52:00.000Z'), stamp('a2', '2026-09-24T05:52:00.000Z')])
    const out = annotateOwnArrivals(rows, f, ME)
    expect(out[0].arrival.carried).toBe(false)
    expect(out[1].arrival).toMatchObject({ at: '2026-09-24T05:52:00.000Z', carried: true })
  })

  it('two different instants are two arrivals', () => {
    const rows = [row('a1'), row('a2', { block_start_time: '12:00:00', block_end_time: '13:00:00' })]
    const f = facts([stamp('a1', '2026-09-24T05:52:00.000Z'), stamp('a2', '2026-09-24T10:40:00.000Z')])
    expect(annotateOwnArrivals(rows, f, ME).map((r) => r.arrival.carried)).toEqual([false, false])
  })

  it('the same instant at two different studios is not folded', () => {
    const rows = [row('a1'), row('a2', { location_id: L2, block_start_time: '07:30:00', block_end_time: '08:30:00' })]
    const f = facts([stamp('a1', '2026-09-24T05:52:00.000Z'), stamp('a2', '2026-09-24T05:52:00.000Z')])
    expect(annotateOwnArrivals(rows, f, ME)[1].arrival.carried).toBe(false)
  })
})

describe('annotateOwnArrivals — the window the absence line is judged on (D5)', () => {
  it('no stamp: the window is still sent, for the phone to judge against now', () => {
    expect(arrivalOf([row('a1')], facts([]), 'a1')).toEqual({
      at: null, at_local: null, at_local_date: null, source: null, carried: false, tracked: true,
      starts_at: '2026-09-24T06:00:00.000Z', ends_at: '2026-09-24T07:00:00.000Z',
    })
  })

  it('an override moves the window; the override is never an arrival', () => {
    const r = row('a1', { block_start_time: '07:00:00', block_end_time: '10:00:00', start_time_override: '08:00:00' })
    expect(arrivalOf([r], facts([]), 'a1')).toMatchObject({ at: null, starts_at: '2026-09-24T07:00:00.000Z', ends_at: '2026-09-24T09:00:00.000Z' })
  })

  it('an override ending after midnight wraps to the next day', () => {
    const r = row('a1', { start_time_override: '22:00:00', end_time_override: '01:00:00' })
    expect(arrivalOf([r], facts([]), 'a1')).toMatchObject({ starts_at: '2026-09-24T21:00:00.000Z', ends_at: '2026-09-25T00:00:00.000Z' })
  })

  it('winter time (GMT)', () => {
    const r = row('a1', { shift_date: '2026-01-10', block_start_time: '09:00:00', block_end_time: '10:00:00' })
    expect(arrivalOf([r], facts([]), 'a1').starts_at).toBe('2026-01-10T09:00:00.000Z')
  })

  it('the spring-forward day', () => {
    const r = row('a1', { shift_date: '2026-03-29', block_start_time: '09:00:00', block_end_time: '10:00:00' })
    expect(arrivalOf([r], facts([]), 'a1').starts_at).toBe('2026-03-29T08:00:00.000Z')
  })

  it('a row without times sends no window (the phone then shows no absence)', () => {
    const r = row('a1', { block_start_time: null, block_end_time: null })
    expect(arrivalOf([r], facts([]), 'a1')).toMatchObject({ starts_at: null, ends_at: null })
  })

  it('an unknown studio timezone falls back to Dublin', () => {
    expect(arrivalOf([row('a1')], facts([], { timezones: new Map() }), 'a1').starts_at).toBe('2026-09-24T06:00:00.000Z')
  })
})

describe('annotateOwnArrivals — tracking (D8)', () => {
  it('a studio in the tracking map as false is not tracked', () => {
    expect(arrivalOf([row('a1')], facts([], { tracked: new Map([[L1, false]]) }), 'a1').tracked).toBe(false)
  })
  it('a studio missing from a successful tracking read is not tracked', () => {
    expect(arrivalOf([row('a1')], facts([], { tracked: new Map() }), 'a1').tracked).toBe(false)
  })
  it('a failed tracking read is unknown (null), and the stamps still ride', () => {
    const a = arrivalOf([row('a1')], facts([stamp('a1', '2026-09-24T05:52:00.000Z')], { tracked: null }), 'a1')
    expect(a.tracked).toBeNull()
    expect(a.at).toBe('2026-09-24T05:52:00.000Z')
  })
})

describe('annotateOwnArrivals — own rows only, unknown is never absence (D1, D6)', () => {
  it("a colleague's row is null even when the facts name it", () => {
    const rows = [row('a1'), row('c1', { profile_id: 'colleague' })]
    const f = facts([stamp('a1', '2026-09-24T05:52:00.000Z'), stamp('c1', '2026-09-24T05:40:00.000Z')])
    const out = annotateOwnArrivals(rows, f, ME)
    expect(out[1].arrival).toBeNull()
    expect(out[0].arrival.at).toBe('2026-09-24T05:52:00.000Z')
  })

  it("a manager's team feed carries nobody else's arrival", () => {
    const rows = [row('m1', { profile_id: 'manager' }), row('c1', { profile_id: 'coach-a' }), row('c2', { profile_id: 'coach-b' })]
    const f = facts([stamp('m1', '2026-09-24T05:50:00.000Z'), stamp('c1', '2026-09-24T05:51:00.000Z'), stamp('c2', '2026-09-24T05:52:00.000Z')])
    const out = annotateOwnArrivals(rows, f, 'manager')
    expect(out.map((r) => r.arrival?.at ?? null)).toEqual(['2026-09-24T05:50:00.000Z', null, null])
  })

  it("a colleague's stamp is never carried onto the viewer's shift", () => {
    const rows = [row('c1', { profile_id: 'colleague' }), row('a2', { block_start_time: '08:30:00', block_end_time: '09:30:00' })]
    const out = annotateOwnArrivals(rows, facts([stamp('c1', '2026-09-24T05:52:00.000Z')]), ME)
    expect(out[1].arrival.carried).toBe(false)
  })

  it('a failed stamps read is null on every row, never an absence', () => {
    const out = annotateOwnArrivals([row('a1'), row('c1', { profile_id: 'x' })], facts([], { stamps: null }), ME)
    expect(out.map((r) => r.arrival)).toEqual([null, null])
  })

  it('no viewer: every row is null', () => {
    expect(annotateOwnArrivals([row('a1')], facts([stamp('a1', '2026-09-24T05:52:00.000Z')]), null).map((r) => r.arrival)).toEqual([null])
  })

  it('keeps every other field and does not mutate its input', () => {
    const r = row('a1', { open_swap_status: 'pending' })
    const before = JSON.parse(JSON.stringify(r))
    const out = annotateOwnArrivals([r], facts([]), ME)
    expect(out[0].open_swap_status).toBe('pending')
    expect(r).toEqual(before)
  })

  it('a non-array input is an empty list', () => {
    expect(annotateOwnArrivals(null, facts([]), ME)).toEqual([])
  })
})

describe('ownLocationIds', () => {
  it("is the studios of the caller's own rows, de-duplicated, nobody else's", () => {
    const rows = [row('a1'), row('a2'), row('a3', { location_id: L2 }), row('c1', { profile_id: 'x', location_id: 'loc-other' })]
    expect(ownLocationIds(rows, ME)).toEqual([L1, L2])
  })
  it('no viewer or no rows is empty', () => {
    expect(ownLocationIds([row('a1')], null)).toEqual([])
    expect(ownLocationIds(null, ME)).toEqual([])
  })
})

// ── fetchOwnArrivalFacts ──────────────────────────────────────────
const { fetchOwnArrivalFacts, OWN_ARRIVAL_ID_CHUNK } = await import('./shift-arrivals')
const { logWarn } = await import('./log')

// Records EVERY query with its filters; `result(q)` answers per query.
function mockDb(result) {
  const queries = []
  return {
    queries,
    from(t) {
      const q = { table: t, select: null, filters: [] }
      queries.push(q)
      const b = {
        select: (c) => { q.select = c; return b },
        eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
        in: (c, v) => { q.filters.push(['in', c, v]); return b },
        then: (res, rej) => Promise.resolve(result(q)).then(res, rej),
      }
      return b
    },
  }
}
const ok = (data) => ({ data, error: null })
const answers = (byTable) => (q) => byTable[q.table](q)
const geoOn = { geofence: { enabled: true, latitude: 53.29, longitude: -6.2, radius_m: 100 } }

describe('fetchOwnArrivalFacts', () => {
  it('reads stamps keyed on the caller AND bounded to their own ids; tracking keyed on the caller', async () => {
    const db = mockDb(answers({
      shift_assignments: () => ok([{ id: 'a1', arrived_at: '2026-09-24T05:52:00.000Z', arrival_source: 'geofence' }, { id: 'a2', arrived_at: null, arrival_source: null }]),
      locations: () => ok([{ id: L1, timezone: 'Europe/Dublin', settings: geoOn }, { id: L2, timezone: 'Europe/Dublin', settings: {} }]),
      profile_locations: () => ok([{ location_id: L1, geofence_exempt: false }, { location_id: L2, geofence_exempt: false }]),
    }))
    const f = await fetchOwnArrivalFacts(db, ME, ['a1', 'a2'], [L1, L2])

    const sa = db.queries.find((q) => q.table === 'shift_assignments')
    expect(sa.select).toBe('id, arrived_at, arrival_source')
    expect(sa.filters).toEqual([['eq', 'profile_id', ME], ['in', 'id', ['a1', 'a2']]])
    const pl = db.queries.find((q) => q.table === 'profile_locations')
    expect(pl.select).toBe('location_id, geofence_exempt')
    expect(pl.filters).toEqual([['eq', 'profile_id', ME], ['in', 'location_id', [L1, L2]]])
    const lo = db.queries.find((q) => q.table === 'locations')
    expect(lo.select).toBe('id, timezone, settings')
    expect(lo.filters).toEqual([['in', 'id', [L1, L2]]])

    expect([...f.stamps.keys()]).toEqual(['a1'])           // a row with no arrival is not a stamp
    expect(f.timezones.get(L1)).toBe('Europe/Dublin')
    expect(Object.fromEntries(f.tracked)).toEqual({ [L1]: true, [L2]: false }) // L2 geofence not configured
  })

  it('an exempt coach is not tracked; no membership row is not tracked', async () => {
    const db = mockDb(answers({
      shift_assignments: () => ok([]),
      locations: () => ok([{ id: L1, timezone: null, settings: geoOn }, { id: L2, timezone: null, settings: geoOn }]),
      profile_locations: () => ok([{ location_id: L1, geofence_exempt: true }]),
    }))
    const f = await fetchOwnArrivalFacts(db, ME, ['a1'], [L1, L2])
    expect(Object.fromEntries(f.tracked)).toEqual({ [L1]: false, [L2]: false })
  })

  it('chunks the stamps read past OWN_ARRIVAL_ID_CHUNK ids', async () => {
    const ids = Array.from({ length: OWN_ARRIVAL_ID_CHUNK + 5 }, (_, i) => `a${i}`)
    const db = mockDb(answers({ shift_assignments: () => ok([]), locations: () => ok([]), profile_locations: () => ok([]) }))
    await fetchOwnArrivalFacts(db, ME, ids, [L1])
    const reads = db.queries.filter((q) => q.table === 'shift_assignments')
    expect(reads).toHaveLength(2)
    expect(reads[0].filters[1][2]).toHaveLength(OWN_ARRIVAL_ID_CHUNK)
    expect(reads[1].filters[1][2]).toHaveLength(5)
  })

  it('no viewer or no own ids costs no query at all', async () => {
    const db = mockDb(() => { throw new Error('should not query') })
    expect(await fetchOwnArrivalFacts(db, ME, [], [L1])).toEqual({ stamps: new Map(), timezones: new Map(), tracked: new Map() })
    expect(await fetchOwnArrivalFacts(db, null, ['a1'], [L1])).toEqual({ stamps: new Map(), timezones: new Map(), tracked: new Map() })
    expect(db.queries).toHaveLength(0)
  })

  it('a failed stamps read is null (unknown), logged, never thrown', async () => {
    logWarn.mockClear()
    const db = mockDb(answers({
      shift_assignments: () => ({ data: null, error: { message: 'boom' } }),
      locations: () => ok([{ id: L1, timezone: 'Europe/Dublin', settings: geoOn }]),
      profile_locations: () => ok([{ location_id: L1, geofence_exempt: false }]),
    }))
    const f = await fetchOwnArrivalFacts(db, ME, ['a1'], [L1])
    expect(f.stamps).toBeNull()
    expect(f.tracked.get(L1)).toBe(true)
    expect(logWarn).toHaveBeenCalledWith('schedule', expect.stringContaining('arrivals'), expect.anything())
  })

  it('a failed membership read makes tracking unknown (null) but keeps the timezones', async () => {
    const db = mockDb(answers({
      shift_assignments: () => ok([]),
      locations: () => ok([{ id: L1, timezone: 'Europe/Dublin', settings: geoOn }]),
      profile_locations: () => ({ data: null, error: { message: 'boom' } }),
    }))
    const f = await fetchOwnArrivalFacts(db, ME, ['a1'], [L1])
    expect(f.tracked).toBeNull()
    expect(f.timezones.get(L1)).toBe('Europe/Dublin')
  })

  it('a failed locations read makes tracking unknown and leaves the timezones empty (Dublin)', async () => {
    const db = mockDb(answers({
      shift_assignments: () => ok([]),
      locations: () => ({ data: null, error: { message: 'boom' } }),
      profile_locations: () => ok([]),
    }))
    const f = await fetchOwnArrivalFacts(db, ME, ['a1'], [L1])
    expect(f.tracked).toBeNull()
    expect(f.timezones.size).toBe(0)
  })

  it('a read that throws is caught', async () => {
    const db = mockDb(() => { throw new Error('socket hang up') })
    const f = await fetchOwnArrivalFacts(db, ME, ['a1'], [L1])
    expect(f.stamps).toBeNull()
    expect(f.tracked).toBeNull()
  })
})
