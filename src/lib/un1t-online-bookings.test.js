import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { mapUn1tBookingStatus, mapUn1tBookingToClassBooking, projectUn1tBookings } from './un1t-online-bookings.js'
import { logWarn } from './log'

const LOC = 'loc-hatch'
const NOW = '2026-10-17T10:00:00.000Z'

const booking = (over = {}) => ({
  location_id: LOC,
  un1t_id: 'b1',
  un1t_user_id: 'u1',
  event_id: 'e1',
  status: 'attended',
  source: 'app',
  credit_charged: true,
  has_guest: false,
  external_member_ref: 'ext-m',
  external_booking_ref: 'ext-b',
  remote_created_at: '2026-10-01T00:00:00.000Z',
  remote_updated_at: '2026-10-02T00:00:00.000Z',
  raw: { huge: 'payload', guest_email: 'guest@x.ie' },
  synced_at: NOW,
  contact_id: 'c1',
  ...over,
})

const event = (over = {}) => ({
  location_id: LOC,
  un1t_id: 'e1',
  title: 'HYROX Tuesday',
  status: 'scheduled',
  starts_at: '2026-10-20T17:30:00.000Z',
  ends_at: '2026-10-20T18:30:00.000Z',
  ...over,
})

describe('mapUn1tBookingStatus', () => {
  it('maps every un1t status to the Glofox shape', () => {
    expect(mapUn1tBookingStatus('booked')).toEqual({ status: 'BOOKED', attended: false })
    expect(mapUn1tBookingStatus('attended')).toEqual({ status: 'BOOKED', attended: true })
    expect(mapUn1tBookingStatus('no_show')).toEqual({ status: 'BOOKED', attended: false })
    expect(mapUn1tBookingStatus('cancelled')).toEqual({ status: 'CANCELLED', attended: false })
    expect(mapUn1tBookingStatus('waitlisted')).toEqual({ status: 'WAITLISTED', attended: false })
    expect(mapUn1tBookingStatus(null)).toEqual({ status: null, attended: false })
    expect(mapUn1tBookingStatus(undefined)).toEqual({ status: null, attended: false })
    expect(mapUn1tBookingStatus('')).toEqual({ status: null, attended: false })
  })
})

describe('mapUn1tBookingToClassBooking', () => {
  it('maps a booking with un1t: ids, source_platform un1t_online, no glofox_member_id, the event\'s title and starts_at', () => {
    const row = mapUn1tBookingToClassBooking(booking(), { locationId: LOC, event: event(), memberName: 'One Member', nowIso: NOW })
    expect(row).toEqual({
      location_id: LOC,
      glofox_booking_id: 'un1t:b1',
      glofox_event_id: 'un1t:e1',
      glofox_member_id: null,
      source_platform: 'un1t_online',
      contact_id: 'c1',
      member_name: 'One Member',
      class_name: 'HYROX Tuesday',
      starts_at: '2026-10-20T17:30:00.000Z',
      status: 'BOOKED',
      attended: true,
      raw: { un1t: { status: 'attended', source: 'app', credit_charged: true } },
      synced_at: NOW,
    })
    // Never the booking's own raw (guest details live there).
    expect(JSON.stringify(row)).not.toContain('guest')
    expect(JSON.stringify(row)).not.toContain('huge')
  })

  it('omits member_name when memberName is undefined, keeps an explicit null, and caps class_name at 200', () => {
    const noKey = mapUn1tBookingToClassBooking(booking(), { locationId: LOC, event: event(), nowIso: NOW })
    expect(noKey).not.toHaveProperty('member_name')
    const nullName = mapUn1tBookingToClassBooking(booking(), { locationId: LOC, event: event(), memberName: null, nowIso: NOW })
    expect(nullName).toHaveProperty('member_name', null)
    const long = mapUn1tBookingToClassBooking(booking(), { locationId: LOC, event: event({ title: 'x'.repeat(300) }), nowIso: NOW })
    expect(long.class_name).toHaveLength(200)
    const untitled = mapUn1tBookingToClassBooking(booking(), { locationId: LOC, event: event({ title: null }), nowIso: NOW })
    expect(untitled.class_name).toBeNull()
  })

  it('returns null with no un1t_id, no event_id, no event, or an event with no start', () => {
    const ctx = { locationId: LOC, event: event(), nowIso: NOW }
    expect(mapUn1tBookingToClassBooking(booking({ un1t_id: null }), ctx)).toBeNull()
    expect(mapUn1tBookingToClassBooking(booking({ event_id: null }), ctx)).toBeNull()
    expect(mapUn1tBookingToClassBooking(booking(), { ...ctx, event: null })).toBeNull()
    expect(mapUn1tBookingToClassBooking(booking(), { ...ctx, event: event({ starts_at: null }) })).toBeNull()
    expect(mapUn1tBookingToClassBooking(null, ctx)).toBeNull()
  })
})

