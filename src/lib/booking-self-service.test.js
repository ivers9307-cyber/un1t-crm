// BOOKINGSELF.1 — the customer cancel / reschedule rules. The two-hour
// cut-off on the studio's clock (Dublin and New York, across their DST
// changes), the compare-and-swap writes, the reminder reset, the timeline
// line and the re-sent confirmation.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

vi.mock('@/lib/booking-confirmations', async (importOriginal) => ({
  ...(await importOriginal()),
  sendBookingConfirmation: vi.fn(async () => ({ sent: ['email'], skipped: [], failed: [] })),
}))

const { sendBookingConfirmation } = await import('@/lib/booking-confirmations')
const {
  bookingChangeState, bookingStartMs, cancelBookingByCustomer, rescheduleBookingByCustomer,
  publicBookingView, bookingManageMessage, CHANGE_CUTOFF_MS,
} = await import('./booking-self-service.js')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const MON_SAT = { start: '09:00', end: '12:00' }
const ET = {
  id: 'et1', name: 'Free Consultation', active: true, duration_minutes: 30, buffer_minutes: 0, max_advance_days: 30, location_id: 'L1',
  availability: { mon: MON_SAT, tue: MON_SAT, wed: MON_SAT, thu: MON_SAT, fri: MON_SAT, sat: MON_SAT },
  locations: { id: 'L1', name: 'UN1T Stillorgan', address: '1 Main St', timezone: DUB },
}
function booking(over = {}) {
  return {
    id: 'bk1', status: 'confirmed', contact_id: 'c1', location_id: 'L1', customer_name: 'Sam Member',
    booking_date: '2026-10-20', start_time: '10:00:00', end_time: '10:30:00', event_type_id: 'et1',
    event_types: ET, ...over,
  }
}
const at = (iso) => Date.parse(iso)

afterEach(() => { vi.useRealTimers() })

describe('bookingStartMs — the studio wall clock as an instant', () => {
  it('Dublin: summer time before the October change, winter time after', () => {
    // IST (UTC+1) until 25 Oct 2026, GMT after.
    expect(bookingStartMs(booking(), DUB)).toBe(at('2026-10-20T09:00:00Z'))
    expect(bookingStartMs(booking({ booking_date: '2026-10-27' }), DUB)).toBe(at('2026-10-27T10:00:00Z'))
  })
  it('New York: EDT before 1 Nov 2026, EST after', () => {
    expect(bookingStartMs(booking({ booking_date: '2026-10-30' }), NY)).toBe(at('2026-10-30T14:00:00Z'))
    expect(bookingStartMs(booking({ booking_date: '2026-11-02' }), NY)).toBe(at('2026-11-02T15:00:00Z'))
  })
})

