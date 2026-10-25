// TZ.3 — the timezone-change preflight and the drip-broadcast follow.
//
// D2 = A (Richard, 11 Oct 2026): an owner may change a location's zone at any
// time. The preflight only REPORTS what has future wall-clock meaning at the
// studio; it never refuses. What is pinned here:
//   - "future" is judged against TODAY IN THE LOCATION'S CURRENT ZONE, never the
//     UTC day (Dublin just after local midnight in summer time; New York the
//     night before the 2026 spring-forward)
//   - every count is a head:true count scoped by location_id (the 1k cap never
//     applies), except hyrox (a block's end is starts_on + 7*weeks, which
//     PostgREST cannot filter, so the active blocks are paged with .range) and
//     the pending sequence steps (scoped through email_sequences.location_id:
//     an embedded filter under head:true silently counts 0, CLAUDE.md)
//   - a failed read is null and listed in `unknown`, NEVER 0
//   - followBroadcastZone moves the unfinished broadcasts whose send_window_tz
//     IS the old zone (compared through canonicalZone) and lists the rest

import { describe, it, expect } from 'vitest'
import {
  timezoneChangePreflight,
  followBroadcastZone,
  PREFLIGHT_KEYS,
} from './timezone-change.js'

const LOC = 'a0000000-0000-0000-0000-000000000001'

// A recording fake: every chain is a thenable whose result comes from
// `answer(table, state)`. state = { table, cols, opts, filters: [[op, col, val]], range, update }.
function fakeDb(answer) {
  const calls = []
  return {
    calls,
    from(table) {
      const state = { table, cols: null, opts: null, filters: [], range: null, update: null, order: null }
      calls.push(state)
      const b = {
        select(cols, opts) { state.cols = cols; state.opts = opts || null; return b },
        update(p) { state.update = p; return b },
        eq(c, v) { state.filters.push(['eq', c, v]); return b },
        neq(c, v) { state.filters.push(['neq', c, v]); return b },
        gte(c, v) { state.filters.push(['gte', c, v]); return b },
        gt(c, v) { state.filters.push(['gt', c, v]); return b },
        in(c, v) { state.filters.push(['in', c, v]); return b },
        order(c) { state.order = c; return b },
        range(a, z) { state.range = [a, z]; return b },
        then(res, rej) { return Promise.resolve().then(() => answer(table, state)).then(res, rej) },
      }
      return b
    },
  }
}
const f = (state, op, col) => state.filters.find(([o, c]) => o === op && c === col)?.[2]

const COUNTS = { bookings: 4, shift_blocks: 7, race_events: 1, sonos_schedules: 2, shelly_devices: 3, whatsapp_broadcasts: 1, sequence_enrollments: 5 }
function happy(overrides = {}) {
  return (table, state) => {
    if (overrides[table]) return overrides[table](state)
    if (table === 'email_sequences') return { data: [{ id: 's1' }, { id: 's2' }], error: null }
    if (table === 'hyrox_blocks') return { data: [], error: null }
    return { count: COUNTS[table], data: null, error: null }
  }
}

