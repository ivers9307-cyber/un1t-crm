// GET /api/admin/tenants/[orgId] through the real withAuth wrapper: masters
// (profiles.role) only; a malformed or unknown id is a 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, MASTER, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/admin-tenants', () => ({ getTenantDetail: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { getTenantDetail } = await import('@/lib/admin-tenants')
const { GET } = await import('./route.js')

const ORG_ID = 'c0000000-0000-4000-8000-00000000000c'
const get = (orgId = ORG_ID) => GET(new Request(`http://localhost/api/admin/tenants/${orgId}`), { params: Promise.resolve({ orgId }) })

beforeEach(() => {
  vi.clearAllMocks()
  getTenantDetail.mockResolvedValue({ organization: { id: ORG_ID }, locations: [] })
})

describe('GET /api/admin/tenants/[orgId]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 "Master only" for an owner, nothing read', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
    expect(getTenantDetail).not.toHaveBeenCalled()
  })

  it('404 for a malformed id and for an unknown one', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await get('nope')).status).toBe(404)
    getTenantDetail.mockResolvedValue(null)
    expect((await get()).status).toBe(404)
  })

  it('a master gets the tenant detail', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { organization: { id: ORG_ID }, locations: [] } })
    expect(getTenantDetail).toHaveBeenCalledWith({ tag: 'db' }, ORG_ID)
  })

  it('a failed read is a 500 without the error text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    getTenantDetail.mockRejectedValue(new Error('secret detail'))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
