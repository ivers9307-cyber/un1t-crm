// BOOKONE.1 — createBooking is the one way an event-type booking is made: it
// judges the slot, inserts, and reads a database overlap refusal as "taken".
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/booking-slots', () => ({ findBookableSlot: vi.fn() }))
const { findBookableSlot } = await import('@/lib/booking-slots')
const { createBooking, createEventBooking } = await import('./bookings-write.js')

const EVENT = { id: 'ev1', location_id: 'loc1', active: true }
const CUSTOMER = { name: 'Ann', email: ' Ann@X.ie ', phone: '+353871234567' }

function dbWith({ insertError = null, event = EVENT, eventError = null } = {}) {
  const inserts = []
  return {
    inserts,
    from(table) {
      const q = {}
      q.select = () => q
      q.eq = () => q
      q.maybeSingle = async () => ({ data: table === 'event_types' ? event : null, error: eventError })
      q.insert = (row) => { inserts.push(row); return q }
      q.single = async () => (insertError ? { data: null, error: insertError } : { data: { id: 'bk1', ...inserts.at(-1) }, error: null })
      return q
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  findBookableSlot.mockResolvedValue({ slot: { start: '18:00', end: '18:30' }, error: null })
})

describe('createBooking', () => {
  it('judges the slot, then inserts a confirmed booking at the slot it found', async () => {
    const db = dbWith()
    const res = await createBooking(db, { event: EVENT, date: '2026-07-03', startTime: '18:00', customer: CUSTOMER, source: 'booking_page' })
    expect(res.ok).toBe(true)
    expect(findBookableSlot).toHaveBeenCalledWith(db, EVENT, '2026-07-03', '18:00')
    expect(db.inserts[0]).toMatchObject({
      event_type_id: 'ev1', location_id: 'loc1', booking_date: '2026-07-03', start_time: '18:00', end_time: '18:30',
      customer_email: 'ann@x.ie', status: 'confirmed', source: 'booking_page',
    })
  })

  it('a time the slot rules do not offer is refused, nothing inserted', async () => {
    findBookableSlot.mockResolvedValue({ slot: null, error: null })
    const db = dbWith()
    expect(await createBooking(db, { event: EVENT, date: '2026-07-03', startTime: '03:00', customer: CUSTOMER })).toEqual({ ok: false, code: 'slot_unavailable' })
    expect(db.inserts).toHaveLength(0)
  })

  it('an unreadable slot check refuses rather than guessing', async () => {
    findBookableSlot.mockResolvedValue({ slot: null, error: { message: 'down' } })
    expect((await createBooking(dbWith(), { event: EVENT, date: 'd', startTime: '18:00', customer: CUSTOMER })).code).toBe('slot_check_failed')
    findBookableSlot.mockRejectedValue(new Error('zone unreadable'))
    expect((await createBooking(dbWith(), { event: EVENT, date: 'd', startTime: '18:00', customer: CUSTOMER })).code).toBe('slot_check_failed')
  })

  it('the database overlap guard (23P01) reads as the slot being taken', async () => {
    const res = await createBooking(dbWith({ insertError: { code: '23P01', message: 'conflicting key value violates exclusion constraint' } }), { event: EVENT, date: 'd', startTime: '18:00', customer: CUSTOMER })
    expect(res).toMatchObject({ ok: false, code: 'slot_taken' })
  })

  it('a slot the caller already found is used without a second check', async () => {
    const db = dbWith()
    await createBooking(db, { event: EVENT, date: 'd', startTime: '18:00', slot: { start: '18:00', end: '19:00' }, customer: CUSTOMER })
    expect(findBookableSlot).not.toHaveBeenCalled()
    expect(db.inserts[0].end_time).toBe('19:00')
  })
})

describe('createEventBooking (the WhatsApp Flow)', () => {
  const CONTACT = { id: 'ct1', name: 'Ann', email: 'ann@x.ie', phone: '+353871234567' }

  it('re-judges the picked slot at submit and links the contact', async () => {
    const db = dbWith()
    const res = await createEventBooking(db, { event: { id: 'ev1', location_id: 'loc1' }, date: '2026-07-03', startTime: '18:00', contact: CONTACT, source: 'whatsapp_flow' })
    expect(res.bookingId).toBe('bk1')
    expect(findBookableSlot).toHaveBeenCalled()
    expect(db.inserts[0]).toMatchObject({ contact_id: 'ct1', source: 'whatsapp_flow', status: 'confirmed' })
  })

  it('a slot gone since the Flow showed it is not booked', async () => {
    findBookableSlot.mockResolvedValue({ slot: null, error: null })
    const db = dbWith()
    const res = await createEventBooking(db, { event: { id: 'ev1', location_id: 'loc1' }, date: '2026-07-03', startTime: '18:00', contact: CONTACT })
    expect(res.error.code).toBe('slot_unavailable')
    expect(db.inserts).toHaveLength(0)
  })

  it('an event type of another studio is refused', async () => {
    const res = await createEventBooking(dbWith({ event: { ...EVENT, location_id: 'loc-other' } }), { event: { id: 'ev1', location_id: 'loc1' }, date: 'd', startTime: '18:00', contact: CONTACT })
    expect(res.error.code).toBe('not_found')
  })

  it('returns { error } when the insert fails', async () => {
    const res = await createEventBooking(dbWith({ insertError: { message: 'boom' } }), { event: { id: 'ev1', location_id: 'loc1' }, date: 'd', startTime: '18:00', contact: CONTACT })
    expect(res.error).toBeTruthy()
    expect(res.bookingId).toBeUndefined()
  })
})
