import { describe, it, expect, vi } from 'vitest'
import { mapBookingToRosterRow, upsertClassBookings, resolveClassLinkSource, lookupBookedMember, mergeRosterWithSessions, pickNearestBookedOccurrence } from './class-bookings'

describe('class-bookings: mapBookingToRosterRow', () => {
  // Real /2.0/bookings item is polymorphic: model:'events' + model_id (the
  // class id), NOT a top-level event_id. The old fixtures mocked event_id,
  // which is exactly why the empty-class_bookings bug shipped green.
  const base = {
    _id: 'bk1', model: 'events', model_id: 'ev1', event_name: 'DR1VE',
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
  it('maps a raw webhook-shape booking (id + model_id, not _id/event_id)', () => {
    const row = mapBookingToRosterRow(
      { id: 'bk9', model: 'events', model_id: 'mev9', model_name: 'ZONE', time_start: 1_750_000_000, status: 'BOOKED' },
      { locationId: 'loc1' },
    )
    expect(row).toMatchObject({ glofox_booking_id: 'bk9', glofox_event_id: 'mev9', class_name: 'ZONE' })
  })
  it('falls back to legacy _id / event_id when the model fields are absent', () => {
    const row = mapBookingToRosterRow({ _id: 'bkf', event_id: 'evf' }, { locationId: 'loc1' })
    expect(row).toMatchObject({ glofox_booking_id: 'bkf', glofox_event_id: 'evf' })
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

describe('class-bookings: resolveClassLinkSource', () => {
  it('null when no live class', () => {
    expect(resolveClassLinkSource({ liveClass: null, booked: false })).toBeNull()
    expect(resolveClassLinkSource({ liveClass: null, booked: true })).toBeNull()
  })
  it('booked vs presence under a live class', () => {
    expect(resolveClassLinkSource({ liveClass: { glofox_event_id: 'e' }, booked: true })).toBe('booked')
    expect(resolveClassLinkSource({ liveClass: { glofox_event_id: 'e' }, booked: false })).toBe('presence')
  })
})

describe('class-bookings: lookupBookedMember', () => {
  // Mock the .select().eq().eq().eq().not().limit() chain → { data }.
  const db = (rows) => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              not: vi.fn(() => ({
                limit: vi.fn(() => Promise.resolve({ data: rows })),
              })),
            })),
          })),
        })),
      })),
    })),
  })
  it('true when a non-cancelled booking row exists', async () => {
    expect(await lookupBookedMember(db([{ id: 'x' }]), { locationId: 'l', glofoxEventId: 'e', glofoxMemberId: 'm' })).toBe(true)
  })
  it('false when none match', async () => {
    expect(await lookupBookedMember(db([]), { locationId: 'l', glofoxEventId: 'e', glofoxMemberId: 'm' })).toBe(false)
  })
  it('false (no query) when member / event / location id missing', async () => {
    const spy = db([{ id: 'x' }])
    expect(await lookupBookedMember(spy, { locationId: 'l', glofoxEventId: 'e', glofoxMemberId: null })).toBe(false)
    expect(await lookupBookedMember(spy, { locationId: 'l', glofoxMemberId: 'm' })).toBe(false)
    expect(spy.from).not.toHaveBeenCalled()
  })
})

describe('class-bookings: mergeRosterWithSessions', () => {
  const roster = [
    { glofox_member_id: 'm1', member_name: 'Jo B', status: 'BOOKED' },
    { glofox_member_id: 'm2', member_name: 'Al C', status: 'BOOKED' },
    { glofox_member_id: 'm3', member_name: 'Cancelled Cara', status: 'CANCELLED' },
  ]
  const sessions = [
    { id: 's1', contactId: 'c1', glofoxMemberId: 'm1', contactName: 'Jo B', currentBpm: 140, deviceIdentifier: 'ant:1' },
    { id: 's2', contactId: 'c9', glofoxMemberId: 'm9', contactName: 'Zed K', currentBpm: 130, deviceIdentifier: 'ant:2' },
    { id: 's3', contactId: null, glofoxMemberId: null, contactName: 'ant:99', currentBpm: 120, deviceIdentifier: 'ant:99' },
  ]
  it('tags booked+hr, booked+no-hr, present-not-booked, and anon walk-in', () => {
    const out = mergeRosterWithSessions(roster, sessions)
    expect(out.find((r) => r.label === 'Jo B')).toMatchObject({ booked: true, hasHr: true, currentBpm: 140 })
    expect(out.find((r) => r.label === 'Al C')).toMatchObject({ booked: true, hasHr: false, currentBpm: null })
    // present but not booked (known member m9, no roster row)
    expect(out.find((r) => r.label === 'Zed K')).toMatchObject({ booked: false, hasHr: true, anon: false })
    // anon walk-in (session with no contact + no roster match)
    expect(out.find((r) => r.label === 'ant:99')).toMatchObject({ booked: false, hasHr: true, anon: true })
  })
  it('excludes CANCELLED roster rows', () => {
    const out = mergeRosterWithSessions(roster, [])
    expect(out.find((r) => r.label === 'Cancelled Cara')).toBeUndefined()
    expect(out).toHaveLength(2) // Jo B + Al C only
  })
  it('handles empty inputs', () => {
    expect(mergeRosterWithSessions([], [])).toEqual([])
  })
})

describe('pickNearestBookedOccurrence', () => {
  const NOW = Date.parse('2026-06-27T07:45:00Z')
  const occ8 = { glofox_event_id: 'e8', name: 'TEMPO', starts_at: '2026-06-27T08:00:00Z', ends_at: '2026-06-27T09:00:00Z' }
  const occ7 = { glofox_event_id: 'e7', name: 'RIDE',  starts_at: '2026-06-27T07:00:00Z', ends_at: '2026-06-27T08:00:00Z' }
  const occByEvent = (occs) => new Map(occs.map((o) => [o.glofox_event_id, o]))
  const W = { preMs: 45 * 60000, postMs: 30 * 60000 }

  it('maps an early arrival to the upcoming booked class even when a previous class still overlaps', () => {
    const bookings = [
      { glofox_event_id: 'e8', status: 'BOOKED', starts_at: occ8.starts_at },
      { glofox_event_id: 'e7', status: 'BOOKED', starts_at: occ7.starts_at },
    ]
    const out = pickNearestBookedOccurrence(bookings, occByEvent([occ7, occ8]), NOW, W)
    expect(out).toEqual({ glofox_event_id: 'e8', class_name: 'TEMPO', ends_at: '2026-06-27T09:00:00Z' })
  })

  it('ignores cancelled bookings', () => {
    const bookings = [{ glofox_event_id: 'e8', status: 'CANCELLED', starts_at: occ8.starts_at }]
    expect(pickNearestBookedOccurrence(bookings, occByEvent([occ8]), NOW, W)).toBeNull()
  })

  it('returns null when the booked occurrence is outside the window', () => {
    const far = { glofox_event_id: 'eX', name: 'LATE', starts_at: '2026-06-27T12:00:00Z', ends_at: '2026-06-27T13:00:00Z' }
    const bookings = [{ glofox_event_id: 'eX', status: 'BOOKED', starts_at: far.starts_at }]
    expect(pickNearestBookedOccurrence(bookings, occByEvent([far]), NOW, W)).toBeNull()
  })

  it('returns null with no bookings', () => {
    expect(pickNearestBookedOccurrence([], new Map(), NOW, W)).toBeNull()
  })
})
