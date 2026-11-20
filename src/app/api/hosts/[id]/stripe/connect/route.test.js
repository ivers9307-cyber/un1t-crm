// EVENTS-HOST.2 — POST /api/hosts/[id]/stripe/connect through the real withAuth
// wrapper: Manager+ on the active role, the host read in the active
// organisation, provider text never answered.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, ORG } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/hosts', () => ({ loadHostForOrg: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.example.com' }))
vi.mock('@/lib/payments/stripe-connect', () => ({ createConnectedAccount: vi.fn(), createOnboardingLink: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { loadHostForOrg } = await import('@/lib/hosts')
const { createConnectedAccount, createOnboardingLink } = await import('@/lib/payments/stripe-connect')
const { POST } = await import('./route.js')

const HOST = 'a0000000-0000-4000-8000-000000000001'
let db
const post = () => POST(new Request(`http://localhost/api/hosts/${HOST}/stripe/connect`, { method: 'POST' }), { params: Promise.resolve({ id: HOST }) })
const as = (role) => person({ [LOC_A]: { role } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { event_hosts: [{ id: HOST, organization_id: ORG, name: 'Host', payment_provider: 'stripe_connect' }] } })
  createServerClient.mockReturnValue(db)
  loadHostForOrg.mockResolvedValue({ id: HOST, name: 'Host', email: 'host@example.com', payment_provider: 'stripe_connect', stripe_connected_account_id: null })
  createConnectedAccount.mockResolvedValue('acct_1')
  createOnboardingLink.mockResolvedValue('https://connect.stripe.example/link')
})

describe('POST /api/hosts/[id]/stripe/connect', () => {
  it('401 signed out, nothing created', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(createConnectedAccount).not.toHaveBeenCalled()
  })

  it("403 'Manager+ required' for staff, no host read", async () => {
    getCurrentUser.mockResolvedValue(as('staff'))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
    expect(loadHostForOrg).not.toHaveBeenCalled()
  })

  it('404 for a host outside the organisation, nothing created', async () => {
    getCurrentUser.mockResolvedValue(as('owner'))
    loadHostForOrg.mockResolvedValue(null)
    expect((await post()).status).toBe(404)
    expect(createConnectedAccount).not.toHaveBeenCalled()
  })

  it('a manager gets an onboarding link; the new account is saved on the host', async () => {
    getCurrentUser.mockResolvedValue(as('manager'))
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { url: 'https://connect.stripe.example/link' } })
    expect(loadHostForOrg).toHaveBeenCalledWith(db, HOST, ORG)
    expect(db.tables.event_hosts[0].stripe_connected_account_id).toBe('acct_1')
  })

  it('a Stripe failure is a 502 without Stripe’s text', async () => {
    getCurrentUser.mockResolvedValue(as('owner'))
    createOnboardingLink.mockRejectedValue(new Error('secret detail'))
    const res = await post()
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
