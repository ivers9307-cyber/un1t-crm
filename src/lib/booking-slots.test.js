// AGENT-HANDS.1 — tests for the slot machinery extracted from the
// public /api/public/bookings/[slug]/slots route so the customer
// agent's consultation tools reuse the EXACT same availability logic
// (incident-hardened Dublin-time semantics included).

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
// Pin "today" so computeAvailableDays' range/weekday math is deterministic.
// 2026-06-29 is a Monday (2026-06-30 = Tue, per the live calendar).
// TZ.7: the lib reads the clock through @/lib/location-time now, so the clock
// itself is pinned (it used to mock @/lib/dublin-time's today/now): 23:00Z on
// 28 Jun is Dublin midnight on Mon 29 Jun, minute 0 (the same pins as before).
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-06-28T23:00:00Z'))
})
afterAll(() => vi.useRealTimers())
import { generateDaySlots, filterAvailableSlots, computeAvailableDays, computeAvailableSlots, findBookableSlot } from './booking-slots'

// Chainable db stub: every bookings/blocked_times query resolves to { data: [] }.
function makeEmptyDb() {
  const chain = { from() { return chain }, select() { return chain }, eq() { return chain }, in() { return chain }, then(r) { r({ data: [] }) } }
  return chain
}

describe('generateDaySlots', () => {
  it('steps through the window by duration+buffer', () => {
    const slots = generateDaySlots({ start: '09:00', end: '11:00', durationMinutes: 30, bufferMinutes: 30 })
    expect(slots).toEqual([
      { start: '09:00', end: '09:30' },
      { start: '10:00', end: '10:30' },
    ])
  })
  it('never emits a slot that overruns the window end', () => {
    const slots = generateDaySlots({ start: '09:00', end: '10:15', durationMinutes: 30, bufferMinutes: 0 })
    expect(slots.map((s) => s.start)).toEqual(['09:00', '09:30'])
  })
  it('returns [] for a missing window', () => {
    expect(generateDaySlots(null)).toEqual([])
    expect(generateDaySlots({})).toEqual([])
  })
})

describe('filterAvailableSlots', () => {
  const slots = [
    { start: '09:00', end: '09:30' },
    { start: '09:30', end: '10:00' },
    { start: '10:00', end: '10:30' },
  ]
  it('removes slots overlapping bookings and blocked windows', () => {
    const out = filterAvailableSlots(slots, {
      booked: [{ start: '09:15', end: '09:45' }], // clips first two
      blocked: [{ start: '10:00', end: '10:30' }],
      nowMinutes: -1,
    })
    expect(out).toEqual([])
  })
  it('keeps non-overlapping slots', () => {
    const out = filterAvailableSlots(slots, { booked: [{ start: '09:00', end: '09:30' }], blocked: [], nowMinutes: -1 })
    expect(out.map((s) => s.start)).toEqual(['09:30', '10:00'])
  })
  it('drops past slots when filtering today (Dublin minutes)', () => {
    const out = filterAvailableSlots(slots, { booked: [], blocked: [], nowMinutes: 9 * 60 + 30 })
    expect(out.map((s) => s.start)).toEqual(['10:00'])
  })
})

describe('computeAvailableDays', () => {
  // Windows only on Mon + Wed → within a 5-day horizon from Mon 29 Jun only
  // those two weekdays produce a slot; Tue/Thu/Fri are dropped from the list.
  const event = {
    id: 'ev1', duration_minutes: 60, buffer_minutes: 0, max_advance_days: 30,
    availability: { mon: { start: '09:00', end: '10:00' }, wed: { start: '09:00', end: '10:00' } },
  }

  it('returns only days that have an open slot, with Dublin day labels', async () => {
    const days = await computeAvailableDays(makeEmptyDb(), event, { days: 5 })
    expect(days.map((d) => d.date)).toEqual(['2026-06-29', '2026-07-01'])
    expect(days[0].label).toContain('29 Jun')
    expect(days[1].label).toContain('1 Jul')
  })

  it('returns [] when the event is missing', async () => {
    expect(await computeAvailableDays(makeEmptyDb(), null, { days: 5 })).toEqual([])
  })
})

