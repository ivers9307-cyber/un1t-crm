// AGENT-HANDS.1 — tests for the slot machinery extracted from the
// public /api/public/bookings/[slug]/slots route so the customer
// agent's consultation tools reuse the EXACT same availability logic
// (incident-hardened Dublin-time semantics included).

import { describe, it, expect, vi } from 'vitest'
// Pin "today" so computeAvailableDays' range/weekday math is deterministic.
// 2026-06-29 is a Monday (2026-06-30 = Tue, per the live calendar).
vi.mock('@/lib/dublin-time', () => ({
  dublinTodayStr: () => '2026-06-29',
  dublinNowMinutes: () => 0,
  addDaysISO: (d, n) => {
    const dt = new Date(`${d}T00:00:00Z`)
    dt.setUTCDate(dt.getUTCDate() + Number(n))
    return dt.toISOString().slice(0, 10)
  },
}))
import { generateDaySlots, filterAvailableSlots, computeAvailableDays } from './booking-slots'

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
