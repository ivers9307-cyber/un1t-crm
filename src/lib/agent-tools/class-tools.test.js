import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { runTool } from './registry.js'
import getClasses from './get-classes.js'
import getClassRoster from './get-class-roster.js'
import getAppointments from './get-appointments.js'

const DUB = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a01'
// Same organisation, Contacts off: its occurrences are not readable through MCP.
const NOCON = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1a02'
const ME = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1b01'
const OCC = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1f01'
const C1 = '0b6d5d8e-6f0c-4a49-9a8e-2b8f0c6d1e01'
// 2031-07-15 12:00 UTC: summer time in Dublin (UTC+1).
const NOW_MS = Date.UTC(2031, 6, 15, 12, 0, 0)

function auth(role = 'manager', perms = {}) {
  const loc = (id, name) => ({ id, name, timezone: 'Europe/Dublin', organization_id: 'org-1' })
  const locations = [loc(DUB, 'Dublin Studio'), loc(NOCON, 'No Contacts')]
  return {
    token: 't',
    clientId: 'client-1',
    scopes: [],
    extra: {
      user: {
        id: ME,
        full_name: 'Pat',
        role,
        isMaster: false,
        locations,
        activeLocation: locations[0],
        rolesByLocation: { [DUB]: role, [NOCON]: role },
        assignmentsByLocation: {
          [DUB]: { role, permissions: { assistant: true, contacts: true, class_roster: true, bookings: true, ...perms } },
          [NOCON]: { role, permissions: { assistant: true, contacts: false, class_roster: true } },
        },
      },
      enabledOrgIds: ['org-1'],
      assistantAnywhere: true,
    },
  }
}

function makeDb(tables = {}) {
  const queries = []
  const db = {
    rpc: vi.fn(async () => ({ data: 1, error: null })),
    from: vi.fn((table) => {
      const q = { table, calls: [] }
      queries.push(q)
      const answer = () => {
        const t = typeof tables[table] === 'function' ? tables[table](q) : tables[table]
        return t ?? { data: [], error: null }
      }
      const b = {}
      for (const m of ['select', 'insert', 'eq', 'in', 'lt', 'lte', 'gte', 'neq', 'or', 'order', 'limit', 'range', 'is']) {
        b[m] = (...args) => { q.calls.push([m, ...args]); return b }
      }
      b.maybeSingle = async () => answer()
      b.single = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    }),
  }
  const on = (table) => queries.filter((q) => q.table === table)
  return { db, on }
}
const argOf = (q, method, ...match) => q.calls.find((c) => c[0] === method && match.every((a, i) => c[i + 1] === a))
const run = (tool, input, role, db, perms) => runTool(tool, input, auth(role, perms), { db, nowMs: NOW_MS })

beforeEach(() => vi.clearAllMocks())

