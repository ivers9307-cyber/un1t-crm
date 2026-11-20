// GET /api/policies through the real withAuth wrapper: any signed-in employee;
// the list is scoped by listPoliciesWithStatus to the caller's organisation.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/policies', () => ({ listPoliciesWithStatus: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { listPoliciesWithStatus } = await import('@/lib/policies')
const { GET } = await import('./route.js')

const get = () => GET(new Request('http://localhost/api/policies'))

beforeEach(() => {
  vi.clearAllMocks()
  listPoliciesWithStatus.mockResolvedValue([{ id: 'p1', title: 'Handbook', acknowledged: false }])
})

describe('GET /api/policies', () => {
  it('401 signed out, and nothing is read', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
    expect(listPoliciesWithStatus).not.toHaveBeenCalled()
  })

  it('a staff member with no active studio still reads their policies', async () => {
    const staff = { ...person({ [LOC_A]: { role: 'staff' } }, LOC_A), activeLocation: null }
    getCurrentUser.mockResolvedValue(staff)
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: [{ id: 'p1', title: 'Handbook', acknowledged: false }] })
    expect(listPoliciesWithStatus).toHaveBeenCalledWith(staff)
  })

  it('a failed read is a fixed 500 without the error text', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    listPoliciesWithStatus.mockRejectedValue(new Error('column secret does not exist'))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
  })
})
