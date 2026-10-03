// QUALS.1 — GET/POST /api/qualifications. The data layer is pinned in
// src/lib/qualifications-server.test.js; here: the gates, the query and body
// contracts, and that the route sends what the data layer answers.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ db: true })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/dublin-time', async (importOriginal) => ({ ...(await importOriginal()), dublinTodayStr: () => '2026-09-28' }))
vi.mock('@/lib/qualifications-server', async (importOriginal) => ({
  ...(await importOriginal()),
  loadQualificationsPage: vi.fn(),
  createQualificationRecord: vi.fn(),
}))

const { NextResponse } = await import('next/server')
const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { loadQualificationsPage, createQualificationRecord } = await import('@/lib/qualifications-server')
const { GET, POST } = await import('./route.js')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PERSON = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const TYPE = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const coach = { id: 'c1', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'staff' } }
const headCoach = { ...coach, id: 'h1', rolesByLocation: { [LOC]: 'head_coach' } }
const manager = { ...coach, id: 'm1', rolesByLocation: { [LOC]: 'manager' } }

const getReq = (params = {}) => {
  const url = new URL('http://test/api/qualifications')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const postReq = (body) => ({ url: 'http://test/api/qualifications', json: async () => body })
const VALID = { profile_id: PERSON, qualification_type_id: TYPE, issued_on: '2026-01-10', expires_on: '2028-01-10', note: 'PHECC' }

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  loadQualificationsPage.mockResolvedValue({ status: 200, body: { success: true, data: { audience: 'self' } } })
  createQualificationRecord.mockResolvedValue({ status: 201, body: { success: true, data: { id: 'r1' } } })
})

describe('GET /api/qualifications', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(401)
    expect(loadQualificationsPage).not.toHaveBeenCalled()
  })

  it('400 without a well-formed location_id', async () => {
    getCurrentUser.mockResolvedValue(coach)
    expect((await GET(getReq())).status).toBe(400)
    expect((await GET(getReq({ location_id: 'nope' }))).status).toBe(400)
  })

  it('403 from assertLocationAccess for a studio outside the caller\'s assignments', async () => {
    getCurrentUser.mockResolvedValue(manager)
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false }, { status: 403 }))
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(403)
    expect(loadQualificationsPage).not.toHaveBeenCalled()
  })

  it('any member of the studio reaches the data layer (which decides manager or self), as of Dublin today', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const res = await GET(getReq({ location_id: LOC }))
    expect(res.status).toBe(200)
    expect(loadQualificationsPage).toHaveBeenCalledWith({ db: true }, { user: coach, locationId: LOC, today: '2026-09-28' })
    expect(await res.json()).toEqual({ success: true, data: { audience: 'self' } })
  })

  it('sends the data layer\'s failure as it is', async () => {
    getCurrentUser.mockResolvedValue(manager)
    loadQualificationsPage.mockResolvedValue({ status: 500, body: { success: false, error: 'Could not read the team' } })
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(500)
  })
})

describe('POST /api/qualifications', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(postReq(VALID))).status).toBe(401)
  })

  it.each([['a coach', coach], ['a head coach', headCoach]])('403 for %s (records are owners\' and managers\')', async (_, user) => {
    getCurrentUser.mockResolvedValue(user)
    expect((await POST(postReq(VALID))).status).toBe(403)
    expect(createQualificationRecord).not.toHaveBeenCalled()
  })

  it.each([
    [{ ...VALID, expires_on: '2026-02-30' }],
    [{ ...VALID, issued_on: '2028-02-01' }], // expiry before issue
    [{ ...VALID, note: 'x'.repeat(301) }],
    [{ ...VALID, profile_id: 'nope' }],
    [{ qualification_type_id: TYPE }],
  ])('400 for %j', async (body) => {
    getCurrentUser.mockResolvedValue(manager)
    expect((await POST(postReq(body))).status).toBe(400)
    expect(createQualificationRecord).not.toHaveBeenCalled()
  })

  it('a manager somewhere reaches the data layer, which judges the person on the row; no expiry is allowed', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const body = { ...VALID, expires_on: null }
    const res = await POST(postReq(body))
    expect(res.status).toBe(201)
    expect(createQualificationRecord).toHaveBeenCalledWith({ db: true }, { user: manager, input: body })
  })
})
