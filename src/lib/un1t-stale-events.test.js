// UN1TBOOK.19 — a un1t.online class the latest sync did not see is never offered.
//
// Live 19 Oct 2026 12:07 UTC at Hatch Street: a customer booked ARENA (Sat 24
// Oct 07:00) through the WhatsApp Flow and un1t.online answered 404 "Event not
// found". The event had been deleted upstream after the 09:45 sync; the sync
// never deletes mirror rows, so its un1t_events row stayed 'scheduled' with
// synced_at frozen at 09:45 while every later run refreshed the other 52
// future classes. Every reader that OFFERS a un1t.online class for booking now
// keeps only rows within the freshness window of the studio's newest
// synced_at (freshCutoff): the website /start list, the Flow's day and slot
// screens, the staff Book panel's class list and Mia's timetable. A stalled
// sync (no newer run) keeps every row, and a Glofox studio is untouched.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', async (orig) => ({
  ...(await orig()),
  glofoxCredentialsForLocation: vi.fn(),
  missingGlofoxCredentialsForLocation: vi.fn(),
  fetchUpcomingEvents: vi.fn(),
}))
vi.mock('@/lib/location-time', async (orig) => ({ ...(await orig()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))
vi.mock('@/lib/log', async (orig) => ({ ...(await orig()), logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/un1t-staff-booking', () => ({ gateUn1tStaffBooking: vi.fn(async () => ({ ok: true, un1tUserId: 'usr-1' })) }))

import { readPublicClasses, listPublicClasses } from './public-classes'
import { handleDataExchange } from './whatsapp-flow/handler'
import { SCREEN } from './whatsapp-flow/screens'
import { listUn1tOnlineClasses } from './agent/booking-tools'
import { GET as staffClasses } from '@/app/api/un1t-online/classes/route'
import { freshCutoff, FRESH_TABLES } from './un1t-online-freshness'
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, fetchUpcomingEvents } from '@/lib/glofox'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
const STILLORGAN = 'a0000000-0000-4000-8000-000000000001'
const C1 = 'c0000000-0000-4000-8000-000000000001'
const HOUR = 3_600_000
const at = (h) => new Date(Date.now() + h * HOUR).toISOString()
// The live stamps: the 12:00 run saw every class but ARENA, last seen at 09:45.
const LATEST = '2026-10-19T12:00:22.508Z'
const FROZEN = '2026-10-19T09:45:22.445Z'

const event = (over) => ({
  location_id: HATCH, status: 'scheduled', access_mode: 'open', capacity: 20, bookings_count: 2, synced_at: LATEST, ...over,
})

function hatchEvents({ stalled = false } = {}) {
  return [
    event({ un1t_id: 'ev-past', title: 'EARLY', status: 'completed', starts_at: at(-30) }),
    event({ un1t_id: 'ev-rally', title: 'RALLY ', starts_at: at(24), synced_at: stalled ? FROZEN : LATEST }),
    event({ un1t_id: 'ev-arena', title: 'ARENA', starts_at: at(30), synced_at: FROZEN }),
    event({ un1t_id: 'ev-duo', title: 'DUO', starts_at: at(50), synced_at: stalled ? FROZEN : LATEST }),
  ].map((e) => (stalled && e.un1t_id === 'ev-past' ? { ...e, synced_at: FROZEN } : e))
}

// A small PostgREST stand-in: filters, order, range and limit really apply,
// so the newest-synced_at read and the listing read behave as in prod.
function fakeDb(tables, { fail = () => false } = {}) {
  const reads = []
  const db = {
    from(table) {
      const q = { table, cols: null, f: [], order: null, range: null, limit: null }
      reads.push(q)
      const match = (r) => q.f.every(([op, c, v]) => {
        const x = r[c]
        if (op === 'eq') return x === v
        if (op === 'in') return v.includes(x)
        if (op === 'gt') return x > v
        if (op === 'gte') return x >= v
        if (op === 'lt') return x < v
        if (op === 'lte') return x <= v
        return true
      })
      const run = () => {
        if (fail(q)) return { data: null, error: { message: 'boom' } }
        let rows = (tables[table] || []).filter(match)
        if (q.order) {
          const [c, asc] = q.order
          rows = [...rows].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (asc ? 1 : -1)))
        }
        if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1)
        if (q.limit != null) rows = rows.slice(0, q.limit)
        return { data: rows, error: null }
      }
      const b = {
        select: (c) => { q.cols = c; return b },
        order: (c, o) => { q.order = [c, o?.ascending !== false]; return b },
        range: (a, z) => { q.range = [a, z]; return b },
        limit: (n) => { q.limit = n; return b },
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error } },
        then: (ok, no) => Promise.resolve(run()).then(ok, no),
      }
      for (const op of ['eq', 'in', 'gt', 'gte', 'lt', 'lte']) b[op] = (c, v) => { q.f.push([op, c, v]); return b }
      return b
    },
  }
  return { db, reads }
}

