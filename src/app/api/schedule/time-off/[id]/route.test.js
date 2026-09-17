// ROSTER-FIX.2 — authorisation tests for PUT /api/schedule/time-off/[id].
//
// The old gate was role-only: any manager, at any studio, could cancel any
// request; and a manager could approve their OWN leave because the self
// branch fell through to the MANAGER_ROLES escape hatch.

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
const { PUT } = await import('./route.js')

const PROPS = { params: Promise.resolve({ id: 'req-1' }) }

function req(body) {
  return { json: () => Promise.resolve(body), headers: { get: () => '' } }
}

function buildDb({ existing }) {
  const updateSpy = vi.fn()
  const db = {
    from: (t) => {
      if (t !== 'time_off_requests') throw new Error(t)
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: existing, error: null }) }) }),
        update: (updates) => {
          updateSpy(updates)
          return {
            eq: () => ({
              select: () => ({ single: () => Promise.resolve({ data: { ...existing, ...updates }, error: null }) }),
            }),
          }
        },
      }
    },
  }
  return { db, updateSpy }
}

beforeEach(() => { createServerClient.mockReset(); getCurrentUser.mockReset() })

describe('PUT /api/schedule/time-off/[id] — authorisation', () => {
  it('a manager at another location cannot cancel', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' } })
    const { db, updateSpy } = buildDb({ existing: { id: 'req-1', profile_id: 'c', location_id: 'loc-2', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a manager cannot approve their own request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' } })
    const { db, updateSpy } = buildDb({ existing: { id: 'req-1', profile_id: 'c', location_id: 'loc-1', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a coach may cancel their own pending request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' } })
    const { db } = buildDb({ existing: { id: 'req-1', profile_id: 'c', location_id: 'loc-1', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(200)
  })

  it('a coach may not cancel an approved request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' } })
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
