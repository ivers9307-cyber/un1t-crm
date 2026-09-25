// ROSTER-FIX.2 — integrity tests for POST /api/schedule/time-off.
//
// The POST used to accept overlapping requests from the same person, count
// weekends against a holiday allowance, and write one row for a range that
// straddles 31 December (so the second year's allowance never saw it).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: vi.fn((u) => (u?.locations ? u.locations.map((l) => l.id) : ['loc-1'])),
    assertLocationAccess: vi.fn(() => null),
    // SCHEDROLES.1 — REAL: GET scopes by the role at each studio.
    hasRoleAtLocation: real.hasRoleAtLocation,
  }
})
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
// LEAVEPHONE.1 — observed, not silenced for its own sake: who writes the
// no-holiday-list warning (the POST) and who must not (the preview).
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET, POST } = await import('./route.js')

const { fakeDb, queriesOf, resolveLocations, scopedAssignments, locationScopeOf } = await import('@/lib/time-off.test-helpers')
const { notifyUsersOnce } = await import('@/lib/push-dedup')
const { hasPermissionForLocation } = await import('@/lib/permissions')
const { logWarn, logError } = await import('@/lib/log')

function req(body) {
  return { url: 'http://x/api/schedule/time-off', json: () => Promise.resolve(body), headers: { get: () => '' } }
}

// LEAVE.2 — the POST now also reads the subject's employment type, their
// studios, the contract entitlement and (on notify) the approver set.
function buildDb({
  overlapping = [], overlappingError = null,
  allowance = null, allowanceByYear = null,
  pendingHoliday = [], pendingError = null,
  employmentType = 'fte',
  entitlement = null,
  subjectLocations = ['loc-1'],
  approverLinks = [],
  assignments = [],
  approveError = null,
  country = 'IE',
  customHolidays = [], holidaysError = null,
}) {
  const insertSpy = vi.fn()
  const updateSpy = vi.fn()
  let inserted = []
  const db = fakeDb((q) => {
    const cols = (q.columns || '').replace(/\s/g, '')
    if (q.table === 'staff_allowances') {
      return { data: allowanceByYear ? (allowanceByYear[q.eq.year] ?? null) : allowance, error: null }
    }
    if (q.table === 'profiles') return { data: { employment_type: employmentType }, error: null }
    if (q.table === 'profile_compensation') {
      return { data: entitlement == null ? null : { annual_leave_entitlement: entitlement }, error: null }
    }
    if (q.table === 'profile_locations') {
      // approver lookup selects role + permissions; membership reads location_id only
      if (cols.includes('permissions')) return { data: approverLinks, error: null }
      return { data: subjectLocations.map((location_id) => ({ location_id })), error: null }
    }
    if (q.table === 'location_role_permissions') return { data: [], error: null }
    // HOLIDAYLEAVE.1 — `locations` is read two ways: the approver lookup lists
    // features (awaited, a list) and getNonWorkingDates reads one studio's
    // country (.maybeSingle()).
    if (q.table === 'locations') {
      return q.terminal === 'maybeSingle' ? { data: { country }, error: null } : { data: [], error: null }
    }
    if (q.table === 'location_holidays') return { data: holidaysError ? null : customHolidays, error: holidaysError }
    if (q.table === 'shift_assignments') return { data: assignments, error: null }
    if (q.table === 'time_off_requests') {
      if (q.action === 'insert') {
        insertSpy(q.payload)
        inserted = q.payload.map((r, i) => ({ id: `row-${i + 1}`, ...r }))
        return { data: inserted, error: null }
      }
      if (q.action === 'update') {
        updateSpy(q.payload)
        return approveError ? { data: null, error: approveError } : { data: inserted.map((r) => ({ ...r, ...q.payload })), error: null }
      }
      // The holiday allowance check reads only total_days; everything
      // else selected here is the overlap probe.
      if (cols === 'total_days') return { data: pendingError ? null : pendingHoliday, error: pendingError }
      return { data: overlappingError ? null : overlapping, error: overlappingError }
    }
    throw new Error(q.table)
  })
  return { db, insertSpy, updateSpy }
}

const USER = { id: 'c', role: 'staff', profileRole: 'staff', full_name: 'Coach', activeLocation: { id: 'loc-1' }, locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'staff' } }

beforeEach(() => {
  createServerClient.mockReset(); getCurrentUser.mockReset(); notifyUsersOnce.mockClear()
  hasPermissionForLocation.mockImplementation(() => true)
})

