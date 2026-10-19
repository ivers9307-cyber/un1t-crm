import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { UN1T_STATUS_RANK, mapUn1tBookingStatus, mapUn1tBookingToClassBooking, projectUn1tBookings, shouldReplaceStored } from './un1t-online-bookings.js'
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

describe('mapUn1tBookingStatus (UN1TBOOK.16, spec C §3 status table)', () => {
  it('maps every row of the status table, upper-case and padded input too', () => {
    expect(mapUn1tBookingStatus('booked')).toEqual({ status: 'BOOKED', attended: false, rank: 0 })
    expect(mapUn1tBookingStatus('attended')).toEqual({ status: 'ATTENDED', attended: true, rank: 1 })
    expect(mapUn1tBookingStatus('no_show')).toEqual({ status: 'NO_SHOW', attended: false, rank: 1 })
    expect(mapUn1tBookingStatus('cancelled')).toEqual({ status: 'CANCELLED', attended: false, rank: 1 })
    expect(mapUn1tBookingStatus('ATTENDED')).toEqual({ status: 'ATTENDED', attended: true, rank: 1 })
    expect(mapUn1tBookingStatus(' No_Show ')).toEqual({ status: 'NO_SHOW', attended: false, rank: 1 })
    expect(UN1T_STATUS_RANK).toEqual({ BOOKED: 0, ATTENDED: 1, NO_SHOW: 1, CANCELLED: 1 })
    expect(Object.isFrozen(UN1T_STATUS_RANK)).toBe(true)
  })

  it('an unknown, empty or null status is not projectable (null), never uppercased through', () => {
    expect(mapUn1tBookingStatus('waitlisted')).toBeNull()
    expect(mapUn1tBookingStatus('canceled')).toBeNull()
    expect(mapUn1tBookingStatus('')).toBeNull()
    expect(mapUn1tBookingStatus('   ')).toBeNull()
    expect(mapUn1tBookingStatus(null)).toBeNull()
    expect(mapUn1tBookingStatus(undefined)).toBeNull()
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
      status: 'ATTENDED',
      attended: true,
      raw: {
        un1t: {
          status: 'attended',
          source: 'app',
          credit_charged: true,
          has_guest: false,
          updated_at: '2026-10-02T00:00:00.000Z',
          written_by: 'sync',
        },
      },
      synced_at: NOW,
    })
    // Never the booking's own raw (guest details live there).
    // (has_guest is the one guest fact kept: a boolean, no details.)
    expect(JSON.stringify(row)).not.toContain('guest@')
    expect(JSON.stringify(row)).not.toContain('guest_email')
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

  it('raw holds exactly status, source, credit_charged, has_guest, updated_at, written_by', () => {
    const row = mapUn1tBookingToClassBooking(booking(), { locationId: LOC, event: event(), memberName: 'One Member', nowIso: NOW })
    expect(Object.keys(row.raw)).toEqual(['un1t'])
    expect(Object.keys(row.raw.un1t)).toEqual(['status', 'source', 'credit_charged', 'has_guest', 'updated_at', 'written_by'])
  })

  it('raw.un1t.updated_at is un1t.online\'s own remote_updated_at, null when it gives none, never our clock', () => {
    const none = mapUn1tBookingToClassBooking(booking({ remote_updated_at: null }), { locationId: LOC, event: event(), nowIso: NOW })
    expect(none.raw.un1t.updated_at).toBeNull()
    const missing = booking()
    delete missing.remote_updated_at
    const row = mapUn1tBookingToClassBooking(missing, { locationId: LOC, event: event(), nowIso: NOW })
    expect(row.raw.un1t.updated_at).toBeNull()
    expect(JSON.stringify(row.raw)).not.toContain(NOW)
  })

  it('writtenBy crm is carried into raw.un1t.written_by; the default is sync; anything else throws', () => {
    const crm = mapUn1tBookingToClassBooking(booking(), { locationId: LOC, event: event(), nowIso: NOW, writtenBy: 'crm' })
    expect(crm.raw.un1t.written_by).toBe('crm')
    const dflt = mapUn1tBookingToClassBooking(booking(), { locationId: LOC, event: event(), nowIso: NOW })
    expect(dflt.raw.un1t.written_by).toBe('sync')
    expect(() => mapUn1tBookingToClassBooking(booking(), { locationId: LOC, event: event(), nowIso: NOW, writtenBy: 'staff' })).toThrow(TypeError)
  })

  it('an unprojectable status maps to null', () => {
    expect(mapUn1tBookingToClassBooking(booking({ status: 'waitlisted' }), { locationId: LOC, event: event(), nowIso: NOW })).toBeNull()
    expect(mapUn1tBookingToClassBooking(booking({ status: null }), { locationId: LOC, event: event(), nowIso: NOW })).toBeNull()
  })

  it('a guest booking with no contact is named Guest; a contactless booking without a guest stays null', () => {
    const guest = mapUn1tBookingToClassBooking(booking({ contact_id: null, un1t_user_id: null, has_guest: true }), { locationId: LOC, event: event(), memberName: null, nowIso: NOW })
    expect(guest).toMatchObject({ contact_id: null, member_name: 'Guest' })
    expect(guest.raw.un1t.has_guest).toBe(true)
    const nobody = mapUn1tBookingToClassBooking(booking({ contact_id: null, has_guest: false }), { locationId: LOC, event: event(), memberName: null, nowIso: NOW })
    expect(nobody.member_name).toBeNull()
    // A member who brought a guest keeps their own name.
    const member = mapUn1tBookingToClassBooking(booking({ has_guest: true }), { locationId: LOC, event: event(), memberName: 'One Member', nowIso: NOW })
    expect(member.member_name).toBe('One Member')
    // Names unreadable (memberName undefined): the key stays off every row, guests too.
    const unread = mapUn1tBookingToClassBooking(booking({ contact_id: null, has_guest: true }), { locationId: LOC, event: event(), nowIso: NOW })
    expect(unread).not.toHaveProperty('member_name')
  })

  it('a dual-studio booking keeps its Stillorgan contact_id and the Hatch location_id', () => {
    const row = mapUn1tBookingToClassBooking(booking({ contact_id: 'contact-at-stillorgan' }), { locationId: LOC, event: event(), memberName: 'Dual Member', nowIso: NOW })
    expect(row).toMatchObject({ location_id: LOC, contact_id: 'contact-at-stillorgan', source_platform: 'un1t_online' })
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

// A recording fake: selects on un1t_events / contacts / class_bookings (the
// stored rows the tie-break pre-read sees), upserts on class_bookings.
function makeDb({ events = [], contacts = [], stored = [], failSelect = [], upsertError = null } = {}) {
  const log = []
  const from = (table) => {
    const s = { op: 'select', columns: null, filters: [], payload: null, options: null }
    const run = () => {
      log.push({ table, op: s.op, columns: s.columns, payload: s.payload, filters: s.filters, options: s.options })
      if (s.op === 'select') {
        if (failSelect.includes(table)) return { data: null, error: { code: '57014', message: `${table} read boom`, details: 'SECRET' } }
        const src = table === 'un1t_events' ? events : table === 'contacts' ? contacts : table === 'class_bookings' ? stored : []
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
    expect(r).toEqual({ upserted: 1, kept_stored: 0, skipped_no_event: 0, skipped_unknown_status: 0 })
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
    expect(r).toEqual({ upserted: 1, kept_stored: 0, skipped_no_event: 2, skipped_unknown_status: 0 })
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
    expect(r).toEqual({ upserted: 2, kept_stored: 0, skipped_no_event: 1, skipped_unknown_status: 0 })
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
    expect(r).toEqual({ upserted: 0, kept_stored: 0, skipped_no_event: 150, skipped_unknown_status: 0 })
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
    expect(r).toEqual({ upserted: 2, kept_stored: 0, skipped_no_event: 0, skipped_unknown_status: 0, names: 'unreadable' })
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
    expect(r).toEqual({ upserted: 131, kept_stored: 0, skipped_no_event: 0, skipped_unknown_status: 0 })
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
    expect(r).toEqual({ upserted: 450, kept_stored: 0, skipped_no_event: 0, skipped_unknown_status: 0 })
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
    expect(r).toEqual({ upserted: 1, kept_stored: 0, skipped_no_event: 0, skipped_unknown_status: 0 })
    expect(upsertsOf(log)[0].payload).toHaveLength(1)
    expect(upsertsOf(log)[0].payload[0].status).toBe('CANCELLED')
  })

  it('an unknown, empty or null status is not projected, counted skipped_unknown_status, with one logWarn per run naming the distinct values', async () => {
    const { db, log } = makeDb()
    const r = await projectUn1tBookings(db, {
      locationId: LOC,
      bookings: [
        booking({ contact_id: null }),
        booking({ un1t_id: 'b2', status: 'waitlisted', contact_id: null }),
        booking({ un1t_id: 'b3', status: 'waitlisted', contact_id: null }),
        booking({ un1t_id: 'b4', status: 'pending', contact_id: null }),
        booking({ un1t_id: 'b5', status: '', contact_id: null }),
        booking({ un1t_id: 'b6', status: null, contact_id: null }),
      ],
      events: [event()],
      nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 1, kept_stored: 0, skipped_no_event: 0, skipped_unknown_status: 5 })
    expect(upsertsOf(log).flatMap((e) => e.payload).map((p) => p.glofox_booking_id)).toEqual(['un1t:b1'])
    const warns = logWarn.mock.calls.filter(([mod]) => mod === 'un1t-online-bookings')
    expect(warns).toHaveLength(1)
    expect(warns[0][2]).toEqual({ locationId: LOC, count: 5, statuses: ['waitlisted', 'pending', '(empty)'] })
  })

  it('an unknown status is counted as such even when its event is also unknown, and its event is never read', async () => {
    const { db, log } = makeDb()
    const r = await projectUn1tBookings(db, {
      locationId: LOC,
      bookings: [booking({ status: 'waitlisted', event_id: 'e-unknown', contact_id: null })],
      events: [],
      nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 0, kept_stored: 0, skipped_no_event: 0, skipped_unknown_status: 1 })
    expect(log.some((e) => e.table === 'un1t_events')).toBe(false)
  })

  it('projects the four statuses explicitly, and guests as Guest', async () => {
    const { db, log } = makeDb({ contacts: [{ id: 'c1', name: 'One Member' }] })
    const r = await projectUn1tBookings(db, {
      locationId: LOC,
      bookings: [
        booking({ un1t_id: 'b1', status: 'booked' }),
        booking({ un1t_id: 'b2', status: 'attended' }),
        booking({ un1t_id: 'b3', status: 'no_show' }),
        booking({ un1t_id: 'b4', status: 'cancelled' }),
        booking({ un1t_id: 'b5', status: 'booked', contact_id: null, un1t_user_id: null, has_guest: true }),
      ],
      events: [event()],
      nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 5, kept_stored: 0, skipped_no_event: 0, skipped_unknown_status: 0 })
    const rows = upsertsOf(log).flatMap((e) => e.payload)
    expect(rows.map((p) => [p.glofox_booking_id, p.status, p.attended, p.member_name])).toEqual([
      ['un1t:b1', 'BOOKED', false, 'One Member'],
      ['un1t:b2', 'ATTENDED', true, 'One Member'],
      ['un1t:b3', 'NO_SHOW', false, 'One Member'],
      ['un1t:b4', 'CANCELLED', false, 'One Member'],
      ['un1t:b5', 'BOOKED', false, 'Guest'],
    ])
    expect(rows.every((p) => p.raw.un1t.written_by === 'sync')).toBe(true)
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
    expect(await projectUn1tBookings(db, { locationId: LOC, bookings: [], events: [event()], nowIso: NOW })).toEqual({ upserted: 0, kept_stored: 0, skipped_no_event: 0, skipped_unknown_status: 0 })
    expect(log).toHaveLength(0)
  })
})

// UN1TBOOK.17 — spec C §7 as decided 17 Oct.
const stored = (status, { writtenBy, updatedAt, raw } = {}) => ({
  status,
  raw: raw !== undefined ? raw : { un1t: { status: status.toLowerCase(), ...(writtenBy !== undefined ? { written_by: writtenBy } : {}), updated_at: updatedAt ?? null } },
})
const incoming = (status, updatedAt = null) => ({ status, raw: { un1t: { status: status.toLowerCase(), written_by: 'sync', updated_at: updatedAt } } })
const T1 = '2026-10-02T09:00:00.000Z'
const T2 = '2026-10-02T10:00:00.000Z'

describe('shouldReplaceStored', () => {
  it('no stored row: write', () => {
    expect(shouldReplaceStored(incoming('BOOKED'), null)).toBe(true)
    expect(shouldReplaceStored(incoming('BOOKED'), undefined)).toBe(true)
  })

  describe('a sync-written stored row always follows un1t.online (rule 0, Review Focus 5)', () => {
    it('cancel then rebook: a sync BOOKED replaces a sync-written CANCELLED', () => {
      expect(shouldReplaceStored(incoming('BOOKED', T1), stored('CANCELLED', { writtenBy: 'sync', updatedAt: T2 }))).toBe(true)
    })
    it('un-marked attendance: a sync BOOKED replaces a sync-written ATTENDED', () => {
      expect(shouldReplaceStored(incoming('BOOKED', T1), stored('ATTENDED', { writtenBy: 'sync', updatedAt: T2 }))).toBe(true)
    })
    it('a sync NO_SHOW replaces a sync-written ATTENDED whatever the timestamps', () => {
      expect(shouldReplaceStored(incoming('NO_SHOW', T1), stored('ATTENDED', { writtenBy: 'sync', updatedAt: T2 }))).toBe(true)
      expect(shouldReplaceStored(incoming('NO_SHOW', T2), stored('ATTENDED', { writtenBy: 'sync', updatedAt: T1 }))).toBe(true)
      expect(shouldReplaceStored(incoming('NO_SHOW'), stored('ATTENDED', { writtenBy: 'sync', updatedAt: T2 }))).toBe(true)
    })
    it('a stored row with no written_by is treated as sync-written', () => {
      expect(shouldReplaceStored(incoming('BOOKED', T1), stored('CANCELLED', { updatedAt: T2 }))).toBe(true)
      expect(shouldReplaceStored(incoming('BOOKED', T1), stored('CANCELLED', { raw: null }))).toBe(true)
      expect(shouldReplaceStored(incoming('BOOKED', T1), stored('CANCELLED', { raw: {} }))).toBe(true)
      expect(shouldReplaceStored(incoming('BOOKED', T1), stored('CANCELLED', { raw: { un1t: null } }))).toBe(true)
    })
  })

  describe('a CRM-written stored row (rules 1-3)', () => {
    it('a terminal sync status overwrites a stored CRM BOOKED even with an older updated_at', () => {
      for (const s of ['ATTENDED', 'NO_SHOW', 'CANCELLED']) {
        expect(shouldReplaceStored(incoming(s, T1), stored('BOOKED', { writtenBy: 'crm', updatedAt: T2 }))).toBe(true)
      }
    })
    it('a sync BOOKED never undoes a stored CRM CANCELLED, even with a newer updated_at', () => {
      expect(shouldReplaceStored(incoming('BOOKED', T2), stored('CANCELLED', { writtenBy: 'crm', updatedAt: T1 }))).toBe(false)
      expect(shouldReplaceStored(incoming('BOOKED'), stored('CANCELLED', { writtenBy: 'crm' }))).toBe(false)
    })
    it('same rank against a CRM row: the newer un1t.online updated_at wins either way', () => {
      expect(shouldReplaceStored(incoming('CANCELLED', T2), stored('CANCELLED', { writtenBy: 'crm', updatedAt: T1 }))).toBe(true)
      expect(shouldReplaceStored(incoming('CANCELLED', T1), stored('CANCELLED', { writtenBy: 'crm', updatedAt: T2 }))).toBe(false)
      expect(shouldReplaceStored(incoming('BOOKED', T2), stored('BOOKED', { writtenBy: 'crm', updatedAt: T1 }))).toBe(true)
      expect(shouldReplaceStored(incoming('BOOKED', T1), stored('BOOKED', { writtenBy: 'crm', updatedAt: T2 }))).toBe(false)
      expect(shouldReplaceStored(incoming('ATTENDED', T1), stored('CANCELLED', { writtenBy: 'crm', updatedAt: T2 }))).toBe(false)
    })
    it('timestamps are compared as instants, not as strings', () => {
      // 00:30 at +01:00 is 23:30Z the day before: older, though it sorts later as text.
      expect(shouldReplaceStored(incoming('BOOKED', '2026-10-02T00:30:00+01:00'), stored('BOOKED', { writtenBy: 'crm', updatedAt: '2026-10-02T00:00:00.000Z' }))).toBe(false)
      // The same instant in two spellings is equal: re-write.
      expect(shouldReplaceStored(incoming('BOOKED', '2026-10-02T01:00:00+01:00'), stored('BOOKED', { writtenBy: 'crm', updatedAt: '2026-10-02T00:00:00.000Z' }))).toBe(true)
    })
    it('a CRM row with no un1t.online timestamp loses to the sync row of the same rank', () => {
      expect(shouldReplaceStored(incoming('BOOKED', T1), stored('BOOKED', { writtenBy: 'crm', updatedAt: null }))).toBe(true)
      expect(shouldReplaceStored(incoming('BOOKED'), stored('BOOKED', { writtenBy: 'crm', updatedAt: T2 }))).toBe(true)
      // An unreadable timestamp counts as none.
      expect(shouldReplaceStored(incoming('BOOKED', 'not a date'), stored('BOOKED', { writtenBy: 'crm', updatedAt: T2 }))).toBe(true)
    })
    it('equal timestamps re-write (idempotent re-run)', () => {
      expect(shouldReplaceStored(incoming('CANCELLED', T1), stored('CANCELLED', { writtenBy: 'crm', updatedAt: T1 }))).toBe(true)
    })
    it('a stored CRM status outside the table ranks 0', () => {
      expect(shouldReplaceStored(incoming('ATTENDED', T1), stored('WAITING', { writtenBy: 'crm', updatedAt: T2 }))).toBe(true)
      expect(shouldReplaceStored(incoming('BOOKED', T1), stored('WAITING', { writtenBy: 'crm', updatedAt: T2 }))).toBe(false)
    })
  })
})

describe('projectUn1tBookings tie-break pre-read (UN1TBOOK.17)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('the pre-read is location-scoped, in chunks of 100, selecting glofox_booking_id, status, raw', async () => {
    const bookings = Array.from({ length: 130 }, (_, i) => booking({ un1t_id: `b${i}`, contact_id: null }))
    const { db, log } = makeDb()
    const r = await projectUn1tBookings(db, { locationId: LOC, bookings, events: [event()], nowIso: NOW })
    expect(r).toEqual({ upserted: 130, kept_stored: 0, skipped_no_event: 0, skipped_unknown_status: 0 })
    const reads = log.filter((e) => e.table === 'class_bookings' && e.op === 'select')
    expect(reads).toHaveLength(2)
    expect(reads.every((e) => e.columns === 'glofox_booking_id, status, raw')).toBe(true)
    expect(reads.map((e) => e.filters[0])).toEqual([['eq', 'location_id', LOC], ['eq', 'location_id', LOC]])
    expect(reads.map((e) => e.filters[1][1])).toEqual(['glofox_booking_id', 'glofox_booking_id'])
    expect(reads.map((e) => e.filters[1][2].length)).toEqual([100, 30])
    expect(reads[0].filters[1][2][0]).toBe('un1t:b0')
    // The pre-read comes before the first upsert.
    const firstUpsert = log.findIndex((e) => e.op === 'upsert')
    expect(log.findIndex((e) => e.table === 'class_bookings' && e.op === 'select')).toBeLessThan(firstUpsert)
  })

  it('a failed pre-read writes nothing and returns error', async () => {
    const { db, log } = makeDb({ failSelect: ['class_bookings'] })
    const r = await projectUn1tBookings(db, { locationId: LOC, bookings: [booking({ contact_id: null })], events: [event()], nowIso: NOW })
    expect(r).toEqual({ error: { code: '57014', message: 'class_bookings read boom' } })
    expect(upsertsOf(log)).toHaveLength(0)
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })

  it('keeps a stored CRM CANCELLED against a sync BOOKED and counts kept_stored; writes the rest', async () => {
    const { db, log } = makeDb({
      stored: [
        { location_id: LOC, glofox_booking_id: 'un1t:b1', status: 'CANCELLED', raw: { un1t: { written_by: 'crm', updated_at: T1 } } },
        { location_id: LOC, glofox_booking_id: 'un1t:b2', status: 'CANCELLED', raw: { un1t: { written_by: 'sync', updated_at: T2 } } },
        // Another studio's row with the same id is not ours to judge by.
        { location_id: 'loc-other', glofox_booking_id: 'un1t:b3', status: 'CANCELLED', raw: { un1t: { written_by: 'crm', updated_at: T1 } } },
      ],
    })
    const r = await projectUn1tBookings(db, {
      locationId: LOC,
      bookings: [
        booking({ un1t_id: 'b1', status: 'booked', remote_updated_at: T2, contact_id: null }),
        booking({ un1t_id: 'b2', status: 'booked', remote_updated_at: T1, contact_id: null }),
        booking({ un1t_id: 'b3', status: 'booked', contact_id: null }),
      ],
      events: [event()],
      nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 2, kept_stored: 1, skipped_no_event: 0, skipped_unknown_status: 0 })
    expect(upsertsOf(log).flatMap((e) => e.payload).map((p) => p.glofox_booking_id)).toEqual(['un1t:b2', 'un1t:b3'])
  })

  it('a terminal sync status lands over a stored CRM BOOKED', async () => {
    const { db, log } = makeDb({
      stored: [{ location_id: LOC, glofox_booking_id: 'un1t:b1', status: 'BOOKED', raw: { un1t: { written_by: 'crm', updated_at: T2 } } }],
    })
    const r = await projectUn1tBookings(db, {
      locationId: LOC,
      bookings: [booking({ un1t_id: 'b1', status: 'attended', remote_updated_at: T1, contact_id: null })],
      events: [event()],
      nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 1, kept_stored: 0, skipped_no_event: 0, skipped_unknown_status: 0 })
    expect(upsertsOf(log)[0].payload[0]).toMatchObject({ status: 'ATTENDED', attended: true, raw: { un1t: { written_by: 'sync' } } })
  })

  it('every row kept: no upsert at all', async () => {
    const { db, log } = makeDb({
      stored: [{ location_id: LOC, glofox_booking_id: 'un1t:b1', status: 'CANCELLED', raw: { un1t: { written_by: 'crm', updated_at: null } } }],
    })
    const r = await projectUn1tBookings(db, {
      locationId: LOC,
      bookings: [booking({ un1t_id: 'b1', status: 'booked', contact_id: null })],
      events: [event()],
      nowIso: NOW,
    })
    expect(r).toEqual({ upserted: 0, kept_stored: 1, skipped_no_event: 0, skipped_unknown_status: 0 })
    expect(upsertsOf(log)).toHaveLength(0)
  })
})
