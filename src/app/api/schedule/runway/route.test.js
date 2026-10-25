// RUNWAY.1 — route contract for GET /api/schedule/runway. The arithmetic is
// pinned in shared/roster-runway.test.js and the read in
// src/lib/roster-runway-data.test.js. Locked here: the gate. This answer is
// about UNPUBLISHED rosters, so a coach must never get it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'service-role' })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    // REAL: the role AT location_id is what is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/roster-runway-data', () => ({ fetchRosterRunways: vi.fn() }))

const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { fetchRosterRunways } = await import('@/lib/roster-runway-data')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const RUNWAY = {
  weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
  blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
}

const req = (params = {}) => {
  const url = new URL('http://test/api/schedule/runway')
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const userWith = (rolesByLocation, profileRole = 'staff') => ({
  id: 'u1', profileRole, rolesByLocation, locations: Object.keys(rolesByLocation).map((id) => ({ id })),
})

beforeEach(() => {
  getCurrentUser.mockReset()
  assertLocationAccess.mockReset().mockReturnValue(null)
  fetchRosterRunways.mockReset().mockResolvedValue({ success: true, data: { byLocation: { [LOC]: RUNWAY } } })
})

describe('GET /api/schedule/runway', () => {
  it('403 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req({ location_id: LOC }))).status).toBe(403)
    expect(fetchRosterRunways).not.toHaveBeenCalled()
  })

  it('403 for a coach: whether a week is published is manager information', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'staff' }))
    expect((await GET(req({ location_id: LOC }))).status).toBe(403)
    expect(fetchRosterRunways).not.toHaveBeenCalled()
  })

  it('403 for the studio where the caller is only staff, even though they manage another', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'head_coach', [OTHER]: 'staff' }))
    expect((await GET(req({ location_id: OTHER }))).status).toBe(403)
    expect(fetchRosterRunways).not.toHaveBeenCalled()
  })

  it('403 from assertLocationAccess is passed straight through', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [OTHER]: 'manager' }))
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }))
    expect((await GET(req({ location_id: LOC }))).status).toBe(403)
    expect(fetchRosterRunways).not.toHaveBeenCalled()
  })

  it('400 on a missing or malformed location_id', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    expect((await GET(req({}))).status).toBe(400)
    expect((await GET(req({ location_id: 'nope' }))).status).toBe(400)
  })

  it('200 for a head coach at the location: reads that ONE location with the service-role client', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'head_coach' }))
    const res = await GET(req({ location_id: LOC }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { runway: RUNWAY } })
    expect(fetchRosterRunways).toHaveBeenCalledWith({ tag: 'service-role' }, [LOC])
  })

  it('a ready studio is runway:null, not a missing key; master is allowed', async () => {
    getCurrentUser.mockResolvedValue(userWith({}, 'master'))
    fetchRosterRunways.mockResolvedValue({ success: true, data: { byLocation: { [LOC]: null } } })
    expect(await (await GET(req({ location_id: LOC }))).json()).toEqual({ success: true, data: { runway: null } })
  })

  it('500 when the read fails: never "ready" by default', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'owner' }))
    fetchRosterRunways.mockResolvedValue({ success: false, error: 'blocks down' })
    const res = await GET(req({ location_id: LOC }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'blocks down' })
  })
})