describe('bookingChangeState — two hours before the start, on the studio clock', () => {
  it('Dublin (IST): allowed at 2h01 before, refused at exactly 2h before and after', () => {
    expect(CHANGE_CUTOFF_MS).toBe(2 * 3600_000)
    const b = booking()
    expect(bookingChangeState({ booking: b, zone: DUB, nowMs: at('2026-10-20T06:59:00Z') }))
      .toEqual({ canCancel: true, canReschedule: true, code: null })
    expect(bookingChangeState({ booking: b, zone: DUB, nowMs: at('2026-10-20T07:00:00Z') }))
      .toEqual({ canCancel: false, canReschedule: false, code: 'not_changeable' })
    expect(bookingChangeState({ booking: b, zone: DUB, nowMs: at('2026-10-21T07:00:00Z') }).code).toBe('not_changeable')
  })

  it('Dublin after the clocks go back: the cut-off moves with the offset (a UTC reading would be an hour off)', () => {
    const b = booking({ booking_date: '2026-10-27' }) // 10:00 GMT = 10:00Z
    expect(bookingChangeState({ booking: b, zone: DUB, nowMs: at('2026-10-27T07:59:00Z') }).canCancel).toBe(true)
    expect(bookingChangeState({ booking: b, zone: DUB, nowMs: at('2026-10-27T08:00:00Z') }).canCancel).toBe(false)
  })

  it('New York either side of its DST change', () => {
    const edt = booking({ booking_date: '2026-10-30' }) // 14:00Z
    expect(bookingChangeState({ booking: edt, zone: NY, nowMs: at('2026-10-30T11:59:00Z') }).canCancel).toBe(true)
    expect(bookingChangeState({ booking: edt, zone: NY, nowMs: at('2026-10-30T12:00:00Z') }).canCancel).toBe(false)
    const est = booking({ booking_date: '2026-11-02' }) // 15:00Z
    expect(bookingChangeState({ booking: est, zone: NY, nowMs: at('2026-11-02T12:59:00Z') }).canCancel).toBe(true)
    expect(bookingChangeState({ booking: est, zone: NY, nowMs: at('2026-11-02T13:00:00Z') }).canCancel).toBe(false)
  })

  it('cancelled, completed and no-show bookings cannot change', () => {
    const early = at('2026-10-01T00:00:00Z')
    expect(bookingChangeState({ booking: booking({ status: 'cancelled' }), zone: DUB, nowMs: early }).code).toBe('cancelled')
    expect(bookingChangeState({ booking: booking({ status: 'completed' }), zone: DUB, nowMs: early }).code).toBe('not_changeable')
    expect(bookingChangeState({ booking: booking({ status: 'no_show' }), zone: DUB, nowMs: early }).code).toBe('not_changeable')
  })

  it('an inactive type may still be cancelled, but not moved', () => {
    const b = booking({ event_types: { ...ET, active: false } })
    expect(bookingChangeState({ booking: b, zone: DUB, nowMs: at('2026-10-01T00:00:00Z') }))
      .toEqual({ canCancel: true, canReschedule: false, code: 'reschedule_unavailable' })
  })
})

describe('publicBookingView', () => {
  it('carries no email or phone, renders the stored wall clock, and the studio in the refusal', () => {
    const v = publicBookingView(booking({ customer_email: 'x@y.ie', customer_phone: '+353' }),
      { canCancel: false, canReschedule: false, code: 'not_changeable' }, { zone: DUB })
    expect(JSON.stringify(v)).not.toMatch(/x@y\.ie|\+353/)
    expect(v).toMatchObject({ start_time: '10:00', when_label: 'Tue, 20 Oct, 10:00', studio_name: 'UN1T Stillorgan', can_cancel: false })
    expect(v.blocked_reason).toBe('This booking can no longer be changed online. Please contact UN1T Stillorgan.')
  })

  it('no customer sentence uses an em dash', () => {
    for (const code of ['not_found', 'cancelled', 'not_changeable', 'reschedule_unavailable', 'same_time', 'slot_unavailable', 'changed', 'save_failed', 'load_failed']) {
      expect(bookingManageMessage(code, { studioName: 'X' })).not.toMatch(/—/)
    }
  })
})

describe('cancelBookingByCustomer', () => {
  it('flips a confirmed booking to cancelled', async () => {
    const tables = { bookings: [booking()] }
    expect(await cancelBookingByCustomer(makeFakeDb(tables), { booking: booking() })).toEqual({ ok: true })
    expect(tables.bookings[0].status).toBe('cancelled')
  })

  it('a booking changed in between (no longer confirmed) is `changed`, untouched', async () => {
    const tables = { bookings: [booking({ status: 'completed' })] }
    expect(await cancelBookingByCustomer(makeFakeDb(tables), { booking: booking() })).toEqual({ ok: false, code: 'changed' })
    expect(tables.bookings[0].status).toBe('completed')
  })

  it('a failed write is save_failed', async () => {
    const db = { from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: null, error: { message: 'down' } }) }) }) }) }) }
    expect(await cancelBookingByCustomer(db, { booking: booking() })).toEqual({ ok: false, code: 'save_failed' })
  })
})

