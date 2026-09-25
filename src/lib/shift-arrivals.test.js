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
