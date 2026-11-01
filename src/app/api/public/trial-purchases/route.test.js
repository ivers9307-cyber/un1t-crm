// PAIDTRIAL.1 / TRIALSTUDIO.6 — POST /api/public/trial-purchases: the body
// names a studio and never sets a price; a page with nothing sellable is
// refused with a machine-readable code. Stillorgan: a buyer with a trial
// history is refused BEFORE any row or checkout; a clean buyer captures the
// lead, inserts the row with the BLOCK's price and opens the Revolut payment.
// Hatch Street: no CRM charge ever; the CRM finds or creates the un1t.online
// account and hands back un1t.online's hosted checkout URL.
//
// The studio loader (the `trial` page's studio rows) and the eligibility reads
// run for real against the fake database below (one fixture list per table;
// `pages` below is one entry per studio: its public path and the paid_trial
// block fields its row on the trial page carries); the un1t.online primitives,
// the legal-documents read, the customer host and the staff alert are mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Un1tWriteRefused } from '@/lib/un1t-online-write'

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(), contact: vi.fn(), payment: vi.fn(), capi: vi.fn(), consent: vi.fn(), deal: vi.fn(), tag: vi.fn(),
  read: vi.fn(), inserted: vi.fn(), updated: vi.fn(),
  ensureAccount: vi.fn(), checkout: vi.fn(), legal: vi.fn(), baseUrl: vi.fn(), alert: vi.fn(),
  chosen: vi.fn(),
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
// CLASSFIRST.1 — the chosen class is judged by its own module (its tests
// live beside it); here it answers what a test sets.
vi.mock('@/lib/class-first-choice', async (importOriginal) => ({ ...(await importOriginal()), resolveChosenClass: mocks.chosen }))

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

vi.mock('@/lib/brands', async (importOriginal) => ({ ...(await importOriginal()), UN1T_GROUP_ORG_ID: 'org-un1t' }))
vi.mock('@/lib/landing-pages', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, resolvePublicPageRequest: vi.fn(actual.resolvePublicPageRequest), studioTermsCopy: vi.fn(async () => ({ terms_required_message: 'Tick the Hatch page terms.' })) }
})

import { POST } from './route'
import { resolvePublicPageRequest } from '@/lib/landing-pages'

const SELLABLE = [{ id: 'b1', type: 'paid_trial', price_cents: 3900, currency: 'EUR', duration_days: 14, product_name: '2 Week Trial', membership_id: 'm1', plan_code: 'p1', trial_used_text: 'You have had a trial.', help_cta_label: 'Help me' }]
const HATCH_PRODUCT_ID = '674d62bf-4d4b-4231-b1ba-d53543657bea'
const HATCH_BLOCKS = [
  { id: 'h1', type: 'paid_trial', duration_days: 14, product_name: 'The UN1T Trial', un1t_product_id: HATCH_PRODUCT_ID, active_member_text: 'You are already a member.', help_cta_label: 'Help me', help_sent_text: 'The Hatch team will call you.' },
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
  product: { un1t_id: HATCH_PRODUCT_ID, status: 'active', type: 'one_time', price_cents: 3900, currency: 'eur', title: 'The UN1T Trial' },
  locations: {
    loc1: { id: 'loc1', name: 'Stillorgan', organization_id: 'org1', settings: {} },
    loc2: { id: 'loc2', name: 'UN1T Hatch Street', organization_id: 'org1', settings: { un1t_online: { writes_enabled: true } } },
  },
  contact: { id: 'c1', email: 'ava@example.com', name: 'Ava Byrne', first_name: 'Ava', last_name: 'Byrne', phone: '0851234567', un1t_user_id: null, glofox_member_id: 'g1', glofox_membership_status: 'active', glofox_membership_plan: 'Monthly' },
  rows: { glofox_trial_claims: [], glofox_push_events: [], trial_purchases: [], un1t_subscriptions: [], contact_studios: [] },
  errors: {},
})
const filterValue = (filters, col) => filters.find((f) => f[0] === 'eq' && f[1] === col)?.[2]

const trialUpdates = () => mocks.updated.mock.calls.filter(([t]) => t === 'trial_purchases').map(([, patch, filters]) => ({ patch, filters }))

