// src/app/api/schedule/change-log/route.test.js
// CHANGELOG.1 — route-level contract for GET /api/schedule/change-log.
// The read is pinned in roster-change-log.test.js. Locked here: the gate
// (manager role AT location_id + assertLocationAccess), the query contract,
// and that a failed read is a 500, never an empty list.

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
vi.mock('@/lib/roster-change-log', async (importOriginal) => ({
  ...(await importOriginal()),
  listRosterChanges: vi.fn(),
}))

const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { listRosterChanges } = await import('@/lib/roster-change-log')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const CHANGE = {
  id: 'c1', action: 'assigned', block_id: 'b1', block_date: '2026-09-15', start_time: '06:00:00', end_time: '07:00:00',
  shift_name: 'Morning', coach_id: 'p1', coach_name: 'Coach A', actor_name: 'Manager B',
  details: {}, notified_at: null, created_at: '2026-09-15T12:58:00Z',
}

function buildReq(params = {}) {
  const url = new URL('http://test/api/schedule/change-log')
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const ok = { location_id: LOC, from: '2026-09-14', to: '2026-09-20' }
const userAt = (loc, role) => ({ id: 'u1', role, profileRole: 'staff', locations: [{ id: loc }], rolesByLocation: { [loc]: role } })

beforeEach(() => {
  getCurrentUser.mockReset()
  assertLocationAccess.mockReset()
  assertLocationAccess.mockReturnValue(null)
  listRosterChanges.mockReset()
  listRosterChanges.mockResolvedValue({ changes: [CHANGE], truncated: false, error: null })
})

describe('GET /api/schedule/change-log — auth', () => {
  it('403 with no session, and reads nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(buildReq(ok))).status).toBe(403)
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('403 for a coach: the audit trail is manager information', async () => {
    getCurrentUser.mockResolvedValue(userAt(LOC, 'staff'))
    expect((await GET(buildReq(ok))).status).toBe(403)
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('403 for a manager of ANOTHER studio, via assertLocationAccess', async () => {
    getCurrentUser.mockResolvedValue(userAt(OTHER, 'manager'))
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false, error: 'Forbidden — location not in your assignments' }, { status: 403 }))
    const res = await GET(buildReq(ok))
    expect(res.status).toBe(403)
    expect(assertLocationAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), LOC)
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('200 for a head coach at the studio', async () => {
    getCurrentUser.mockResolvedValue(userAt(LOC, 'head_coach'))
    expect((await GET(buildReq(ok))).status).toBe(200)
  })

  // SCHEDROLES.1 — head coach at LOC, plain staff at OTHER, member of both.
  const mixed = (active) => ({
    id: 'mix', role: active === LOC ? 'head_coach' : 'staff', profileRole: 'staff',
    activeLocation: { id: active },
    locations: [{ id: LOC }, { id: OTHER }],
    rolesByLocation: { [LOC]: 'head_coach', [OTHER]: 'staff' },
  })

  it('refuses the studio where the caller is only staff, even though they manage another', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC))
    expect((await GET(buildReq({ ...ok, location_id: OTHER }))).status).toBe(403)
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('allows the studio they manage even when the ACTIVE studio is the one where they are staff', async () => {
    getCurrentUser.mockResolvedValue(mixed(OTHER))
    expect((await GET(buildReq(ok))).status).toBe(200)
  })

  it('a master is allowed', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    expect((await GET(buildReq(ok))).status).toBe(200)
  })
})

describe('GET /api/schedule/change-log — contract', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue(userAt(LOC, 'manager')))

  it('200: the changes and the truncated flag, read for exactly that studio and range', async () => {
    const res = await GET(buildReq(ok))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { changes: [CHANGE], truncated: false } })
    expect(listRosterChanges).toHaveBeenCalledWith(expect.anything(), { locationId: LOC, from: '2026-09-14', to: '2026-09-20' })
  })

  it('400 on a missing or malformed param, before any read', async () => {
    for (const bad of [{ ...ok, location_id: undefined }, { ...ok, from: undefined }, { ...ok, to: '20-09-2026' }, { ...ok, location_id: 'not-a-uuid' }]) {
      expect((await GET(buildReq(bad))).status).toBe(400)
    }
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('400 for a date that is well-formed but not a real day, before any read', async () => {
    // isoDate is a SHAPE check. Without a calendar check these reach Postgres
    // and come back as a 500 "date/time field value out of range".
    for (const bad of [{ ...ok, from: '2026-13-01' }, { ...ok, to: '2026-09-31' }, { ...ok, from: '2026-02-30', to: '2026-03-05' }]) {
      const res = await GET(buildReq(bad))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/not a real date/)
    }
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('400 when to is before from', async () => {
    const res = await GET(buildReq({ ...ok, from: '2026-09-20', to: '2026-09-14' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/on or after/)
  })

  it('400 for a range longer than 92 days: the drawer asks for a week or a month', async () => {
    const res = await GET(buildReq({ ...ok, from: '2026-01-01', to: '2026-12-31' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/92 days/)
    expect(listRosterChanges).not.toHaveBeenCalled()
  })

  it('a 31-day month is fine', async () => {
    expect((await GET(buildReq({ ...ok, from: '2026-10-01', to: '2026-10-31' }))).status).toBe(200)
  })

  it('500 when the read fails: never an empty list that reads as "no changes"', async () => {
    listRosterChanges.mockResolvedValue({ changes: [], truncated: false, error: { message: 'boom' } })
    const res = await GET(buildReq(ok))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'boom' })
  })

  it('carries no pay field', async () => {
    const wire = JSON.stringify(await (await GET(buildReq(ok))).json())
    expect(wire).not.toMatch(/hourly_rate|annual_salary|overtime_rate|contracted_hours/)
  })
})
