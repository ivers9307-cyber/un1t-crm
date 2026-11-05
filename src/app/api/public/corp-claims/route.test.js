// CORPPROMO.1 — POST /api/public/corp-claims. The promo decides the studio,
// credits and expiry; refusals land before anything reaches un1t.online.
// Without `page` the promo's public path names its studio page (the resolver's
// legacy branch, mocked here: its own tests live beside it).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  rateLimit: vi.fn(), contact: vi.fn(), capi: vi.fn(), consent: vi.fn(), deal: vi.fn(), tag: vi.fn(),
  membership: vi.fn(), eligibility: vi.fn(), fulfil: vi.fn(), legal: vi.fn(), chosen: vi.fn(),
  reads: {}, readErrors: {}, inserted: vi.fn(), updates: [],
  gElig: vi.fn(), gFulfil: vi.fn(), gPlan: vi.fn(), gCreds: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: m.rateLimit, getClientIp: () => '1.2.3.4', rateLimitResponse: () => new Response('rate', { status: 429 }) }))
// MOBILEFUNNEL.1 — the route reads the outcome form; `m.created` says whether this POST made the contact.
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: m.contact, findOrCreateRaceContactWithOutcome: async (a) => ({ contactId: await m.contact(a), created: m.created === true }) }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: m.capi, fbcFromFbclid: () => null }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: m.consent }))
vi.mock('@/lib/waitlist-entry', () => ({ placeWaitlistEntry: m.deal }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: m.tag }))
vi.mock('@/lib/trial-eligibility', () => ({ hatchActiveMembership: m.membership }))
vi.mock('@/lib/corp-promo-eligibility', () => ({ corpPromoEligibility: m.eligibility }))
vi.mock('@/lib/corp-promo-claim', () => ({ fulfilCorpPromoClaim: m.fulfil }))
// NEWSTART.1 — the Glofox branch. The shipped registry keeps the promo off, so the
// tests present it live with plan ids (controller ruling 3).
vi.mock('@/lib/corp-promos', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, resolveCorpPromo: (k) => (k === 'stillorgan-newstart' ? { ...actual.CORP_PROMOS[k], live: true } : actual.resolveCorpPromo(k)) }
})
vi.mock('@/lib/corp-promo-glofox-plans', () => ({ glofoxPlanForPromo: m.gPlan }))
vi.mock('@/lib/corp-promo-eligibility-glofox', () => ({ glofoxCorpPromoEligibility: m.gElig }))
vi.mock('@/lib/corp-promo-claim-glofox', () => ({ fulfilGlofoxCorpPromoClaim: m.gFulfil }))
vi.mock('@/lib/glofox', async (importOriginal) => ({ ...(await importOriginal()), glofoxCredentialsForLocation: m.gCreds }))
vi.mock('@/lib/un1t-online-legal', () => ({ readUn1tLegalDocs: m.legal }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
// CLASSFIRST.1 — the chosen class is judged by its own module (tested beside it).
vi.mock('@/lib/class-first-choice', async (importOriginal) => ({ ...(await importOriginal()), resolveChosenClass: m.chosen }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      let kind = 'select'
      let payload = null
      const settle = async () => {
        if (kind === 'insert') return m.inserted(table, payload)
        if (kind === 'update') { m.updates.push({ table, payload }); return { error: null } }
        if (m.readErrors[table]) return { data: null, error: m.readErrors[table] }
        return { data: m.reads[table] ?? null, error: null }
      }
      const q = {
        select: () => q,
        insert: (p) => { kind = 'insert'; payload = p; return q },
        update: (p) => { kind = 'update'; payload = p; return q },
        maybeSingle: settle, single: settle,
        then: (ok, no) => settle().then(ok, no),
      }
      for (const op of ['eq', 'is', 'in', 'order', 'limit']) q[op] = () => q
      return q
    },
  }),
}))

vi.mock('@/lib/landing-pages', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, resolvePublicPageRequest: vi.fn() }
})

import { POST } from './route'
import { resolvePublicPageRequest } from '@/lib/landing-pages'

