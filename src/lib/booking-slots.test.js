// AGENT-HANDS.1 — tests for the slot machinery extracted from the
// public /api/public/bookings/[slug]/slots route so the customer
// agent's consultation tools reuse the EXACT same availability logic
// (incident-hardened Dublin-time semantics included).

import { describe, it, expect } from 'vitest'
import { generateDaySlots, filterAvailableSlots } from './booking-slots'

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