describe('rescheduleBookingByCustomer', () => {
  const NOW = at('2026-10-15T08:00:00Z')
  beforeEach(() => { vi.clearAllMocks() })

  function fixture(over = {}) {
    return {
      bookings: [booking()],
      blocked_times: [],
      booking_reminder_sends: [
        { booking_id: 'bk1', reminder_id: 'r24', status: 'sent' },
        { booking_id: 'other', reminder_id: 'r24', status: 'sent' },
      ],
      activities: [],
      ...over,
    }
  }

  it('moves the same row, clears its reminder sends + reminder_sent_at, logs the timeline, re-sends the confirmation', async () => {
    const tables = fixture()
    tables.bookings[0].reminder_sent_at = '2026-10-19T09:00:00Z'
    const out = await rescheduleBookingByCustomer(makeFakeDb(tables), {
      booking: booking(), date: '2026-10-22', startTime: '11:00', zone: DUB, nowMs: NOW,
    })
    expect(out).toMatchObject({ ok: true, booking: { booking_date: '2026-10-22', start_time: '11:00', end_time: '11:30' } })
    expect(tables.bookings[0]).toMatchObject({ id: 'bk1', booking_date: '2026-10-22', start_time: '11:00', end_time: '11:30', reminder_sent_at: null, status: 'confirmed' })
    expect(tables.booking_reminder_sends).toEqual([{ booking_id: 'other', reminder_id: 'r24', status: 'sent' }])
    expect(tables.activities).toHaveLength(1)
    expect(tables.activities[0]).toMatchObject({
      contact_id: 'c1', location_id: 'L1', kind: 'event', type: 'booking', done: true,
      subject: 'Booking rescheduled by customer: Free Consultation',
      note: 'Moved online from Tue, 20 Oct, 10:00 to Thu, 22 Oct, 11:00.',
    })
    expect(sendBookingConfirmation).toHaveBeenCalledWith(expect.anything(), 'bk1')
  })

  it('may shift by less than its own length (its own slot is not "taken")', async () => {
    const tables = fixture()
    const out = await rescheduleBookingByCustomer(makeFakeDb(tables), {
      booking: booking(), date: '2026-10-20', startTime: '10:30', zone: DUB, nowMs: NOW,
    })
    expect(out.ok).toBe(true)
  })

  it('refuses a slot another booking holds, off the grid, or on a closed day; nothing written', async () => {
    const tables = fixture()
    tables.bookings.push({ id: 'bk2', event_type_id: 'et1', booking_date: '2026-10-22', start_time: '11:00:00', end_time: '11:30:00', status: 'confirmed' })
    const db = makeFakeDb(tables)
    for (const [date, startTime] of [['2026-10-22', '11:00'], ['2026-10-22', '11:10'], ['2026-10-25', '10:00']]) {
      expect(await rescheduleBookingByCustomer(db, { booking: booking(), date, startTime, zone: DUB, nowMs: NOW }))
        .toEqual({ ok: false, code: 'slot_unavailable' })
    }
    expect(tables.bookings[0].booking_date).toBe('2026-10-20')
    expect(tables.booking_reminder_sends).toHaveLength(2)
    expect(sendBookingConfirmation).not.toHaveBeenCalled()
  })

  it('the time already booked is same_time', async () => {
    expect(await rescheduleBookingByCustomer(makeFakeDb(fixture()), {
      booking: booking(), date: '2026-10-20', startTime: '10:00', zone: DUB, nowMs: NOW,
    })).toEqual({ ok: false, code: 'same_time' })
  })

  it('a row moved by someone else in between is `changed`, and its reminder history is kept', async () => {
    const tables = fixture()
    tables.bookings[0].start_time = '09:00:00' // staff moved it after the page read it
    const out = await rescheduleBookingByCustomer(makeFakeDb(tables), {
      booking: booking(), date: '2026-10-22', startTime: '11:00', zone: DUB, nowMs: NOW,
    })
    expect(out).toEqual({ ok: false, code: 'changed' })
    expect(tables.booking_reminder_sends).toHaveLength(2)
    expect(tables.activities).toHaveLength(0)
  })

  it('an unreadable occupancy read fails closed (load_failed), nothing written', async () => {
    const tables = fixture()
    const fake = makeFakeDb(tables)
    const db = {
      from(t) {
        const b = fake.from(t)
        if (t !== 'bookings') return b
        const orig = b.then
        b.then = (res, rej) => orig(() => res({ data: null, error: { message: 'down' } }), rej)
        return b
      },
    }
    expect(await rescheduleBookingByCustomer(db, { booking: booking(), date: '2026-10-22', startTime: '11:00', zone: DUB, nowMs: NOW }))
      .toEqual({ ok: false, code: 'load_failed' })
    expect(tables.bookings[0].booking_date).toBe('2026-10-20')
  })
})
