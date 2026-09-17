// ROSTER-FIX.2 — authorisation tests for PUT /api/schedule/time-off/[id].
//
// The old gate was role-only: any manager, at any studio, could cancel any
// request; and a manager could approve their OWN leave because the self
// branch fell through to the MANAGER_ROLES escape hatch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: vi.fn((u) => (u.locations ? u.locations.map((l) => l.id) : ['loc-1'])),
    // SCHEDROLES.1 — REAL: the role at the request's studio is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
  }
})
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn(() => Promise.resolve()) }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { hasPermissionForLocation } = await import('@/lib/permissions')
const { PUT } = await import('./route.js')
const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')

const PROPS = { params: Promise.resolve({ id: 'req-1' }) }

function req(body) {
  return { json: () => Promise.resolve(body), headers: { get: () => '' } }
}

// LEAVE.2 — the route now also reads the requester's studios, their
// employment type, the allowance (to seed it) and their shifts (clashes).
function buildDb({
  existing,
  requesterLocations = [existing?.location_id].filter(Boolean),
  employmentType = 'fte',
  allowance = null,
  entitlement = null,
  assignments = [],
}) {
  const updateSpy = vi.fn()
  const allowanceInsertSpy = vi.fn()
  const db = fakeDb((q) => {
    if (q.table === 'time_off_requests' && q.action === 'select') return { data: existing, error: null }
    if (q.table === 'time_off_requests' && q.action === 'update') {
      updateSpy(q.payload)
      return { data: { ...existing, ...q.payload }, error: null }
    }
    if (q.table === 'profile_locations') return { data: requesterLocations.map((location_id) => ({ location_id })), error: null }
    if (q.table === 'profiles') return { data: { employment_type: employmentType }, error: null }
    if (q.table === 'staff_allowances' && q.action === 'select') return { data: allowance, error: null }
    if (q.table === 'staff_allowances' && q.action === 'insert') { allowanceInsertSpy(q.payload); return { data: null, error: null } }
    if (q.table === 'profile_compensation') return { data: entitlement == null ? null : { annual_leave_entitlement: entitlement }, error: null }
    if (q.table === 'shift_assignments') return { data: assignments, error: null }
    throw new Error(`unexpected ${q.table}/${q.action}`)
  })
  return { db, updateSpy, allowanceInsertSpy }
}

beforeEach(() => {
  createServerClient.mockReset(); getCurrentUser.mockReset()
  hasPermissionForLocation.mockImplementation(() => true)
  // Requests below run 1-2 Jun 2026; "today" is before them, so none has expired.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-05-20T10:00:00Z'))
})
afterEach(() => { vi.useRealTimers() })