// The trial page the fixture serves: every studio's paid_trial fields are its
// own row's `offer`, over a block that carries only its id and type.
const TRIAL_PAGE = {
  id: 'p-trial', organization_id: 'org-un1t', slug: 'trial', kind: 'campaign', scope: 'all', primary_location_id: null,
  offer_type: 'paid_trial', publish_state: 'live', chrome: {}, blocks: [{ id: 'pt', type: 'paid_trial' }],
}
const trialRows = (s) => s.pages.map((p, i) => {
  const block = (p.blocks || []).find((b) => b.type === 'paid_trial') || null
  const { id: _id, type: _type, ...offer } = block || {}
  return {
    page_id: 'p-trial', location_id: p.location_id, enabled: p.enabled !== false, sort_order: i, offer, attribution: {},
    // loadTrialStudios embeds the location's settings (TRIALSTUDIO.10: a
    // un1t.online studio with its writes off is not for sale): the same
    // object the route's own locations read sees.
    locations: p.locations && { ...p.locations, settings: s.locations[p.location_id]?.settings },
  }
})

async function readFixture(table, filters) {
  const s = mocks.state
  if (table === 'landing_pages') {
    if (s.pagesError) return { data: null, error: s.pagesError }
    // studioPublicPath: the studio page of a location (its slug).
    const loc = filterValue(filters, 'primary_location_id')
    if (loc) return { data: { slug: s.pages.find((p) => p.location_id === loc)?.public_path ?? null }, error: null }
    // listStudioPageSlugs: the live studio pages of the host's organisation.
    if (filterValue(filters, 'kind') === 'studio' && filterValue(filters, 'slug') === undefined) {
      if (s.studioSlugsError) return { data: null, error: s.studioSlugsError }
      s.studioSlugReads = (s.studioSlugReads || 0) + 1
      return { data: (s.studioSlugs || ['stillorgan', 'hatch-street']).map((slug) => ({ slug })), error: null }
    }
    // loadTrialStudios: the trial page in the group organisation.
    if (filterValue(filters, 'slug') === 'trial') return { data: s.noTrialPage ? null : { ...TRIAL_PAGE, publish_state: s.trialState || 'live' }, error: null }
    throw new Error('unexpected landing_pages read')
  }
  if (table === 'landing_page_studios') {
    if (s.studiosError) return { data: null, error: s.studiosError }
    return { data: trialRows(s), error: null }
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
  mocks.chosen.mockImplementation(async (_db, { eventId }) => (eventId
    ? { ok: true, chosen: { event_id: eventId, name: 'S&C', starts_at: '2099-01-05T11:00:00.000Z' } }
    : { ok: true, chosen: null }))
})

// CLASSFIRST.1 — the class before the details.
describe('POST /api/public/trial-purchases — the chosen class', () => {
  it('no event_id: no class on the row, nothing judged beyond the empty id', async () => {
    expect((await POST(req(BODY))).status).toBe(200)
    expect(mocks.chosen).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: 'loc1', eventId: undefined }))
    const row = mocks.inserted.mock.calls[0][0]
    expect(row).not.toHaveProperty('class_event_id')
  })
  it('a chosen class is stored on the row as the SERVER saw it, for Stillorgan and for Hatch', async () => {
    expect((await POST(req({ ...BODY, event_id: 'ev-1', class_name: 'FORGED' }))).status).toBe(200)
    expect(mocks.inserted.mock.calls[0][0]).toMatchObject({ class_event_id: 'ev-1', class_name: 'S&C', class_starts_at: '2099-01-05T11:00:00.000Z' })
    expect((await POST(req({ ...HATCH_BODY, event_id: 'un1t:ev-2' }))).status).toBe(200)
    expect(mocks.chosen).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ locationId: 'loc2', eventId: 'un1t:ev-2' }))
    expect(mocks.inserted.mock.calls[1][0]).toMatchObject({ class_event_id: 'un1t:ev-2', class_name: 'S&C' })
  })
  it('a class that is gone is 400 class_unavailable before the lead, the row or any money', async () => {
    mocks.chosen.mockResolvedValueOnce({ ok: false, code: 'class_unavailable' })
    const r = await POST(req({ ...BODY, event_id: 'ev-gone' }))
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ success: false, code: 'class_unavailable' })
    expect(mocks.contact).not.toHaveBeenCalled()
    expect(mocks.inserted).not.toHaveBeenCalled()
    expect(mocks.payment).not.toHaveBeenCalled()
    expect(mocks.capi).not.toHaveBeenCalled()
  })
  it('an unreadable timetable is 503 timetable_unavailable in the block\'s words, nothing captured', async () => {
    mocks.chosen.mockResolvedValueOnce({ ok: false, code: 'timetable_unavailable' })
    mocks.state.pages[0].blocks = [{ ...SELLABLE[0], timetable_unavailable_text: 'Timetable down; buy anyway.' }]
    const r = await POST(req({ ...BODY, event_id: 'ev-1' }))
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ success: false, code: 'timetable_unavailable', error: 'Timetable down; buy anyway.' })
    expect(mocks.contact).not.toHaveBeenCalled()
    expect(mocks.inserted).not.toHaveBeenCalled()
  })
})