describe('get_classes', () => {
  it('get_classes builds the window in the studio zone and counts booked and waitlisted per event', async () => {
    const occ = (id, ev, name) => ({
      id, glofox_event_id: ev, name, program: 'p', starts_at: '2031-07-15T07:00:00Z', ends_at: '2031-07-15T08:00:00Z',
      capacity: 12, instructor: 'Sam', source_platform: 'glofox',
    })
    const { db, on } = makeDb({
      class_occurrences: { data: [occ('o1', 'e1', 'HIIT'), occ('o2', 'e2', 'Yoga')], error: null },
      class_bookings: {
        data: [
          { glofox_event_id: 'e1', status: 'BOOKED' },
          { glofox_event_id: 'e1', status: 'booked' },
          { glofox_event_id: 'e1', status: 'WAITING' },
          { glofox_event_id: 'e1', status: 'CANCELLED' },
          { glofox_event_id: 'e1', status: null },
          { glofox_event_id: 'e2', status: 'WAITING' },
        ],
        error: null,
      },
    })
    const r = await run(getClasses, {}, 'staff', db)
    expect(r.ok).toBe(true)
    expect(r.data.classes).toEqual([
      { id: 'o1', starts_at: '2031-07-15T07:00:00Z', ends_at: '2031-07-15T08:00:00Z', name: 'HIIT', trainer: 'Sam', capacity: 12, booked: 3, waitlisted: 1, platform: 'glofox' },
      { id: 'o2', starts_at: '2031-07-15T07:00:00Z', ends_at: '2031-07-15T08:00:00Z', name: 'Yoga', trainer: 'Sam', capacity: 12, booked: 0, waitlisted: 1, platform: 'glofox' },
    ])
    expect(r.data.capped).toBe(false)

    // The default day is today on the studio's calendar, midnight to midnight
    // in Dublin (UTC+1 in July), not midnight UTC.
    const q = on('class_occurrences')[0]
    expect(argOf(q, 'eq', 'location_id')[2]).toBe(DUB)
    expect(argOf(q, 'gte', 'starts_at')[2]).toBe('2031-07-14T23:00:00.000Z')
    expect(argOf(q, 'lt', 'starts_at')[2]).toBe('2031-07-15T23:00:00.000Z')
    const bq = on('class_bookings')[0]
    expect(argOf(bq, 'eq', 'location_id')[2]).toBe(DUB)
    expect(argOf(bq, 'in', 'glofox_event_id')[2]).toEqual(['e1', 'e2'])
  })

  it('get_classes hides a class the sync marked cancelled', async () => {
    const row = (id, cancelled_at) => ({
      id, glofox_event_id: `e-${id}`, name: id, program: null, starts_at: '2031-07-15T07:00:00Z', ends_at: '2031-07-15T08:00:00Z',
      capacity: 10, instructor: null, source_platform: 'glofox', cancelled_at,
    })
    // The stand-in honours the filter the way PostgREST would.
    const { db, on } = makeDb({
      class_occurrences: (q) => {
        const live = Boolean(argOf(q, 'is', 'cancelled_at', null))
        return { data: [row('live', null), row('gone', '2031-07-10T00:00:00Z')].filter((r) => !live || r.cancelled_at === null), error: null }
      },
    })
    const r = await run(getClasses, { date: '2031-07-15' }, 'staff', db)
    expect(r.data.classes.map((c) => c.id)).toEqual(['live'])
    expect(argOf(on('class_occurrences')[0], 'is', 'cancelled_at', null)).toBeDefined()
  })

  it('get_classes refuses more than 14 days', async () => {
    const { db, on } = makeDb()
    const r = await run(getClasses, { start: '2031-07-01', end: '2031-07-20' }, 'staff', db)
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(r.message).toContain('14')
    expect(on('class_occurrences')).toHaveLength(0)

    const ok = await run(getClasses, { start: '2031-07-01', end: '2031-07-14' }, 'staff', makeDb().db)
    expect(ok.ok).toBe(true)
    const half = await run(getClasses, { start: '2031-07-01' }, 'staff', makeDb().db)
    expect(half).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('get_classes fails the call when a read fails, never an empty timetable', async () => {
    const { db } = makeDb({ class_occurrences: { data: null, error: { message: 'boom' } } })
    const r = await run(getClasses, { date: '2031-07-15' }, 'staff', db)
    expect(r).toMatchObject({ ok: false, code: 'tool_failed' })
  })
})

describe('get_class_roster', () => {
  it('get_class_roster answers not_found when the occurrence is at an unreadable studio', async () => {
    // Unknown id and an occurrence at a studio without Contacts answer alike.
    const unknown = makeDb({ class_occurrences: { data: null, error: null } })
    const r1 = await run(getClassRoster, { occurrence_id: OCC }, 'manager', unknown.db)
    expect(r1).toMatchObject({ ok: false, code: 'not_found' })

    // The fence is the readable-studios list, so the read is asked for DUB only
    // and the unreadable studio's row never comes back.
    const other = { id: OCC, location_id: NOCON, glofox_event_id: 'e1', name: 'HIIT', starts_at: 'x' }
    const { db, on } = makeDb({
      class_occurrences: (q) => ({ data: argOf(q, 'in', 'location_id')[2].includes(NOCON) ? other : null, error: null }),
    })
    const r2 = await run(getClassRoster, { occurrence_id: OCC }, 'manager', db)
    expect(r2).toMatchObject({ ok: false, code: 'not_found' })
    expect(r2.message).toBe(r1.message)
    expect(argOf(on('class_occurrences')[0], 'in', 'location_id')[2]).toEqual([DUB])
    expect(argOf(on('class_occurrences')[0], 'is', 'cancelled_at', null)).toBeDefined()
    expect(on('class_bookings')).toHaveLength(0)

    // No Contacts at the resolved studio: no studio is readable at all, so no read.
    const none = makeDb()
    const r3 = await run(getClassRoster, { occurrence_id: OCC }, 'manager', none.db, { contacts: false })
    expect(r3).toMatchObject({ ok: false, code: 'not_found' })
    expect(none.on('class_occurrences')).toHaveLength(0)
    expect(none.on('class_bookings')).toHaveLength(0)
  })

  it('get_class_roster lists the bookings of a readable occurrence and needs class_roster', async () => {
    const { db, on } = makeDb({
      class_occurrences: { data: { id: OCC, location_id: DUB, glofox_event_id: 'e1', name: 'HIIT', starts_at: '2031-07-15T07:00:00Z' }, error: null },
      class_bookings: {
        data: [
          { contact_id: C1, member_name: 'Ann', status: 'BOOKED', attended: true },
          { contact_id: null, member_name: 'Walk In', status: 'WAITING', attended: false },
        ],
        error: null,
      },
    })
    const r = await run(getClassRoster, { occurrence_id: OCC }, 'manager', db)
    expect(r.ok).toBe(true)
    expect(r.data.roster).toEqual([
      { contact_id: C1, name: 'Ann', status: 'BOOKED', attended: true },
      { contact_id: null, name: 'Walk In', status: 'WAITING', attended: false },
    ])
    const bq = on('class_bookings')[0]
    expect(argOf(bq, 'eq', 'location_id')[2]).toBe(DUB)
    expect(argOf(bq, 'eq', 'glofox_event_id')[2]).toBe('e1')

    const denied = await run(getClassRoster, { occurrence_id: OCC }, 'manager', makeDb().db, { class_roster: false })
    expect(denied).toMatchObject({ ok: false, code: 'forbidden' })
  })
})

describe('get_appointments', () => {
  it('get_appointments needs the bookings permission and caps the range at 31 days', async () => {
    const denied = await run(getAppointments, { start: '2031-07-01', end: '2031-07-05' }, 'manager', makeDb().db, { bookings: false })
    expect(denied).toMatchObject({ ok: false, code: 'forbidden' })

    const { db, on } = makeDb()
    const wide = await run(getAppointments, { start: '2031-07-01', end: '2031-08-05' }, 'manager', db)
    expect(wide).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(wide.message).toContain('31')
    expect(on('bookings')).toHaveLength(0)

    const { db: db2, on: on2 } = makeDb({
      bookings: {
        data: [{
          id: 'b1', booking_date: '2031-07-02', start_time: '10:00:00', end_time: '10:30:00', status: 'confirmed',
          contact_id: C1, event_types: { name: 'Consult', slug: 'consult' }, contacts: { name: 'Ann' },
        }],
        error: null,
      },
    })
    const r = await run(getAppointments, { start: '2031-07-01', end: '2031-07-31' }, 'manager', db2)
    expect(r.ok).toBe(true)
    expect(r.data.appointments).toEqual([
      { id: 'b1', date: '2031-07-02', start: '10:00', end: '10:30', status: 'confirmed', type: 'Consult', contact: { id: C1, name: 'Ann' } },
    ])
    const q = on2('bookings')[0]
    expect(argOf(q, 'eq', 'location_id')[2]).toBe(DUB)
    expect(argOf(q, 'gte', 'booking_date')[2]).toBe('2031-07-01')
    expect(argOf(q, 'lte', 'booking_date')[2]).toBe('2031-07-31')
  })
})