describe('timezoneChangePreflight', () => {
  it('lists the keys the dialog shows, in order', () => {
    expect(PREFLIGHT_KEYS).toEqual(['bookings', 'shift_blocks', 'race_events', 'hyrox_blocks',
      'pending_enrolments', 'sonos_schedules', 'shelly_devices', 'drip_broadcasts'])
  })

  it('Europe/Dublin: today is the LOCAL day just after midnight in summer time, not the UTC day', async () => {
    const db = fakeDb(happy())
    // 2026-10-24 23:30 UTC = 00:30 IST on Sunday 25 October (clocks go back at 01:00 UTC that morning).
    const nowMs = Date.parse('2026-10-24T23:30:00Z')
    const r = await timezoneChangePreflight(db, { id: LOC, timezone: 'Europe/Dublin' }, { nowMs })
    expect(r.zone).toBe('Europe/Dublin')
    expect(r.today).toBe('2026-10-25')
    const bookings = db.calls.find((c) => c.table === 'bookings')
    expect(bookings.opts).toEqual({ count: 'exact', head: true })
    expect(f(bookings, 'eq', 'location_id')).toBe(LOC)
    expect(f(bookings, 'gte', 'booking_date')).toBe('2026-10-25')
    expect(f(bookings, 'neq', 'status')).toBe('cancelled')
    expect(f(db.calls.find((c) => c.table === 'shift_blocks'), 'gte', 'block_date')).toBe('2026-10-25')
    expect(f(db.calls.find((c) => c.table === 'race_events'), 'gte', 'race_date')).toBe('2026-10-25')
    expect(r.future).toEqual({ bookings: 4, shift_blocks: 7, race_events: 1, hyrox_blocks: 0,
      pending_enrolments: 5, sonos_schedules: 2, shelly_devices: 3, drip_broadcasts: 1 })
    expect(r.unknown).toEqual([])
    expect(r.hasFutureData).toBe(true)
  })

  it('America/New_York across the 2026 spring-forward: today is still Saturday 7 March locally', async () => {
    const db = fakeDb(happy())
    // 04:30 UTC on 8 March = 23:30 EST on 7 March; DST starts at 02:00 local that night.
    const nowMs = Date.parse('2026-03-08T04:30:00Z')
    const r = await timezoneChangePreflight(db, { id: LOC, timezone: 'America/New_York' }, { nowMs })
    expect(r.zone).toBe('America/New_York')
    expect(r.today).toBe('2026-03-07')
    expect(f(db.calls.find((c) => c.table === 'bookings'), 'gte', 'booking_date')).toBe('2026-03-07')
  })

  it('a NULL or invalid stored zone is judged in the Dublin floor (zoneOfLocation)', async () => {
    const r = await timezoneChangePreflight(fakeDb(happy()), { id: LOC, timezone: null }, { nowMs: Date.parse('2026-10-24T23:30:00Z') })
    expect(r.zone).toBe('Europe/Dublin')
    expect(r.today).toBe('2026-10-25')
  })

  it('a failed count is null and listed as unknown, never 0', async () => {
    const db = fakeDb(happy({ shift_blocks: () => ({ count: null, data: null, error: { message: 'boom' } }) }))
    const r = await timezoneChangePreflight(db, { id: LOC, timezone: 'Europe/Dublin' })
    expect(r.future.shift_blocks).toBeNull()
    expect(r.unknown).toEqual(['shift_blocks'])
    expect(r.future.bookings).toBe(4)
  })

  it('a count that throws is unknown too, and the others still answer', async () => {
    const db = fakeDb(happy({ race_events: () => { throw new Error('network') } }))
    const r = await timezoneChangePreflight(db, { id: LOC, timezone: 'Europe/Dublin' })
    expect(r.future.race_events).toBeNull()
    expect(r.unknown).toEqual(['race_events'])
  })

  it('hasFutureData is false only when every count answered 0, and null when some are unknown', async () => {
    const zero = (table, state) => (table === 'email_sequences' || table === 'hyrox_blocks'
      ? { data: [], error: null } : { count: 0, error: null, state })
    const all0 = await timezoneChangePreflight(fakeDb(zero), { id: LOC, timezone: 'Europe/Dublin' })
    expect(all0.hasFutureData).toBe(false)
    const someUnknown = await timezoneChangePreflight(fakeDb((t, s) => (t === 'bookings' ? { error: { message: 'x' } } : zero(t, s))),
      { id: LOC, timezone: 'Europe/Dublin' })
    expect(someUnknown.hasFutureData).toBeNull()
    expect(someUnknown.unknown).toEqual(['bookings'])
  })

  it('scopes Sonos, Shelly and drip broadcasts to what actually runs on a wall clock', async () => {
    const db = fakeDb(happy())
    await timezoneChangePreflight(db, { id: LOC, timezone: 'Europe/Dublin' })
    const sonos = db.calls.find((c) => c.table === 'sonos_schedules')
    expect(f(sonos, 'eq', 'location_id')).toBe(LOC)
    expect(f(sonos, 'eq', 'enabled')).toBe(true)
    const shelly = db.calls.find((c) => c.table === 'shelly_devices')
    expect(f(shelly, 'eq', 'enabled')).toBe(true)
    expect(f(shelly, 'in', 'schedule_mode')).toEqual(['fixed', 'class'])
    const wa = db.calls.find((c) => c.table === 'whatsapp_broadcasts')
    expect(wa.opts).toEqual({ count: 'exact', head: true })
    expect(f(wa, 'eq', 'delivery_mode')).toBe('drip')
    expect(f(wa, 'in', 'status')).toEqual(['scheduled', 'sending'])
  })

  describe('pending sequence steps', () => {
    it('counts active enrolments with a future step, scoped through the location\'s sequences', async () => {
      const db = fakeDb(happy())
      const nowMs = Date.parse('2026-10-24T23:30:00Z')
      await timezoneChangePreflight(db, { id: LOC, timezone: 'Europe/Dublin' }, { nowMs })
      const seq = db.calls.find((c) => c.table === 'email_sequences')
      expect(f(seq, 'eq', 'location_id')).toBe(LOC)
      expect(seq.order).toBe('id')
      expect(seq.range).toEqual([0, 999])
      const enr = db.calls.find((c) => c.table === 'sequence_enrollments')
      expect(enr.opts).toEqual({ count: 'exact', head: true })
      expect(f(enr, 'in', 'sequence_id')).toEqual(['s1', 's2'])
      expect(f(enr, 'eq', 'status')).toBe('active')
      expect(f(enr, 'gt', 'next_step_at')).toBe('2026-10-24T23:30:00.000Z')
    })

    it('no sequences at the studio is 0 with no enrolment query', async () => {
      const db = fakeDb(happy({ email_sequences: () => ({ data: [], error: null }) }))
      const r = await timezoneChangePreflight(db, { id: LOC, timezone: 'Europe/Dublin' })
      expect(r.future.pending_enrolments).toBe(0)
      expect(db.calls.some((c) => c.table === 'sequence_enrollments')).toBe(false)
    })

    it('pages past 1,000 sequences and sums the counts per chunk of ids', async () => {
      const ids = Array.from({ length: 1200 }, (_, i) => `s${i}`)
      const db = fakeDb(happy({
        email_sequences: (s) => ({ data: ids.slice(s.range[0], s.range[1] + 1).map((id) => ({ id })), error: null }),
        sequence_enrollments: (s) => ({ count: f(s, 'in', 'sequence_id').length, error: null }),
      }))
      const r = await timezoneChangePreflight(db, { id: LOC, timezone: 'Europe/Dublin' })
      expect(r.future.pending_enrolments).toBe(1200)
      expect(db.calls.filter((c) => c.table === 'email_sequences').map((c) => c.range)).toEqual([[0, 999], [1000, 1999]])
      for (const c of db.calls.filter((x) => x.table === 'sequence_enrollments')) {
        expect(f(c, 'in', 'sequence_id').length).toBeLessThanOrEqual(200)
      }
    })

    it('a failed sequence read, or one failed chunk, is unknown (never a partial sum)', async () => {
      const a = await timezoneChangePreflight(fakeDb(happy({ email_sequences: () => ({ data: null, error: { message: 'x' } }) })),
        { id: LOC, timezone: 'Europe/Dublin' })
      expect(a.future.pending_enrolments).toBeNull()
      const b = await timezoneChangePreflight(fakeDb(happy({ sequence_enrollments: () => ({ count: null, error: { message: 'x' } }) })),
        { id: LOC, timezone: 'Europe/Dublin' })
      expect(b.future.pending_enrolments).toBeNull()
      expect(b.unknown).toContain('pending_enrolments')
    })
  })

  describe('hyrox blocks', () => {
    it('counts the active blocks whose last day (starts_on + 7*weeks - 1) is today or later', async () => {
      const blocks = [
        { id: 'h1', starts_on: '2026-09-28', weeks: 4 }, // last day 2026-10-25 → counts
        { id: 'h2', starts_on: '2026-09-27', weeks: 4 }, // last day 2026-10-24 → over
        { id: 'h3', starts_on: '2026-11-02', weeks: 6 }, // future → counts
      ]
      const db = fakeDb(happy({ hyrox_blocks: () => ({ data: blocks, error: null }) }))
      const r = await timezoneChangePreflight(db, { id: LOC, timezone: 'Europe/Dublin' }, { nowMs: Date.parse('2026-10-24T23:30:00Z') })
      expect(r.future.hyrox_blocks).toBe(2)
      const q = db.calls.find((c) => c.table === 'hyrox_blocks')
      expect(f(q, 'eq', 'location_id')).toBe(LOC)
      expect(f(q, 'eq', 'status')).toBe('active')
      expect(q.range).toEqual([0, 999])
    })

    it('a failed read is unknown', async () => {
      const r = await timezoneChangePreflight(fakeDb(happy({ hyrox_blocks: () => ({ data: null, error: { message: 'x' } }) })),
        { id: LOC, timezone: 'Europe/Dublin' })
      expect(r.future.hyrox_blocks).toBeNull()
    })
  })
})

