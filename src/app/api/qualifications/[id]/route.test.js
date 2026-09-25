// QUALS.1 — PATCH/DELETE /api/qualifications/[id]: gates and delegation.
// A malformed id is a 404 (detail route: ids are never confirmed).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ db: true })) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return { getCurrentUser: vi.fn(), hasRoleAtAnyLocation: real.hasRoleAtAnyLocation }
})
vi.mock('@/lib/qualifications-server', async (importOriginal) => ({
  ...(await importOriginal()),
  updateQualificationRecord: vi.fn(),
  deleteQualificationRecord: vi.fn(),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { updateQualificationRecord, deleteQualificationRecord } = await import('@/lib/qualifications-server')
const { PATCH, DELETE } = await import('./route.js')

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const coach = { id: 'c1', profileRole: 'staff', rolesByLocation: { [LOC]: 'staff' } }
const owner = { id: 'o1', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' } }
const props = (id = ID) => ({ params: Promise.resolve({ id }) })
const req = (body) => ({ url: `http://test/api/qualifications/${ID}`, json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  updateQualificationRecord.mockResolvedValue({ status: 200, body: { success: true, data: { id: ID } } })
  deleteQualificationRecord.mockResolvedValue({ status: 200, body: { success: true, data: { id: ID, deleted: true } } })
})

describe('PATCH /api/qualifications/[id]', () => {
  it('401, 403 for a coach, 404 for a malformed id, 400 for an empty or impossible body', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PATCH(req({ note: 'x' }), props())).status).toBe(401)
    getCurrentUser.mockResolvedValue(coach)
    expect((await PATCH(req({ note: 'x' }), props())).status).toBe(403)
    getCurrentUser.mockResolvedValue(owner)
    expect((await PATCH(req({ note: 'x' }), props('nope'))).status).toBe(404)
    expect((await PATCH(req({}), props())).status).toBe(400)
    expect((await PATCH(req({ issued_on: '2026-05-01', expires_on: '2026-04-01' }), props())).status).toBe(400)
    expect(updateQualificationRecord).not.toHaveBeenCalled()
  })

  it('delegates with the id and the parsed body', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const res = await PATCH(req({ expires_on: '2028-01-01' }), props())
    expect(res.status).toBe(200)
    expect(updateQualificationRecord).toHaveBeenCalledWith({ db: true }, { user: owner, id: ID, input: { expires_on: '2028-01-01' } })
  })
})

describe('DELETE /api/qualifications/[id]', () => {
  it('401, 403 for a coach, 404 for a malformed id; otherwise delegates', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await DELETE(req(), props())).status).toBe(401)
    getCurrentUser.mockResolvedValue(coach)
    expect((await DELETE(req(), props())).status).toBe(403)
    getCurrentUser.mockResolvedValue(owner)
    expect((await DELETE(req(), props('nope'))).status).toBe(404)
    expect(deleteQualificationRecord).not.toHaveBeenCalled()
    expect((await DELETE(req(), props())).status).toBe(200)
    expect(deleteQualificationRecord).toHaveBeenCalledWith({ db: true }, { user: owner, id: ID })
  })
})
