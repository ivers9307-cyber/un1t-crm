// QUALS.1 — the template editor's qualification requirements. Same gate as
// the template editor itself (SCHEDROLES.1): MANAGER_ROLES at the studio,
// head coaches included.

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
vi.mock('@/lib/qualifications-server', async (importOriginal) => ({
  ...(await importOriginal()),
  readTemplateRequirements: vi.fn(),
  replaceTemplateRequirements: vi.fn(),
}))

const { NextResponse } = await import('next/server')
const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { readTemplateRequirements, replaceTemplateRequirements } = await import('@/lib/qualifications-server')
const { GET, PUT } = await import('./route.js')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const TPL = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
const T = (n) => `0000000${n}-0000-0000-0000-000000000000`
const coach = { id: 'c1', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'staff' } }
const headCoach = { ...coach, id: 'h1', rolesByLocation: { [LOC]: 'head_coach' } }

const getReq = (params = {}) => {
  const url = new URL('http://test/api/schedule/template-qualifications')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const putReq = (body) => ({ url: 'http://test/api/schedule/template-qualifications', json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  readTemplateRequirements.mockResolvedValue({ status: 200, body: { success: true, data: { types: [], requirements: {} } } })
  replaceTemplateRequirements.mockResolvedValue({ status: 200, body: { success: true, data: { template_id: TPL } } })
})

describe('GET', () => {
  it('401; 400 without a location; 403 outside the studio; 403 for staff there', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(401)
    getCurrentUser.mockResolvedValue(headCoach)
    expect((await GET(getReq())).status).toBe(400)
    assertLocationAccess.mockReturnValueOnce(NextResponse.json({ success: false }, { status: 403 }))
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(403)
    getCurrentUser.mockResolvedValue(coach)
    expect((await GET(getReq({ location_id: LOC }))).status).toBe(403)
    expect(readTemplateRequirements).not.toHaveBeenCalled()
  })

  it('a head coach at the studio reads it', async () => {
    getCurrentUser.mockResolvedValue(headCoach)
    const res = await GET(getReq({ location_id: LOC }))
    expect(res.status).toBe(200)
    expect(readTemplateRequirements).toHaveBeenCalledWith({ db: true }, { locationId: LOC })
  })
})

describe('PUT', () => {
  it('401; 403 for someone who manages nowhere; 400 for six types or a malformed id', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(putReq({ template_id: TPL, qualification_type_ids: [] }))).status).toBe(401)
    getCurrentUser.mockResolvedValue(coach)
    expect((await PUT(putReq({ template_id: TPL, qualification_type_ids: [] }))).status).toBe(403)
    getCurrentUser.mockResolvedValue(headCoach)
    expect((await PUT(putReq({ template_id: TPL, qualification_type_ids: [1, 2, 3, 4, 5, 6].map(T) }))).status).toBe(400)
    expect((await PUT(putReq({ template_id: 'nope', qualification_type_ids: [] }))).status).toBe(400)
    expect(replaceTemplateRequirements).not.toHaveBeenCalled()
  })

  it('delegates; the data layer judges the template\'s studio on the row', async () => {
    getCurrentUser.mockResolvedValue(headCoach)
    const body = { template_id: TPL, qualification_type_ids: [T(1)] }
    expect((await PUT(putReq(body))).status).toBe(200)
    expect(replaceTemplateRequirements).toHaveBeenCalledWith({ db: true }, { user: headCoach, input: body })
  })
})
