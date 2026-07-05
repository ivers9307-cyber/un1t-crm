// AGENT-HANDS.1 — tests for the agent's booking tools (pure parts).
// Executor IO is exercised against prod-shaped inputs at the guard /
// shaping layer; the network writes reuse live-probed helpers
// (createBooking, the bookings insert shape from /api/public/book).

import { describe, it, expect } from 'vitest'
import {
  BOOKING_TOOLS,
  BOOKING_TOOL_NAMES,
  bookingMode,
  classBookingGuard,
  shapeClassListForAgent,
  consultationInputGuard,
  findSlot,
  shapeMemberBookingsForAgent,
  cancelBookingGuard,
  leadDetailsPatch,
} from './booking-tools'

describe('BOOKING_TOOLS definitions', () => {
  it('declares the seven tools with schemas', () => {
    const names = BOOKING_TOOLS.map((t) => t.name)
    expect(names).toEqual([
      'list_upcoming_classes', 'book_class',
      'list_consultation_slots', 'book_consultation',
      'list_my_upcoming_bookings', 'cancel_class_booking',
      'save_lead_details',
    ])
    for (const t of BOOKING_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40)
      expect(t.input_schema?.type).toBe('object')
    }
    expect(BOOKING_TOOL_NAMES.has('book_class')).toBe(true)
  })
})

describe('bookingMode', () => {
  it("defaults to 'auto' and honours the draft override", () => {
    expect(bookingMode(null)).toBe('auto')
    expect(bookingMode({})).toBe('auto')
    expect(bookingMode({ booking_mode: 'draft' })).toBe('draft')
    expect(bookingMode({ booking_mode: 'auto' })).toBe('auto')
    expect(bookingMode({ booking_mode: 'banana' })).toBe('auto')
  })
})

describe('classBookingGuard', () => {
  it('requires verification, a Glofox link, and a 24-hex event id', () => {
    const ok = { verifiedContactId: 'c1', glofoxMemberId: 'm1', eventId: 'a'.repeat(24) }
    expect(classBookingGuard(ok)).toEqual({ ok: true })
    expect(classBookingGuard({ ...ok, verifiedContactId: null }).error).toBe('not_verified')
    expect(classBookingGuard({ ...ok, glofoxMemberId: null }).error).toBe('not_linked')
    expect(classBookingGuard({ ...ok, eventId: 'nope' }).error).toBe('bad_event_id')
  })
})

describe('shapeClassListForAgent', () => {
  const NOW = Date.UTC(2026, 5, 12, 10, 0, 0)
  const ev = (over = {}) => ({
    _id: 'e'.repeat(24), name: 'UN1T Strength',
    time_start: Math.floor(NOW / 1000) + 7200, size: 16, booked: 10,
    active: true, private: false, ...over,
  })
  it('lists upcoming public classes with spots left, time-sorted', () => {
    const late = ev({ _id: 'f'.repeat(24), time_start: Math.floor(NOW / 1000) + 9000, booked: 16 })
    const out = shapeClassListForAgent([late, ev()], NOW)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ event_id: 'e'.repeat(24), name: 'UN1T Strength', spots_left: 6, full: false })
    expect(out[1]).toMatchObject({ full: true, spots_left: 0 })
    expect(typeof out[0].time).toBe('string')
  })
  it('skips past, private, and inactive events + junk', () => {
    expect(shapeClassListForAgent([
      ev({ time_start: Math.floor(NOW / 1000) - 60 }),
      ev({ private: true }), ev({ active: false }), null,
    ], NOW)).toEqual([])
  })
  it('caps the list at 60 — high enough that 7 days of a full timetable survive time-sorted truncation', () => {
    const many = Array.from({ length: 80 }, (_, i) => ev({ _id: String(i).padStart(24, '0'), time_start: Math.floor(NOW / 1000) + 3600 + i * 60 }))
    expect(shapeClassListForAgent(many, NOW).length).toBe(60)
  })

  // Times must be Dublin wall-clock, not UTC. Glofox time_start is an
  // absolute instant; the raw .toISOString() the agent originally got
  // made it tell customers a 7am summer class was at "6am" (IST = UTC+1).
  // The model must never do timezone math — hand it the local label.
  it('labels class times in Dublin local time, not UTC', () => {
    // 06:00 UTC on Sat 13 Jun 2026 = 07:00 in Dublin (Irish Summer Time)
    const seven_am_dublin = Math.floor(Date.UTC(2026, 5, 13, 6, 0, 0) / 1000)
    const out = shapeClassListForAgent([ev({ time_start: seven_am_dublin })], NOW)
    expect(out[0].time).toContain('07:00')
    expect(out[0].time).not.toContain('06:00')
    expect(out[0].time).toContain('Sat')
    expect(out[0].time).toContain('13')
  })

  // Winter (no DST): 07:00 UTC in January IS 07:00 Dublin.
  it('matches UTC in winter when Dublin offset is zero', () => {
    const jan = Math.floor(Date.UTC(2027, 0, 15, 7, 0, 0) / 1000)
    const out = shapeClassListForAgent([ev({ time_start: jan })], NOW)
    expect(out[0].time).toContain('07:00')
  })
})

describe('consultationInputGuard', () => {
  const good = { name: 'Jane Murphy', email: 'jane@example.com', date: '2026-06-13', start_time: '10:00' }
  it('passes complete input', () => {
    expect(consultationInputGuard(good)).toEqual({ ok: true })
  })
  it('flags each missing/invalid field', () => {
    expect(consultationInputGuard({ ...good, name: ' ' }).error).toBe('need_name')
    expect(consultationInputGuard({ ...good, email: 'not-an-email' }).error).toBe('need_email')
    expect(consultationInputGuard({ ...good, date: '13/06/2026' }).error).toBe('bad_date')
    expect(consultationInputGuard({ ...good, start_time: '10am' }).error).toBe('bad_time')
  })
})

