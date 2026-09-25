// QUALS.1 — POST /api/qualifications/types and PATCH /api/qualifications/types/[id].
// Owners (and masters) edit their organisation's catalogue.

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
  createQualificationType: vi.fn(),
  updateQualificationType: vi.fn(),
}))

const { NextResponse } = await import('next/server')
const { getCurrentUser, assertLocationAccess } = await import('@/lib/auth')
const { createQualificationType, updateQualificationType } = await import('@/lib/qualifications-server')
const { POST } = await import('./route.js')
const { PATCH } = await import('./[id]/route.js')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
const manager = { id: 'm1', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } }
const owner = { ...manager, id: 'o1', rolesByLocation: { [LOC]: 'owner' } }
const req = (body) => ({ url: 'http://test/api/qualifications/types', json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  createQualificationType.mockResolvedValue({ status: 201, body: { success: true, data: { id: ID } } })
  updateQualificationType.mockResolvedValue({ status: 200, body: { success: true, data: { id: ID } } })
})

describe('POST /api/qualifications/types', () => {
  it('401; 400 for a blank, two-line or over-long name; 403 outside the studio; 403 for a manager', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req({ location_id: LOC, name: 'X' }))).status).toBe(401)
    getCurrentUser.mockResolvedValue(owner)
    for (const name of ['', '   ', 'Two\nlines', 'x'.repeat(61)]) {
      expect((await POST(req({ location_id: LOC, name }))).status, JSON.stringify(name)).toBe(400)
    }
    assertLocationAccess.mockReturnValueOnce(NextResponse.json({ success: false }, { status: 403 }))
    expect((await POST(req({ location_id: LOC, name: 'Manual handling' }))).status).toBe(403)
    getCurrentUser.mockResolvedValue(manager)
    expect((await POST(req({ location_id: LOC, name: 'Manual handling' }))).status).toBe(403)
    expect(createQualificationType).not.toHaveBeenCalled()
  })

  it('an owner at the studio creates it (name trimmed)', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const res = await POST(req({ location_id: LOC, name: '  Manual handling ' }))
    expect(res.status).toBe(201)
    expect(createQualificationType).toHaveBeenCalledWith({ db: true }, { user: owner, input: { location_id: LOC, name: 'Manual handling' } })
  })
})

describe('PATCH /api/qualifications/types/[id]', () => {
  const props = (id = ID) => ({ params: Promise.resolve({ id }) })
  it('401; 403 for someone who owns nothing; 404 for a malformed id; 400 for an empty body; otherwise delegates', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PATCH(req({ active: false }), props())).status).toBe(401)
    getCurrentUser.mockResolvedValue(manager)
    expect((await PATCH(req({ active: false }), props())).status).toBe(403)
    getCurrentUser.mockResolvedValue(owner)
    expect((await PATCH(req({ active: false }), props('nope'))).status).toBe(404)
    expect((await PATCH(req({}), props())).status).toBe(400)
    expect(updateQualificationType).not.toHaveBeenCalled()
    expect((await PATCH(req({ active: false }), props())).status).toBe(200)
    expect(updateQualificationType).toHaveBeenCalledWith({ db: true }, { user: owner, id: ID, input: { active: false } })
  })
})
