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

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET, POST } = await import('./route.js')

const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')
const { notifyUsersOnce } = await import('@/lib/push-dedup')
const { hasPermissionForLocation } = await import('@/lib/permissions')

function req(body) {
  return { url: 'http://x/api/schedule/time-off', json: () => Promise.resolve(body), headers: { get: () => '' } }
}

// LEAVE.2 — the POST now also reads the subject's employment type, their
// studios, the contract entitlement and (on notify) the approver set.
function buildDb({
  overlapping = [], overlappingError = null,
  allowance = null, allowanceByYear = null,
  pendingHoliday = [],
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
      if (cols === 'total_days') return { data: pendingHoliday, error: null }
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
        { id: 'old', profile_id: 'm1', status: 'pending', start_date: '2026-08-26', end_date: '2026-08-26' },
        { id: 'next', profile_id: 'm2', status: 'approved', start_date: '2026-09-18', end_date: '2026-09-20' },
      ]
      const db = fakeDb((q) => {
        if (q.table === 'profile_locations') return { data: [{ profile_id: 'm1' }, { profile_id: 'm2' }], error: null }
        if (q.table === 'shift_assignments') {
          return { data: [
            { id: 'a', profile_id: 'm2', status: 'scheduled', shift_blocks: { block_date: '2026-09-19' } },
            { id: 'b', profile_id: 'm2', status: 'cancelled', shift_blocks: { block_date: '2026-09-19' } },
          ], error: null }
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
})

// LEAVE.2-5 — contractor types, first-request balance, approver notification,
// and recording leave on someone's behalf.
describe('POST /api/schedule/time-off — LEAVE.2', () => {
  const link = (profile_id, role, location_id = 'loc-1', extra = {}) => ({
    profile_id, location_id, role, permissions: {}, profiles: { id: profile_id, active: true, role: 'staff', employment_type: 'fte' }, ...extra,
  })

  it('400 when a contractor files holiday, sick or unpaid leave; unavailable is accepted', async () => {
    getCurrentUser.mockResolvedValue(USER)
    for (const type of ['holiday', 'sick', 'unpaid', 'other']) {
      const { db, insertSpy } = buildDb({ employmentType: 'contractor' })
      createServerClient.mockReturnValue(db)
      const res = await POST(req({ type, start_date: '2026-06-01', end_date: '2026-06-02' }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/Contractors/)
      expect(insertSpy).not.toHaveBeenCalled()
    }
    const { db, insertSpy } = buildDb({ employmentType: 'contractor' })
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ type: 'unavailable', start_date: '2026-06-01', end_date: '2026-06-02' }))).status).toBe(201)
    expect(insertSpy).toHaveBeenCalled()
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
      expect((await POST(req(body({ type: 'holiday' })))).status).toBe(400)
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
