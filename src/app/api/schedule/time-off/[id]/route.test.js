// ROSTER-FIX.2 — authorisation tests for PUT /api/schedule/time-off/[id].
//
// The old gate was role-only: any manager, at any studio, could cancel any
// request; and a manager could approve their OWN leave because the self
// branch fell through to the MANAGER_ROLES escape hatch.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), getUserLocationIds: vi.fn(() => ['loc-1']) }))
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
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager' })
    const { db, updateSpy } = buildDb({ existing: { id: 'req-1', profile_id: 'c', location_id: 'loc-2', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a manager cannot approve their own request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'manager' })
    const { db, updateSpy } = buildDb({ existing: { id: 'req-1', profile_id: 'c', location_id: 'loc-1', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('a coach may cancel their own pending request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff' })
    const { db } = buildDb({ existing: { id: 'req-1', profile_id: 'c', location_id: 'loc-1', status: 'pending', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(200)
  })

  it('a coach may not cancel an approved request', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff' })
    const { db, updateSpy } = buildDb({ existing: { id: 'req-1', profile_id: 'c', location_id: 'loc-1', status: 'approved', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-02' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ status: 'cancelled' }), PROPS)
    expect(res.status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
