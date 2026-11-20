// EVENTS-HOST.9 — POST /api/hosts/[id]/onboarding-link/send through the real
// withAuth wrapper (ROUTEWRAP.R6): ADMIN_ROLES on the active role, the host
// read in the active organisation, and no provider text in a failed send.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { person, LOC_A, ORG } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/hosts', async (importOriginal) => ({ ...(await importOriginal()), loadHostForOrg: vi.fn() }))
vi.mock('@/lib/tenant-host', async (importOriginal) => ({ ...(await importOriginal()), resolveCustomerBaseUrl: vi.fn(async () => 'https://crm.example.com') }))
vi.mock('@/lib/host-onboarding-tokens', async (importOriginal) => ({ ...(await importOriginal()), signHostOnboardingToken: vi.fn(() => 'tok') }))
vi.mock('@/lib/host-onboarding-email', async (importOriginal) => ({ ...(await importOriginal()), sendHostOnboardingEmail: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { loadHostForOrg } = await import('@/lib/hosts')
const { sendHostOnboardingEmail } = await import('@/lib/host-onboarding-email')
const { logError } = await import('@/lib/log')
const { POST } = await import('./route.js')

const HOST = 'a0000000-0000-4000-8000-000000000001'
const post = () => POST(new Request(`http://localhost/api/hosts/${HOST}/onboarding-link/send`, { method: 'POST' }), { params: Promise.resolve({ id: HOST }) })
const as = (role) => person({ [LOC_A]: { role } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-secret')
  loadHostForOrg.mockResolvedValue({ id: HOST, payment_provider: 'stripe_connect', anchor_location_id: LOC_A, email: 'host@example.test' })
  sendHostOnboardingEmail.mockResolvedValue(undefined)
})
afterEach(() => { vi.unstubAllEnvs() })

describe('POST /api/hosts/[id]/onboarding-link/send', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Manager+ required" for staff, no host read, nothing sent', async () => {
    getCurrentUser.mockResolvedValue(as('staff'))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
    expect(loadHostForOrg).not.toHaveBeenCalled()
    expect(sendHostOnboardingEmail).not.toHaveBeenCalled()
  })

  it('404 for a host outside the organisation, nothing sent', async () => {
    getCurrentUser.mockResolvedValue(as('owner'))
    loadHostForOrg.mockResolvedValue(null)
    expect((await post()).status).toBe(404)
    expect(sendHostOnboardingEmail).not.toHaveBeenCalled()
  })

  it('a manager sends the link to a host in the active organisation', async () => {
    getCurrentUser.mockResolvedValue(as('manager'))
    const res = await post()
    expect(res.status).toBe(200)
    expect(loadHostForOrg).toHaveBeenCalledWith({ tag: 'db' }, HOST, ORG)
    expect(sendHostOnboardingEmail).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://crm.example.com/host-connect/tok' }))
  })

  it('a failed send is a 502 with a fixed message; the provider text is logged only', async () => {
    getCurrentUser.mockResolvedValue(as('manager'))
    sendHostOnboardingEmail.mockRejectedValue(new Error('postmark: 422 sender signature not confirmed'))
    const res = await post()
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).not.toMatch(/postmark|422/)
    expect(logError).toHaveBeenCalled()
  })
})
