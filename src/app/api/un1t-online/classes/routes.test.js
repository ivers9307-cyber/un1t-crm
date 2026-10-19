// UN1TWRITE.14 — the staff un1t.online class list, book and cancel routes.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => ({ ...(await vi.importActual('@/lib/auth')), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/location-time', async (o) => ({ ...(await o()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))
vi.mock('@/lib/un1t-online-settings', async (o) => ({ ...(await o()), readUn1tWriteSettings: vi.fn() }))
vi.mock('@/lib/un1t-online-write-ops', () => ({ book: vi.fn(), cancel: vi.fn() }))

import { GET } from './route.js'
import { POST as BOOK, maxDuration as bookMax } from './book/route.js'
import { POST as CANCEL, maxDuration as cancelMax } from './cancel/route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { book, cancel } from '@/lib/un1t-online-write-ops'

const HATCH = 'a0000000-0000-4000-8000-000000000002'
const C1 = 'c0000000-0000-4000-8000-000000000001'
const staff = { id: 'u-s', role: 'staff', profileRole: 'staff', isMaster: false, locations: [{ id: HATCH }], rolesByLocation: { [HATCH]: 'staff' }, activeLocation: { id: HATCH } }
const HOUR = 3_600_000
const at = (h) => new Date(Date.now() + h * HOUR).toISOString()

let tables
let queries
function makeDb() {
  return {
    from(table) {
      const q = { table, f: [] }
      queries.push(q)
      const rows = () => (tables[table] || []).filter((r) => q.f.every(([k, c, v]) => (k === 'eq' ? r[c] === v : k === 'in' ? v.includes(r[c]) : k === 'gt' ? r[c] > v : k === 'gte' ? r[c] >= v : k === 'lte' ? r[c] <= v : true)))
      const b = {
        select: () => b, order: () => b, limit: () => b, range: () => b,
        gte: (c, v) => { q.f.push(['gte', c, v]); return b },
        eq: (c, v) => { q.f.push(['eq', c, v]); return b },
        in: (c, v) => { q.f.push(['in', c, v]); return b },
        gt: (c, v) => { q.f.push(['gt', c, v]); return b },
        lte: (c, v) => { q.f.push(['lte', c, v]); return b },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok, no) => Promise.resolve({ data: rows(), error: null }).then(ok, no),
      }
      return b
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  queries = []
  getCurrentUser.mockResolvedValue(staff)
  readUn1tWriteSettings.mockResolvedValue({ membershipSource: 'un1t_online', studioName: 'Hatch Street', organizationId: 'org-1', settings: { writesEnabled: true } })
  tables = {
    contacts: [{ id: C1, organization_id: 'org-1', name: 'Test', un1t_user_id: 'usr-1' }],
    un1t_clients: [{ id: 'cl-1', location_id: HATCH, un1t_user_id: 'usr-1', credit_balance: 2, credit_unlimited: false, crm_written_at: null, synced_at: '2026-10-18T08:00:00.000Z' }],
    un1t_events: [
      { location_id: HATCH, un1t_id: 'ev-1', title: 'RALLY ', status: 'scheduled', starts_at: at(24), capacity: 20, bookings_count: 18, access_mode: 'open' },
      { location_id: HATCH, un1t_id: 'ev-2', title: 'MEMBERS', status: 'scheduled', starts_at: at(48), capacity: null, bookings_count: 0, access_mode: 'community' },
      { location_id: HATCH, un1t_id: 'ev-old', title: 'PAST', status: 'scheduled', starts_at: at(-2), capacity: 20, bookings_count: 0, access_mode: 'open' },
      { location_id: HATCH, un1t_id: 'ev-far', title: 'FAR', status: 'scheduled', starts_at: at(24 * 20), capacity: 20, bookings_count: 0, access_mode: 'open' },
      { location_id: HATCH, un1t_id: 'ev-x', title: 'GONE', status: 'cancelled', starts_at: at(30), capacity: 20, bookings_count: 0, access_mode: 'open' },
    ],
    un1t_bookings: [
      { location_id: HATCH, un1t_id: 'bk-1', event_id: 'ev-1', status: 'booked', un1t_user_id: 'usr-1' },
      { location_id: HATCH, un1t_id: 'bk-other', event_id: 'ev-1', status: 'booked', un1t_user_id: 'usr-2' },
    ],
  }
  createServerClient.mockReturnValue(makeDb())
})

