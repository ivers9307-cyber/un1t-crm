// PAIDTRIAL.1 — POST /api/public/trial-purchases: the body never sets a price,
// a page with nothing sellable is refused with a machine-readable code, and a
// well-formed purchase captures the lead, inserts the row with the BLOCK's
// price and opens the provider payment.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(), contact: vi.fn(), payment: vi.fn(), capi: vi.fn(), consent: vi.fn(), deal: vi.fn(), tag: vi.fn(),
  page: vi.fn(), location: vi.fn(), inserted: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit, getClientIp: () => '1.2.3.4', rateLimitResponse: () => new Response('rate', { status: 429 }) }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: mocks.contact }))
vi.mock('@/lib/trial-purchase-payments', () => ({ createTrialPurchasePayment: mocks.payment }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: mocks.capi, fbcFromFbclid: (v) => (v ? `fb.1.${v}` : null) }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: mocks.consent }))
vi.mock('@/lib/waitlist-entry', () => ({ placeWaitlistEntry: mocks.deal }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: mocks.tag }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      if (table === 'landing_page_settings') return { select: () => ({ eq: () => ({ maybeSingle: mocks.page }) }) }
      if (table === 'locations') return { select: () => ({ eq: () => ({ maybeSingle: mocks.location }) }) }
      if (table === 'contacts') return { update: () => { const c = { eq: () => c, is: () => c, then: (r) => r({ error: null }) }; return c } }
      if (table === 'trial_purchases') return { insert: (row) => ({ select: () => ({ single: async () => mocks.inserted(row) }) }) }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { POST } from './route'

const SELLABLE = [{ id: 'b1', type: 'paid_trial', price_cents: 3900, currency: 'EUR', duration_days: 14, product_name: '2 Week Trial', membership_id: 'm1', plan_code: 'p1' }]
const BODY = { path: 'stillorgan', first_name: 'Ava', last_name: 'Byrne', email: 'Ava@Example.com', phone: '0851234567', consent: true, lead_event_id: 'lead-abcdefgh', attribution: { utm_campaign: 'c1', ad_provider: 'meta', ad_external_id: 'ad9', fbclid: 'xyz', fbp: 'fb.1.1.2' } }
const req = (body) => new Request('http://x/api/public/trial-purchases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.page.mockResolvedValue({ data: { location_id: 'loc1', blocks: SELLABLE }, error: null })
  mocks.location.mockResolvedValue({ data: { id: 'loc1', name: 'Stillorgan', organization_id: 'org1', settings: {} }, error: null })
  mocks.contact.mockResolvedValue('c1')
  mocks.inserted.mockImplementation(async (row) => ({ data: { id: 'tp1', ...row }, error: null }))
  mocks.payment.mockResolvedValue({ purchaseId: 'tp1', checkout: { provider: 'revolut', token: 'tok', url: null } })
  mocks.capi.mockResolvedValue({ sent: true })
})

describe('POST /api/public/trial-purchases', () => {
  it('400s a malformed body before touching the database', async () => {
    const r = await POST(req({ ...BODY, phone: 'nope' }))
    expect(r.status).toBe(400)
    expect(mocks.page).not.toHaveBeenCalled()
  })
  it('refuses with not_configured when the page sells nothing (no Glofox product)', async () => {
    mocks.page.mockResolvedValue({ data: { location_id: 'loc1', blocks: [{ ...SELLABLE[0], plan_code: '' }] }, error: null })
    const r = await POST(req(BODY))
    expect(r.status).toBe(400)
    expect((await r.json()).code).toBe('not_configured')
    expect(mocks.contact).not.toHaveBeenCalled()
  })
  it('answers 503, not not_configured, when the landing row cannot be read', async () => {
    mocks.page.mockResolvedValue({ data: null, error: new Error('db') })
    const r = await POST(req(BODY))
    expect(r.status).toBe(503)
    expect((await r.json()).code).toBe('unavailable')
  })
  it('captures the lead, inserts the row at the BLOCK price and opens the payment', async () => {
    const r = await POST(req({ ...BODY, price_cents: 100 }))
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.data).toMatchObject({ purchaseId: 'tp1', amount_cents: 3900, currency: 'EUR', product_name: '2 Week Trial', checkout: { provider: 'revolut', token: 'tok' } })
    expect(mocks.contact).toHaveBeenCalledWith(expect.objectContaining({ email: 'ava@example.com', restrictToOrg: true, insertFields: expect.objectContaining({ source: 'paid_trial' }) }))
    const row = mocks.inserted.mock.calls[0][0]
    expect(row).toMatchObject({ location_id: 'loc1', contact_id: 'c1', status: 'awaiting_payment', amount_cents: 3900, membership_id: 'm1', plan_code: 'p1', customer_email: 'ava@example.com', lead_event_id: 'lead-abcdefgh' })
    expect(row.attribution).toMatchObject({ utm_campaign: 'c1', ad_external_id: 'ad9', fbc: 'fb.1.xyz', fbp: 'fb.1.1.2', event_source_url: 'https://www.un1tdublin.com/trial' })
    expect(row.attribution.fbclid).toBeUndefined()
    expect(mocks.payment).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 3900, currency: 'EUR' }))
    expect(mocks.consent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: 'c1', source: 'paid_trial' }))
    expect(mocks.deal).toHaveBeenCalled()
    expect(mocks.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventName: 'Lead', eventId: 'lead-abcdefgh', locationId: 'loc1' }))
  })
  it('502s when the provider checkout cannot be opened, and a failed lead capture is a 500', async () => {
    mocks.payment.mockRejectedValue(new Error('revolut down'))
    expect((await POST(req(BODY))).status).toBe(502)
    mocks.contact.mockResolvedValue(null)
    expect((await POST(req(BODY))).status).toBe(500)
  })
})