const LOC = 'loc-hatch'
// The resolver's answer for the promo's studio page (the legacy, no-page branch).
const studioPageOk = (extra = {}) => ({
  ok: true, pageId: 'page-hatch', page: { id: 'page-hatch', slug: 'hatch-street', kind: 'studio' },
  studioRow: { location_id: LOC, enabled: true, offer: {}, attribution: {} },
  locationId: LOC, publicPath: 'hatch-street', blocks: [], attribution: {}, terms: {}, ...extra,
})
const BODY = { promo: 'hatch-3-free', first_name: 'Ann', last_name: 'Byrne', email: 'Ann@Work.ie', phone: '0871234567', consent: true, terms_accepted: true }
const req = (body) => new Request('http://x/api/public/corp-claims', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const call = async (body = BODY) => { const r = await POST(req(body)); return { status: r.status, json: await r.json() } }

beforeEach(() => {
  vi.clearAllMocks()
  m.created = false
  m.updates = []
  m.readErrors = {}
  m.reads = {
    locations: { id: LOC, name: 'UN1T Hatch Street', organization_id: 'org-1', timezone: 'Europe/Dublin', settings: { un1t_online: { writes_enabled: true, trial_product_id: 'tp' } } },
    contacts: { id: 'c-1', email: 'ann@work.ie', first_name: 'Ann', last_name: 'Byrne' },
  }
  resolvePublicPageRequest.mockReset()
  resolvePublicPageRequest.mockResolvedValue(studioPageOk())
  m.rateLimit.mockResolvedValue({ allowed: true })
  m.contact.mockResolvedValue('c-1')
  m.membership.mockResolvedValue({ ok: true, active: false })
  m.eligibility.mockResolvedValue({ ok: true, eligible: true })
  m.legal.mockResolvedValue({ version: 'v3' })
  m.inserted.mockImplementation(async (table, row) => ({ data: { id: 'claim-1', ...row }, error: null }))
  m.gPlan.mockReturnValue({ membershipId: 'mem-1', planCode: 'plan-1', planName: 'New Start' })
  m.gCreds.mockResolvedValue({ branchId: 'b', apiKey: 'k', apiToken: 't' })
  m.gElig.mockResolvedValue({ ok: true, eligible: true })
  m.gFulfil.mockResolvedValue({ kind: 'granted', credits: 3, expiresAt: null })
  m.fulfil.mockResolvedValue({ kind: 'granted', credits: 3, expiresAt: '2026-11-04T10:00:00.000Z' })
  m.chosen.mockImplementation(async (_db, { eventId }) => (eventId
    ? { ok: true, chosen: { event_id: eventId, name: 'RALLY', starts_at: '2099-01-07T18:00:00.000Z' } }
    : { ok: true, chosen: null }))
})

// CLASSFIRST.1 — the class before the details.
describe('POST /api/public/corp-claims — the chosen class', () => {
  it('a chosen class is stored on the claim as the server saw it and reaches the fulfilment', async () => {
    const { status } = await call({ ...BODY, event_id: 'un1t:ev-7', class_name: 'FORGED' })
    expect(status).toBe(200)
    expect(m.chosen).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: LOC, eventId: 'un1t:ev-7' }))
    expect(m.inserted).toHaveBeenCalledWith('corp_promo_claims', expect.objectContaining({ class_event_id: 'un1t:ev-7', class_name: 'RALLY', class_starts_at: '2099-01-07T18:00:00.000Z' }))
    expect(m.fulfil).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ claim: expect.objectContaining({ class_event_id: 'un1t:ev-7' }) }))
  })
  it('no event_id: no class columns on the claim', async () => {
    await call()
    expect(m.inserted.mock.calls[0][1]).not.toHaveProperty('class_event_id')
  })
  it('a gone class is 400 class_unavailable, an unreadable timetable 503 in the block words; nothing captured either way', async () => {
    m.chosen.mockResolvedValueOnce({ ok: false, code: 'class_unavailable' })
    let r = await call({ ...BODY, event_id: 'x' })
    expect(r.status).toBe(400)
    expect(r.json).toMatchObject({ success: false, code: 'class_unavailable' })
    m.chosen.mockResolvedValueOnce({ ok: false, code: 'timetable_unavailable' })
    resolvePublicPageRequest.mockResolvedValueOnce(studioPageOk({ blocks: [{ type: 'corp_promo', timetable_unavailable_text: 'Down, claim anyway.' }] }))
    r = await call({ ...BODY, event_id: 'x' })
    expect(r.status).toBe(503)
    expect(r.json).toEqual({ success: false, code: 'timetable_unavailable', error: 'Down, claim anyway.' })
    expect(m.contact).not.toHaveBeenCalled()
    expect(m.inserted).not.toHaveBeenCalled()
    expect(m.fulfil).not.toHaveBeenCalled()
  })
})

