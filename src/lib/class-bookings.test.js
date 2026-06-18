import { describe, it, expect, vi } from 'vitest'
import { mapBookingToRosterRow, upsertClassBookings } from './class-bookings'

describe('class-bookings: mapBookingToRosterRow', () => {
  const base = {
    _id: 'bk1', event_id: 'ev1', event_name: 'DR1VE',
    time_start: 1_750_000_000, status: 'booked', attended: false,
  }
  it('shapes a Glofox booking into a roster row', () => {
    const row = mapBookingToRosterRow(base, { locationId: 'loc1', contactId: 'c1', glofoxMemberId: 'm1', memberName: 'Jo B' })
    expect(row).toMatchObject({
      location_id: 'loc1', glofox_event_id: 'ev1', glofox_booking_id: 'bk1',
      glofox_member_id: 'm1', contact_id: 'c1', member_name: 'Jo B',
      class_name: 'DR1VE', status: 'BOOKED', attended: false,
    })
    expect(row.starts_at).toBe(new Date(1_750_000_000 * 1000).toISOString())
  })
  it('uppercases status and coerces attended', () => {
    const row = mapBookingToRosterRow({ ...base, status: 'attended', attended: true }, { locationId: 'loc1' })
    expect(row.status).toBe('ATTENDED')
    expect(row.attended).toBe(true)
  })
  it('returns null without a booking id, event id, or location', () => {
    expect(mapBookingToRosterRow({ event_id: 'ev1' }, { locationId: 'loc1' })).toBeNull()
    expect(mapBookingToRosterRow({ _id: 'bk1' }, { locationId: 'loc1' })).toBeNull()
    expect(mapBookingToRosterRow({ _id: 'bk1', event_id: 'ev1' }, {})).toBeNull()
  })
  it('tolerates a missing time_start (null starts_at)', () => {
    const row = mapBookingToRosterRow({ _id: 'bk1', event_id: 'ev1' }, { locationId: 'loc1' })
    expect(row.starts_at).toBeNull()
  })
})

describe('class-bookings: upsertClassBookings', () => {
  it('upserts shaped rows on the booking-id conflict key', async () => {
    let captured = null
    const db = { from: vi.fn(() => ({ upsert: vi.fn((rows, opts) => { captured = { rows, opts }; return Promise.resolve({ error: null }) }) })) }
    const bookings = [
      { _id: 'bk1', event_id: 'ev1', event_name: 'DR1VE', time_start: 1_750_000_000, status: 'booked' },
      { _id: 'bk2', event_id: 'ev2', event_name: 'TEMPO', time_start: 1_750_003_600, status: 'booked' },
    ]
    const out = await upsertClassBookings(db, { locationId: 'loc1', contactId: 'c1', glofoxMemberId: 'm1', memberName: 'Jo B', bookings })
    expect(out.upserted).toBe(2)
    expect(captured.opts).toEqual({ onConflict: 'location_id,glofox_booking_id' })
    expect(captured.rows[0]).toMatchObject({ glofox_booking_id: 'bk1', contact_id: 'c1' })
  })
  it('skips unshapeable bookings but upserts the rest', async () => {
    let captured = null
    const db = { from: vi.fn(() => ({ upsert: vi.fn((rows) => { captured = rows; return Promise.resolve({ error: null }) }) })) }
    const out = await upsertClassBookings(db, { locationId: 'loc1', bookings: [{ _id: 'bk1', event_id: 'ev1' }, { event_id: 'no-id' }] })
    expect(out.upserted).toBe(1)
    expect(captured).toHaveLength(1)
  })
  it('no-ops on an empty / non-array list', async () => {
    const db = { from: vi.fn() }
    expect((await upsertClassBookings(db, { locationId: 'loc1', bookings: [] })).upserted).toBe(0)
    expect((await upsertClassBookings(db, { locationId: 'loc1' })).upserted).toBe(0)
    expect(db.from).not.toHaveBeenCalled()
  })
})