describe('POST /api/schedule/time-off — request integrity', () => {
  it('409 when the range overlaps the caller\'s existing pending request', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({
      overlapping: [{ id: 'old', start_date: '2026-06-02', end_date: '2026-06-04', status: 'pending', type: 'holiday' }],
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-07' }))
    expect(res.status).toBe(409)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('a Mon-Sun holiday counts 5 working days', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-08', end_date: '2026-06-14' }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy).toHaveBeenCalledWith([expect.objectContaining({ total_days: 5 })])
  })

  it('400 when the range has no working days for a holiday', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-06', end_date: '2026-06-07' }))
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('a 30 Dec → 2 Jan range is split into one row per year, in ONE insert', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'sick', start_date: '2026-12-30', end_date: '2027-01-02' }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy).toHaveBeenCalledWith([
      expect.objectContaining({ start_date: '2026-12-30', end_date: '2026-12-31' }),
      expect.objectContaining({ start_date: '2027-01-01', end_date: '2027-01-02' }),
    ])
    const body = await res.json()
    expect(body.data.start_date).toBe('2026-12-30')
    expect(body.data_all).toHaveLength(2)
  })

  it('400 for a date the calendar does not have, before anything is written', async () => {
    // SCHEDHYGIENE.1 — the pattern alone let 2026-02-30 through; V8 rolled it
    // to 2 March for the day count and Postgres refused it at insert.
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    for (const [start_date, end_date] of [['2026-02-30', '2026-03-06'], ['2026-02-23', '2026-02-30'], ['2026-13-01', '2026-13-02']]) {
      const res = await POST(req({ type: 'holiday', start_date, end_date }))
      expect(res.status).toBe(400)
    }
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('400 when the range is longer than a year', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'unpaid', start_date: '2026-01-01', end_date: '2027-06-01' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Time-off requests are limited to one year')
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('500 (no insert) when the overlap guard query fails', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({ overlappingError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-05' }))
    expect(res.status).toBe(500)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('400 when the SECOND year of a straddling holiday has no allowance left', async () => {
    getCurrentUser.mockResolvedValue(USER)
    // 28-31 Dec 2026 = 4 working days against 20; 1-8 Jan 2027 = 5 working
    // days (Fri 1 Jan is a bank holiday) against 1. Charging the whole range to
    // the first year would pass.
    const { db, insertSpy } = buildDb({
      allowanceByYear: {
        2026: { total_days: 20, carried_over: 0, used_days: 0 },
        2027: { total_days: 1, carried_over: 0, used_days: 0 },
      },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-12-28', end_date: '2027-01-08' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Insufficient holiday balance/)
    expect(insertSpy).not.toHaveBeenCalled()
  })
})

// HOLIDAYLEAVE.1 — a bank holiday, or a day the studio is closed, inside a
// holiday request costs no allowance.
// LEAVEDAYS.1 — the pending sum moved into getPendingHolidayDays so the
// allowances GET can report the same number the refusal is judged on. These pin
// the refusal itself across that move.
describe('POST /api/schedule/time-off — pending holiday requests count against the balance', () => {
  it('3 remaining with 2 pending: a 2-day request is refused, naming the NET figure', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({
      allowance: { total_days: 20, used_days: 17, carried_over: 0 },
      pendingHoliday: [{ total_days: 2 }],
    })
    createServerClient.mockReturnValue(db)
    // Fri 12 Jun to Mon 15 Jun: 2 working days.
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-12', end_date: '2026-06-15' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Insufficient holiday balance. You have 1 days remaining (including pending requests).')
    expect(insertSpy).not.toHaveBeenCalled()
    const pendingRead = db.queries.find((q) => q.table === 'time_off_requests' && q.columns === 'total_days')
    expect(pendingRead.eq).toEqual({ profile_id: 'c', type: 'holiday', status: 'pending' })
    expect(pendingRead.calls).toContainEqual(['gte', 'start_date', '2026-01-01'])
    expect(pendingRead.calls).toContainEqual(['lte', 'start_date', '2026-12-31'])
  })

  it('the same request fits once nothing is pending', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db } = buildDb({ allowance: { total_days: 20, used_days: 17, carried_over: 0 } })
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ type: 'holiday', start_date: '2026-06-12', end_date: '2026-06-15' }))).status).toBe(201)
  })

  it('500 (no insert) when the pending read fails: an unreadable sum is not "nothing pending"', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({ pendingError: { message: 'down' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-12', end_date: '2026-06-15' }))
    expect(res.status).toBe(500)
    expect(insertSpy).not.toHaveBeenCalled()
  })
})

describe('POST /api/schedule/time-off — bank holidays are not charged', () => {
  it('Mon 1 Jun (June Public Holiday) to Sun 7 Jun is 4 days, not 5', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-07' }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledWith([expect.objectContaining({ total_days: 4 })])
  })

  it('the studio\'s own closure is not charged either, and is read for THAT studio over the requested range', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({ customHolidays: [{ date: '2026-06-10', name: 'Studio closed' }] })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-08', end_date: '2026-06-14' }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledWith([expect.objectContaining({ total_days: 4 })])
    const closures = queriesOf(db, 'location_holidays')[0]
    expect(closures.eq).toEqual({ location_id: 'loc-1' })
    expect(closures.calls).toContainEqual(['gte', 'date', '2026-06-08'])
    expect(closures.calls).toContainEqual(['lte', 'date', '2026-06-14'])
  })

  it('the balance check uses the working-day count: 4 days fit a 4-day balance', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({ entitlement: 4 })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-05' }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })

  it('a holiday that is ONLY a bank holiday is refused: nothing to take', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-01' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('No working days in that range')
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('follows the studio\'s country: 1 Jun is an ordinary Monday in the UK', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({ country: 'GB' })
    createServerClient.mockReturnValue(db)
    await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-07' }))
    expect(insertSpy).toHaveBeenCalledWith([expect.objectContaining({ total_days: 5 })])
  })

  it('sick leave still counts calendar days and never reads the holiday list', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    await POST(req({ type: 'sick', start_date: '2026-06-01', end_date: '2026-06-07' }))
    expect(insertSpy).toHaveBeenCalledWith([expect.objectContaining({ total_days: 7 })])
    expect(queriesOf(db, 'location_holidays')).toHaveLength(0)
  })

  it('500 and NO insert when the holiday list cannot be read: never charge blind', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({ holidaysError: { message: 'closures boom' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-05' }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('closures boom')
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('400 with no studio to file against: never counted blind, never a misleading balance error', async () => {
    // No location_id in the body and no active studio on the session.
    getCurrentUser.mockResolvedValue({ ...USER, activeLocation: null })
    for (const type of ['holiday', 'sick']) {
      // entitlement 1: had the count run (old Mon-Fri rule, 5 days) this would
      // have answered "Insufficient holiday balance" instead.
      const { db, insertSpy } = buildDb({ entitlement: 1 })
      createServerClient.mockReturnValue(db)
      const res = await POST(req({ type, start_date: '2026-06-01', end_date: '2026-06-05' }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('No studio to file this request against')
      expect(queriesOf(db, 'staff_allowances')).toHaveLength(0)
      expect(queriesOf(db, 'location_holidays')).toHaveLength(0)
      // It is judged before ANY read: nothing was asked of the database.
      expect(db.queries).toHaveLength(0)
      expect(insertSpy).not.toHaveBeenCalled()
    }
  })

  it('recording for a colleague with no studio is the same 400, not the approver 403', async () => {
    getCurrentUser.mockResolvedValue({ ...USER, id: 'hc', role: 'head_coach', activeLocation: null })
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-05', profile_id: '99999999-9999-4999-8999-999999999999' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('No studio to file this request against')
    expect(db.queries).toHaveLength(0)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('a year-straddling holiday: each year\'s row gets its own working-day count', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    // Mon 21 Dec 2026 - Fri 8 Jan 2027. 2026: 9 weekdays minus Fri 25 Dec = 8.
    // 2027: 6 weekdays minus Fri 1 Jan = 5.
    const res = await POST(req({ type: 'holiday', start_date: '2026-12-21', end_date: '2027-01-08' }))
    expect(res.status).toBe(201)
    expect(insertSpy.mock.calls[0][0].map((r) => [r.start_date, r.total_days])).toEqual([['2026-12-21', 8], ['2027-01-01', 5]])
  })
})

// SCHEDROLES.1 — what GET lists is decided by the role at each studio, not by
// `user.role` (the ACTIVE studio's). Head coach at loc-1, plain staff at loc-2.
describe('GET /api/schedule/time-off — role per studio (SCHEDROLES.1)', () => {
  // Records every filter the route puts on the time_off_requests query.
  // LEAVE.2 — profile_locations answers the member lookup (m1, m2).
  function listDb() {
    const db = fakeDb((q) => {
      if (q.table === 'profile_locations') return { data: [{ profile_id: 'm1' }, { profile_id: 'm2' }], error: null }
      return { data: [], error: null }
    })
    const calls = new Proxy([], { get: (t, k) => {
      const main = queriesOf(db, 'time_off_requests')[0]
      const arr = main ? main.calls : []
      const v = arr[k]
      return typeof v === 'function' ? v.bind(arr) : v
    } })
    return { calls, db }
  }
  const getReq = (qs = '') => ({ url: `http://x/api/schedule/time-off${qs}`, headers: { get: () => '' } })
  const mixed = (active) => ({
    id: 'mix', role: active === 'loc-1' ? 'head_coach' : 'staff', profileRole: 'staff',
    activeLocation: { id: active },
    locations: [{ id: 'loc-1' }, { id: 'loc-2' }],
    rolesByLocation: { 'loc-1': 'head_coach', 'loc-2': 'staff' },
  })

  it('at the studio where the caller is staff, lists only their own requests (wherever filed)', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const { db, calls } = listDb()
    createServerClient.mockReturnValue(db)
    expect((await GET(getReq('?location_id=loc-2'))).status).toBe(200)
    expect(calls).toContainEqual(['eq', 'profile_id', 'mix'])
    // LEAVE.2 — own leave covers the person, not the studio it was filed at.
    expect(calls.some((c) => c[1] === 'location_id')).toBe(false)
  })

  it('at the studio the caller manages, lists leave filed there OR taken by its members (and honours profile_id)', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    let { db, calls } = listDb()
    createServerClient.mockReturnValue(db)
    await GET(getReq('?location_id=loc-1'))
    expect(calls).toContainEqual(['or', 'location_id.in.(loc-1),profile_id.in.(m1,m2),profile_id.eq.mix'])
    expect(calls.some((c) => c[0] === 'eq' && c[1] === 'profile_id')).toBe(false)

    ;({ db, calls } = listDb())
    createServerClient.mockReturnValue(db)
    await GET(getReq('?location_id=loc-1&profile_id=someone'))
    expect(calls).toContainEqual(['eq', 'profile_id', 'someone'])
  })

  it('still lists everyone at the managed studio with the ACTIVE studio set to the staff one', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-2'))
    const { db, calls } = listDb()
    createServerClient.mockReturnValue(db)
    await GET(getReq('?location_id=loc-1'))
    expect(calls.some((c) => c[0] === 'eq' && c[1] === 'profile_id')).toBe(false)
  })

  it('with no location_id: leave at/for managed studios, plus their own', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-2'))
    const { db, calls } = listDb()
    createServerClient.mockReturnValue(db)
    await GET(getReq())
    expect(calls).toContainEqual(['or', 'location_id.in.(loc-1),profile_id.in.(m1,m2),profile_id.eq.mix'])
    expect(calls.some((c) => c[0] === 'eq' && c[1] === 'profile_id')).toBe(false)
  })

  it('a plain coach sees only their own; master sees every studio they hold', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'staff' } })
    let { db, calls } = listDb()
    createServerClient.mockReturnValue(db)
    await GET(getReq())
    expect(calls).toContainEqual(['eq', 'profile_id', 'c'])

    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [{ id: 'loc-1' }, { id: 'loc-2' }], rolesByLocation: {} })
    ;({ db, calls } = listDb())
    createServerClient.mockReturnValue(db)
    await GET(getReq())
    expect(calls).toContainEqual(['or', 'location_id.in.(loc-1,loc-2),profile_id.in.(m1,m2),profile_id.eq.boss'])
    expect(calls.some((c) => c[0] === 'eq' && c[1] === 'profile_id')).toBe(false)
  })

  it('status=pending excludes expired requests; status=expired asks for exactly them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'))
    try {
      getCurrentUser.mockResolvedValue(mixed('loc-1'))
      let { db, calls } = listDb()
      createServerClient.mockReturnValue(db)
      await GET(getReq('?location_id=loc-1&status=pending'))
      expect(calls).toContainEqual(['eq', 'status', 'pending'])
      expect(calls).toContainEqual(['gte', 'end_date', '2026-09-17'])

      ;({ db, calls } = listDb())
      createServerClient.mockReturnValue(db)
      await GET(getReq('?location_id=loc-1&status=expired'))
      expect(calls).toContainEqual(['eq', 'status', 'pending'])
      expect(calls).toContainEqual(['lt', 'end_date', '2026-09-17'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('annotates expired rows and, with with_clashes=1, the clash count', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'))
    try {
      getCurrentUser.mockResolvedValue(mixed('loc-1'))
      const rows = [
        { id: 'old', profile_id: 'm1', location_id: 'loc-1', status: 'pending', start_date: '2026-08-26', end_date: '2026-08-26' },
        { id: 'next', profile_id: 'm2', location_id: 'loc-1', status: 'approved', start_date: '2026-09-18', end_date: '2026-09-20' },
      ]
      const db = fakeDb((q) => {
        if (q.table === 'profile_locations') return { data: [{ profile_id: 'm1', location_id: 'loc-1' }, { profile_id: 'm2', location_id: 'loc-1' }], error: null }
        if (q.table === 'locations') return resolveLocations(q, { 'loc-1': 'org-1', 'loc-2': 'org-1' })
        if (q.table === 'shift_assignments') {
          return scopedAssignments(q, [
            { id: 'a', profile_id: 'm2', status: 'scheduled', shift_blocks: { block_date: '2026-09-19', location_id: 'loc-1' } },
            { id: 'b', profile_id: 'm2', status: 'cancelled', shift_blocks: { block_date: '2026-09-19', location_id: 'loc-1' } },
          ])
        }
        return { data: rows, error: null }
      })
      createServerClient.mockReturnValue(db)
      const json = await (await GET(getReq('?location_id=loc-1&with_clashes=1'))).json()
      const byId = Object.fromEntries(json.data.map((r) => [r.id, r]))
      expect(byId.old).toMatchObject({ expired: true, effective_status: 'expired' })
      expect(byId.old.clash_count).toBeUndefined()
      expect(byId.next).toMatchObject({ expired: false, effective_status: 'approved', clash_count: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  // ORGSCOPE.2 — m2 is also on staff at loc-x, another organisation's studio.
  it('with_clashes=1 never counts a coach\'s shifts at another organisation\'s studio', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'))
    try {
      getCurrentUser.mockResolvedValue(mixed('loc-1'))
      const rows = [{ id: 'next', profile_id: 'm2', location_id: 'loc-1', status: 'approved', start_date: '2026-09-18', end_date: '2026-09-20' }]
      const db = fakeDb((q) => {
        if (q.table === 'profile_locations') return { data: [{ profile_id: 'm2', location_id: 'loc-1' }, { profile_id: 'm2', location_id: 'loc-x' }], error: null }
        if (q.table === 'locations') return resolveLocations(q, { 'loc-1': 'org-1', 'loc-2': 'org-1', 'loc-x': 'org-x' })
        if (q.table === 'shift_assignments') {
          return scopedAssignments(q, [
            { id: 'a', profile_id: 'm2', status: 'scheduled', shift_blocks: { block_date: '2026-09-19', location_id: 'loc-1' } },
            { id: 'x', profile_id: 'm2', status: 'scheduled', shift_blocks: { block_date: '2026-09-19', location_id: 'loc-x' } },
          ])
        }
        return { data: rows, error: null }
      })
      createServerClient.mockReturnValue(db)
      const json = await (await GET(getReq('?location_id=loc-1&with_clashes=1'))).json()
      expect(json.data[0].clash_count).toBe(1)
      expect(locationScopeOf(queriesOf(db, 'shift_assignments')[0]).sort()).toEqual(['loc-1', 'loc-2'])
    } finally {
      vi.useRealTimers()
    }
  })
})

// LEAVE.2-5 — contractor types, first-request balance, approver notification,
// and recording leave on someone's behalf.
describe('POST /api/schedule/time-off — LEAVE.2', () => {
  const link = (profile_id, role, location_id = 'loc-1', extra = {}) => ({
    profile_id, location_id, role, permissions: {}, profiles: { id: profile_id, active: true, role: 'staff', employment_type: 'fte' }, ...extra,
  })

  it('400 when a contractor files holiday, sick, unpaid or other leave, pointing at My availability', async () => {
    getCurrentUser.mockResolvedValue(USER)
    for (const type of ['holiday', 'sick', 'unpaid', 'other']) {
      const { db, insertSpy } = buildDb({ employmentType: 'contractor' })
      createServerClient.mockReturnValue(db)
      const res = await POST(req({ type, start_date: '2026-06-01', end_date: '2026-06-02' }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/^Contractors.*My availability/)
      expect(insertSpy).not.toHaveBeenCalled()
    }
  })

  it('checks the balance on the FIRST holiday of the year, against the contract entitlement', async () => {
    getCurrentUser.mockResolvedValue(USER)
    // No allowance row; entitlement 3 days; Mon-Fri = 5 working days.
    let { db, insertSpy } = buildDb({ entitlement: 3 })
    createServerClient.mockReturnValue(db)
    let res = await POST(req({ type: 'holiday', start_date: '2026-06-08', end_date: '2026-06-12' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/3 days remaining/)
    expect(insertSpy).not.toHaveBeenCalled()

    // No entitlement recorded → 20, so the same week passes.
    ;({ db, insertSpy } = buildDb({ entitlement: null }))
    createServerClient.mockReturnValue(db)
    res = await POST(req({ type: 'holiday', start_date: '2026-06-08', end_date: '2026-06-12' }))
    expect(res.status).toBe(201)
  })

  it('notifies everyone who can approve time off (head coaches included), never the requester', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db } = buildDb({
      subjectLocations: ['loc-1', 'loc-2'],
      approverLinks: [
        link('owner-1', 'owner'),
        link('hc-1', 'head_coach'),
        link('hc-2', 'head_coach', 'loc-2'),
        link('staff-1', 'staff'),
        link('c', 'manager'),
        link('gone', 'manager', 'loc-1', { profiles: { id: 'gone', active: false, role: 'staff' } }),
      ],
    })
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ type: 'sick', start_date: '2026-06-01', end_date: '2026-06-01' }))).status).toBe(201)
    await vi.waitFor(() => expect(notifyUsersOnce).toHaveBeenCalled())
    const [, key, ids, payload] = notifyUsersOnce.mock.calls[0]
    expect(key).toBe('time_off_inbound:row-1')
    expect(ids.sort()).toEqual(['hc-1', 'hc-2', 'owner-1'])
    expect(payload.category).toBe('time_off')
    // The approver lookup covered BOTH of the requester's studios.
    const approverQuery = db.queries.find((q) => q.table === 'profile_locations' && (q.columns || '').includes('permissions'))
    expect(approverQuery.calls).toContainEqual(['in', 'location_id', ['loc-1', 'loc-2']])
  })

  describe('recording leave for a colleague', () => {
    // uuidLike-valid: the body is Zod-validated. location_id falls back to the
    // caller's active studio (loc-1).
    const COACH9 = '99999999-9999-4999-8999-999999999999'
    const HC = { id: 'hc', role: 'head_coach', profileRole: 'staff', full_name: 'Head', activeLocation: { id: 'loc-1' }, locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'head_coach' } }
    const body = (over = {}) => ({ type: 'sick', start_date: '2026-06-01', end_date: '2026-06-02', profile_id: COACH9, ...over })

    it('403 without the time-off approval permission at the studio', async () => {
      getCurrentUser.mockResolvedValue(HC)
      hasPermissionForLocation.mockImplementation(() => false)
      const { db, insertSpy } = buildDb({})
      createServerClient.mockReturnValue(db)
      expect((await POST(req(body()))).status).toBe(403)
      expect(insertSpy).not.toHaveBeenCalled()
    })

    it('404 when the person is not on that studio\'s staff', async () => {
      getCurrentUser.mockResolvedValue(HC)
      const { db, insertSpy } = buildDb({ subjectLocations: ['loc-2'] })
      createServerClient.mockReturnValue(db)
      expect((await POST(req(body()))).status).toBe(404)
      expect(insertSpy).not.toHaveBeenCalled()
    })

    it('inserts pending with created_by, then approves it (so the allowance trigger fires) and returns clashes', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-05-20T10:00:00Z'))
      try {
        getCurrentUser.mockResolvedValue(HC)
        const { db, insertSpy, updateSpy } = buildDb({
          assignments: [{ id: 'a1', profile_id: COACH9, status: 'scheduled', shift_blocks: { id: 'b1', block_date: '2026-06-01', location_id: 'loc-1' } }],
        })
        createServerClient.mockReturnValue(db)
        const res = await POST(req(body()))
        expect(res.status).toBe(201)
        expect(insertSpy).toHaveBeenCalledWith([expect.objectContaining({ profile_id: COACH9, status: 'pending', created_by: 'hc' })])
        expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved', reviewed_by: 'hc' }))
        const json = await res.json()
        expect(json.data.status).toBe('approved')
        expect(json.clashes.map((c) => c.id)).toEqual(['a1'])
        // The person is told; approvers are not asked to approve it.
        await vi.waitFor(() => expect(notifyUsersOnce).toHaveBeenCalled())
        expect(notifyUsersOnce.mock.calls[0][1]).toBe('time_off_recorded:row-1')
        expect(notifyUsersOnce.mock.calls[0][2]).toEqual([COACH9])
      } finally {
        vi.useRealTimers()
      }
    })

    it('applies the contractor and balance rules to the PERSON, not the caller', async () => {
      getCurrentUser.mockResolvedValue(HC)
      let { db, insertSpy } = buildDb({ employmentType: 'contractor' })
      createServerClient.mockReturnValue(db)
      const refused = await POST(req(body({ type: 'holiday' })))
      expect(refused.status).toBe(400)
      // AVAIL.3 review N8 — spoken about the contractor, not to the approver.
      const refusedError = (await refused.json()).error
      expect(refusedError).toMatch(/^Contractors.*My availability/)
      expect(refusedError).not.toMatch(/\byou\b|\byour\b/i)
      expect(insertSpy).not.toHaveBeenCalled()

      ;({ db, insertSpy } = buildDb({ entitlement: 1 }))
      createServerClient.mockReturnValue(db)
      const res = await POST(req(body({ type: 'holiday', start_date: '2026-06-08', end_date: '2026-06-09' })))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/They have 1 days remaining/)
      const staffAllowanceRead = queriesOf(db, 'staff_allowances')[0]
      expect(staffAllowanceRead.eq.profile_id).toBe(COACH9)
    })

    it('seeds the allowance from the entitlement before approving recorded holiday', async () => {
      getCurrentUser.mockResolvedValue(HC)
      const { db } = buildDb({ entitlement: 25 })
      createServerClient.mockReturnValue(db)
      expect((await POST(req(body({ type: 'holiday' })))).status).toBe(201)
      const seed = queriesOf(db, 'staff_allowances', 'insert')[0]
      expect(seed.payload).toMatchObject({ profile_id: COACH9, year: 2026, total_days: 25, used_days: 0 })
    })

    it('reports a failed approve as recorded-but-pending (500), not a clean failure', async () => {
      getCurrentUser.mockResolvedValue(HC)
      const { db } = buildDb({ approveError: { message: 'boom' } })
      createServerClient.mockReturnValue(db)
      const res = await POST(req(body()))
      expect(res.status).toBe(500)
      expect((await res.json()).error).toMatch(/Recorded as pending/)
    })
  })
})