const hatchTables = (opts) => ({
  locations: [{ id: HATCH, membership_source: 'un1t_online', settings: { un1t_online: { writes_enabled: true, funnel_enabled: true } } }],
  landing_page_settings: [{ location_id: HATCH, blocks: [{ type: 'class_funnel', min_notice_hours: 1 }] }],
  un1t_events: hatchEvents(opts),
  un1t_clients: [{ location_id: HATCH, un1t_user_id: 'usr-1', credit_balance: 3, credit_unlimited: false, synced_at: LATEST }],
  un1t_bookings: [],
})

// The cutoff read is the one that selects synced_at alone.
const cutoffRead = (q) => q.table === 'un1t_events' && q.cols === 'synced_at'

function noGlofox() {
  glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, readError: null })
  missingGlofoxCredentialsForLocation.mockReturnValue(['Branch ID', 'API Key', 'API Token'])
}

async function flowDays(db) {
  return (await handleDataExchange(db, { decryptedBody: { action: 'INIT' }, contact: null, locationId: HATCH, config: {} })).data.days.map((d) => d.id)
}
async function flowSlots(db, day) {
  const res = await handleDataExchange(db, {
    decryptedBody: { action: 'data_exchange', screen: SCREEN.DAY, data: { path: 'class', day } },
    contact: null, locationId: HATCH, config: {},
  })
  return res.data.slots.map((s) => s.id.split('|')[0])
}
async function staffIds(db) {
  createServerClient.mockReturnValue(db)
  const res = await staffClasses(new Request(`http://x/api/un1t-online/classes?location_id=${HATCH}&contact_id=${C1}`))
  return { status: res.status, body: await res.json() }
}
const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

beforeEach(() => {
  vi.clearAllMocks()
  noGlofox()
  getCurrentUser.mockResolvedValue({ id: 'u-s', role: 'staff', locations: [{ id: HATCH }], rolesByLocation: { [HATCH]: 'staff' } })
})

describe('freshCutoff knows un1t_events', () => {
  it('is one of the sync-stamped tables, and answers the newest synced_at minus 10 minutes', async () => {
    expect(FRESH_TABLES).toContain('un1t_events')
    const { db } = fakeDb(hatchTables())
    expect(await freshCutoff(db, 'un1t_events', HATCH)).toBe('2026-10-19T11:50:22.508Z')
  })
})

describe('the website /start list (readPublicClasses, un1t.online branch)', () => {
  it('leaves out a class the latest sync did not see', async () => {
    const { db } = fakeDb(hatchTables())
    const out = await readPublicClasses(db, HATCH, 14)
    expect(out.error).toBeNull()
    expect(out.classes.map((c) => c.event_id)).toEqual(['un1t:ev-rally', 'un1t:ev-duo'])
  })

  it('a stalled sync (no newer run) still lists every class', async () => {
    const { db } = fakeDb(hatchTables({ stalled: true }))
    const out = await readPublicClasses(db, HATCH, 14)
    expect(out.classes.map((c) => c.event_id)).toEqual(['un1t:ev-rally', 'un1t:ev-arena', 'un1t:ev-duo'])
  })

  it('an unreadable freshness read is an unreadable timetable, never the whole mirror', async () => {
    const { db } = fakeDb(hatchTables(), { fail: cutoffRead })
    expect(await readPublicClasses(db, HATCH, 14)).toEqual({ classes: [], error: 'un1t_events_unreadable' })
  })

  it('the freshness read is scoped to THIS studio', async () => {
    const tables = hatchTables()
    // Another studio synced later: it must not make Hatch's 12:00 run look stale.
    tables.un1t_events.push(event({ location_id: 'elsewhere', un1t_id: 'x', title: 'X', starts_at: at(26), synced_at: '2026-10-19T13:00:00.000Z' }))
    const { db } = fakeDb(tables)
    const out = await readPublicClasses(db, HATCH, 14)
    expect(out.classes.map((c) => c.event_id)).toEqual(['un1t:ev-rally', 'un1t:ev-duo'])
  })
})

