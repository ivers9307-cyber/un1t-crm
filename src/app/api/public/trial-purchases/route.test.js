// PAIDTRIAL.1 / TRIALSTUDIO.6 — POST /api/public/trial-purchases: the body
// names a studio and never sets a price; a page with nothing sellable is
// refused with a machine-readable code. Stillorgan: a buyer with a trial
// history is refused BEFORE any row or checkout; a clean buyer captures the
// lead, inserts the row with the BLOCK's price and opens the Revolut payment.
// Hatch Street: no CRM charge ever; the CRM finds or creates the un1t.online
// account and hands back un1t.online's hosted checkout URL.
//
// The studio loader and the eligibility reads run for real against the fake
// database below (one fixture list per table); the un1t.online primitives,
// the legal-documents read, the customer host and the staff alert are mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Un1tWriteRefused } from '@/lib/un1t-online-write'

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(), contact: vi.fn(), payment: vi.fn(), capi: vi.fn(), consent: vi.fn(), deal: vi.fn(), tag: vi.fn(),
  read: vi.fn(), inserted: vi.fn(), updated: vi.fn(),
  ensureAccount: vi.fn(), checkout: vi.fn(), legal: vi.fn(), baseUrl: vi.fn(), alert: vi.fn(),
  state: null,
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit, getClientIp: () => '1.2.3.4', rateLimitResponse: () => new Response('rate', { status: 429 }) }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: mocks.contact }))
vi.mock('@/lib/trial-purchase-payments', () => ({ createTrialPurchasePayment: mocks.payment }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: mocks.capi, fbcFromFbclid: (v) => (v ? `fb.1.${v}` : null) }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: mocks.consent }))
vi.mock('@/lib/waitlist-entry', () => ({ placeWaitlistEntry: mocks.deal }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: mocks.tag }))
vi.mock('@/lib/un1t-online-account', () => ({ ensureUn1tAccount: mocks.ensureAccount }))
vi.mock('@/lib/un1t-online-write-ops', () => ({ createCheckoutLink: mocks.checkout }))
vi.mock('@/lib/un1t-online-legal', () => ({ readUn1tLegalDocs: mocks.legal }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: mocks.baseUrl }))
vi.mock('@/lib/trial-purchase-processor', () => ({ alertTrialPurchaseStaff: mocks.alert }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

// A chainable fake: every filter is recorded; a select resolves through
// mocks.read(table, filters, mode), an insert through mocks.inserted(row)
// (trial_purchases only), an update through mocks.updated(table, patch, filters).
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      const filters = []
      let kind = 'select'
      let payload = null
      const settle = async (mode) => {
        if (kind === 'insert') {
          if (table !== 'trial_purchases') throw new Error(`unexpected insert into ${table}`)
          return mocks.inserted(payload)
        }
        if (kind === 'update') return (await mocks.updated(table, payload, filters)) ?? { error: null }
        return mocks.read(table, filters, mode)
      }
      const b = {
        select: () => b,
        insert: (row) => { kind = 'insert'; payload = row; return b },
        update: (patch) => { kind = 'update'; payload = patch; return b },
        maybeSingle: () => settle('one'),
        single: () => settle('one'),
        then: (res, rej) => settle('many').then(res, rej),
      }
      for (const op of ['eq', 'is', 'in', 'neq', 'not', 'ilike', 'limit', 'order']) {
        b[op] = (...args) => { filters.push([op, ...args]); return b }
      }
      return b
    },
  }),
}))

import { POST } from './route'