// AVAIL.3 — "unavailable" moved into availability (mig 631). An old phone or a
// stale tab can still send it; the answer must say where to go, and nothing
// may be read or written first.
describe('POST /api/schedule/time-off — AVAIL.3: unavailable is refused', () => {
  const COACH9 = '99999999-9999-4999-8999-999999999999'
  const HC = { id: 'hc', role: 'head_coach', profileRole: 'staff', full_name: 'Head', activeLocation: { id: 'loc-1' }, locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'head_coach' } }

  it.each([
    ['a contractor, for themselves', USER, 'contractor', {}],
    ['an employee, for themselves', USER, 'fte', {}],
    ['an approver, on a contractor\'s behalf', HC, 'contractor', { profile_id: COACH9 }],
  ])('400 with the My availability message: %s', async (_label, who, employmentType, extra) => {
    getCurrentUser.mockResolvedValue(who)
    const { db, insertSpy } = buildDb({ employmentType })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'unavailable', start_date: '2026-10-03', end_date: '2026-10-05', ...extra }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({
      success: false,
      error: expect.stringMatching(/^Unavailable is no longer a time-off request\..*My availability/),
    })
    // Review N8 — "you can't work" only when the caller IS the person.
    if (extra.profile_id) expect(json.error).not.toMatch(/\byou\b|\byour\b/i)
    else expect(json.error).toMatch(/you can’t work/)
    expect(insertSpy).not.toHaveBeenCalled()
    // Refused before the database is even opened: no read, no write, no notice.
    expect(createServerClient).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('401 still comes first for a signed-out caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ type: 'unavailable', start_date: '2026-10-03', end_date: '2026-10-05' }))
    expect(res.status).toBe(401)
  })

  it('the type still parses, so the refusal (not "Invalid request body") is what an old phone sees', async () => {
    const { timeOffTypeSchema } = await import('@/lib/schemas')
    expect(timeOffTypeSchema.safeParse('unavailable').success).toBe(true)
  })
})

