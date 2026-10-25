// BOOKINGOUTCOME.1 — POST /api/bookings/outcomes, the "Mark all as showed"
// bulk action on /bookings?filter=needs_outcome.
//   { booking_ids: uuid[] (1..200), status: 'completed' | 'no_show' }
// Every booking is judged like POST /api/bookings/[id]/status (membership at
// its studio, then the WEB `bookings` key there), must still be 'confirmed',
// and its end (a wall clock in ITS studio's zone) must have passed. The write
// is a compare-and-swap on 'confirmed'; the answer says, per id, what happened.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { resetLocationZoneCache } from '@/lib/location-time'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../tests/helpers/role-sweep-callers.js'
import { POST } from './route.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const req = (body) => new Request('http://localhost/api/bookings/outcomes', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const NOW = '2026-11-01T12:00:00Z' // 12:00 GMT in Dublin, 07:00 EST in New York
let tables
const row = (n) => tables.bookings.find((b) => b.id === id(n))
const bk = (n, fields) => ({
  id: id(n), status: 'confirmed', location_id: LOC_A, booking_date: '2026-10-30', start_time: '09:00:00', end_time: '10:00:00', ...fields,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  resetLocationZoneCache()
  getCurrentUser.mockResolvedValue(person({
    [LOC_A]: { role: 'staff', permissions: { bookings: true } },
    [LOC_B]: { role: 'staff', permissions: { bookings: true } },
  }, LOC_A))
  tables = {
    locations: [{ id: LOC_A, timezone: 'Europe/Dublin' }, { id: LOC_B, timezone: 'America/New_York' }],
    bookings: [bk(1), bk(2)],
  }
  createServerClient.mockReturnValue(makeFakeDb(tables))
})
afterEach(() => vi.useRealTimers())

describe('POST /api/bookings/outcomes: who may call it', () => {
  it('401 without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req({ booking_ids: [id(1)], status: 'completed' }))).status).toBe(401)
  })

  it('403 without web bookings at any studio, before any read', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { bookings: false } } }, LOC_A))
    const db = makeFakeDb(tables)
    const from = vi.spyOn(db, 'from')
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ booking_ids: [id(1)], status: 'completed' }))).status).toBe(403)
    expect(from).not.toHaveBeenCalled()
    expect(row(1).status).toBe('confirmed')
  })
})

describe('POST /api/bookings/outcomes: the body', () => {
  it.each([
    ['no ids', { booking_ids: [], status: 'completed' }],
    ['over 200 ids', { booking_ids: Array.from({ length: 201 }, (_, i) => id(i + 1)), status: 'completed' }],
    ['not a uuid', { booking_ids: ['nope'], status: 'completed' }],
    ['cancelled (cancel notifies; it has its own route)', { booking_ids: [id(1)], status: 'cancelled' }],
    ['confirmed (not an outcome)', { booking_ids: [id(1)], status: 'confirmed' }],
  ])('400 for %s', async (_label, body) => {
    expect((await POST(req(body))).status).toBe(400)
    expect(row(1).status).toBe('confirmed')
  })
})

