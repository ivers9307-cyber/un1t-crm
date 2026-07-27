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
  resolveConsultationIdentity,
  findSlot,
  shapeMemberBookingsForAgent,
  cancelBookingGuard,
  leadDetailsPatch,
  bookingRejectionRoute,
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
  it('lists upcoming public classes with a full flag, time-sorted', () => {
    const late = ev({ _id: 'f'.repeat(24), time_start: Math.floor(NOW / 1000) + 9000, booked: 16 })
    const out = shapeClassListForAgent([late, ev()], NOW)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ event_id: 'e'.repeat(24), name: 'UN1T Strength', full: false })
    expect(out[1]).toMatchObject({ full: true })
    expect(typeof out[0].time).toBe('string')
  })

  // CAPACITY-SECRECY.1 — owner invariant 2: the model must never receive a
  // spaces count, so it can never relay one. `limited` is the urgency signal.
  it('never exposes a spot count, and flags a nearly-full class as limited', () => {
    const out = shapeClassListForAgent([
      ev({ booked: 10 }),                                                    // 6 left
      ev({ _id: 'f'.repeat(24), time_start: Math.floor(NOW / 1000) + 9000, booked: 14 }), // 2 left
      ev({ _id: '0'.repeat(24), time_start: Math.floor(NOW / 1000) + 10800, booked: 16 }), // full
    ], NOW)
    expect(JSON.stringify(out)).not.toMatch(/spots?_left|booked|size/)
    expect(out[0].limited).toBeUndefined()
    expect(out[1]).toMatchObject({ full: false, limited: true })
    expect(out[2]).toMatchObject({ full: true })
    expect(out[2].limited).toBeUndefined()   // full is never also "limited"
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

describe('book_consultation schema — does not force re-collecting on-file details', () => {
  it('requires only date + start_time (name/email are pre-filled from the contact)', () => {
    const t = BOOKING_TOOLS.find((x) => x.name === 'book_consultation')
    expect(t.input_schema.required).toEqual(['date', 'start_time'])
    expect(t.description.toLowerCase()).toContain('do not ask again')
  })
})

describe('resolveConsultationIdentity', () => {
  const contact = { first_name: 'Edel', last_name: 'Crehan', email: 'Edel.Crehan@GMAIL.com', phone: '353871234567' }
  it('uses the on-file contact when the model supplies nothing (known lead — never re-ask)', () => {
    expect(resolveConsultationIdentity({ input: {}, contact })).toEqual({
      name: 'Edel Crehan', email: 'edel.crehan@gmail.com', phone: '353871234567',
    })
  })
  it('prefers explicit model input over the contact record', () => {
    const out = resolveConsultationIdentity({
      input: { name: 'New Person', email: 'NEW@x.com', phone: '999' }, contact,
    })
    expect(out).toEqual({ name: 'New Person', email: 'new@x.com', phone: '999' })
  })
  it('falls back to the channel name hint when no contact name exists', () => {
    const out = resolveConsultationIdentity({ input: {}, contact: { email: 'a@b.com' }, nameHint: 'Sam' })
    expect(out.name).toBe('Sam')
    expect(out.email).toBe('a@b.com')
  })
  it('leaves fields blank for a brand-new person with nothing on file → guard still asks', () => {
    const out = resolveConsultationIdentity({ input: {}, contact: {}, nameHint: null })
    expect(out).toEqual({ name: '', email: '', phone: null })
    expect(consultationInputGuard({ ...out, date: '2026-06-13', start_time: '10:00' }).error).toBe('need_name')
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
import { buildBookingConfirmationText, buildCancellationConfirmationText } from './notify'

describe('buildBookingConfirmationText', () => {
  it('includes the confirmed class + time when known', () => {
    const t = buildBookingConfirmationText({ className: 'UN1T Strength', classTime: 'Sat 09:00' })
    expect(t).toContain('UN1T Strength, Sat 09:00')
    expect(t.toLowerCase()).toContain('booked')
  })
  it('still reads well with no details (the "for {class}" clause is dropped)', () => {
    const t = buildBookingConfirmationText({})
    expect(t.toLowerCase()).toContain('booked')
    expect(t).not.toMatch(/\{class\}|\bfor\s*\./)
  })
  // HUMANIZE.1 — customer-visible copy: no em/en dash, no emoji.
  it('ships no dashes or emoji in either default', () => {
    for (const t of [
      buildBookingConfirmationText({ className: 'ARENA', classTime: 'Sat 09:00' }),
      buildBookingConfirmationText({}),
      buildCancellationConfirmationText({ className: 'ARENA', classTime: 'Sat 09:00' }),
      buildCancellationConfirmationText({}),
    ]) {
      expect(t).not.toMatch(/[—–]/)
      expect(t).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })
  it('uses the operator template when set, and scrubs a dash the operator typed', () => {
    const t = buildBookingConfirmationText({
      className: 'ARENA', classTime: 'Sat 09:00',
      template: 'You are in for {class} — see you on the floor.',
    })
    expect(t).toBe('You are in for ARENA, Sat 09:00, see you on the floor.')
  })
  it('cancellation honours its own operator template', () => {
    expect(buildCancellationConfirmationText({ className: 'ARENA', template: 'Cancelled: {class}.' }))
      .toBe('Cancelled: ARENA.')
    expect(buildCancellationConfirmationText({ template: '   ' }).toLowerCase()).toContain('cancelled')
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

// MIA-BOOK.1 — rejected-booking routing: staff-fixable and UNKNOWN codes go
// to a pending approval (fail safe); venue codes stay an honest reply.
describe('bookingRejectionRoute', () => {
  it('routes staff-fixable and unknown codes to approval, venue codes to reply', () => {
    expect(bookingRejectionRoute('YOU_HAVE_NO_CREDITS_LEFT')).toBe('approval')
    expect(bookingRejectionRoute('BRAND_NEW_CODE')).toBe('approval')
    expect(bookingRejectionRoute(null)).toBe('approval')
    expect(bookingRejectionRoute('EVENT_HAS_BEEN_CANCELLED')).toBe('reply')
    expect(bookingRejectionRoute('EVENT_FULL')).toBe('reply')
  })
})