// LEAVEPHONE.1 — before filing, the coach's leave form asks the SERVER two
// things: how many days will this be charged, and which of MY shifts does it
// hit? Own rows only, published only, and the POST's own day count.
describe('GET /api/schedule/time-off?preview=1 — charged days + own published shifts', () => {
  const getReq = (qs) => ({ url: `http://x/api/schedule/time-off${qs}`, headers: { get: () => '' } })
  const asg = (id, profile_id, date, rosterStatus, extra = {}) => ({
    id, profile_id, status: 'scheduled', start_time_override: null, end_time_override: null,
    shift_blocks: {
      id: `b-${id}`, block_date: date, start_time: '06:00:00', end_time: '09:00:00', location_id: 'loc-1',
      rosters: { status: rosterStatus },
      shift_templates: { name: 'Morning', start_time: '06:00:00', end_time: '07:00:00' },
      locations: { name: 'Studio One' },
    },
    ...extra,
  })
  const MANAGER = { id: 'boss', role: 'manager', profileRole: 'staff', activeLocation: { id: 'loc-1' }, locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } }

  // Only the three tables the preview may read. Anything else — above all the
  // request list the old GET runs — throws.
  function previewDb({ shifts = [], shiftsError = null, closures = [], closuresError = null } = {}) {
    return fakeDb((q) => {
      if (q.table === 'shift_assignments') return { data: shiftsError ? null : shifts, error: shiftsError }
      if (q.table === 'locations') return { data: { country: 'IE' }, error: null }
      if (q.table === 'location_holidays') return { data: closuresError ? null : closures, error: closuresError }
      throw new Error(`preview must not read ${q.table}`)
    })
  }

  it('returns an OBJECT: the days the POST would charge (bank holiday excluded) and the published, live clashes with effective times', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-05-20T10:00:00Z'))
    try {
      getCurrentUser.mockResolvedValue(USER)
      const db = previewDb({ shifts: [
        asg('a1', 'c', '2026-06-02', 'published', { start_time_override: '06:30:00' }),
        asg('a2', 'c', '2026-06-03', 'draft'),
        asg('a3', 'c', '2026-06-04', 'published', { status: 'cancelled' }),
        asg('a4', 'c', '2026-06-05', 'published', { status: 'swapped' }),
      ] })
      createServerClient.mockReturnValue(db)
      // Mon 1 Jun 2026 is the June Public Holiday: Mon-Sun is 4 days, not 5.
      const res = await GET(getReq('?preview=1&type=holiday&start_date=2026-06-01&end_date=2026-06-07'))
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(Array.isArray(json.data)).toBe(false)
      expect(json.data).toEqual({
        type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-07',
        days: { total: 4, segments: [{ year: 2026, start_date: '2026-06-01', end_date: '2026-06-07', days: 4 }] },
        clashes: [
          { id: 'a1', block_date: '2026-06-02', start_time: '06:30:00', end_time: '09:00:00', template_name: 'Morning', location_name: 'Studio One' },
          { id: 'a4', block_date: '2026-06-05', start_time: '06:00:00', end_time: '09:00:00', template_name: 'Morning', location_name: 'Studio One' },
        ],
      })
    } finally { vi.useRealTimers() }
  })

  it('AGREES WITH THE POST — same input, same number, closure and year split included', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const closures = [{ date: '2026-12-30', name: 'Studio closed' }]
    createServerClient.mockReturnValue(previewDb({ closures }))
    // Neither call names a studio, so both fall back to USER.activeLocation —
    // the POST's targetLocation rule and the preview's are the same rule.
    const preview = (await (await GET(getReq('?preview=1&type=holiday&start_date=2026-12-28&end_date=2027-01-05'))).json()).data.days

    const { db, insertSpy } = buildDb({ customHolidays: closures })
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ type: 'holiday', start_date: '2026-12-28', end_date: '2027-01-05' }))).status).toBe(201)
    const inserted = insertSpy.mock.calls[0][0]
    expect(preview.segments.map((s) => s.days)).toEqual(inserted.map((r) => r.total_days))
    expect(preview.segments.map((s) => [s.start_date, s.end_date])).toEqual(inserted.map((r) => [r.start_date, r.end_date]))
    expect(preview.total).toBe(inserted.reduce((n, r) => n + r.total_days, 0))
    // Guard against agreeing on a trivial number: 28, 29, 31 Dec (30th closed) + 4, 5 Jan (1st is New Year's Day).
    expect(preview.segments.map((s) => s.days)).toEqual([3, 2])
  })

  it('AGREES WITH THE POST on a non-holiday type too (calendar days, year split)', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(previewDb())
    const preview = (await (await GET(getReq('?preview=1&type=sick&start_date=2026-12-30&end_date=2027-01-02'))).json()).data.days
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ type: 'sick', start_date: '2026-12-30', end_date: '2027-01-02' }))).status).toBe(201)
    expect(preview.segments.map((s) => s.days)).toEqual(insertSpy.mock.calls[0][0].map((r) => r.total_days))
    expect(preview.segments.map((s) => s.days)).toEqual([2, 2])
  })

  it('a range the POST would refuse as "No working days" previews as 0, not an error', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(previewDb())
    // Sat 6 + Sun 7 Jun 2026. The form shows "No working days in that range".
    const json = await (await GET(getReq('?preview=1&type=holiday&start_date=2026-06-06&end_date=2026-06-07'))).json()
    expect(json.success).toBe(true)
    expect(json.data.days.total).toBe(0)
  })

  it('counts for the studio the POST would file at: location_id, else the active studio', async () => {
    getCurrentUser.mockResolvedValue(USER)
    let db = previewDb(); createServerClient.mockReturnValue(db)
    await GET(getReq('?preview=1&type=holiday&start_date=2099-06-01&end_date=2099-06-05'))
    expect(queriesOf(db, 'location_holidays')[0].eq).toEqual({ location_id: 'loc-1' })   // USER.activeLocation

    getCurrentUser.mockResolvedValue({ ...USER, locations: [{ id: 'loc-1' }, { id: 'loc-2' }] })
    db = previewDb(); createServerClient.mockReturnValue(db)
    await GET(getReq('?preview=1&type=holiday&start_date=2099-06-01&end_date=2099-06-05&location_id=loc-2'))
    expect(queriesOf(db, 'location_holidays')[0].eq).toEqual({ location_id: 'loc-2' })
  })

  it('400 with no studio, exactly like the POST — and before ANY read', async () => {
    getCurrentUser.mockResolvedValue({ ...USER, activeLocation: null })
    const db = fakeDb(() => { throw new Error('must not query') })
    createServerClient.mockReturnValue(db)
    for (const type of ['holiday', 'sick']) {
      const res = await GET(getReq(`?preview=1&type=${type}&start_date=2099-06-01&end_date=2099-06-05`))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('No studio to file this request against')
    }
    expect(db.queries).toHaveLength(0)
  })

  it('a location_id outside the caller\'s studios is refused by the location guard before the preview runs', async () => {
    const { assertLocationAccess } = await import('@/lib/auth')
    const { NextResponse } = await import('next/server')
    getCurrentUser.mockResolvedValue(USER)
    const db = fakeDb(() => { throw new Error('must not query') })
    createServerClient.mockReturnValue(db)
    assertLocationAccess.mockReturnValueOnce(NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }))
    const res = await GET(getReq('?preview=1&type=holiday&start_date=2099-06-01&end_date=2099-06-05&location_id=not-mine'))
    expect(res.status).toBe(403)
    expect(db.queries).toHaveLength(0)
  })

  // The case above mocks the guard, so it proves ORDER (no read before it).
  // This one runs the REAL assertLocationAccess (the same importOriginal route
  // this file already takes for hasRoleAtLocation), so it proves the refusal.
  it('the REAL location guard refuses a studio the caller does not belong to, and allows one they do', async () => {
    const real = await vi.importActual('@/lib/auth')
    const { assertLocationAccess } = await import('@/lib/auth')
    getCurrentUser.mockResolvedValue(USER)   // belongs to loc-1 only

    assertLocationAccess.mockImplementationOnce(real.assertLocationAccess)
    const denied = fakeDb(() => { throw new Error('must not query') })
    createServerClient.mockReturnValue(denied)
    const res = await GET(getReq('?preview=1&type=holiday&start_date=2099-06-01&end_date=2099-06-05&location_id=loc-2'))
    expect(res.status).toBe(403)
    expect(denied.queries).toHaveLength(0)

    assertLocationAccess.mockImplementationOnce(real.assertLocationAccess)
    createServerClient.mockReturnValue(previewDb())
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2099-06-01&end_date=2099-06-05&location_id=loc-1'))).status).toBe(200)
  })

  it('a non-holiday type counts calendar days and never reads the holiday lists', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const db = previewDb(); createServerClient.mockReturnValue(db)
    const json = await (await GET(getReq('?preview=1&type=unavailable&start_date=2099-06-01&end_date=2099-06-07'))).json()
    expect(json.data.days.total).toBe(7)
    expect(queriesOf(db, 'location_holidays')).toHaveLength(0)
  })

  it('ignores profile_id — a manager previews their OWN shifts, never a colleague\'s', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    // Even if the roster read handed back a colleague's row, it is dropped.
    const db = previewDb({ shifts: [asg('theirs', 'someone-else', '2099-10-06', 'published')] })
    createServerClient.mockReturnValue(db)
    const json = await (await GET(getReq('?preview=1&type=holiday&start_date=2099-10-05&end_date=2099-10-09&profile_id=someone-else&location_id=loc-1'))).json()
    const q = queriesOf(db, 'shift_assignments')[0]
    expect(q.calls).toContainEqual(['in', 'profile_id', ['boss']])
    expect(JSON.stringify(q.calls)).not.toContain('someone-else')
    expect(json.data.clashes).toEqual([])
  })

  it('400 on an unknown type, missing or malformed dates, an inverted range, and a span over a year', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(previewDb())
    expect((await GET(getReq('?preview=1&start_date=2026-10-05&end_date=2026-10-09'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=sabbatical&start_date=2026-10-05&end_date=2026-10-09'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=holiday'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=holiday&start_date=05/10/2026&end_date=2026-10-09'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2026-10-09&end_date=2026-10-05'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2026-13-45&end_date=2026-13-46'))).status).toBe(400)
    // 30 Feb fits the pattern and V8 rolls it over to 2 Mar: a nonsense count, not a 500.
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2026-02-30&end_date=2026-03-06'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2026-02-23&end_date=2026-02-30'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=sick&start_date=2026-04-31'))).status).toBe(400)
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2026-01-01&end_date=2028-01-01'))).status).toBe(400)
  })

  it('end_date defaults to start_date (a one-tap, single-day pick)', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(previewDb())
    const json = await (await GET(getReq('?preview=1&type=sick&start_date=2099-10-05'))).json()
    expect(json.data).toMatchObject({ start_date: '2099-10-05', end_date: '2099-10-05', days: { total: 1 }, clashes: [] })
  })

  it('500 when the holiday list OR the roster cannot be read — never a guessed number, never "no clashes"', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(previewDb({ closuresError: { message: 'boom' } }))
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2099-10-05&end_date=2099-10-09'))).status).toBe(500)
    createServerClient.mockReturnValue(previewDb({ shiftsError: { message: 'boom' } }))
    const res = await GET(getReq('?preview=1&type=holiday&start_date=2099-10-05&end_date=2099-10-09'))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  it('a year with no national holiday list: the PREVIEW writes no warning, the POST still writes exactly one', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(previewDb())
    logWarn.mockClear()
    const res = await GET(getReq('?preview=1&type=holiday&start_date=2099-06-01&end_date=2099-06-05'))
    expect(res.status).toBe(200)
    expect(logWarn).not.toHaveBeenCalled()

    const { db } = buildDb({})
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ type: 'holiday', start_date: '2099-06-01', end_date: '2099-06-05' }))).status).toBe(201)
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith('time-off', expect.stringMatching(/no national bank-holiday list/i), expect.objectContaining({ years: [2099] }))
  })

  it('401 without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq('?preview=1&type=holiday&start_date=2099-10-05'))).status).toBe(401)
  })

  it('without preview=1 the GET is still the request LIST (an array) — the shape an OTA\'d phone tells apart', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(fakeDb((q) => {
      if (q.table === 'time_off_requests') return { data: [], error: null }
      throw new Error(q.table)
    }))
    const json = await (await GET(getReq('?type=holiday&start_date=2099-10-05&end_date=2099-10-09'))).json()
    expect(Array.isArray(json.data)).toBe(true)
  })
})