const SELLABLE = [{ id: 'b1', type: 'paid_trial', price_cents: 3900, currency: 'EUR', duration_days: 14, product_name: '2 Week Trial', membership_id: 'm1', plan_code: 'p1', trial_used_text: 'You have had a trial.', help_cta_label: 'Help me' }]
const HATCH_PRODUCT_ID = '674d62bf-4d4b-4231-b1ba-d53543657bea'
const HATCH_BLOCKS = [
  { id: 'h1', type: 'paid_trial', duration_days: 14, product_name: 'The UN1T Trial', un1t_product_id: HATCH_PRODUCT_ID, active_member_text: 'You are already a member.', help_cta_label: 'Help me', help_sent_text: 'The Hatch team will call you.' },
  { id: 'h2', type: 'class_funnel', terms_required_message: 'Tick the Hatch terms, please.' },
]
const BODY = { studio: 'stillorgan', first_name: 'Ava', last_name: 'Byrne', email: 'Ava@Example.com', phone: '0851234567', consent: true, lead_event_id: 'lead-abcdefgh', attribution: { utm_campaign: 'c1', ad_provider: 'meta', ad_external_id: 'ad9', fbclid: 'xyz', fbp: 'fb.1.1.2' } }
const HATCH_BODY = { ...BODY, studio: 'hatch', terms_accepted: true }
const req = (body) => new Request('http://x/api/public/trial-purchases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const freshState = () => ({
  pages: [
    { location_id: 'loc1', public_path: 'stillorgan', blocks: SELLABLE, locations: { membership_source: 'glofox' } },
    { location_id: 'loc2', public_path: 'hatch-street', blocks: HATCH_BLOCKS, locations: { membership_source: 'un1t_online' } },
  ],
  pagesError: null,
  product: { un1t_id: HATCH_PRODUCT_ID, status: 'active', price_cents: 3900, currency: 'eur', title: 'The UN1T Trial' },
  locations: {
    loc1: { id: 'loc1', name: 'Stillorgan', organization_id: 'org1', settings: {} },
    loc2: { id: 'loc2', name: 'UN1T Hatch Street', organization_id: 'org1', settings: { un1t_online: { writes_enabled: true } } },
  },
  contact: { id: 'c1', email: 'ava@example.com', name: 'Ava Byrne', first_name: 'Ava', last_name: 'Byrne', phone: '0851234567', un1t_user_id: null, glofox_member_id: 'g1', glofox_membership_status: 'active', glofox_membership_plan: 'Monthly' },
  rows: { glofox_trial_claims: [], glofox_push_events: [], trial_purchases: [], un1t_subscriptions: [], contact_memberships: [] },
  errors: {},
})
const filterValue = (filters, col) => filters.find((f) => f[0] === 'eq' && f[1] === col)?.[2]

const trialUpdates = () => mocks.updated.mock.calls.filter(([t]) => t === 'trial_purchases').map(([, patch, filters]) => ({ patch, filters }))

