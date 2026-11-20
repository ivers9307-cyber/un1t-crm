// POST /api/hosts/[id]/stripe/sync — HOSTAPPLEPAY.1: once the host's account
// can charge, the sync registers our checkout domains on it (Apple Pay on
// direct charges), best effort: a registration failure never fails the sync.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/hosts', () => ({ HOST_COLS: 'id', loadHostForOrg: vi.fn() }))
vi.mock('@/lib/payments/stripe-connect', () => ({ retrieveAccountStatus: vi.fn() }))
vi.mock('@/lib/payments/apple-pay-domains', () => ({
  registerCheckoutDomainsForAccount: vi.fn(async () => ({ ok: true, results: [] })),
}))

const { POST } = await import('./route.js')
const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { loadHostForOrg } = await import('@/lib/hosts')
const { retrieveAccountStatus } = await import('@/lib/payments/stripe-connect')
const { registerCheckoutDomainsForAccount } = await import('@/lib/payments/apple-pay-domains')

const db = {
  from: () => ({
    update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'h1' }, error: null }) }) }) }),
  }),
}
const props = { params: Promise.resolve({ id: 'h1' }) }
const req = () => new Request('http://localhost/api/hosts/h1/stripe/sync', { method: 'POST' })
const status = (charges) => ({ chargesEnabled: charges, payoutsEnabled: charges, detailsSubmitted: true, requirementsCurrentlyDue: [] })

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue({ role: 'owner', activeOrganization: { id: 'org1' } })
  loadHostForOrg.mockResolvedValue({ id: 'h1', stripe_connected_account_id: 'acct_h', onboarding_completed_at: '2026-01-01T00:00:00Z' })
})

describe('POST /api/hosts/[id]/stripe/sync — Apple Pay domains (HOSTAPPLEPAY.1)', () => {
  it('registers the checkout domains on a host that can charge', async () => {
    retrieveAccountStatus.mockResolvedValue(status(true))
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(registerCheckoutDomainsForAccount).toHaveBeenCalledWith(db, 'acct_h')
  })

  it('registers nothing while the host cannot charge yet', async () => {
    retrieveAccountStatus.mockResolvedValue(status(false))
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(registerCheckoutDomainsForAccount).not.toHaveBeenCalled()
  })

  it('a failed registration still answers the sync with success', async () => {
    retrieveAccountStatus.mockResolvedValue(status(true))
    registerCheckoutDomainsForAccount.mockResolvedValueOnce({ ok: false, error: 'down', results: [] })
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })

  it('a host with no Stripe account touches neither Stripe nor the domains', async () => {
    loadHostForOrg.mockResolvedValue({ id: 'h1', stripe_connected_account_id: null })
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
    expect(registerCheckoutDomainsForAccount).not.toHaveBeenCalled()
  })
})

// ROUTEWRAP.R8 — the gate through withAuth, in its old order, and no provider
// or database text in an answer.
describe('POST /api/hosts/[id]/stripe/sync — gate and errors', () => {
  it('401 signed out, Stripe never called', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req(), props)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })

  it('403 "Manager+ required" for staff, the host never read', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', activeOrganization: { id: 'org1' } })
    const res = await POST(req(), props)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
    expect(loadHostForOrg).not.toHaveBeenCalled()
  })

  it('404 for a host of another organisation', async () => {
    loadHostForOrg.mockResolvedValue(null)
    const res = await POST(req(), props)
    expect(res.status).toBe(404)
    expect(loadHostForOrg).toHaveBeenCalledWith(db, 'h1', 'org1')
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })

  it('a Stripe failure answers a fixed 502, never Stripe’s text', async () => {
    retrieveAccountStatus.mockRejectedValue(new Error('No such account: acct_h; a similar object exists in test mode'))
    const res = await POST(req(), props)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, error: 'Stripe sync failed. Try again.' })
  })
})
