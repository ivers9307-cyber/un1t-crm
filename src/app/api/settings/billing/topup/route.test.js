// POST /api/settings/billing/topup through the real withAuth wrapper: signed
// in, then by hand, in the old order: org admin somewhere 403, body 400, the
// location's organisation 404 (never 403); then createTopup, unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, ORG, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/wallet-topup', async (importOriginal) => ({ ...(await importOriginal()), createTopup: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { createTopup, TOPUP_DENOMINATIONS_CENTS } = await import('@/lib/wallet-topup')
const { POST } = await import('./route.js')

const AMOUNT = TOPUP_DENOMINATIONS_CENTS[0]
const post = (body) => POST(new Request('http://localhost/api/settings/billing/topup', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
const owner = person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner' } }, LOC_A)
const orgAdmin = { ...owner, orgAdminOrgIds: [ORG] }
const OTHER_ORG = 'f0000000-0000-4000-8000-0000000000f9'

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { locations: [
    { id: LOC_B, organization_id: ORG }, { id: LOC_OTHER, organization_id: OTHER_ORG },
  ] } }))
  createTopup.mockResolvedValue({ checkoutUrl: 'https://checkout.example/x', invoiceId: 'inv-1', number: 'T-1' })
})

describe('POST /api/settings/billing/topup', () => {
  it('401 signed out (withAuth), no checkout started', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ location_id: LOC_B, amount_cents: AMOUNT })).status).toBe(401)
    expect(createTopup).not.toHaveBeenCalled()
  })

  it('403 for a studio owner who is not an organisation admin', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const res = await post({ location_id: LOC_B, amount_cents: AMOUNT })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Wallet top-ups are made by an organisation admin' })
  })

  it('404 for another organisation\'s location, and for an unknown one', async () => {
    getCurrentUser.mockResolvedValue(orgAdmin)
    expect((await post({ location_id: LOC_OTHER, amount_cents: AMOUNT })).status).toBe(404)
    expect((await post({ location_id: 'd0000000-0000-4000-8000-0000000000ab', amount_cents: AMOUNT })).status).toBe(404)
    expect(createTopup).not.toHaveBeenCalled()
  })

  it('an org admin starts the checkout for their organisation\'s location', async () => {
    getCurrentUser.mockResolvedValue(orgAdmin)
    const res = await post({ location_id: LOC_B, amount_cents: AMOUNT })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { checkout_url: 'https://checkout.example/x', invoice_id: 'inv-1', number: 'T-1' } })
    expect(createTopup.mock.calls[0][1]).toEqual({ locationId: LOC_B, amountCents: AMOUNT, userId: owner.id })
  })
})
