// ROSTER-FIX.6c — route-level contract tests for GET /api/schedule/week-cost.
//
// The arithmetic is pinned in roster-week-cost.test.js. What is locked here is
// the gate (MANAGER_ROLES + assertLocationAccess), the query contract, and the
// one thing this endpoint exists for: no pay field is in the body.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    // SCHEDROLES.1 — REAL: the role at location_id is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/roster-week-cost', () => ({ computeWeeklyFteHours: vi.fn() }))

const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { computeWeeklyFteHours } = await import('@/lib/roster-week-cost')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const PAYLOAD = {
  weekStartIso: '2026-05-04',
  weekEndIso: '2026-05-10',
  coaches: [{
    profile_id: 'p1', full_name: 'Sarah FTE',
    allocated_hours: 34, contracted_hours: 30, overtime_hours: 4,
    status: 'overtime', over_threshold: true,
  }],
  totals: { coaches: 1, allocated_hours: 34, overtime_hours: 4, over_threshold: 1 },
}

function buildReq(params = {}) {
  const url = new URL('http://test/api/schedule/week-cost')
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return { url: url.toString() }
}

const okParams = { location_id: LOC, week_start: '2026-05-04' }

beforeEach(() => {
  getCurrentUser.mockReset()
  assertLocationAccess.mockReset()
  assertLocationAccess.mockReturnValue(null)
  computeWeeklyFteHours.mockReset()
  computeWeeklyFteHours.mockResolvedValue(PAYLOAD)
})

describe('GET /api/schedule/week-cost — auth', () => {
  it('403 when there is no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(403)
    expect(computeWeeklyFteHours).not.toHaveBeenCalled()
  })

  it('403 for a coach — hours against a contract are manager information', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'staff' } })
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(403)
    expect(computeWeeklyFteHours).not.toHaveBeenCalled()
  })

  it('403 for a manager at another location, via assertLocationAccess', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'head_coach', profileRole: 'staff', locations: [{ id: OTHER }], rolesByLocation: { [OTHER]: 'head_coach' } })
    assertLocationAccess.mockReturnValue(
      NextResponse.json({ success: false, error: 'Forbidden — location not in your assignments' }, { status: 403 })
    )
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(403)
    expect(assertLocationAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), LOC)
    expect(computeWeeklyFteHours).not.toHaveBeenCalled()
  })

  it('200 for a head_coach at the location', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'head_coach', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'head_coach' } })
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.coaches[0].profile_id).toBe('p1')
  })
})

// SCHEDROLES.1 — head coach at LOC, plain staff at OTHER. The route read
// `user.role` (the ACTIVE studio's) and then checked only membership.
describe('GET /api/schedule/week-cost — role at location_id (SCHEDROLES.1)', () => {
  const mixed = (active) => ({
    id: 'mix', role: active === LOC ? 'head_coach' : 'staff', profileRole: 'staff',
    activeLocation: { id: active },
    locations: [{ id: LOC }, { id: OTHER }],
    rolesByLocation: { [LOC]: 'head_coach', [OTHER]: 'staff' },
  })

  it('refuses the studio where the caller is staff, and computes nothing', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC))
    const res = await GET(buildReq({ location_id: OTHER, week_start: '2026-05-04' }))
    expect(res.status).toBe(403)
    expect(computeWeeklyFteHours).not.toHaveBeenCalled()
  })

  it('allows the studio the caller manages', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC))
    expect((await GET(buildReq(okParams))).status).toBe(200)
  })

  it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(mixed(OTHER))
    expect((await GET(buildReq(okParams))).status).toBe(200)
  })

  it('master is allowed', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    expect((await GET(buildReq({ location_id: OTHER, week_start: '2026-05-04' }))).status).toBe(200)
  })
})

describe('GET /api/schedule/week-cost — contract', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } })
  })

  it('the body carries hours and NO pay field', async () => {
    const res = await GET(buildReq(okParams))
    const body = await res.json()
    const wire = JSON.stringify(body).toLowerCase()
    for (const banned of ['rate', 'salary', 'cost', 'eur', 'annual', 'hourly']) {
      expect(wire).not.toContain(banned)
    }
    expect(Object.keys(body.data.coaches[0]).sort()).toEqual([
      'allocated_hours', 'contracted_hours', 'full_name', 'over_threshold',
      'overtime_hours', 'profile_id', 'status',
    ])
  })

  it('400 on a missing or malformed param, before any work is done', async () => {
    for (const params of [
      {},
      { location_id: LOC },
      { week_start: '2026-05-04' },
      { location_id: LOC, week_start: 'not-a-date' },
      { location_id: 'nope', week_start: '2026-05-04' },
    ]) {
      const res = await GET(buildReq(params))
      expect(res.status).toBe(400)
    }
    expect(computeWeeklyFteHours).not.toHaveBeenCalled()
  })

  // DATECHECK.1 — 2026-02-30 was parsed as 2 March and answered 200 with the
  // week of 2 March: numbers for a week nobody asked about, with no error.
  it('400 on a week_start the calendar does not have, and computes nothing', async () => {
    for (const week_start of ['2026-02-30', '2026-04-31', '2026-13-01', '2027-02-29']) {
      const res = await GET(buildReq({ location_id: LOC, week_start }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('week_start: Use a real date, YYYY-MM-DD')
    }
    expect(computeWeeklyFteHours).not.toHaveBeenCalled()
  })

  it('29 Feb in a leap year is a real date', async () => {
    const res = await GET(buildReq({ location_id: LOC, week_start: '2028-02-29' }))
    expect(res.status).toBe(200)
    expect(computeWeeklyFteHours).toHaveBeenCalledWith(expect.objectContaining({ weekStart: '2028-02-29' }))
  })

  it('passes the location and week straight through', async () => {
    await GET(buildReq(okParams))
    expect(computeWeeklyFteHours).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: LOC, weekStart: '2026-05-04' })
    )
  })

  it('500s with the failure named rather than an empty week', async () => {
    computeWeeklyFteHours.mockRejectedValue(new Error('blocks read failed'))
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('blocks read failed')
  })
})