// MOBILEFUNNEL.1 — consent is optional and starts unticked (src/lib/offer-form-consent.js).
describe('POST /api/public/corp-claims — marketing consent', () => {
  it('ticked: opts in', async () => {
    const { status } = await call({ ...BODY, consent: true })
    expect(status).toBe(200)
    expect(m.consent).toHaveBeenCalledTimes(1)
    expect(m.consent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: 'c-1', consent: true, source: 'corp_promo', locationId: LOC }))
  })
  it('unticked and the contact was created by this claim: opts out (a new contact defaults to on)', async () => {
    m.created = true
    const { status, json } = await call({ ...BODY, consent: false })
    expect(status).toBe(200)
    expect(json.success).toBe(true)
    expect(m.consent).toHaveBeenCalledTimes(1)
    expect(m.consent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: 'c-1', consent: false, source: 'corp_promo', locationId: LOC }))
  })
  it('unticked (or absent) and the contact already existed: the claim succeeds and no consent is written', async () => {
    const { consent: _drop, ...noConsent } = BODY
    for (const body of [{ ...BODY, consent: false }, noConsent]) {
      m.consent.mockClear()
      const { status, json } = await call(body)
      expect(status).toBe(200)
      expect(json.success).toBe(true)
      expect(m.consent).not.toHaveBeenCalled()
    }
  })
})

describe('POST /api/public/corp-claims', () => {
  it('granted: 3 credits, the expiry, the done words; the claim row is processing first, terms recorded', async () => {
    const { status, json } = await call()
    expect(status).toBe(200)
    expect(json).toMatchObject({ success: true, data: { credits: 3, expires_at: '2026-11-04T10:00:00.000Z' } })
    expect(json.data.message).toContain('Wednesday, 4 November')
    expect(m.inserted).toHaveBeenCalledWith('corp_promo_claims', expect.objectContaining({
      location_id: LOC, contact_id: 'c-1', promo_key: 'hatch-3-free', customer_email: 'ann@work.ie', status: 'processing', terms_source: 'website', terms_version: 'v3',
    }))
    // No page: the promo's public path names the studio page; the claim came from the promo's own form.
    expect(resolvePublicPageRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ legacyPath: 'hatch-street' }))
    expect(resolvePublicPageRequest.mock.calls[0][1].page).toBeUndefined()
    expect(m.inserted.mock.calls[0][1]).not.toHaveProperty('page_id')
    expect(m.fulfil).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ promo: expect.objectContaining({ credits: 3, expiresInDays: 7 }), trialProductId: 'tp' }))
    expect(m.tag).toHaveBeenCalledWith(expect.anything(), { contactId: 'c-1', locationId: LOC, tag: 'hatch-corp-promo' })
    expect(m.consent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: 'corp_promo', locationId: LOC }))
    expect(m.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventName: 'Lead' }))
  })

  it('an unknown promo: 400 not_available, nothing captured', async () => {
    const { status, json } = await call({ ...BODY, promo: 'nope' })
    expect([status, json.code]).toEqual([400, 'not_available'])
    expect(m.contact).not.toHaveBeenCalled()
  })

  it('writes off at the studio: 400 not_available, nothing captured', async () => {
    m.reads.locations.settings = { un1t_online: { writes_enabled: false } }
    const { status, json } = await call()
    expect([status, json.code]).toEqual([400, 'not_available'])
    expect(m.contact).not.toHaveBeenCalled()
  })

  it('no terms tick: 400 terms_required with the words, nothing captured', async () => {
    const { status, json } = await call({ ...BODY, terms_accepted: false })
    expect([status, json.code]).toEqual([400, 'terms_required'])
    expect(json.terms).toBeTruthy()
    expect(m.contact).not.toHaveBeenCalled()
  })

  it('an unreadable studio page or location: 503; no studio page for the promo: 400 not_available', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason: 'unreadable' })
    expect((await call()).status).toBe(503)
    resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    const none = await call()
    expect([none.status, none.json.code]).toEqual([400, 'not_available'])
    m.readErrors.locations = { code: '57014' }
    expect((await call()).status).toBe(503)
    expect(m.contact).not.toHaveBeenCalled()
  })

  it("the studio page's words and terms wording come through: the corp_promo block's copy and its chrome terms", async () => {
    resolvePublicPageRequest.mockResolvedValue(studioPageOk({
      blocks: [{ type: 'corp_promo', promo_key: 'hatch-3-free', active_member_text: 'Studio words for members' }],
      terms: { terms_required_message: 'Tick the studio terms.' },
    }))
    m.membership.mockResolvedValue({ ok: true, active: true })
    expect((await call()).json.error).toBe('Studio words for members')
    const noTick = await call({ ...BODY, terms_accepted: false })
    expect([noTick.status, noTick.json.code, noTick.json.error]).toEqual([400, 'terms_required', 'Tick the studio terms.'])
  })

  it('an active member: 200 active_member, no claim row', async () => {
    m.membership.mockResolvedValue({ ok: true, active: true })
    const { status, json } = await call()
    expect([status, json.code]).toEqual([200, 'active_member'])
    expect(m.inserted).not.toHaveBeenCalled()
  })

  it.each([
    ['trained', 'trained with us at UN1T Hatch Street'],
    ['free_trial_used', 'already had a free trial'],
    ['already_claimed', 'already claimed this offer'],
  ])('not eligible (%s): 200 with the words, no claim row, nothing to un1t.online', async (reason, words) => {
    m.eligibility.mockResolvedValue({ ok: true, eligible: false, reason })
    const { status, json } = await call()
    expect([status, json.code]).toEqual([200, reason])
    expect(json.error).toContain(words)
    expect(m.inserted).not.toHaveBeenCalled()
    expect(m.fulfil).not.toHaveBeenCalled()
  })

  it('the eligibility read fails: 503, never a refusal or a grant', async () => {
    m.eligibility.mockResolvedValue({ ok: false })
    expect((await call()).status).toBe(503)
    expect(m.fulfil).not.toHaveBeenCalled()
  })

  it('the person matched by email or mobile is passed to eligibility', async () => {
    await call()
    expect(m.eligibility).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ email: 'ann@work.ie', phone: '0871234567', promoKey: 'hatch-3-free', organizationId: 'org-1' }))
  })

  it('help filed: 200 help_filed with the words; a retry: 503', async () => {
    m.fulfil.mockResolvedValueOnce({ kind: 'help_filed' })
    expect((await call()).json.code).toBe('help_filed')
    m.fulfil.mockResolvedValueOnce({ kind: 'unavailable' })
    expect((await call()).status).toBe(503)
  })

  it('the claim insert fails: 503, no fulfilment', async () => {
    m.inserted.mockResolvedValue({ data: null, error: { code: '42P01' } })
    expect((await call()).status).toBe(503)
    expect(m.fulfil).not.toHaveBeenCalled()
  })
})

