// ROSTER-FIX.6c — route-level contract tests for GET /api/schedule/week-cost.
//
// The arithmetic is pinned in roster-week-cost.test.js. What is locked here is
// the gate (MANAGER_ROLES + assertLocationAccess), the query contract, and the
// one thing this endpoint exists for: no pay field is in the body.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
}))
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
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', locations: [{ id: LOC }] })
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(403)
    expect(computeWeeklyFteHours).not.toHaveBeenCalled()
  })

  it('403 for a manager at another location, via assertLocationAccess', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'head_coach', locations: [{ id: OTHER }] })
    assertLocationAccess.mockReturnValue(
      NextResponse.json({ success: false, error: 'Forbidden — location not in your assignments' }, { status: 403 })
    )
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(403)
    expect(assertLocationAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), LOC)
    expect(computeWeeklyFteHours).not.toHaveBeenCalled()
  })

  it('200 for a head_coach at the location', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'head_coach', locations: [{ id: LOC }] })
    const res = await GET(buildReq(okParams))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.coaches[0].profile_id).toBe('p1')
  })
})

describe('GET /api/schedule/week-cost — contract', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: LOC }] })
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
