// GRID.1 — GET /api/schedule/grid. The read is pinned in
// src/lib/roster-grid-data.test.js; locked here: the gate, the query contract,
// and that the body carries hours and never pay.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    // SCHEDROLES.1 — REAL: the role AT location_id is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/roster-grid-data', () => ({ loadRosterGrid: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { loadRosterGrid } = await import('@/lib/roster-grid-data')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const GRID = {
  week_start: '2026-09-21',
  week_end: '2026-09-27',
  members: [{ profile_id: 'p1', full_name: 'Alex Example', employment_type: 'fte', contracted_hours: 39, member: true }],
  shifts: [{
    assignment_id: 'a1', profile_id: 'p1', status: 'scheduled', block_id: 'b1', block_date: '2026-09-21',
    location_id: LOC, location_name: 'Studio North', here: true, kind: 'class', name: 'Strength',
    start_time: '09:00:00', end_time: '12:00:00', start_time_override: null, end_time_override: null,
    shift_templates: { start_time: '09:00:00', end_time: '12:00:00' },
  }],
  cross_studio_checked: true,
}

const req = (params = {}) => {
  const url = new URL('http://test/api/schedule/grid')
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const as = (rolesByLocation, profileRole = 'staff') => ({
  id: 'u1', role: Object.values(rolesByLocation)[0] || profileRole, profileRole, rolesByLocation,
  locations: Object.keys(rolesByLocation).map((id) => ({ id })),
})
const ok = { location_id: LOC, start_date: '2026-09-24' }

beforeEach(() => {
  getCurrentUser.mockReset()
  assertLocationAccess.mockReset().mockReturnValue(null)
  loadRosterGrid.mockReset().mockResolvedValue({ data: GRID, error: null })
})

describe('GET /api/schedule/grid', () => {
  it('403 with no session, and reads nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req(ok))).status).toBe(403)
    expect(loadRosterGrid).not.toHaveBeenCalled()
  })

  it('403 for a coach at the studio, even though they manage another', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'staff', [OTHER]: 'manager' }))
    expect((await GET(req(ok))).status).toBe(403)
    expect(loadRosterGrid).not.toHaveBeenCalled()
  })

  it('403 for a manager of another studio, via assertLocationAccess', async () => {
    getCurrentUser.mockResolvedValue(as({ [OTHER]: 'manager' }))
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false, error: 'Forbidden — location not in your assignments' }, { status: 403 }))
    expect((await GET(req(ok))).status).toBe(403)
    expect(assertLocationAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), LOC)
    expect(loadRosterGrid).not.toHaveBeenCalled()
  })

  it('400 on a missing or malformed location_id, and on a missing or impossible start_date', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    for (const params of [
      { start_date: '2026-09-24' },
      { location_id: 'nope', start_date: '2026-09-24' },
      { location_id: LOC },
      { location_id: LOC, start_date: '2026-02-30' },
      { location_id: LOC, start_date: '24/09/2026' },
    ]) {
      expect((await GET(req(params))).status, JSON.stringify(params)).toBe(400)
    }
    expect(loadRosterGrid).not.toHaveBeenCalled()
  })

  it('200 for a head coach at the studio: any day of the week is snapped to its Monday, one read', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'head_coach' }))
    const res = await GET(req(ok))
    expect(res.status).toBe(200)
    expect(loadRosterGrid).toHaveBeenCalledTimes(1)
    expect(loadRosterGrid).toHaveBeenCalledWith({ tag: 'db' }, { locationId: LOC, weekStart: '2026-09-21' })
    expect(await res.json()).toEqual({ success: true, data: GRID })
  })

  it('the Sunday of a clock-change week snaps to that week’s Monday (29 Mar, 25 Oct 2026)', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    for (const [day, monday] of [['2026-03-29', '2026-03-23'], ['2026-10-25', '2026-10-19'], ['2026-10-26', '2026-10-26']]) {
      loadRosterGrid.mockClear()
      expect((await GET(req({ location_id: LOC, start_date: day }))).status).toBe(200)
      expect(loadRosterGrid).toHaveBeenCalledWith({ tag: 'db' }, { locationId: LOC, weekStart: monday })
    }
  })

  it('master is allowed', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    expect((await GET(req(ok))).status).toBe(200)
  })

  it('the body carries hours and names, never pay', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    const body = await (await GET(req(ok))).json()
    const wire = JSON.stringify(body).toLowerCase()
    for (const banned of ['rate', 'salary', 'hourly', 'annual', 'overtime', 'cost', 'eur', '€']) {
      expect(wire, banned).not.toContain(banned)
    }
    expect(Object.keys(body.data.members[0]).sort()).toEqual(['contracted_hours', 'employment_type', 'full_name', 'member', 'profile_id'])
  })

  it('500 when the read fails: never an empty grid', async () => {
    getCurrentUser.mockResolvedValue(as({ [LOC]: 'manager' }))
    loadRosterGrid.mockResolvedValue({ data: null, error: { message: 'db down' } })
    const res = await GET(req(ok))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
  })
})