describe('the WhatsApp Flow (day and slot screens)', () => {
  it('offers no day or slot for a class the latest sync did not see', async () => {
    const { db } = fakeDb(hatchTables())
    const arenaDay = dayOf(at(30))
    const days = await flowDays(db)
    const slots = await flowSlots(db, arenaDay)
    expect(slots).not.toContain('un1t:ev-arena')
    // ARENA's day is only offered if another fresh class runs that day.
    const freshDays = new Set([dayOf(at(24)), dayOf(at(50))])
    expect(days.includes(arenaDay)).toBe(freshDays.has(arenaDay))
  })

  it('a stalled sync still offers it', async () => {
    const { db } = fakeDb(hatchTables({ stalled: true }))
    expect(await flowDays(db)).toContain(dayOf(at(30)))
    expect(await flowSlots(db, dayOf(at(30)))).toContain('un1t:ev-arena')
  })

  it('an unreadable freshness read offers nothing (listPublicClasses: [] on any failure)', async () => {
    const { db } = fakeDb(hatchTables(), { fail: cutoffRead })
    expect(await listPublicClasses(db, HATCH)).toEqual([])
  })
})

describe('the staff Book panel (GET /api/un1t-online/classes)', () => {
  it('leaves out a class the latest sync did not see', async () => {
    const { status, body } = await staffIds(fakeDb(hatchTables()).db)
    expect(status).toBe(200)
    expect(body.data.classes.map((c) => c.id)).toEqual(['ev-rally', 'ev-duo'])
  })

  it('a stalled sync still lists every class', async () => {
    const { body } = await staffIds(fakeDb(hatchTables({ stalled: true })).db)
    expect(body.data.classes.map((c) => c.id)).toEqual(['ev-rally', 'ev-arena', 'ev-duo'])
  })

  it('an unreadable freshness read is the route\'s unreadable-timetable 503', async () => {
    const { status, body } = await staffIds(fakeDb(hatchTables(), { fail: cutoffRead }).db)
    expect(status).toBe(503)
    expect(body.success).toBe(false)
  })
})

describe('Mia\'s timetable (listUn1tOnlineClasses)', () => {
  it('leaves out a class the latest sync did not see, in both shapes', async () => {
    const { db } = fakeDb(hatchTables())
    const names = await listUn1tOnlineClasses(db, HATCH, 'Europe/Dublin', Date.now())
    expect(names.classes.map((c) => c.name)).toEqual(['RALLY', 'DUO'])
    const ids = await listUn1tOnlineClasses(db, HATCH, 'Europe/Dublin', Date.now(), { withEventIds: true })
    expect(ids.classes.map((c) => c.event_id)).toEqual(['un1t:ev-rally', 'un1t:ev-duo'])
  })

  it('a stalled sync still lists every class', async () => {
    const { db } = fakeDb(hatchTables({ stalled: true }))
    const out = await listUn1tOnlineClasses(db, HATCH, 'Europe/Dublin', Date.now())
    expect(out.classes.map((c) => c.name)).toEqual(['RALLY', 'ARENA', 'DUO'])
  })

  it('an unreadable freshness read hands off, as an unreadable timetable does', async () => {
    const { db } = fakeDb(hatchTables(), { fail: cutoffRead })
    const out = await listUn1tOnlineClasses(db, HATCH, 'Europe/Dublin', Date.now())
    expect(out.classes).toBeUndefined()
    const { db: unreadable } = fakeDb(hatchTables(), { fail: (q) => q.table === 'un1t_events' })
    expect(out).toEqual(await listUn1tOnlineClasses(unreadable, HATCH, 'Europe/Dublin', Date.now()))
  })
})

describe('a Glofox studio is unchanged', () => {
  it('lists Glofox\'s answer and never reads un1t_events', async () => {
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null, hiddenClassKeywords: [] })
    missingGlofoxCredentialsForLocation.mockReturnValue([])
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [{ _id: 'g1', name: 'HIIT', time_start: Math.floor(Date.now() / 1000) + 86400, size: 10, booked: 1 }] })
    const { db, reads } = fakeDb({ un1t_events: hatchEvents().map((e) => ({ ...e, location_id: STILLORGAN })) })
    const out = await readPublicClasses(db, STILLORGAN, 7)
    expect(out.classes.map((c) => c.event_id)).toEqual(['g1'])
    expect(reads.some((r) => r.table === 'un1t_events')).toBe(false)
  })
})
