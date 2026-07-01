import { describe, it, expect, vi } from 'vitest'
import { createEventBooking } from './bookings-write.js'

describe('createEventBooking', () => {
  it('inserts a confirmed booking for the event type + slot', async () => {
    const insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'bk1' }, error: null }) }) }))
    const db = { from: () => ({ insert }) }
    const res = await createEventBooking(db, {
      event: { id: 'ev1', location_id: 'loc1' }, date: '2026-07-03', startTime: '18:00', endTime: '18:30',
      contact: { id: 'ct1', name: 'Ann', email: 'ann@x.ie', phone: '+353871234567' }, source: 'whatsapp_flow',
    })
    expect(res.bookingId).toBe('bk1')
    const row = insert.mock.calls[0][0]
    expect(row.event_type_id).toBe('ev1')
    expect(row.location_id).toBe('loc1')
    expect(row.contact_id).toBe('ct1')
    expect(row.booking_date).toBe('2026-07-03')
    expect(row.start_time).toBe('18:00')
    expect(row.end_time).toBe('18:30')
    expect(row.status).toBe('confirmed')
    expect(row.source).toBe('whatsapp_flow')
    expect(row.customer_name).toBe('Ann')
    expect(row.customer_email).toBe('ann@x.ie')
    expect(row.customer_phone).toBe('+353871234567')
  })

  it('returns { error } when the insert fails', async () => {
    const insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'boom' } }) }) }))
    const db = { from: () => ({ insert }) }
    const res = await createEventBooking(db, {
      event: { id: 'ev1', location_id: 'loc1' }, date: '2026-07-03', startTime: '18:00', endTime: '18:30',
      contact: { id: 'ct1', name: 'Ann', email: 'a@b.ie' },
    })
    expect(res.error).toBeTruthy()
    expect(res.bookingId).toBeUndefined()
  })
})