// PAGES.1 — `page`: the promo is the one the page's studio row names (the
// registry still decides credits and expiry); a body `promo` that names
// another is not_found, and the claim records the page.
describe('POST /api/public/corp-claims — page (PAGES.1)', () => {
  const pageOk = (extra = {}) => ({
    ok: true, pageId: 'page-corp', page: { id: 'page-corp', slug: 'corp', offer_type: 'promo_credits' },
    studioRow: { location_id: LOC, enabled: true, offer: { promo_key: 'hatch-3-free' }, attribution: {} },
    locationId: LOC, publicPath: 'hatch-street', blocks: [{ type: 'corp_promo', promo_key: 'hatch-3-free', heading: 'Corp' }],
    attribution: { tag: 'hatch-street-corp', lead_source: 'meta_corp' }, terms: {}, ...extra,
  })

  it('page=corp claims the row\'s promo_key; a body promo_key is ignored', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk())
    const { promo: _omit, ...noPromo } = BODY
    const { status, json } = await call({ ...noPromo, page: 'corp', studio: 'hatch-street', promo_key: 'other', credits: 99 })
    expect(status).toBe(200)
    expect(json.data.credits).toBe(3)
    expect(resolvePublicPageRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ page: 'corp', studio: 'hatch-street' }))
    expect(m.rateLimit).toHaveBeenCalledWith(expect.anything(), 'corpclaim:hatch-3-free:1.2.3.4', expect.anything())
    expect(m.inserted).toHaveBeenCalledWith('corp_promo_claims', expect.objectContaining({ page_id: 'page-corp', location_id: LOC, promo_key: 'hatch-3-free' }))
    expect(m.fulfil).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ promo: expect.objectContaining({ key: 'hatch-3-free', credits: 3, expiresInDays: 7 }) }))
    // No row attribution: the registry's tag and lead source, as /corp has always written.
    expect(m.tag).toHaveBeenCalledWith(expect.anything(), { contactId: 'c-1', locationId: LOC, tag: 'hatch-corp-promo' })
    expect(m.updates).toContainEqual({ table: 'contacts', payload: { lead_source: 'corp_promo' } })

    // The same promo named in the body is fine; another one is not_found.
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk())
    expect((await call({ ...BODY, page: 'corp' })).status).toBe(200)
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk())
    const other = await call({ ...BODY, promo: 'hatch-10-free', page: 'corp' })
    expect(other).toEqual({ status: 404, json: { success: false, error: 'not_found' } })
  })

  it("the row's own tag and lead source win over the registry's", async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ studioRow: { location_id: LOC, offer: { promo_key: 'hatch-3-free' }, attribution: { tag: 'row-tag', lead_source: 'row-src' } } }))
    const { promo: _omit, ...noPromo } = BODY
    expect((await call({ ...noPromo, page: 'corp' })).status).toBe(200)
    expect(m.tag).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: 'row-tag' }))
    expect(m.updates).toContainEqual({ table: 'contacts', payload: { lead_source: 'row-src' } })
  })

  it('the terms tick on a page uses the studio terms wording', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ terms: { terms_required_message: 'Tick the studio terms.' } }))
    const { status, json } = await call({ ...BODY, terms_accepted: false, page: 'corp' })
    expect([status, json.code, json.error]).toEqual([400, 'terms_required', 'Tick the studio terms.'])
  })

  it('refusals: not_found 404, unreadable 503, a non-promo page 404, a row naming no live promo not_available', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect((await call({ ...BODY, page: 'corp' })).status).toBe(404)
    resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason: 'unreadable' })
    expect((await call({ ...BODY, page: 'corp' })).status).toBe(503)
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ page: { id: 'p', slug: 'trial', offer_type: 'paid_trial' } }))
    expect((await call({ ...BODY, page: 'trial' })).status).toBe(404)
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ blocks: [{ type: 'corp_promo', promo_key: 'nope' }] }))
    const { promo: _omit, ...noPromo } = BODY
    const bad = await call({ ...noPromo, page: 'corp' })
    expect([bad.status, bad.json.code]).toEqual([400, 'not_available'])
    expect(m.contact).not.toHaveBeenCalled()
    expect(m.inserted).not.toHaveBeenCalled()
  })

  it('without page a body with no promo is a 400', async () => {
    const { promo: _omit, ...noPromo } = BODY
    expect((await call(noPromo)).status).toBe(400)
  })
})