// A recording fake: selects on un1t_events / contacts, upserts on class_bookings.
function makeDb({ events = [], contacts = [], failSelect = [], upsertError = null } = {}) {
  const log = []
  const from = (table) => {
    const s = { op: 'select', columns: null, filters: [], payload: null, options: null }
    const run = () => {
      log.push({ table, op: s.op, columns: s.columns, payload: s.payload, filters: s.filters, options: s.options })
      if (s.op === 'select') {
        if (failSelect.includes(table)) return { data: null, error: { code: '57014', message: `${table} read boom`, details: 'SECRET' } }
        const src = table === 'un1t_events' ? events : table === 'contacts' ? contacts : []
        const out = src.filter((r) => s.filters.every(([kind, col, val]) => (kind === 'eq' ? r[col] === val : val.includes(r[col]))))
        return { data: out, error: null }
      }
      if (s.op === 'upsert') {
        if (upsertError) return { data: null, error: upsertError }
        return { data: null, error: null }
      }
      return { data: null, error: { message: `${s.op} is not allowed in this fake` } }
    }
    const api = {
      select(c) { s.columns = c; return api },
      upsert(p, o) { s.op = 'upsert'; s.payload = p; s.options = o || null; return api },
      update(p) { s.op = 'update'; s.payload = p; return api },
      delete() { s.op = 'delete'; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject) },
    }
    return api
  }
  return { db: { from }, log }
}

const upsertsOf = (log) => log.filter((e) => e.op === 'upsert')