// LEAVECANCEL.1 — the list tells the screen where a cancellation request
// stands and what THIS caller may do about it; the leave itself stays approved.
describe('GET /api/schedule/time-off — cancel-request annotations (LEAVECANCEL.1)', () => {
  const getReq = (qs = '') => ({ url: `http://x/api/schedule/time-off${qs}`, headers: { get: () => '' } })
  const at = (id, role) => ({
    id, role, profileRole: 'staff', activeLocation: { id: 'loc-1' },
    locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': role },
  })
  const OPEN = { cancel_requested_at: '2026-09-16T09:00:00Z', cancel_requested_by: 'mgr', cancel_decided_at: null, cancel_decision: null }
  const ROWS = [
    { id: 'asked', profile_id: 'mgr', location_id: 'loc-1', status: 'approved', start_date: '2026-10-05', end_date: '2026-10-07', ...OPEN },
    { id: 'plain', profile_id: 'mgr', location_id: 'loc-1', status: 'approved', start_date: '2026-11-02', end_date: '2026-11-03', cancel_requested_at: null, cancel_decided_at: null },
  ]
  const listDb = () => fakeDb((q) => {
    if (q.table === 'profile_locations') return { data: [{ profile_id: 'mgr', location_id: 'loc-1' }], error: null }
    return { data: ROWS, error: null }
  })
  const byId = async (user) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'))
    try {
      getCurrentUser.mockResolvedValue(user)
      createServerClient.mockReturnValue(listDb())
      const json = await (await GET(getReq('?location_id=loc-1'))).json()
      return Object.fromEntries(json.data.map((r) => [r.id, r]))
    } finally {
      vi.useRealTimers()
    }
  }

  it('the requester: the asked row is still APPROVED, shows as open, and offers Withdraw; their other leave offers the ask', async () => {
    const rows = await byId(at('mgr', 'manager'))
    expect(rows.asked).toMatchObject({ status: 'approved', effective_status: 'approved', cancel_request_state: 'open', can_withdraw_cancel: true, can_request_cancel: false, can_decide_cancel: false })
    expect(rows.plain).toMatchObject({ cancel_request_state: null, can_request_cancel: true, cancel_needs_owner: true, can_withdraw_cancel: false })
  })

  it('reads who DECIDED a cancellation, so a cancelled row can say "approved by <name>"', async () => {
    getCurrentUser.mockResolvedValue(at('mgr', 'manager'))
    const db = listDb()
    createServerClient.mockReturnValue(db)
    await GET(getReq('?location_id=loc-1'))
    expect(queriesOf(db, 'time_off_requests')[0].columns.replace(/\s/g, '')).toContain('cancel_decider:profiles!cancel_decided_by(id,full_name)')
  })

  it('an owner may decide it; another manager sees it is open and is offered nothing', async () => {
    expect((await byId(at('own', 'owner'))).asked).toMatchObject({ cancel_request_state: 'open', can_decide_cancel: true, can_withdraw_cancel: false })
    const seenByManager = (await byId(at('mgr-2', 'manager'))).asked
    expect(seenByManager).toMatchObject({ cancel_request_state: 'open', can_decide_cancel: false, can_withdraw_cancel: false, can_request_cancel: false })
  })
})