describe('PUT /api/schedule/time-off/[id] — authorisation', () => {
  it('a manager at another location cannot cancel', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } })
    const { db, updateSpy } = buildDb({ existing: { id: 'req-1', profile_id: 'c', location_id: 'loc-2', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a manager cannot approve their own request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'manager', profileRole: 'manager', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'manager' } })
    const { db, updateSpy } = buildDb({ existing: { id: 'req-1', profile_id: 'c', location_id: 'loc-1', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a coach may cancel their own pending request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'staff' } })
    const { db } = buildDb({ existing: { id: 'req-1', profile_id: 'c', location_id: 'loc-1', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(200)
  })

  it('a coach may not cancel an approved request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'staff' } })
    const { db, updateSpy } = buildDb({ existing: { id: 'req-1', profile_id: 'c', location_id: 'loc-1', status: 'approved', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })
})

// SCHEDROLES.1 — head coach at loc-1, plain staff at loc-2. The route read
// `user.role` (the ACTIVE studio's) plus membership, so this caller could
// cancel a loc-2 colleague's leave from a loc-1 session.
describe('PUT /api/schedule/time-off/[id] — role at the request\'s studio (SCHEDROLES.1)', () => {
  const mixed = (active, id = 'mix') => ({
    id, role: active === 'loc-1' ? 'head_coach' : 'staff', profileRole: 'staff',
    activeLocation: { id: active },
    locations: [{ id: 'loc-1' }, { id: 'loc-2' }],
    rolesByLocation: { 'loc-1': 'head_coach', 'loc-2': 'staff' },
  })
  const row = (location_id, profile_id = 'colleague', status = 'pending') => ({
    id: 'req-1', profile_id, location_id, status, type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02',
  })

  it('refuses a colleague\'s request at the studio where the caller is staff (404, nothing written)', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const { db, updateSpy } = buildDb({ existing: row('loc-2') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('allows a colleague\'s request at the studio the caller manages', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const { db, updateSpy } = buildDb({ existing: row('loc-1') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(updateSpy).toHaveBeenCalled()
  })

  it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-2'))
    const { db } = buildDb({ existing: row('loc-1') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
  })

  it('the same caller may still cancel their OWN pending request at the studio where they are staff', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const { db } = buildDb({ existing: row('loc-2', 'mix') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(200)
  })

  it('...but not reopen their own APPROVED request there, which only a manager of that studio could', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    const { db, updateSpy } = buildDb({ existing: row('loc-2', 'mix', 'approved') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('master is allowed at any studio', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    const { db } = buildDb({ existing: row('loc-2') })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
  })
})


// LEAVE.2 — the decision now judges the PERSON's studios, refuses an expired
// request, refuses a contractor's non-unavailable leave, seeds the allowance
// from the entitlement and reports rostered-shift clashes.
describe('PUT /api/schedule/time-off/[id] — LEAVE.2', () => {
  const HC = (locs, id = 'hc') => ({
    id, role: 'head_coach', profileRole: 'staff',
    locations: locs.map((l) => ({ id: l })),
    rolesByLocation: Object.fromEntries(locs.map((l) => [l, 'head_coach'])),
  })
  const row = (over = {}) => ({
    id: 'req-1', profile_id: 'coach', location_id: 'loc-1', status: 'pending', type: 'holiday',
    start_date: '2026-06-01', end_date: '2026-06-02', total_days: 2, ...over,
  })

  it('a head coach at the requester\'s OTHER studio can decide leave filed at the first', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-2']))
    const { db, updateSpy } = buildDb({ existing: row(), requesterLocations: ['loc-1', 'loc-2'] })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(updateSpy).toHaveBeenCalled()
  })

  it('...but not when the requester does not belong to the caller\'s studio (404)', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-2']))
    const { db, updateSpy } = buildDb({ existing: row(), requesterLocations: ['loc-1'] })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('403 without the time-off approval permission', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    hasPermissionForLocation.mockImplementation(() => false)
    const { db, updateSpy } = buildDb({ existing: row() })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('409 approving a pending request whose end date has passed; it can still be declined', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'))
    let { db, updateSpy } = buildDb({ existing: row() })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/expired/)
    expect(updateSpy).not.toHaveBeenCalled()

    ;({ db, updateSpy } = buildDb({ existing: row() }))
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'rejected' }), PROPS)).status).toBe(200)
  })

  it('400 approving holiday for a contractor, and no allowance is created', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    const { db, updateSpy, allowanceInsertSpy } = buildDb({ existing: row(), employmentType: 'contractor' })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Contractors/)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(allowanceInsertSpy).not.toHaveBeenCalled()
  })

  it('approves a contractor\'s unavailable leave without touching allowances', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    const { db, allowanceInsertSpy } = buildDb({ existing: row({ type: 'unavailable' }), employmentType: 'contractor' })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(allowanceInsertSpy).not.toHaveBeenCalled()
  })

  it('seeds the first allowance of the year from the entitlement before approving a holiday', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    const { db, allowanceInsertSpy } = buildDb({ existing: row(), entitlement: 15 })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(allowanceInsertSpy).toHaveBeenCalledWith(expect.objectContaining({ profile_id: 'coach', year: 2026, total_days: 15, used_days: 0 }))
  })

  it('never rewrites an existing allowance row', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    const { db, allowanceInsertSpy } = buildDb({ existing: row(), entitlement: 15, allowance: { id: 'a', total_days: 20, used_days: 3, carried_over: 0 } })
    createServerClient.mockReturnValue(db)
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(200)
    expect(allowanceInsertSpy).not.toHaveBeenCalled()
  })

  it('returns the live shifts the leave clashes with, and does not unassign them', async () => {
    getCurrentUser.mockResolvedValue(HC(['loc-1']))
    const block = (id, date, location_id = 'loc-1') => ({ id, block_date: date, start_time: '09:00:00', end_time: '10:00:00', location_id, rosters: { status: 'published' }, shift_templates: { name: 'AM' }, locations: { name: 'Stillorgan' } })
    const { db } = buildDb({
      existing: row({ type: 'unavailable' }),
      assignments: [
        { id: 'a1', profile_id: 'coach', status: 'scheduled', shift_blocks: block('b1', '2026-06-01') },
        { id: 'a2', profile_id: 'coach', status: 'cancelled', shift_blocks: block('b2', '2026-06-02') },
        { id: 'a3', profile_id: 'coach', status: 'confirmed', shift_blocks: block('b3', '2026-06-02', 'loc-2') },
      ],
    })
    createServerClient.mockReturnValue(db)
    const json = await (await PUT(req({ status: 'approved' }), PROPS)).json()
    expect(json.clashes.map((c) => c.id)).toEqual(['a1', 'a3'])
    expect(queriesOf(db, 'shift_assignments', 'delete')).toHaveLength(0)
  })
})