// NEWSTART.1 — a Glofox promo: no terms tick, no waitlist placement, its own
// eligibility and fulfilment; Hatch's un1t.online flow is untouched.
describe('POST /api/public/corp-claims — Glofox promo (NEWSTART.1)', () => {
  const GLOC = 'loc-still'
  const GBODY = { promo: 'stillorgan-newstart', first_name: 'Ann', last_name: 'Byrne', email: 'Ann@Work.ie', phone: '0871234567', consent: true }
  beforeEach(() => {
    m.reads.locations = { id: GLOC, name: 'UN1T Stillorgan', organization_id: 'org-1', timezone: 'Europe/Dublin', settings: {} }
    resolvePublicPageRequest.mockResolvedValue(studioPageOk({ locationId: GLOC, publicPath: 'stillorgan' }))
  })

  it('granted without a terms tick: the Glofox fulfilment runs, not the un1t one, and no waitlist placement', async () => {
    const { status, json } = await call(GBODY)
    expect(status).toBe(200)
    expect(json).toMatchObject({ success: true, data: { credits: 3, expires_at: null } })
    expect(json.data.message).not.toContain('un1t.online')
    expect(m.gFulfil).toHaveBeenCalledTimes(1)
    expect(m.gFulfil.mock.calls[0][1]).toMatchObject({ promo: expect.objectContaining({ key: 'stillorgan-newstart' }) })
    expect(m.fulfil).not.toHaveBeenCalled()
    expect(m.deal).not.toHaveBeenCalled()
    expect(m.legal).not.toHaveBeenCalled()
    expect(m.membership).not.toHaveBeenCalled()
    expect(m.eligibility).not.toHaveBeenCalled()
    const row = m.inserted.mock.calls[0][1]
    expect(row).not.toHaveProperty('terms_accepted_at')
    expect(row).not.toHaveProperty('terms_source')
    expect(row).not.toHaveProperty('terms_version')
    expect(m.gElig).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ promoKey: 'stillorgan-newstart', locationId: GLOC }))
  })

  it('no plan ids: 400 not_available before any write', async () => {
    m.gPlan.mockReturnValue(null)
    const { status, json } = await call(GBODY)
    expect([status, json.code]).toEqual([400, 'not_available'])
    expect(m.contact).not.toHaveBeenCalled()
    expect(m.inserted).not.toHaveBeenCalled()
  })

  it('credentials unreadable: 503; missing: 400 not_available; nothing captured', async () => {
    m.gCreds.mockResolvedValueOnce({ readError: 'x' })
    expect((await call(GBODY)).status).toBe(503)
    m.gCreds.mockResolvedValueOnce({ branchId: 'b' })
    const r = await call(GBODY)
    expect([r.status, r.json.code]).toEqual([400, 'not_available'])
    expect(m.contact).not.toHaveBeenCalled()
  })

  it('eligibility: unreadable 503, active member, already claimed, in progress', async () => {
    m.gElig.mockResolvedValueOnce({ ok: false })
    expect((await call(GBODY)).status).toBe(503)
    m.gElig.mockResolvedValueOnce({ ok: true, eligible: false, reason: 'active_member' })
    expect((await call(GBODY)).json.code).toBe('active_member')
    m.gElig.mockResolvedValueOnce({ ok: true, eligible: false, reason: 'already_claimed' })
    expect((await call(GBODY)).json.code).toBe('already_claimed')
    m.gElig.mockResolvedValueOnce({ ok: true, eligible: false, reason: 'help_pending' })
    const hp = await call(GBODY)
    expect([hp.status, hp.json.code]).toEqual([200, 'help_filed'])
    m.gElig.mockResolvedValueOnce({ ok: true, eligible: false, reason: 'in_progress' })
    const r = await call(GBODY)
    expect([r.status, r.json.code]).toEqual([200, 'help_filed'])
    expect(m.inserted).not.toHaveBeenCalled()
    expect(m.gFulfil).not.toHaveBeenCalled()
  })

  it('a duplicate in-flight claim (23505) answers help_filed; other insert errors 503', async () => {
    m.inserted.mockResolvedValueOnce({ data: null, error: { code: '23505' } })
    const r = await call(GBODY)
    expect([r.status, r.json.code]).toEqual([200, 'help_filed'])
    m.inserted.mockResolvedValueOnce({ data: null, error: { code: '42P01' } })
    expect((await call(GBODY)).status).toBe(503)
    expect(m.gFulfil).not.toHaveBeenCalled()
  })

  it('help_filed and unavailable outcomes from the fulfilment', async () => {
    m.gFulfil.mockResolvedValueOnce({ kind: 'help_filed' })
    expect((await call(GBODY)).json.code).toBe('help_filed')
    m.gFulfil.mockResolvedValueOnce({ kind: 'unavailable' })
    expect((await call(GBODY)).status).toBe(503)
  })

  it('Hatch regression: still needs the terms tick, then un1t fulfilment and waitlist placement; no Glofox module runs', async () => {
    m.reads.locations = { id: LOC, name: 'UN1T Hatch Street', organization_id: 'org-1', timezone: 'Europe/Dublin', settings: { un1t_online: { writes_enabled: true, trial_product_id: 'tp' } } }
    resolvePublicPageRequest.mockResolvedValue(studioPageOk())
    const noTick = await call({ ...BODY, terms_accepted: undefined })
    expect([noTick.status, noTick.json.code]).toEqual([400, 'terms_required'])
    expect(m.gFulfil).not.toHaveBeenCalled()
    expect((await call()).status).toBe(200)
    expect(m.fulfil).toHaveBeenCalledTimes(1)
    expect(m.deal).toHaveBeenCalledTimes(1)
    expect(m.gFulfil).not.toHaveBeenCalled()
    expect(m.gElig).not.toHaveBeenCalled()
    expect(m.gPlan).not.toHaveBeenCalled()
    expect(m.gCreds).not.toHaveBeenCalled()
  })
})
