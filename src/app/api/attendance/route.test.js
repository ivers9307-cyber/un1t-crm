// ATTENDREPORT.1 (follow-ups C4) — GET /api/attendance. The rules are tested in
// src/lib/attendance-report.test.js; this pins the route: the gate, the query
// checks (before any read), the Dublin default window, paging past 1,000 rows,
// the chunked events read, and that no failed read is passed off as an answer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { logError } = await import('@/lib/log')
const { GET } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const MANAGER = { id: 'mgr-1', role: 'manager', activeLocation: { id: LOC, name: 'Studio One' } }
const LOCATION = { id: LOC, name: 'Studio One', timezone: 'Europe/Dublin' }
const PERIOD = '?from=2026-07-01&to=2026-07-31'

const get = (query = '') => new Request(`http://localhost/api/attendance${query}`)

function assignment(n, over = {}) {
  return {
    id: `b0000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    profile_id: 'p-a', status: 'scheduled', arrived_at: null, arrival_source: null,
    start_time_override: null, end_time_override: null,
    block: { id: `blk-${n}`, location_id: LOC, block_date: '2026-07-15', start_time: '07:00:00', end_time: '08:00:00' },
    profile: { id: 'p-a', full_name: 'Coach A', email: null, role: 'staff' },
    ...over,
  }
}

// A recording fake: every builder method is logged; awaiting a list query
// answers by table (assignments by page, events by the ids asked for).
function fakeDb({ location = LOCATION, locationError = null, assignmentPages = [[]], assignmentsError = null, events = [], eventsError = null } = {}) {
  const calls = []
  const answer = (q) => {
    if (q.table === 'shift_assignments') {
      if (assignmentsError) return { data: null, error: assignmentsError }
      return { data: assignmentPages[Math.floor((q.range?.[0] ?? 0) / 1000)] || [], error: null }
    }
    if (q.table === 'staff_attendance_events') {
      if (eventsError) return { data: null, error: eventsError }
      const ids = q.ops.find((o) => o[0] === 'in' && o[1] === 'matched_assignment_id')?.[2] || []
      return { data: events.filter((e) => ids.includes(e.matched_assignment_id)), error: null }
    }
    return { data: null, error: null }
  }
  return {
    calls,
    from(table) {
      const q = { table, ops: [], range: null }
      calls.push(q)
      const b = {}
      for (const name of ['select', 'eq', 'gte', 'lte', 'neq', 'in', 'order']) {
        b[name] = (...args) => { q.ops.push([name, ...args]); return b }
      }
      b.range = (lo, hi) => { q.ops.push(['range', lo, hi]); q.range = [lo, hi]; return b }
      const one = () => Promise.resolve(table === 'locations'
        ? { data: locationError ? null : location, error: locationError }
        : { data: null, error: null })
      b.maybeSingle = one
      b.single = one // the route before this PR used .single()
      b.then = (resolve, reject) => Promise.resolve(answer(q)).then(resolve, reject)
      return b
    },
  }
}

const listQueries = (db, table) => db.calls.filter((c) => c.table === table)
const op = (q, name, col) => q.ops.find((o) => o[0] === name && o[1] === col)

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MANAGER)
})
afterEach(() => vi.useRealTimers())

describe('GET /api/attendance — the gate (D11)', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get())).status).toBe(401)
  })

  it('403 for a head coach (attendance_reports is off by default), before any read', async () => {
    getCurrentUser.mockResolvedValue({ ...MANAGER, role: 'head_coach' })
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    expect((await GET(get(PERIOD))).status).toBe(403)
    expect(db.calls).toEqual([])
  })
})

describe('GET /api/attendance — the query (D6)', () => {
  it.each([
    ['?from=2026-02-30&to=2026-03-06', 'from and to must be real dates, YYYY-MM-DD'],
    ['?from=2026-7-01&to=2026-07-15', 'from and to must be real dates, YYYY-MM-DD'],
    ['?from=2026-07-15&to=2026-07-01', 'to must be on or after from'],
    ['?from=2026-01-01&to=2027-01-02', 'A report can cover at most 366 days'],
    ['?from=2026-07-01&to=2026-07-15&profile_id=abc', 'profile_id must be a UUID'],
  ])('%s is a 400 before any read', async (qs, error) => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    const res = await GET(get(qs))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error })
    expect(db.calls).toEqual([])
  })

  it('the default window is the Dublin day, not the UTC one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-14T23:30:00Z')) // 00:30 on 15 Jul in Dublin
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    expect((await GET(get())).status).toBe(200)
    const [q] = listQueries(db, 'shift_assignments')
    expect(op(q, 'gte', 'block.block_date')).toEqual(['gte', 'block.block_date', '2026-07-01'])
    expect(op(q, 'lte', 'block.block_date')).toEqual(['lte', 'block.block_date', '2026-07-15'])
  })

  it('reads the active studio only, live shifts only, and one coach when asked', async () => {
    const UUID = 'c0000000-0000-0000-0000-000000000001'
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    await GET(get(`${PERIOD}&profile_id=${UUID}`))
    const [q] = listQueries(db, 'shift_assignments')
    expect(op(q, 'eq', 'block.location_id')).toEqual(['eq', 'block.location_id', LOC])
    expect(op(q, 'neq', 'status')).toEqual(['neq', 'status', 'cancelled'])
    expect(op(q, 'eq', 'profile_id')).toEqual(['eq', 'profile_id', UUID])
    expect(op(listQueries(db, 'locations')[0], 'eq', 'id')).toEqual(['eq', 'id', LOC])
  })
})

describe('GET /api/attendance — reading everything (D7, D9)', () => {
  it('pages past 1,000 assignments, ordered by id', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => assignment(i))
    const page2 = [1000, 1001, 1002].map((i) => assignment(i))
    const db = fakeDb({ assignmentPages: [page1, page2] })
    createServerClient.mockReturnValue(db)
    const body = await (await GET(get(PERIOD))).json()
    expect(body.rows).toHaveLength(1003)
    expect(body.summary.total).toBe(1003)
    const qs = listQueries(db, 'shift_assignments')
    expect(qs.map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
    for (const q of qs) expect(op(q, 'order', 'id')).toEqual(['order', 'id', { ascending: true }])
  })

  it('reads the events in chunks of at most 100 assignment ids, ordered and paged', async () => {
    const db = fakeDb({ assignmentPages: [Array.from({ length: 250 }, (_, i) => assignment(i))] })
    createServerClient.mockReturnValue(db)
    await GET(get(PERIOD))
    const qs = listQueries(db, 'staff_attendance_events')
    expect(qs.map((q) => op(q, 'in', 'matched_assignment_id')[2].length)).toEqual([100, 100, 50])
    for (const q of qs) {
      expect(op(q, 'in', 'match_outcome')).toEqual(['in', 'match_outcome', ['matched', 'already_stamped']])
      expect(op(q, 'order', 'id')).toEqual(['order', 'id', { ascending: true }])
      expect(q.range).toEqual([0, 999])
    }
  })

  it('no assignments: no events read', async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    const body = await (await GET(get(PERIOD))).json()
    expect(body).toMatchObject({ success: true, rows: [], warnings: [] })
    expect(listQueries(db, 'staff_attendance_events')).toEqual([])
  })

  it('a location with no timezone is judged in Dublin, not UTC', async () => {
    const db = fakeDb({ location: { ...LOCATION, timezone: null }, assignmentPages: [[assignment(1)]] })
    createServerClient.mockReturnValue(db)
    const body = await (await GET(get(PERIOD))).json()
    expect(body.rows[0].scheduled_at).toBe('2026-07-15T06:00:00.000Z')
    expect(body.location).toEqual({ id: LOC, name: 'Studio One', timezone: 'Europe/Dublin' })
  })

  it('lateness is measured from the adjusted start (D1, end to end)', async () => {
    const a = assignment(1, {
      start_time_override: '08:00:00', arrived_at: '2026-07-15T06:50:00Z', arrival_source: 'geofence',
      block: { id: 'blk-1', location_id: LOC, block_date: '2026-07-15', start_time: '07:00:00', end_time: '10:00:00' },
    })
    const db = fakeDb({ assignmentPages: [[a]] })
    createServerClient.mockReturnValue(db)
    const body = await (await GET(get(PERIOD))).json()
    expect(body.rows[0]).toMatchObject({
      status: 'on_time', minutes_late: -10, scheduled_start: '07:00:00',
      effective_start: '08:00:00', start_adjusted: true, sources: ['geofence'],
    })
  })
})

describe('GET /api/attendance — failures are never an answer (D8)', () => {
  it('a failed location read is a logged 500, not "not found"', async () => {
    const db = fakeDb({ locationError: { message: 'timeout' } })
    createServerClient.mockReturnValue(db)
    const res = await GET(get(PERIOD))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load the attendance report. Try again.' })
    expect(logError).toHaveBeenCalledWith('attendance', expect.stringContaining('location'), expect.objectContaining({ error: 'timeout' }))
    expect(listQueries(db, 'shift_assignments')).toEqual([])
  })

  it('an unknown location is 404', async () => {
    createServerClient.mockReturnValue(fakeDb({ location: null }))
    expect((await GET(get(PERIOD))).status).toBe(404)
  })

  it('a failed assignments read is a logged 500 that does not leak the database message', async () => {
    createServerClient.mockReturnValue(fakeDb({ assignmentsError: { message: 'relation "secret_table" does not exist' } }))
    const res = await GET(get(PERIOD))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not load the attendance report. Try again.' })
    expect(logError).toHaveBeenCalledWith('attendance', expect.stringContaining('assignments'), expect.objectContaining({ error: expect.stringContaining('secret_table') }))
  })

  it('a failed events read keeps the report, says so, and logs it', async () => {
    const a = assignment(1, { arrived_at: '2026-07-15T05:58:00Z', arrival_source: 'geofence' })
    createServerClient.mockReturnValue(fakeDb({ assignmentPages: [[a]], eventsError: { message: 'boom' } }))
    const res = await GET(get(PERIOD))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warnings).toEqual(['sources_unavailable'])
    expect(body.rows[0]).toMatchObject({ status: 'on_time', sources: ['geofence'] })
    expect(logError).toHaveBeenCalledWith('attendance', expect.stringContaining('events'), expect.objectContaining({ error: 'boom' }))
  })

  it('a clean read has no warnings and logs nothing', async () => {
    const a = assignment(1, { arrived_at: '2026-07-15T05:58:00Z' })
    createServerClient.mockReturnValue(fakeDb({
      assignmentPages: [[a]], events: [{ id: 'e1', matched_assignment_id: a.id, source: 'unifi_access' }],
    }))
    const body = await (await GET(get(PERIOD))).json()
    expect(body.warnings).toEqual([])
    expect(body.rows[0].sources).toEqual(['unifi_access'])
    expect(logError).not.toHaveBeenCalled()
  })
})