describe('followBroadcastZone', () => {
  const rows = [
    { id: 'b1', name: 'Drip 1', send_window_tz: 'Europe/Dublin' },
    { id: 'b2', name: 'Drip 2', send_window_tz: 'europe/dublin' }, // same zone, other spelling
    { id: 'b3', name: 'Explicit', send_window_tz: 'Europe/London' },
  ]

  it('moves only the unfinished broadcasts on the OLD zone; lists the ones with their own zone', async () => {
    const db = fakeDb((table, s) => (s.update ? { data: null, error: null } : { data: rows, error: null }))
    const r = await followBroadcastZone(db, LOC, 'Europe/Dublin', 'America/New_York')
    const read = db.calls[0]
    expect(f(read, 'eq', 'location_id')).toBe(LOC)
    expect(f(read, 'in', 'status')).toEqual(['draft', 'scheduled', 'sending'])
    expect(read.order).toBe('id')
    const upd = db.calls.find((c) => c.update)
    expect(upd.update).toEqual({ send_window_tz: 'America/New_York' })
    expect(f(upd, 'eq', 'location_id')).toBe(LOC)
    expect(f(upd, 'in', 'id')).toEqual(['b1', 'b2'])
    expect(r).toEqual({ followed: 2, kept: [{ id: 'b3', name: 'Explicit', send_window_tz: 'Europe/London' }], error: null })
  })

  it('nothing to move writes nothing', async () => {
    const db = fakeDb(() => ({ data: [rows[2]], error: null }))
    const r = await followBroadcastZone(db, LOC, 'Europe/Dublin', 'America/New_York')
    expect(db.calls.some((c) => c.update)).toBe(false)
    expect(r.followed).toBe(0)
  })

  it('a failed read or write is reported, never thrown', async () => {
    const a = await followBroadcastZone(fakeDb(() => ({ data: null, error: { message: 'read down' } })), LOC, 'Europe/Dublin', 'Asia/Tokyo')
    expect(a).toMatchObject({ followed: 0, error: 'read down' })
    const b = await followBroadcastZone(fakeDb((t, s) => (s.update ? { error: { message: 'write down' } } : { data: rows, error: null })),
      LOC, 'Europe/Dublin', 'Asia/Tokyo')
    expect(b).toMatchObject({ followed: 0, error: 'write down' })
  })
})