// LEAVECANCEL.1 (review) — the list embeds cancel_decider through mig 624's FK.
// Code that reaches prod BEFORE the migration (a Vercel preview of the branch,
// an ordering slip) must turn the new feature off, never the leave list: this
// GET feeds the Time Off page, the web roster's approved-leave read, and the
// phone's My leave, Schedule tab and Studio list.
describe('GET /api/schedule/time-off — before mig 624 is applied (LEAVECANCEL.1)', () => {
  const getReq = (qs = '') => ({ url: `http://x/api/schedule/time-off${qs}`, headers: { get: () => '' } })
  const MANAGER = { id: 'mgr', role: 'manager', profileRole: 'staff', activeLocation: { id: 'loc-1' }, locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } }
  const ROWS = [{ id: 'own', profile_id: 'mgr', location_id: 'loc-1', status: 'approved', start_date: '2026-10-05', end_date: '2026-10-07' }]
  const EMBED_MISSING = {
    code: 'PGRST200',
    message: "Could not find a relationship between 'time_off_requests' and 'profiles' in the schema cache",
    details: "Searched for a foreign key relationship between 'time_off_requests' and 'profiles' using the hint 'cancel_decided_by' in the schema 'public', but no matches were found.",
  }
  const listDb = (firstError) => fakeDb((q) => {
    if (q.table === 'profile_locations') return { data: [{ profile_id: 'mgr', location_id: 'loc-1' }], error: null }
    const cols = (q.columns || '').replace(/\s/g, '')
    if (q.table === 'time_off_requests' && cols.includes('cancel_decider')) return { data: null, error: firstError }
    return { data: ROWS, error: null }
  })
  const run = async (firstError) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'))
    try {
      logError.mockClear()
      getCurrentUser.mockResolvedValue(MANAGER)
      const db = listDb(firstError)
      createServerClient.mockReturnValue(db)
      const res = await GET(getReq('?location_id=loc-1&status=approved'))
      return { res, db }
    } finally {
      vi.useRealTimers()
    }
  }

  it('the embed hint is refused: retries ONCE without it, answers 200 with the rows and the feature off, and logs it', async () => {
    const { res, db } = await run(EMBED_MISSING)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.map((r) => r.id)).toEqual(['own'])
    // Feature off: nothing waiting, nothing offered (a button would only 503).
    expect(json.data[0]).toMatchObject({ status: 'approved', cancel_request_state: null, can_request_cancel: false, can_withdraw_cancel: false, can_decide_cancel: false })

    const [first, second, ...rest] = queriesOf(db, 'time_off_requests')
    expect(rest).toHaveLength(0)
    expect(first.columns.replace(/\s/g, '')).toContain('cancel_decider')
    expect(second.columns.replace(/\s/g, '')).not.toContain('cancel')
    // 🔴 The retry keeps EVERY filter: a fallback that dropped the scope would
    // hand a manager the estate's leave.
    expect(second.calls).toEqual(first.calls)
    expect(second.calls).toContainEqual(['or', 'location_id.in.(loc-1),profile_id.in.(mgr),profile_id.eq.mgr'])
    expect(second.calls).toContainEqual(['eq', 'status', 'approved'])

    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][0]).toBe('time-off')
    expect(logError.mock.calls[0][1]).toMatch(/mig 624/)
    expect(logError.mock.calls[0][2]).toMatchObject({ err: { code: 'PGRST200' } })
  })

  it('a missing column (42703) is the same class', async () => {
    const { res } = await run({ code: '42703', message: 'column time_off_requests.cancel_decided_by does not exist' })
    expect(res.status).toBe(200)
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('any OTHER error is unchanged: a 400, one query, no retry, nothing logged as a missing migration', async () => {
    for (const error of [
      { code: '57014', message: 'canceling statement due to statement timeout' },
      { code: 'PGRST200', message: "Could not find a relationship between 'time_off_requests' and 'profiles'", details: "using the hint 'reviewed_by'" },
    ]) {
      const { res, db } = await run(error)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(error.message)
      expect(queriesOf(db, 'time_off_requests')).toHaveLength(1)
      expect(logError).not.toHaveBeenCalled()
    }
  })
})