describe('findSlot', () => {
  const slots = [{ start: '10:00', end: '10:30' }, { start: '11:00', end: '11:30' }]
  it('returns the matching slot or null', () => {
    expect(findSlot(slots, '11:00')).toEqual({ start: '11:00', end: '11:30' })
    expect(findSlot(slots, '12:00')).toBe(null)
    expect(findSlot(null, '10:00')).toBe(null)
  })
})

// Provider subtitle shaping (AGENT-HANDS.1).
import { agentRequestSubtitle } from '../approvals/providers/agent-requests'

describe('agentRequestSubtitle', () => {
  it('summarises each kind', () => {
    expect(agentRequestSubtitle({ kind: 'class_booking', details: { class_name: 'Strength', class_time: 'Sat 09:00' } }))
      .toBe('Strength · Sat 09:00')
    expect(agentRequestSubtitle({ kind: 'consultation', details: { date: '2026-06-13', start_time: '10:00' } }))
      .toBe('2026-06-13 · 10:00')
    expect(agentRequestSubtitle({ kind: 'pause', details: { start_date: '2026-07-01', end_date: '2026-08-01', reason: 'travel' } }))
      .toBe('2026-07-01 → 2026-08-01 · travel')
    expect(agentRequestSubtitle({ kind: 'cancellation', details: {}, customer_note: 'moving away' }))
      .toBe('moving away')
  })
})

// In-thread confirmation text (notify.js).
import { buildBookingConfirmationText } from './notify'

describe('buildBookingConfirmationText', () => {
  it('includes the confirmed class + time when known', () => {
    const t = buildBookingConfirmationText({ className: 'UN1T Strength', classTime: 'Sat 09:00' })
    expect(t).toContain('UN1T Strength — Sat 09:00')
    expect(t.toLowerCase()).toContain('booked')
  })
  it('still reads well with no details', () => {
    expect(buildBookingConfirmationText({}).toLowerCase()).toContain('booked')
  })
})

// AGENT-CANCEL.1 — member's upcoming bookings + cancellation guards
describe('shapeMemberBookingsForAgent', () => {
  const now = Date.UTC(2026, 5, 12, 12, 0, 0) // 12 Jun 2026 13:00 Dublin
  const hour = 3600
  const nowSec = Math.floor(now / 1000)
  it('keeps only future BOOKED rows, sorted, with Dublin labels and ids', () => {
    const out = shapeMemberBookingsForAgent([
      { _id: 'b'.repeat(24), event_name: 'ARENA', time_start: nowSec + 26 * hour, status: 'BOOKED' },
      { _id: 'a'.repeat(24), event_name: 'FUS1ON - HYBRID', time_start: nowSec + 2 * hour, status: 'BOOKED' },
      { _id: 'c'.repeat(24), event_name: 'Old', time_start: nowSec - 2 * hour, status: 'BOOKED' },
      { _id: 'd'.repeat(24), event_name: 'Gone', time_start: nowSec + 5 * hour, status: 'CANCELLED' },
      null,
    ], now)
    expect(out.map(b => b.class_name)).toEqual(['FUS1ON - HYBRID', 'ARENA'])
    expect(out[0].booking_id).toBe('a'.repeat(24))
    expect(out[0].time).toMatch(/Fri 12 Jun, 15:00/)
  })
  it('caps the list', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      _id: String(i).padStart(24, '0'), event_name: 'X', time_start: nowSec + (i + 1) * hour, status: 'BOOKED',
    }))
    expect(shapeMemberBookingsForAgent(rows, now)).toHaveLength(10)
  })
})

describe('cancelBookingGuard', () => {
  const ok = { verifiedContactId: 'c1', glofoxMemberId: 'm1', bookingId: 'f'.repeat(24) }
  it('passes a verified linked member with a real booking id', () => {
    expect(cancelBookingGuard(ok).ok).toBe(true)
  })
  it('rejects unverified, unlinked, and bad ids', () => {
    expect(cancelBookingGuard({ ...ok, verifiedContactId: null }).error).toBe('not_verified')
    expect(cancelBookingGuard({ ...ok, glofoxMemberId: null }).error).toBe('not_linked')
    expect(cancelBookingGuard({ ...ok, bookingId: 'nope' }).error).toBe('bad_booking_id')
  })
})

// AGENT-LEADCAP.1 — fill-empty-only contact enrichment
describe('leadDetailsPatch', () => {
  it('fills only empty fields and never overwrites', () => {
    const { patch } = leadDetailsPatch(
      { first_name: 'Sarah', last_name: null, email: '' },
      { first_name: 'Hacker', last_name: 'Murphy', email: 'sarah@example.com' },
    )
    expect(patch).toEqual({ last_name: 'Murphy', email: 'sarah@example.com' })
  })
  it('rejects invalid emails and blank values', () => {
    const { patch } = leadDetailsPatch({ first_name: null, email: null }, { first_name: '  ', email: 'not-an-email' })
    expect(patch).toEqual({})
  })
  it('builds a note from the interest text', () => {
    const { note } = leadDetailsPatch({}, { interest: 'Wants 6am strength classes, marathon in Sept' })
    expect(note).toMatch(/^\[Mia\] /)
    expect(note).toMatch(/marathon/)
  })
  it('returns no note when interest is blank', () => {
    expect(leadDetailsPatch({}, { interest: '  ' }).note).toBeNull()
  })
})