async function readFixture(table, filters) {
  const s = mocks.state
  if (table === 'landing_page_settings') {
    if (s.pagesError) return { data: null, error: s.pagesError }
    const path = filterValue(filters, 'public_path')
    if (path) return { data: s.pages.find((p) => p.public_path === path) || null, error: null }
    return { data: s.pages, error: null }
  }
  if (table === 'un1t_products') return { data: s.product, error: null }
  if (table === 'locations') return { data: s.locations[filterValue(filters, 'id')] || null, error: null }
  if (table === 'contacts') return { data: s.contact, error: null }
  if (table in s.rows) return { data: s.errors[table] ? null : s.rows[table], error: s.errors[table] || null }
  throw new Error(`unexpected read of ${table}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state = freshState()
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.read.mockImplementation(readFixture)
  mocks.contact.mockResolvedValue('c1')
  mocks.inserted.mockImplementation(async (row) => ({ data: { id: 'tp1', ...row }, error: null }))
  mocks.updated.mockResolvedValue({ error: null })
  mocks.payment.mockResolvedValue({ purchaseId: 'tp1', checkout: { provider: 'revolut', token: 'tok', url: null } })
  mocks.capi.mockResolvedValue({ sent: true })
  mocks.legal.mockResolvedValue({ terms: null, waiver: null, version: 'terms:1|waiver:2' })
  mocks.baseUrl.mockResolvedValue('https://www.un1tdublin.com')
  mocks.ensureAccount.mockResolvedValue({ kind: 'created', un1tUserId: 'u-77', executingContactId: 'c1' })
  mocks.checkout.mockResolvedValue({ checkoutUrl: 'https://pay.un1t.online/s/abc', free: false, ledgerId: 'led-1' })
  mocks.alert.mockResolvedValue(undefined)
})

describe('POST /api/public/trial-purchases', () => {
  it('400s a malformed body before touching the database', async () => {
    const r = await POST(req({ ...BODY, phone: 'nope' }))
    expect(r.status).toBe(400)
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('400s an unknown studio', async () => {
    for (const studio of ['HATCH', 'dundrum', undefined]) {
      const r = await POST(req({ ...BODY, studio }))
      expect(r.status).toBe(400)
    }
    const legacy = await POST(req({ ...BODY, studio: undefined, path: 'stillorgan' }))
    expect(legacy.status).toBe(400)
    expect(mocks.rateLimit).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.contact).not.toHaveBeenCalled()
  })
  it('refuses with not_configured when the page sells nothing (no Glofox product)', async () => {
    mocks.state.pages[0].blocks = [{ ...SELLABLE[0], plan_code: '' }]
    const r = await POST(req(BODY))
    expect(r.status).toBe(400)
    expect((await r.json()).code).toBe('not_configured')
    expect(mocks.contact).not.toHaveBeenCalled()
  })
  it('answers 503, not not_configured, when the landing row cannot be read', async () => {
    mocks.state.pagesError = new Error('db')
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
    // TRIALCHECKOUT.1 — the InitiateCheckout for the same moment, with the price, under the lead-derived id
    expect(mocks.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventName: 'InitiateCheckout', eventId: 'trialcheckout-lead-abcdefgh', locationId: 'loc1', value: 39, currency: 'EUR', contentType: 'product', externalId: 'c1',
    }))
    expect(mocks.capi).toHaveBeenCalledTimes(2)
  })
  it('502s when the provider checkout cannot be opened, and a failed lead capture is a 500', async () => {
    mocks.payment.mockRejectedValue(new Error('revolut down'))
    expect((await POST(req(BODY))).status).toBe(502)
    mocks.contact.mockResolvedValue(null)
    expect((await POST(req(BODY))).status).toBe(500)
  })

  // ── Stillorgan: the trial-history gate, before any money ──
  it('Stillorgan: a buyer with a trial claim gets trial_used and no row, no checkout', async () => {
    mocks.state.rows.glofox_trial_claims = [{ id: 'claim1' }]
    const r = await POST(req(BODY))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: false, code: 'trial_used', error: 'You have had a trial.', help: { cta_label: 'Help me' } })
    // the lead is still captured, against Stillorgan
    expect(mocks.contact).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc1' }))
    expect(mocks.deal).toHaveBeenCalled()
    // the history read is scoped to Stillorgan and keyed on the contact's Glofox member id
    const claimRead = mocks.read.mock.calls.find(([t]) => t === 'glofox_trial_claims')
    expect(filterValue(claimRead[1], 'location_id')).toBe('loc1')
    expect(filterValue(claimRead[1], 'glofox_member_id')).toBe('g1')
    expect(mocks.inserted).not.toHaveBeenCalled()
    expect(mocks.payment).not.toHaveBeenCalled()
    expect(mocks.ensureAccount).not.toHaveBeenCalled()
    expect(mocks.checkout).not.toHaveBeenCalled()
    // the captured lead still reaches Meta: Lead only, sharing the browser's id
    expect(mocks.capi).toHaveBeenCalledTimes(1)
    expect(mocks.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventName: 'Lead', eventId: 'lead-abcdefgh', locationId: 'loc1', externalId: 'c1' }))
    expect(mocks.capi).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventName: 'InitiateCheckout' }))
  })
  it('Stillorgan: 503 on an unreadable history', async () => {
    mocks.state.errors.glofox_trial_claims = { code: '57014' }
    const r = await POST(req(BODY))
    expect(r.status).toBe(503)
    expect((await r.json()).code).toBe('unavailable')
    expect(mocks.inserted).not.toHaveBeenCalled()
    expect(mocks.payment).not.toHaveBeenCalled()
  })
  it('Stillorgan: 503 when the matched contact cannot be re-read', async () => {
    mocks.read.mockImplementation(async (table, filters) => (table === 'contacts' ? { data: null, error: { code: '57014' } } : readFixture(table, filters)))
    const r = await POST(req(BODY))
    expect(r.status).toBe(503)
    expect((await r.json()).code).toBe('unavailable')
    expect(mocks.read.mock.calls.some(([t]) => t === 'glofox_trial_claims')).toBe(false)
    expect(mocks.inserted).not.toHaveBeenCalled()
    expect(mocks.payment).not.toHaveBeenCalled()
  })
  it("Stillorgan: a clean buyer still gets the Revolut checkout (today's shape)", async () => {
    const r = await POST(req(BODY))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: true, data: {
      purchaseId: 'tp1', checkout: { provider: 'revolut', token: 'tok', url: null }, amount_cents: 3900, currency: 'EUR', product_name: '2 Week Trial',
    } })
    expect(mocks.rateLimit).toHaveBeenCalledWith(expect.anything(), 'trialbuy:stillorgan:1.2.3.4', { max: 8, windowMs: 15 * 60_000 })
    const row = mocks.inserted.mock.calls[0][0]
    expect(row).toMatchObject({ location_id: 'loc1', landing_path: 'stillorgan', membership_id: 'm1', plan_code: 'p1', duration_days: 14, status: 'awaiting_payment' })
    expect(row).not.toHaveProperty('payment_provider')
    expect(row).not.toHaveProperty('un1t_product_id')
    expect(row).not.toHaveProperty('terms_accepted_at')
    expect(mocks.payment).toHaveBeenCalledWith(expect.objectContaining({ purchase: expect.objectContaining({ id: 'tp1' }), location: expect.objectContaining({ id: 'loc1' }), amountCents: 3900, currency: 'EUR' }))
    expect(mocks.ensureAccount).not.toHaveBeenCalled()
    expect(mocks.checkout).not.toHaveBeenCalled()
    expect(mocks.legal).not.toHaveBeenCalled()
  })

  // ── Hatch Street: un1t.online's hosted checkout, never a CRM charge ──
  it('Hatch: terms_required without the tick, and the payload names the Hatch legal paths', async () => {
    const r = await POST(req({ ...HATCH_BODY, terms_accepted: undefined }))
    expect(r.status).toBe(400)
    const j = await r.json()
    expect(j).toMatchObject({ success: false, code: 'terms_required', error: 'Tick the Hatch terms, please.' })
    expect(j.terms).toMatchObject({
      required: true,
      terms_url: '/legal/un1t/hatch-street/terms',
      waiver_url: '/legal/un1t/hatch-street/waiver',
      label: expect.stringContaining('UN1T Hatch Street'),
    })
    expect(mocks.contact).not.toHaveBeenCalled()
    expect(mocks.inserted).not.toHaveBeenCalled()
    expect(mocks.ensureAccount).not.toHaveBeenCalled()
    // funnel_enabled is not the gate: writes on with the funnel off still asks for the tick
    mocks.state.locations.loc2.settings = { un1t_online: { writes_enabled: true, funnel_enabled: false } }
    expect((await (await POST(req({ ...HATCH_BODY, terms_accepted: undefined }))).json()).code).toBe('terms_required')
  })
  it('Hatch: writes off is not_configured before the lead capture, with or without the tick', async () => {
    mocks.state.locations.loc2.settings = { un1t_online: { writes_enabled: false, funnel_enabled: true } }
    for (const body of [HATCH_BODY, { ...HATCH_BODY, terms_accepted: undefined }]) {
      const r = await POST(req(body))
      expect(r.status).toBe(400)
      expect((await r.json()).code).toBe('not_configured')
    }
    expect(mocks.contact).not.toHaveBeenCalled()
    expect(mocks.deal).not.toHaveBeenCalled()
    expect(mocks.inserted).not.toHaveBeenCalled()
    expect(mocks.ensureAccount).not.toHaveBeenCalled()
    expect(mocks.checkout).not.toHaveBeenCalled()
    expect(mocks.legal).not.toHaveBeenCalled()
    expect(mocks.capi).not.toHaveBeenCalled()
  })
  it('Hatch: an active member gets active_member and no un1t.online call', async () => {
    mocks.state.rows.contact_memberships = [{ id: 'cm1' }]
    const r = await POST(req(HATCH_BODY))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: false, code: 'active_member', error: 'You are already a member.', help: { cta_label: 'Help me' } })
    expect(mocks.contact).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc2' }))
    const read = mocks.read.mock.calls.find(([t]) => t === 'contact_memberships')
    expect(filterValue(read[1], 'location_id')).toBe('loc2')
    expect(mocks.inserted).not.toHaveBeenCalled()
    expect(mocks.ensureAccount).not.toHaveBeenCalled()
    expect(mocks.checkout).not.toHaveBeenCalled()
    expect(mocks.payment).not.toHaveBeenCalled()
    expect(mocks.capi).toHaveBeenCalledTimes(1)
    expect(mocks.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventName: 'Lead', eventId: 'lead-abcdefgh', locationId: 'loc2', externalId: 'c1' }))
    expect(mocks.capi).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventName: 'InitiateCheckout' }))
  })
  it('Hatch: 503 on an unreadable membership read, no row, no un1t.online call', async () => {
    mocks.state.errors.un1t_subscriptions = { code: '57014' }
    const r = await POST(req(HATCH_BODY))
    expect(r.status).toBe(503)
    expect((await r.json()).code).toBe('unavailable')
    expect(mocks.inserted).not.toHaveBeenCalled()
    expect(mocks.ensureAccount).not.toHaveBeenCalled()
    expect(mocks.checkout).not.toHaveBeenCalled()
  })
  it('Hatch: account + checkout → redirect_url, row stamped un1t_user_id and un1t_ledger_id, origin web_trial, success URL on /trial with the row id', async () => {
    mocks.inserted.mockImplementation(async (row) => ({ data: { id: 'tp9', ...row }, error: null }))
    const r = await POST(req(HATCH_BODY))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: true, data: {
      purchaseId: 'tp9', redirect_url: 'https://pay.un1t.online/s/abc', amount_cents: 3900, currency: 'EUR', product_name: 'The UN1T Trial',
    } })
    expect(mocks.rateLimit).toHaveBeenCalledWith(expect.anything(), 'trialbuy:hatch-street:1.2.3.4', { max: 8, windowMs: 15 * 60_000 })
    // the lead capture runs against Hatch
    expect(mocks.contact).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc2', email: 'ava@example.com' }))
    expect(mocks.tag).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: 'loc2' }))
    expect(mocks.consent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: 'loc2', source: 'paid_trial' }))
    expect(mocks.deal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: 'loc2' }))
    // the row: un1t.online provider, the mirrored price, no Glofox ids, the acceptance recorded
    const row = mocks.inserted.mock.calls[0][0]
    expect(row).toMatchObject({
      location_id: 'loc2', contact_id: 'c1', landing_path: 'hatch-street', status: 'awaiting_payment',
      payment_provider: 'un1t_online', un1t_product_id: HATCH_PRODUCT_ID, membership_id: null, plan_code: null,
      amount_cents: 3900, currency: 'EUR', product_name: 'The UN1T Trial', duration_days: 14,
      terms_source: 'website', terms_version: 'terms:1|waiver:2',
    })
    expect(Number.isNaN(Date.parse(row.terms_accepted_at))).toBe(false)
    expect(mocks.legal).toHaveBeenCalledWith(expect.anything(), 'loc2')
    // the account: the contact re-read by id, the row as the request (it carries the terms), origin web_trial
    expect(mocks.ensureAccount).toHaveBeenCalledWith(expect.anything(), {
      locationId: 'loc2', organizationId: 'org1',
      contact: expect.objectContaining({ id: 'c1', email: 'ava@example.com', first_name: 'Ava', last_name: 'Byrne', phone: '0851234567' }),
      request: expect.objectContaining({ id: 'tp9', terms_accepted_at: row.terms_accepted_at, terms_source: 'website', terms_version: 'terms:1|waiver:2' }),
      origin: 'web_trial', originRef: 'tp9', actor: null,
    })
    // the checkout: the block's product, the row-keyed idempotency key, URLs on the customer host's /trial
    expect(mocks.baseUrl).toHaveBeenCalledWith(expect.anything(), 'loc2')
    expect(mocks.checkout).toHaveBeenCalledWith(expect.anything(), {
      locationId: 'loc2', userId: 'u-77', productId: HATCH_PRODUCT_ID,
      successUrl: 'https://www.un1tdublin.com/trial?purchase=tp9&studio=hatch',
      cancelUrl: 'https://www.un1tdublin.com/trial?purchase=tp9&studio=hatch&cancelled=1',
      idempotencyKey: 'trial_purchase:tp9', origin: 'web_trial', originRef: 'tp9', actor: null,
    })
    // the stamps, in order, each scoped to the row and the studio; the URL is never stored
    const ups = trialUpdates()
    expect(ups.map((u) => u.patch)).toEqual([{ un1t_user_id: 'u-77' }, { un1t_ledger_id: 'led-1' }])
    for (const u of ups) {
      expect(filterValue(u.filters, 'id')).toBe('tp9')
      expect(filterValue(u.filters, 'location_id')).toBe('loc2')
      expect(JSON.stringify(u.patch)).not.toContain('pay.un1t.online')
    }
    expect(mocks.ensureAccount.mock.invocationCallOrder[0]).toBeLessThan(mocks.checkout.mock.invocationCallOrder[0])
    // Meta: Lead + InitiateCheckout to Hatch's dataset
    expect(mocks.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventName: 'Lead', locationId: 'loc2' }))
    expect(mocks.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventName: 'InitiateCheckout', eventId: 'trialcheckout-lead-abcdefgh', locationId: 'loc2', value: 39 }))
    expect(mocks.capi).toHaveBeenCalledTimes(2)
    expect(mocks.alert).not.toHaveBeenCalled()
  })
  it('Hatch: a refused checkout files help_requested and alerts staff', async () => {
    mocks.checkout.mockRejectedValue(new Un1tWriteRefused('purchase_limit_reached', 'already bought', { verdict: 'refused', retryable: false }))
    const r = await POST(req(HATCH_BODY))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: false, code: 'help_filed', error: 'The Hatch team will call you.' })
    const ups = trialUpdates()
    expect(ups.at(-1).patch).toEqual({ status: 'help_requested', last_error: 'un1t_checkout_refused: purchase_limit_reached' })
    expect(filterValue(ups.at(-1).filters, 'id')).toBe('tp1')
    expect(mocks.alert).toHaveBeenCalledTimes(1)
    expect(mocks.alert).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ id: 'tp1', status: 'help_requested', last_error: 'un1t_checkout_refused: purchase_limit_reached' }),
      'un1t_checkout_refused', 'purchase_limit_reached')
    expect(mocks.capi).toHaveBeenCalledTimes(1)
    expect(mocks.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventName: 'Lead', eventId: 'lead-abcdefgh', locationId: 'loc2', externalId: 'c1' }))
    expect(mocks.capi).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventName: 'InitiateCheckout' }))
  })
  it('Hatch: a retry answer marks the row failed and answers 503', async () => {
    mocks.ensureAccount.mockResolvedValue({ kind: 'retry', code: 'UN1T_RATE_BUDGET' })
    const r = await POST(req(HATCH_BODY))
    expect(r.status).toBe(503)
    expect((await r.json()).code).toBe('unavailable')
    expect(trialUpdates().map((u) => u.patch)).toEqual([{ status: 'failed', last_error: 'UN1T_RATE_BUDGET' }])
    expect(mocks.checkout).not.toHaveBeenCalled()
    expect(mocks.alert).not.toHaveBeenCalled()

    // a retryable refusal from the checkout is the same answer
    vi.clearAllMocks()
    mocks.ensureAccount.mockResolvedValue({ kind: 'existing', un1tUserId: 'u-77', executingContactId: 'c1' })
    mocks.checkout.mockRejectedValue(new Un1tWriteRefused('UN1T_RATE_BUDGET', 'busy', { verdict: 'refused', retryable: true }))
    mocks.inserted.mockImplementation(async (row) => ({ data: { id: 'tp2', ...row }, error: null }))
    mocks.updated.mockResolvedValue({ error: null })
    mocks.rateLimit.mockResolvedValue({ allowed: true })
    mocks.contact.mockResolvedValue('c1')
    const again = await POST(req(HATCH_BODY))
    expect(again.status).toBe(503)
    expect(trialUpdates().map((u) => u.patch)).toEqual([{ un1t_user_id: 'u-77' }, { status: 'failed', last_error: 'UN1T_RATE_BUDGET' }])
    expect(mocks.alert).not.toHaveBeenCalled()
  })
  it('Hatch: never calls the Revolut payment helper', async () => {
    // success, a refused account and a retry: none of them reach Revolut
    await POST(req(HATCH_BODY))
    mocks.ensureAccount.mockResolvedValueOnce({ kind: 'card', reason: 'account_ambiguous' })
    const carded = await POST(req(HATCH_BODY))
    expect((await carded.json()).code).toBe('help_filed')
    expect(trialUpdates().at(-1).patch).toEqual({ status: 'help_requested', last_error: 'un1t_account_refused: account_ambiguous' })
    mocks.ensureAccount.mockResolvedValueOnce({ kind: 'retry', code: 'UN1T_RATE_LIMITED' })
    await POST(req(HATCH_BODY))
    expect(mocks.payment).not.toHaveBeenCalled()
    // and a Hatch payment-settings shape that Revolut would refuse is not a reason to refuse here
    mocks.state.locations.loc2.settings = { ...mocks.state.locations.loc2.settings, payments: { provider: 'stripe_connect' } }
    const r = await POST(req(HATCH_BODY))
    expect(r.status).toBe(200)
    expect(mocks.payment).not.toHaveBeenCalled()
  })
})
