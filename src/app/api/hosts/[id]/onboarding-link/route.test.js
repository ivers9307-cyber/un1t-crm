// EVENTS-HOST.5 — POST /api/hosts/[id]/onboarding-link through the real
// withAuth wrapper: ADMIN_ROLES on the active role, the host read in the
// active organisation.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { person, LOC_A, ORG } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/hosts', () => ({ loadHostForOrg: vi.fn() }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://crm.example.com') }))
vi.mock('@/lib/host-onboarding-tokens', () => ({ signHostOnboardingToken: vi.fn(() => 'tok') }))

const { getCurrentUser } = await import('@/lib/auth')
const { loadHostForOrg } = await import('@/lib/hosts')
const { POST } = await import('./route.js')

const HOST = 'a0000000-0000-4000-8000-000000000001'
const post = () => POST(new Request(`http://localhost/api/hosts/${HOST}/onboarding-link`, { method: 'POST' }), { params: Promise.resolve({ id: HOST }) })
const as = (role) => person({ [LOC_A]: { role } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-secret')
  loadHostForOrg.mockResolvedValue({ id: HOST, payment_provider: 'stripe_connect', anchor_location_id: LOC_A })
})
afterEach(() => { vi.unstubAllEnvs() })

describe('POST /api/hosts/[id]/onboarding-link', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Manager+ required" for staff, no host read', async () => {
    getCurrentUser.mockResolvedValue(as('staff'))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
    expect(loadHostForOrg).not.toHaveBeenCalled()
  })

  it('a manager gets a link for a host in the active organisation', async () => {
    getCurrentUser.mockResolvedValue(as('manager'))
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { url: 'https://crm.example.com/host-connect/tok' } })
    expect(loadHostForOrg).toHaveBeenCalledWith({ tag: 'db' }, HOST, ORG)
  })

  it('404 for a host outside the organisation', async () => {
    getCurrentUser.mockResolvedValue(as('owner'))
    loadHostForOrg.mockResolvedValue(null)
    expect((await post()).status).toBe(404)
  })
})