describe('POST /api/public/trial-purchases', () => {
  it('400s a malformed body before touching the database', async () => {
    const r = await POST(req({ ...BODY, phone: 'nope' }))
    expect(r.status).toBe(400)
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('400s an unknown studio', async () => {
    for (const studio of ['HATCH', 'dundrum', '', null]) {
      const r = await POST(req({ ...BODY, studio }))
      expect(r.status).toBe(400)
    }
    expect(mocks.rateLimit).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.contact).not.toHaveBeenCalled()
  })
  // Final review M1 — a page loaded before the studio choice shipped posts no
  // studio; it was the Stillorgan page, so it buys at Stillorgan, never a 400.
  it('a body with no studio (an old page) is a Stillorgan purchase', async () => {
    const { studio: _omit, ...legacyBody } = BODY
    const r = await POST(req({ ...legacyBody, path: 'stillorgan' }))
    expect(r.status).toBe(200)
    expect(mocks.rateLimit).toHaveBeenCalledWith(expect.anything(), 'trialbuy:stillorgan:1.2.3.4', { max: 8, windowMs: 15 * 60_000 })
    expect(mocks.inserted.mock.calls[0][0]).toMatchObject({ location_id: 'loc1', landing_path: 'stillorgan', membership_id: 'm1' })
    expect(mocks.payment).toHaveBeenCalled()
    expect(mocks.checkout).not.toHaveBeenCalled()
  })
  // Final review M5 — the insert failure is logged with ids and the code only.
  it('a failed insert is a 500 logged with ids and the code, never the error details', async () => {
    const { logError } = await import('@/lib/log')
    mocks.inserted.mockImplementation(async () => ({ data: null, error: { code: '23502', message: 'null value', details: 'Failing row contains (ava@example.com, 0851234567)' } }))
    const r = await POST(req(BODY))
    expect(r.status).toBe(500)
    expect(logError).toHaveBeenCalledWith('trialbuy', 'purchase insert failed', { code: '23502', contactId: 'c1' })
    expect(JSON.stringify(logError.mock.calls)).not.toContain('ava@example.com')
  })
  it('refuses with not_configured when the page sells nothing (no Glofox product)', async () => {
    mocks.state.pages[0].blocks = [{ ...SELLABLE[0], plan_code: '' }]
    const r = await POST(req(BODY))
    expect(r.status).toBe(400)
    expect((await r.json()).code).toBe('not_configured')
    expect(mocks.contact).not.toHaveBeenCalled()
  })
  it('answers 503, not not_configured, when the trial page cannot be read', async () => {
    mocks.state.pagesError = new Error('db')
    const r = await POST(req(BODY))
    expect(r.status).toBe(503)
    expect((await r.json()).code).toBe('unavailable')
    mocks.state.pagesError = null
    mocks.state.studiosError = new Error('db')
    expect((await POST(req(BODY))).status).toBe(503)
  })
  it('no page: the studio key names a row of the live trial page; no trial page, a draft one or a switched-off row is not_configured, never a 503', async () => {
    const ok = await POST(req(BODY))
    expect(ok.status).toBe(200)
    expect(mocks.read.mock.calls.some(([t]) => t === 'landing_page_studios')).toBe(true)
    const trialRead = mocks.read.mock.calls.find(([t, f]) => t === 'landing_pages' && f.some((x) => x[1] === 'slug'))
    expect(trialRead[1]).toContainEqual(['eq', 'organization_id', 'org-un1t'])
    expect(trialRead[1]).toContainEqual(['eq', 'slug', 'trial'])
    mocks.contact.mockClear()
    for (const patch of [{ noTrialPage: true }, { trialState: 'draft' }, { trialState: 'retired' }]) {
      mocks.state = { ...freshState(), ...patch }
      const r = await POST(req(BODY))
      expect([r.status, (await r.json()).code]).toEqual([400, 'not_configured'])
    }
    mocks.state = freshState()
    mocks.state.pages[0].enabled = false
    const off = await POST(req(BODY))
    expect([off.status, (await off.json()).code]).toEqual([400, 'not_configured'])
    expect(mocks.contact).not.toHaveBeenCalled()
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

  it('a Stillorgan buyer from /stillorgan has the Revolut order return there', async () => {
    const r = await POST(req({ ...BODY, return_path: '/stillorgan' }))
    expect(r.status).toBe(200)
    expect(mocks.payment).toHaveBeenCalledWith(expect.objectContaining({ returnPath: '/stillorgan' }))
  })
  it("a studio slug of the host's org is accepted; another org's or an unknown path is /trial (read once, scoped to the host's org, live studio pages only)", async () => {
    mocks.state.studioSlugs = ['stillorgan', 'dundrum']
    await POST(req({ ...BODY, return_path: '/dundrum' }))
    expect(mocks.payment).toHaveBeenLastCalledWith(expect.objectContaining({ returnPath: '/dundrum' }))
    expect(mocks.state.studioSlugReads).toBe(1)
    const read = mocks.read.mock.calls.find(([t, f]) => t === 'landing_pages' && f.some((x) => x[1] === 'kind'))
    expect(read[1]).toContainEqual(['eq', 'organization_id', 'org-un1t'])
    expect(read[1]).toContainEqual(['eq', 'kind', 'studio'])
    expect(read[1]).toContainEqual(['eq', 'publish_state', 'live'])
    await POST(req({ ...BODY, return_path: '/hatch-street' }))
    expect(mocks.payment).toHaveBeenLastCalledWith(expect.objectContaining({ returnPath: '/trial' }))
    await POST(req({ ...BODY, return_path: '/50plus' }))
    expect(mocks.payment).toHaveBeenLastCalledWith(expect.objectContaining({ returnPath: '/trial' }))
  })
  it('a failed studio-slug read never fails the purchase: the return path is /trial', async () => {
    mocks.state.studioSlugsError = new Error('db')
    const r = await POST(req({ ...BODY, return_path: '/stillorgan' }))
    expect(r.status).toBe(200)
    expect(mocks.payment).toHaveBeenCalledWith(expect.objectContaining({ returnPath: '/trial' }))
  })
  it('a body with no return_path, or /trial, reads no studio pages', async () => {
    await POST(req(BODY))
    await POST(req({ ...BODY, return_path: '/trial' }))
    expect(mocks.state.studioSlugReads).toBeUndefined()
  })
  it('an unknown return_path falls back to /trial', async () => {
    const r = await POST(req({ ...BODY, return_path: '/evil' }))
    expect(r.status).toBe(200)
    expect(mocks.payment).toHaveBeenCalledWith(expect.objectContaining({ returnPath: '/trial' }))
  })
  it('a body with no return_path keeps the Revolut order on /trial', async () => {
    await POST(req(BODY))
    expect(mocks.payment).toHaveBeenCalledWith(expect.objectContaining({ returnPath: '/trial' }))
  })
  it('a Hatch buyer from /hatch-street is sent back there by un1t.online', async () => {
    mocks.inserted.mockImplementation(async (row) => ({ data: { id: 'tp9', ...row }, error: null }))
    const r = await POST(req({ ...HATCH_BODY, return_path: '/hatch-street' }))
    expect(r.status).toBe(200)
    expect(mocks.checkout).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      successUrl: 'https://www.un1tdublin.com/hatch-street?purchase=tp9&studio=hatch',
      cancelUrl: 'https://www.un1tdublin.com/hatch-street?purchase=tp9&studio=hatch&cancelled=1',
    }))
  })

  // ── Hatch Street: un1t.online's hosted checkout, never a CRM charge ──
  it('Hatch: terms_required without the tick, and the payload names the Hatch legal paths', async () => {
    const r = await POST(req({ ...HATCH_BODY, terms_accepted: undefined }))
    expect(r.status).toBe(400)
    const j = await r.json()
    expect(j).toMatchObject({ success: false, code: 'terms_required', error: 'Tick the Hatch page terms.' })
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
    mocks.state.rows.contact_studios = [{ id: 'cm1' }]
    const r = await POST(req(HATCH_BODY))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: false, code: 'active_member', error: 'You are already a member.', help: { cta_label: 'Help me' } })
    expect(mocks.contact).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc2' }))
    const read = mocks.read.mock.calls.find(([t]) => t === 'contact_studios')
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

// PAGES.1 — `page` + `studio`: the studio's entry is built from the page's
// studio row (its merged paid_trial block, its location embed), the price is
// the row's (Hatch: the mirrored product's), the attribution the row's, and
// the row records the page. The body's studio key and any price are ignored.
describe('POST /api/public/trial-purchases — page (PAGES.1)', () => {
  const hatchRow = (settings = { un1t_online: { writes_enabled: true } }) => ({
    page_id: 'page-trial', location_id: 'loc2', enabled: true, sort_order: 1,
    offer: { un1t_product_id: HATCH_PRODUCT_ID }, attribution: { lead_source: 'meta_trial_hatch' },
    locations: { id: 'loc2', name: 'UN1T Hatch Street', membership_source: 'un1t_online', settings },
  })
  const pageOk = (studioRow, blocks, extra = {}) => ({
    ok: true, pageId: 'page-trial', page: { id: 'page-trial', slug: 'trial', offer_type: 'paid_trial' }, studioRow,
    locationId: studioRow.location_id, publicPath: studioRow.location_id === 'loc2' ? 'hatch-street' : 'stillorgan', blocks,
    attribution: { tag: studioRow.location_id === 'loc2' ? 'hatch-street-trial' : 'stillorgan-trial', lead_source: studioRow.attribution.lead_source || 'meta_trial' },
    ...extra,
  })

  it("?page=trial&studio=hatch-street buys Hatch's product and stamps page_id", async () => {
    const row = hatchRow()
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk(row, [{ id: 'pt', type: 'paid_trial', heading: 'H', duration_days: 14, product_name: 'The UN1T Trial', un1t_product_id: HATCH_PRODUCT_ID }]))
    const r = await POST(req({ ...HATCH_BODY, studio: 'hatch-street', page: 'trial', price_cents: 1, amount_cents: 1, tag: 'evil' }))
    expect(r.status).toBe(200)
    expect(resolvePublicPageRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ page: 'trial', studio: 'hatch-street' }))
    expect(mocks.rateLimit).toHaveBeenCalledWith(expect.anything(), 'trialbuy:hatch-street:1.2.3.4', { max: 8, windowMs: 15 * 60_000 })
    expect(mocks.inserted.mock.calls[0][0]).toMatchObject({
      page_id: 'page-trial', location_id: 'loc2', landing_path: 'hatch-street', payment_provider: 'un1t_online',
      un1t_product_id: HATCH_PRODUCT_ID, amount_cents: 3900,
    })
    expect(mocks.tag).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: 'hatch-street-trial' }))
    expect(mocks.updated).toHaveBeenCalledWith('contacts', { lead_source: 'meta_trial_hatch' }, expect.anything())
    expect(mocks.payment).not.toHaveBeenCalled()
  })

  it('a Glofox studio on the page buys at the row price through Revolut', async () => {
    const row = { page_id: 'page-trial', location_id: 'loc1', enabled: true, sort_order: 0, offer: {}, attribution: {}, locations: { id: 'loc1', name: 'Stillorgan', membership_source: 'glofox', settings: {} } }
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk(row, [{ ...SELLABLE[0], price_cents: 4900 }]))
    const r = await POST(req({ ...BODY, page: 'trial', studio: 'stillorgan' }))
    expect(r.status).toBe(200)
    expect(mocks.inserted.mock.calls[0][0]).toMatchObject({ page_id: 'page-trial', location_id: 'loc1', amount_cents: 4900, membership_id: 'm1', landing_path: 'stillorgan' })
    expect(mocks.payment).toHaveBeenCalled()
  })

  it("a studio page's purchase is priced from the studio page's row, even with the /trial page unpublished", async () => {
    // The card on /stillorgan posts { page: 'stillorgan', studio: 'stillorgan' }; the resolver answers the studio page.
    const row = { page_id: 'page-studio', location_id: 'loc1', enabled: true, sort_order: 0, offer: { membership_id: 'm9', plan_code: 'p9', price_cents: 5900, product_name: 'Studio Page Trial' }, attribution: {}, locations: { id: 'loc1', name: 'Stillorgan', membership_source: 'glofox', settings: {} } }
    mocks.state.noTrialPage = true
    resolvePublicPageRequest.mockResolvedValueOnce({
      ok: true, pageId: 'page-studio', page: { id: 'page-studio', slug: 'stillorgan', kind: 'studio', offer_type: 'paid_trial' }, studioRow: row,
      locationId: 'loc1', publicPath: 'stillorgan', blocks: [{ id: 'pt', type: 'paid_trial', duration_days: 14, ...row.offer }],
      // A studio page's attribution holds only the row's own values (none here).
      attribution: {}, terms: {},
    })
    const r = await POST(req({ ...BODY, page: 'stillorgan', studio: 'stillorgan', price_cents: 1 }))
    expect(r.status).toBe(200)
    expect(resolvePublicPageRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ page: 'stillorgan', studio: 'stillorgan' }))
    expect(mocks.inserted.mock.calls[0][0]).toMatchObject({ page_id: 'page-studio', location_id: 'loc1', amount_cents: 5900, membership_id: 'm9', plan_code: 'p9', landing_path: 'stillorgan' })
    // Nothing read the trial page: the studio page's own row priced it.
    expect(mocks.read.mock.calls.some(([t, f]) => t === 'landing_pages' && f.some((x) => x[1] === 'slug' && x[2] === 'trial'))).toBe(false)
    expect(mocks.read.mock.calls.some(([t]) => t === 'landing_page_studios')).toBe(false)
    expect(mocks.payment).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5900 }))
    // Spec §9: paidTrialConfigFromBlocks' defaults, as before PAGES.1 (never stillorgan-stillorgan).
    expect(mocks.tag).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: 'stillorgan-trial' }))
    expect(mocks.updated).toHaveBeenCalledWith('contacts', { lead_source: 'meta_trial' }, expect.anything())
    expect(mocks.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventSourceUrl: 'https://www.un1tdublin.com/trial' }))
  })

  it('the terms tick on a page uses the studio terms wording', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk(hatchRow(), [{ id: 'pt', type: 'paid_trial', duration_days: 14, product_name: 'The UN1T Trial', un1t_product_id: HATCH_PRODUCT_ID }]))
    const r = await POST(req({ ...HATCH_BODY, terms_accepted: undefined, page: 'trial', studio: 'hatch-street' }))
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ code: 'terms_required', error: 'Tick the Hatch page terms.' })
  })

  it('refusals: not_found 404, studio_required 400, unreadable 503, a non-trial page 404, a page with nothing for sale not_configured', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect((await POST(req({ ...BODY, page: 'trial', studio: 'galway' }))).status).toBe(404)
    resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason: 'studio_required' })
    expect((await POST(req({ ...BODY, studio: undefined, page: 'trial' }))).status).toBe(400)
    resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason: 'unreadable' })
    expect((await POST(req({ ...BODY, page: 'trial' }))).status).toBe(503)
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk(hatchRow(), [{ type: 'corp_promo' }], { page: { id: 'p', slug: 'corp', offer_type: 'promo_credits' } }))
    expect((await POST(req({ ...BODY, page: 'corp' }))).status).toBe(404)
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk(hatchRow({ un1t_online: { writes_enabled: false } }), [{ id: 'pt', type: 'paid_trial', un1t_product_id: HATCH_PRODUCT_ID }]))
    const off = await POST(req({ ...HATCH_BODY, page: 'trial', studio: 'hatch-street' }))
    expect(off.status).toBe(400)
    expect((await off.json()).code).toBe('not_configured')
    expect(mocks.contact).not.toHaveBeenCalled()
    expect(mocks.inserted).not.toHaveBeenCalled()
  })
})