describe('projectUn1tBookings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('projects bookings with names from contacts and events from the run', async () => {
    const { db, log } = makeDb({ contacts: [{ id: 'c1', name: 'One Member' }] })
    const r = await projectUn1tBookings(db, { locationId: LOC, bookings: [booking()], events: [event()], nowIso: NOW })
    expect(r).toEqual({ upserted: 1, skipped_no_event: 0 })
    const [up] = upsertsOf(log)
    expect(up.table).toBe('class_bookings')
    expect(up.payload[0]).toMatchObject({ glofox_booking_id: 'un1t:b1', member_name: 'One Member', source_platform: 'un1t_online' })
    // The run's events were enough: no un1t_events read.
    expect(log.some((e) => e.table === 'un1t_events')).toBe(false)
    const namesRead = log.find((e) => e.table === 'contacts')
    expect(namesRead.columns).toBe('id, name')
    expect(namesRead.filters).toEqual([['in', 'id', ['c1']]])
  })

  it('a booking with no event_id or an unknown event is skipped and counted, never written', async () => {
    const { db, log } = makeDb({ events: [] })
    const r = await projectUn1tBookings(db, {
      locationId: LOC,
      bookings: [booking(), booking({ un1t_id: 'b2', event_id: null }), booking({ un1t_id: 'b3', event_id: 'e-unknown' })],
      events: [event()],
      nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 1, skipped_no_event: 2 })
    const written = upsertsOf(log).flatMap((e) => e.payload.map((p) => p.glofox_booking_id))
    expect(written).toEqual(['un1t:b1'])
    expect(upsertsOf(log).flatMap((e) => e.payload).every((p) => p.starts_at)).toBe(true)
  })

  it('reads missing events from un1t_events scoped to the location', async () => {
    const { db, log } = makeDb({
      events: [
        { location_id: LOC, un1t_id: 'e-old', title: 'Old class', starts_at: '2026-09-01T07:00:00.000Z' },
        { location_id: 'loc-other', un1t_id: 'e-other', title: 'Not ours', starts_at: '2026-09-01T07:00:00.000Z' },
      ],
    })
    const r = await projectUn1tBookings(db, {
      locationId: LOC,
      bookings: [booking(), booking({ un1t_id: 'b2', event_id: 'e-old' }), booking({ un1t_id: 'b3', event_id: 'e-other' })],
      events: [event()],
      nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 2, skipped_no_event: 1 })
    const read = log.find((e) => e.table === 'un1t_events')
    expect(read.columns).toBe('un1t_id, title, starts_at')
    expect(read.filters).toEqual([['eq', 'location_id', LOC], ['in', 'un1t_id', ['e-old', 'e-other']]])
    const old = upsertsOf(log)[0].payload.find((p) => p.glofox_booking_id === 'un1t:b2')
    expect(old).toMatchObject({ glofox_event_id: 'un1t:e-old', class_name: 'Old class', starts_at: '2026-09-01T07:00:00.000Z' })
  })

  it('reads missing events in chunks of 100', async () => {
    const bookings = Array.from({ length: 150 }, (_, i) => booking({ un1t_id: `b${i}`, event_id: `e${i}` }))
    const { db, log } = makeDb()
    const r = await projectUn1tBookings(db, { locationId: LOC, bookings, events: [], nowIso: NOW })
    expect(r).toEqual({ upserted: 0, skipped_no_event: 150 })
    const reads = log.filter((e) => e.table === 'un1t_events')
    expect(reads.map((e) => e.filters[1][2].length)).toEqual([100, 50])
  })

  it('a failed un1t_events read writes nothing and returns error', async () => {
    const { db, log } = makeDb({ failSelect: ['un1t_events'] })
    const r = await projectUn1tBookings(db, {
      locationId: LOC,
      bookings: [booking(), booking({ un1t_id: 'b2', event_id: 'e-old' })],
      events: [event()],
      nowIso: NOW,
    })
    expect(r).toEqual({ error: { code: '57014', message: 'un1t_events read boom' } })
    expect(upsertsOf(log)).toHaveLength(0)
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })

  it('a failed names read writes rows without member_name and reports names: unreadable', async () => {
    const { db, log } = makeDb({ failSelect: ['contacts'] })
    const r = await projectUn1tBookings(db, {
      locationId: LOC,
      bookings: [booking(), booking({ un1t_id: 'b2', contact_id: 'c2' })],
      events: [event()],
      nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 2, skipped_no_event: 0, names: 'unreadable' })
    const rows = upsertsOf(log).flatMap((e) => e.payload)
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(Object.prototype.hasOwnProperty.call(row, 'member_name')).toBe(false)
    expect(logWarn).toHaveBeenCalledWith('un1t-online-bookings', expect.any(String), expect.objectContaining({ err: { code: '57014', message: 'contacts read boom' } }))
  })

  it('reads names in chunks of 100 and writes null for a contact with no row or a booking with no contact', async () => {
    const bookings = Array.from({ length: 130 }, (_, i) => booking({ un1t_id: `b${i}`, contact_id: `c${i}` }))
    bookings.push(booking({ un1t_id: 'b-none', contact_id: null }))
    const { db, log } = makeDb({ contacts: [{ id: 'c0', name: 'Zero' }] })
    const r = await projectUn1tBookings(db, { locationId: LOC, bookings, events: [event()], nowIso: NOW })
    expect(r).toEqual({ upserted: 131, skipped_no_event: 0 })
    expect(log.filter((e) => e.table === 'contacts').map((e) => e.filters[0][2].length)).toEqual([100, 30])
    const rows = upsertsOf(log).flatMap((e) => e.payload)
    expect(rows.find((p) => p.glofox_booking_id === 'un1t:b0').member_name).toBe('Zero')
    expect(rows.find((p) => p.glofox_booking_id === 'un1t:b1').member_name).toBeNull()
    expect(rows.find((p) => p.glofox_booking_id === 'un1t:b-none')).toMatchObject({ member_name: null, contact_id: null })
  })

  it('upserts in chunks of 200 on location_id,glofox_booking_id and never deletes', async () => {
    const bookings = Array.from({ length: 450 }, (_, i) => booking({ un1t_id: `b${i}`, contact_id: null }))
    const { db, log } = makeDb()
    const r = await projectUn1tBookings(db, { locationId: LOC, bookings, events: [event()], nowIso: NOW })
    expect(r).toEqual({ upserted: 450, skipped_no_event: 0 })
    const ups = upsertsOf(log)
    expect(ups.map((e) => e.payload.length)).toEqual([200, 200, 50])
    expect(ups.every((e) => e.table === 'class_bookings' && e.options.onConflict === 'location_id,glofox_booking_id')).toBe(true)
    expect(log.some((e) => e.op === 'delete' || e.op === 'update')).toBe(false)
  })

  it('last row wins per booking id, so one upsert never touches a row twice', async () => {
    const { db, log } = makeDb()
    const r = await projectUn1tBookings(db, {
      locationId: LOC,
      bookings: [booking({ status: 'booked', contact_id: null }), booking({ status: 'cancelled', contact_id: null })],
      events: [event()],
      nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 1, skipped_no_event: 0 })
    expect(upsertsOf(log)[0].payload).toHaveLength(1)
    expect(upsertsOf(log)[0].payload[0].status).toBe('CANCELLED')
  })

  it('a CHECK violation from the upsert is returned as {code, message}, never thrown', async () => {
    const { db } = makeDb({
      upsertError: {
        code: '23514',
        message: 'new row for relation "class_bookings" violates check constraint "class_bookings_source_namespace_check"',
        details: 'Failing row contains (SECRET)',
      },
    })
    const r = await projectUn1tBookings(db, { locationId: LOC, bookings: [booking({ contact_id: null })], events: [event()], nowIso: NOW })
    expect(r).toEqual({
      error: { code: '23514', message: 'new row for relation "class_bookings" violates check constraint "class_bookings_source_namespace_check"' },
    })
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })

  it('a thrown exception is returned as an error, never thrown', async () => {
    const db = { from: () => { throw new Error('kaboom') } }
    await expect(projectUn1tBookings(db, { locationId: LOC, bookings: [booking()], events: [event()], nowIso: NOW }))
      .resolves.toEqual({ error: { code: null, message: 'kaboom' } })
  })

  it('no bookings: nothing read or written', async () => {
    const { db, log } = makeDb()
    expect(await projectUn1tBookings(db, { locationId: LOC, bookings: [], events: [event()], nowIso: NOW })).toEqual({ upserted: 0, skipped_no_event: 0 })
    expect(log).toHaveLength(0)
  })
})