describe('POST /api/bookings/outcomes: the write', () => {
  it.each(['completed', 'no_show'])('marks every eligible booking %s', async (status) => {
    const res = await POST(req({ booking_ids: [id(1), id(2)], status }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, data: { updated: [id(1), id(2)], skipped: [] } })
    expect(row(1).status).toBe(status)
    expect(row(2).status).toBe(status)
  })

  it('a repeated id is judged and reported once', async () => {
    const body = await (await POST(req({ booking_ids: [id(1), id(1)], status: 'completed' }))).json()
    expect(body.data).toEqual({ updated: [id(1)], skipped: [] })
  })

  it('judges each booking on its own and writes only the eligible ones', async () => {
    getCurrentUser.mockResolvedValue(person({
      [LOC_A]: { role: 'staff', permissions: { bookings: true } },
      [LOC_B]: { role: 'staff', permissions: { bookings: false } },
    }, LOC_A))
    tables.bookings = [
      bk(1),
      bk(2, { status: 'completed' }),
      bk(3, { booking_date: '2026-11-02' }), // tomorrow
      bk(4, { location_id: LOC_OTHER }), // a studio they are not at
      bk(5, { location_id: LOC_B }), // web bookings off there
      bk(6, { location_id: null, event_types: { location_id: LOC_A } }), // judged at its type's studio
      bk(7, { end_time: 'later' }),
    ]
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map(id)
    const body = await (await POST(req({ booking_ids: ids, status: 'completed' }))).json()
    expect(body.success).toBe(true)
    expect(body.data.updated).toEqual([id(1), id(6)])
    expect(body.data.skipped).toEqual([
      { id: id(2), reason: 'not_confirmed' },
      { id: id(3), reason: 'not_ended' },
      { id: id(4), reason: 'not_found' },
      { id: id(5), reason: 'forbidden' },
      { id: id(7), reason: 'bad_time' },
      { id: id(8), reason: 'not_found' }, // no such booking
    ])
    expect(tables.bookings.map((b) => b.status)).toEqual(['completed', 'completed', 'confirmed', 'confirmed', 'confirmed', 'completed', 'confirmed'])
  })

  it("reads each booking's end in ITS studio's zone (Dublin GMT vs New York EST on 1 Nov)", async () => {
    // 09:00 to 10:00 on 1 Nov: 10:00Z in Dublin (ended at 12:00Z), 15:00Z in New York (not yet).
    tables.bookings = [
      bk(1, { booking_date: '2026-11-01', location_id: LOC_A }),
      bk(2, { booking_date: '2026-11-01', location_id: LOC_B }),
    ]
    const body = await (await POST(req({ booking_ids: [id(1), id(2)], status: 'completed' }))).json()
    expect(body.data).toEqual({ updated: [id(1)], skipped: [{ id: id(2), reason: 'not_ended' }] })
  })

  it('New York, the day before fall back: a 07:00 EDT end (11:00Z) has passed at 12:00Z', async () => {
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'))
    tables.bookings = [
      bk(1, { booking_date: '2026-10-31', start_time: '06:00', end_time: '07:00', location_id: LOC_B }),
      bk(2, { booking_date: '2026-10-31', start_time: '08:30', end_time: '09:00', location_id: LOC_B }), // 13:00Z
    ]
    const body = await (await POST(req({ booking_ids: [id(1), id(2)], status: 'no_show' }))).json()
    expect(body.data).toEqual({ updated: [id(1)], skipped: [{ id: id(2), reason: 'not_ended' }] })
  })

  it('writes with a compare-and-swap on confirmed: a booking changed underneath is skipped as changed', async () => {
    const real = makeFakeDb(tables)
    createServerClient.mockReturnValue({ from: (t) => {
      const b = real.from(t)
      const update = b.update
      b.update = (p) => {
        row(2).status = 'no_show' // someone else decided it between the read and the write
        return update(p)
      }
      return b
    } })
    const body = await (await POST(req({ booking_ids: [id(1), id(2)], status: 'completed' }))).json()
    expect(body.data).toEqual({ updated: [id(1)], skipped: [{ id: id(2), reason: 'changed' }] })
    expect(row(2).status).toBe('no_show')
  })

  it('nothing eligible: no write at all', async () => {
    tables.bookings = [bk(1, { status: 'completed' })]
    const db = makeFakeDb(tables)
    const from = vi.spyOn(db, 'from')
    createServerClient.mockReturnValue(db)
    const body = await (await POST(req({ booking_ids: [id(1)], status: 'completed' }))).json()
    expect(body.data).toEqual({ updated: [], skipped: [{ id: id(1), reason: 'not_confirmed' }] })
    expect(from.mock.calls.filter(([t]) => t === 'bookings')).toHaveLength(1) // the read only
  })
})

describe('POST /api/bookings/outcomes: failures are never a success', () => {
  const failing = (table, method) => {
    const real = makeFakeDb(tables)
    return { from: (t) => {
      const b = real.from(t)
      if (t !== table) return b
      const orig = b[method]
      b[method] = (...a) => { orig(...a); b.then = (res, rej) => Promise.resolve({ data: null, error: { message: 'timeout' } }).then(res, rej); return b }
      return b
    } }
  }

  it('a failed bookings read is a 500', async () => {
    createServerClient.mockReturnValue(failing('bookings', 'in'))
    const res = await POST(req({ booking_ids: [id(1)], status: 'completed' }))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  it('an unreadable studio zone is a 500 (no guessing which day it is)', async () => {
    createServerClient.mockReturnValue(failing('locations', 'in'))
    const res = await POST(req({ booking_ids: [id(1)], status: 'completed' }))
    expect(res.status).toBe(500)
    expect(row(1).status).toBe('confirmed')
  })

  it('a failed write is a 500 and reports nothing as updated', async () => {
    createServerClient.mockReturnValue(failing('bookings', 'update'))
    const res = await POST(req({ booking_ids: [id(1)], status: 'completed' }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
  })
})
