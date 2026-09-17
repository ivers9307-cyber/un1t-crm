// ROSTER-FIX.1 (D1) — coaches never see draft shifts. The manager/non-manager
// split lives in the route, not the reader, so the calendar (managers) keeps
// its drafts while the mobile schedule feed (coaches) does not.
//
// COACHSCOPE.1 — the split is now per ROW LOCATION: the route hands the reader
// a viewer whose isManagerAt answers from rolesByLocation, never `user.role`
// (the active location's role). The filtering/slimming itself is pinned in
// src/lib/roster-read.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['loc-1']),
  hasRoleAtLocation: (user, loc, roles) => {
    if (!user || !loc) return false
    if (user.profileRole === 'master') return true
    const role = user.rolesByLocation?.[loc]
    return !!role && roles.includes(role)
  },
}))
vi.mock('@/lib/roster-read', () => ({ fetchApiShiftRows: vi.fn(() => Promise.resolve({ rows: [], error: null })) }))
const { getCurrentUser } = await import('@/lib/auth')
const { fetchApiShiftRows } = await import('@/lib/roster-read')
const { GET } = await import('./route.js')
const req = (url = 'http://x/api/schedule/shifts?location_id=loc-1') => ({ url })
beforeEach(() => { getCurrentUser.mockReset(); fetchApiShiftRows.mockClear() })

const viewerFor = async (user) => {
  getCurrentUser.mockResolvedValue(user)
  await GET(req())
  const opts = fetchApiShiftRows.mock.calls[0][1]
  expect(opts.publishedOnly).toBeFalsy()
  return opts.viewer
}

describe('GET /api/schedule/shifts — per-location viewer (D1 + COACHSCOPE.1)', () => {
  it('a coach is a non-manager at their location', async () => {
    const v = await viewerFor({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] })
    expect(v.id).toBe('c')
    expect(v.isManagerAt('loc-1')).toBe(false)
  })

  it('a manager is a manager at their location', async () => {
    const v = await viewerFor({ id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' }, locations: [{ id: 'loc-1' }] })
    expect(v.isManagerAt('loc-1')).toBe(true)
  })

  it('an active-location head coach is still a coach at a studio where they are staff', async () => {
    const v = await viewerFor({
      id: 'x', role: 'head_coach', profileRole: 'head_coach',
      rolesByLocation: { 'loc-1': 'staff', 'loc-2': 'head_coach' },
      locations: [{ id: 'loc-1' }, { id: 'loc-2' }],
    })
    expect(v.isManagerAt('loc-1')).toBe(false)
    expect(v.isManagerAt('loc-2')).toBe(true)
  })

  it('a master is a manager everywhere', async () => {
    const v = await viewerFor({ id: 'ms', role: 'master', profileRole: 'master', rolesByLocation: {}, locations: [{ id: 'loc-1' }] })
    expect(v.isManagerAt('loc-1')).toBe(true)
  })
})