// LEAVEGUARD.1 — the list says, per row, whether THIS caller may take a
// colleague's approved leave out of force. `approved_locked_to_owner: true` is
// a manager-tier person's approved leave seen by someone who is not an owner
// at a studio it belongs to (nor a master), or a master's approved leave seen
// by anyone but another master. Judged by the same functions the PUT refuses
// with (requesterLeaveTier + approvedLeaveGuardAllows).
describe('GET /api/schedule/time-off — approved_locked_to_owner (LEAVEGUARD.1)', () => {
  const getReq = (qs = '') => ({ url: `http://x/api/schedule/time-off${qs}`, headers: { get: () => '' } })
  const at = (id, role) => ({
    id, role, profileRole: 'staff', activeLocation: { id: 'loc-1' },
    locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': role },
  })
  const MASTER = { id: 'boss', role: 'master', profileRole: 'master', locations: [{ id: 'loc-1' }], rolesByLocation: {} }
  const row = (id, profile_id, status = 'approved', role = 'staff') => ({
    id, profile_id, location_id: 'loc-1', status, start_date: '2026-10-05', end_date: '2026-10-07',
    profiles: { id: profile_id, full_name: profile_id, role },
  })
  const ROWS = [
    row('mgr-approved', 'mgr'),
    row('mgr-pending', 'mgr', 'pending'),
    row('coach-approved', 'coach'),
    // Filed at loc-1 where they are staff; head coach at loc-2 (leave covers the person).
    row('hc-approved', 'hc'),
    row('own-approved', 'own'),
    // No studio rows: tier from the embedded profiles.role / an org grant.
    row('master-approved', 'boss-2', 'approved', 'master'),
    row('oa-approved', 'oa'),
  ]
  const MEMBERSHIPS = [
    { profile_id: 'mgr', location_id: 'loc-1', role: 'manager' },
    { profile_id: 'coach', location_id: 'loc-1', role: 'staff' },
    { profile_id: 'hc', location_id: 'loc-1', role: 'staff' },
    { profile_id: 'hc', location_id: 'loc-2', role: 'head_coach' },
    { profile_id: 'own', location_id: 'loc-1', role: 'owner' },
  ]
  const listDb = ({ membershipError = null, orgError = null } = {}) => fakeDb((q) => {
    const inIds = (col) => q.calls.find(([op, c]) => op === 'in' && c === col)?.[2] || []
    if (q.table === 'profile_locations') {
      const cols = (q.columns || '').replace(/\s/g, '')
      // The scope read (members of the managed studio) selects profile_id only.
      if (cols === 'profile_id') return { data: MEMBERSHIPS.map(({ profile_id }) => ({ profile_id })), error: null }
      if (membershipError) return { data: null, error: membershipError }
      return { data: MEMBERSHIPS.filter((m) => inIds('profile_id').includes(m.profile_id)), error: null }
    }
    if (q.table === 'profile_organizations') {
      if (orgError) return { data: null, error: orgError }
      return { data: inIds('profile_id').includes('oa') ? [{ profile_id: 'oa', organization_id: 'org-1', role: 'org_admin' }] : [], error: null }
    }
    if (q.table === 'locations') return { data: [{ id: 'loc-1', organization_id: 'org-1' }, { id: 'loc-2', organization_id: 'org-1' }], error: null }
    return { data: ROWS, error: null }
  })
  const run = async (user, opts) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'))
    try {
      logError.mockClear()
      getCurrentUser.mockResolvedValue(user)
      const db = listDb(opts)
      createServerClient.mockReturnValue(db)
      const res = await GET(getReq('?location_id=loc-1'))
      const json = await res.json()
      return { res, db, locked: Object.fromEntries(json.data.map((r) => [r.id, r.approved_locked_to_owner])) }
    } finally {
      vi.useRealTimers()
    }
  }

  it('a manager: manager-tier, org-admin and master leave is locked; pending and staff leave are not', async () => {
    const { res, locked } = await run(at('mgr-2', 'manager'))
    expect(res.status).toBe(200)
    expect(locked).toEqual({
      'mgr-approved': true, 'mgr-pending': false, 'coach-approved': false, 'hc-approved': true,
      'own-approved': true, 'master-approved': true, 'oa-approved': true,
    })
  })

  it('an owner: only a MASTER\'s approved leave is locked (an owner is not above a master); their own is the self path', async () => {
    const { locked } = await run(at('own', 'owner'))
    expect(locked).toEqual({
      'mgr-approved': false, 'mgr-pending': false, 'coach-approved': false, 'hc-approved': false,
      'own-approved': false, 'master-approved': true, 'oa-approved': false,
    })
  })

  it('a master: nothing is locked, and no role or org read is paid for the flag', async () => {
    const { db, locked } = await run(MASTER)
    expect(Object.values(locked).every((v) => v === false)).toBe(true)
    expect(queriesOf(db, 'profile_locations').filter((q) => (q.columns || '').includes('role'))).toHaveLength(0)
    expect(queriesOf(db, 'profile_organizations')).toHaveLength(0)
  })

  it('reads the colleagues\' roles in ONE paged profile_locations query, and their org grants in one', async () => {
    const { db } = await run(at('mgr-2', 'manager'))
    const roleReads = queriesOf(db, 'profile_locations').filter((q) => (q.columns || '').includes('role'))
    expect(roleReads).toHaveLength(1)
    expect(roleReads[0].columns.replace(/\s/g, '')).toBe('profile_id,location_id,role')
    expect(queriesOf(db, 'profile_organizations')).toHaveLength(1)
  })

  it('unreadable memberships only NARROW, and are logged through logError', async () => {
    let { res, locked } = await run(at('mgr-2', 'manager'), { membershipError: { message: 'boom' } })
    expect(res.status).toBe(200)
    expect(locked).toMatchObject({ 'mgr-approved': true, 'coach-approved': true, 'mgr-pending': false })
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][0]).toBe('time-off')
    ;({ locked } = await run(at('own-2', 'owner'), { membershipError: { message: 'boom' } }))
    expect(locked).toMatchObject({ 'mgr-approved': false, 'coach-approved': false, 'master-approved': true })
  })

  it('unreadable org grants narrow too: a colleague with no manager row is locked for a manager', async () => {
    const { locked } = await run(at('mgr-2', 'manager'), { orgError: { message: 'boom' } })
    expect(locked).toMatchObject({ 'coach-approved': true, 'oa-approved': true, 'mgr-approved': true, 'mgr-pending': false })
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('a plain coach sees only their own rows, and none is locked; no role read is made', async () => {
    const coachRows = ROWS.filter((r) => r.profile_id === 'coach')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'))
    try {
      getCurrentUser.mockResolvedValue({ ...at('coach', 'staff') })
      const db = fakeDb((q) => (q.table === 'profile_locations' ? { data: [], error: null } : { data: coachRows, error: null }))
      createServerClient.mockReturnValue(db)
      const json = await (await GET(getReq('?location_id=loc-1'))).json()
      expect(json.data.map((r) => r.approved_locked_to_owner)).toEqual([false])
      expect(queriesOf(db, 'profile_locations')).toHaveLength(0)
      expect(queriesOf(db, 'profile_organizations')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// DATECHECK.1 — the list's range (the Time Off page, the roster's leave read,
// the phone's My leave) reached Postgres unchecked and came back as a 400 with
// its error text, after the member read had already run. preview=1 and the
// POST were checked already (SCHEDHYGIENE.1).
describe('GET /api/schedule/time-off — a date the calendar does not have', () => {
  const getReq = (qs) => ({ url: `http://x/api/schedule/time-off${qs}`, headers: { get: () => '' } })
  const MANAGER = { id: 'boss', role: 'manager', profileRole: 'staff', activeLocation: { id: 'loc-1' }, locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } }

  it('400s in the route\'s own words, before any read', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    for (const [qs, name] of [
      ['?location_id=loc-1&start_date=2026-02-30&end_date=2026-03-06', 'start_date'],
      ['?location_id=loc-1&start_date=2026-04-01&end_date=2026-04-31', 'end_date'],
      ['?location_id=loc-1&start_date=2026-13-01', 'start_date'],
    ]) {
      const db = fakeDb(() => ({ data: [], error: null }))
      createServerClient.mockReturnValue(db)
      const res = await GET(getReq(qs))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ success: false, error: `${name}: not a real date` })
      expect(db.queries).toHaveLength(0)
    }
  })

  it('a real range still lists the requests that overlap it', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const db = fakeDb(() => ({ data: [], error: null }))
    createServerClient.mockReturnValue(db)
    const res = await GET(getReq('?location_id=loc-1&start_date=2026-02-23&end_date=2026-03-01'))
    expect(res.status).toBe(200)
    const list = queriesOf(db, 'time_off_requests')[0]
    expect(list.calls).toContainEqual(['lte', 'start_date', '2026-03-01'])
    expect(list.calls).toContainEqual(['gte', 'end_date', '2026-02-23'])
  })
})