// BOOKINGWINDOWS.1 — several windows in one day: each starts its own grid,
// nothing is offered in the gap, and the legacy single-window shape still reads.
describe('computeAvailableSlots with several windows a day', () => {
  const db = makeEmptyDb()
  const event = {
    id: 'ev1', duration_minutes: 30, buffer_minutes: 10, max_advance_days: 30, location_id: null,
    availability: { tue: [{ start: '17:00', end: '18:00' }, { start: '07:00', end: '08:15' }] },
  }

  it('offers each window on its own grid, in time order, and nothing in the gap', async () => {
    const slots = await computeAvailableSlots(db, event, '2026-06-30')
    expect(slots.map((s) => s.start)).toEqual(['07:00', '07:40', '17:00'])
  })

  it('an empty list is a closed day', async () => {
    expect(await computeAvailableSlots(db, { ...event, availability: { tue: [] } }, '2026-06-30')).toEqual([])
  })

  it('findBookableSlot accepts a slot in the second window and refuses one in the gap', async () => {
    expect((await findBookableSlot(db, event, '2026-06-30', '17:00')).slot).toEqual({ start: '17:00', end: '17:30' })
    expect((await findBookableSlot(db, event, '2026-06-30', '12:00')).slot).toBeNull()
  })
})

// BOOKINGSELF.1 — the shared write-side check (create + customer reschedule).
describe('findBookableSlot', () => {
  // Mon 29 Jun 2026 is "today" (Dublin midnight, minute 0) per the pin above.
  const event = {
    id: 'ev1', duration_minutes: 30, buffer_minutes: 15, max_advance_days: 7, location_id: null,
    availability: { mon: { start: '09:00', end: '11:00' }, tue: { start: '09:00', end: '11:00' } },
  }
  // A db whose bookings read honours .neq('id') so excludeBookingId is real.
  function dbWith({ bookings = [], blocked = [], bookingsError = null } = {}) {
    return {
      from(table) {
        let rows = table === 'bookings' ? bookings : blocked
        const q = {
          select: () => q, eq: () => q, in: () => q,
          neq: (col, val) => { rows = rows.filter((r) => r[col] !== val); return q },
          then: (r) => r(table === 'bookings' && bookingsError ? { data: null, error: bookingsError } : { data: rows, error: null }),
        }
        return q
      },
    }
  }

  it('finds a slot on the duration + buffer grid and returns its end', async () => {
    expect(await findBookableSlot(dbWith(), event, '2026-06-30', '09:45')).toEqual({ slot: { start: '09:45', end: '10:15' }, error: null })
    expect(await findBookableSlot(dbWith(), event, '2026-06-30', '09:45:00')).toEqual({ slot: { start: '09:45', end: '10:15' }, error: null })
  })

  it('refuses a time off the grid, outside the window, on a closed day, past max_advance_days, or garbage', async () => {
    const db = dbWith()
    expect((await findBookableSlot(db, event, '2026-06-30', '09:30')).slot).toBeNull()
    expect((await findBookableSlot(db, event, '2026-06-30', '11:00')).slot).toBeNull()
    expect((await findBookableSlot(db, event, '2026-07-01', '09:00')).slot).toBeNull() // Wednesday: no window
    expect((await findBookableSlot(db, event, '2026-07-07', '09:00')).slot).toBeNull() // Tue, 8 days out
    expect((await findBookableSlot(db, event, '2026-06-30', 'soon')).slot).toBeNull()
  })

  it('refuses a slot another booking or a blocked time overlaps', async () => {
    const taken = dbWith({ bookings: [{ id: 'other', start_time: '09:50:00', end_time: '10:20:00' }] })
    expect((await findBookableSlot(taken, event, '2026-06-30', '09:45')).slot).toBeNull()
    const blocked = dbWith({ blocked: [{ start_time: null, end_time: null }] })
    expect((await findBookableSlot(blocked, event, '2026-06-30', '09:00')).slot).toBeNull()
  })

  it('excludeBookingId leaves the booking being moved out of "taken"', async () => {
    const own = dbWith({ bookings: [{ id: 'mine', start_time: '09:45:00', end_time: '10:15:00' }] })
    expect((await findBookableSlot(own, event, '2026-06-30', '09:45')).slot).toBeNull()
    expect((await findBookableSlot(own, event, '2026-06-30', '09:45', { excludeBookingId: 'mine' })).slot).toEqual({ start: '09:45', end: '10:15' })
  })

  it('fails CLOSED on an unreadable bookings read, where the display path shows the slot', async () => {
    const err = { message: 'boom' }
    const db = dbWith({ bookingsError: err })
    expect(await findBookableSlot(db, event, '2026-06-30', '09:00')).toEqual({ slot: null, error: err })
    expect((await computeAvailableSlots(db, event, '2026-06-30')).length).toBeGreaterThan(0)
  })
})