const get = () => GET(new Request(`http://x/api/un1t-online/classes?location_id=${HATCH}&contact_id=${C1}`))
const post = (fn, body) => fn(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contact_id: C1, location_id: HATCH, ...body }) }))
const done = (over) => ({ verdict: 'done', sent: true, id: 'bk-9', code: null, message: null, alreadyBooked: false, ledgerId: 'l-1', ...over })

describe('GET /api/un1t-online/classes', () => {
  it('lists only scheduled future events in 14 days, labels community, shows spots to staff', async () => {
    const j = await (await get()).json()
    expect(j.data.classes.map((c) => c.id)).toEqual(['ev-1', 'ev-2'])
    expect(j.data.classes[0]).toMatchObject({ name: 'RALLY', spots_left: 2, community: false })
    expect(j.data.classes[1]).toMatchObject({ spots_left: null, community: true })
    expect(j.data.spots_note).toBe('as of last sync')
  })

  it('the credits line reads balance / unlimited / as_of (crm_written_at else synced_at); upcoming are theirs only', async () => {
    let j = await (await get()).json()
    expect(j.data.credits).toEqual({ balance: 2, unlimited: false, as_of: '2026-10-18T08:00:00.000Z' })
    expect(j.data.upcoming).toEqual([{ booking_id: 'bk-1', event_id: 'ev-1', name: 'RALLY', starts_at: tables.un1t_events[0].starts_at }])
    tables.un1t_clients[0] = { ...tables.un1t_clients[0], credit_unlimited: true, crm_written_at: '2026-10-18T09:00:00.000Z' }
    j = await (await get()).json()
    expect(j.data.credits).toMatchObject({ unlimited: true, as_of: '2026-10-18T09:00:00.000Z' })
  })

  it('refuses a stranger to the studio 403, and writes off 400', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'other' }], rolesByLocation: { other: 'staff' } })
    expect((await get()).status).toBe(403)
    getCurrentUser.mockResolvedValue(staff)
    readUn1tWriteSettings.mockResolvedValue({ membershipSource: 'un1t_online', studioName: 'Hatch Street', organizationId: 'org-1', settings: { writesEnabled: false } })
    expect((await get()).status).toBe(400)
  })
})

describe('POST book / cancel', () => {
  it('both leave room for a check read (maxDuration 120)', () => {
    expect(bookMax).toBe(120)
    expect(cancelMax).toBe(120)
  })

  it('book passes origin staff and the actor; already booked is success', async () => {
    book.mockResolvedValue(done({ alreadyBooked: true, id: 'bk-1' }))
    const res = await post(BOOK, { event_id: 'ev-1' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ un1t_booking_id: 'bk-1', already_booked: true, message: 'Already booked in un1t.online' })
    expect(book.mock.calls[0][1]).toMatchObject({ locationId: HATCH, contactId: C1, un1tUserId: 'usr-1', eventId: 'ev-1', origin: 'staff', actor: { id: 'u-s' } })
  })

  it('book unknown answers the unknown copy (502); a prefixed or odd event id is a 400', async () => {
    book.mockResolvedValue(done({ verdict: 'unknown', id: null }))
    const res = await post(BOOK, { event_id: 'ev-1' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('un1t.online did not answer clearly. Check the class in un1t.online before trying again.')
    expect((await post(BOOK, { event_id: 'un1t:ev-1' })).status).toBe(400)
  })

  it("cancel of a booking that is not this contact's → 404, nothing sent; theirs → cancel with origin staff", async () => {
    expect((await post(CANCEL, { booking_id: 'bk-other' })).status).toBe(404)
    expect(cancel).not.toHaveBeenCalled()
    cancel.mockResolvedValue(done({ id: 'bk-1' }))
    const res = await post(CANCEL, { booking_id: 'bk-1' })
    expect(res.status).toBe(200)
    expect(cancel.mock.calls[0][1]).toMatchObject({ bookingId: 'bk-1', un1tUserId: 'usr-1', origin: 'staff', actor: { id: 'u-s' } })
  })
})
