// CORPPROMO.1 — POST /api/public/corp-claims. The promo decides the studio,
// credits and expiry; refusals land before anything reaches un1t.online.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  rateLimit: vi.fn(), contact: vi.fn(), capi: vi.fn(), consent: vi.fn(), deal: vi.fn(), tag: vi.fn(),
  membership: vi.fn(), eligibility: vi.fn(), fulfil: vi.fn(), legal: vi.fn(),
  reads: {}, readErrors: {}, inserted: vi.fn(), updates: [],
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: m.rateLimit, getClientIp: () => '1.2.3.4', rateLimitResponse: () => new Response('rate', { status: 429 }) }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: m.contact }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: m.capi, fbcFromFbclid: () => null }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: m.consent }))
vi.mock('@/lib/waitlist-entry', () => ({ placeWaitlistEntry: m.deal }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: m.tag }))
vi.mock('@/lib/trial-eligibility', () => ({ hatchActiveMembership: m.membership }))
vi.mock('@/lib/corp-promo-eligibility', () => ({ corpPromoEligibility: m.eligibility }))
vi.mock('@/lib/corp-promo-claim', () => ({ fulfilCorpPromoClaim: m.fulfil }))
vi.mock('@/lib/un1t-online-legal', () => ({ readUn1tLegalDocs: m.legal }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
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

import { POST } from './route'

const LOC = 'loc-hatch'
const BODY = { promo: 'hatch-3-free', first_name: 'Ann', last_name: 'Byrne', email: 'Ann@Work.ie', phone: '0871234567', consent: true, terms_accepted: true }
const req = (body) => new Request('http://x/api/public/corp-claims', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const call = async (body = BODY) => { const r = await POST(req(body)); return { status: r.status, json: await r.json() } }

beforeEach(() => {
  vi.clearAllMocks()
  m.updates = []
  m.readErrors = {}
  m.reads = {
    landing_page_settings: { location_id: LOC, blocks: [] },
    locations: { id: LOC, name: 'UN1T Hatch Street', organization_id: 'org-1', timezone: 'Europe/Dublin', settings: { un1t_online: { writes_enabled: true, trial_product_id: 'tp' } } },
    contacts: { id: 'c-1', email: 'ann@work.ie', first_name: 'Ann', last_name: 'Byrne' },
  }
  m.rateLimit.mockResolvedValue({ allowed: true })
  m.contact.mockResolvedValue('c-1')
  m.membership.mockResolvedValue({ ok: true, active: false })
  m.eligibility.mockResolvedValue({ ok: true, eligible: true })
  m.legal.mockResolvedValue({ version: 'v3' })
  m.inserted.mockImplementation(async (table, row) => ({ data: { id: 'claim-1', ...row }, error: null }))
  m.fulfil.mockResolvedValue({ kind: 'granted', credits: 3, expiresAt: '2026-11-04T10:00:00.000Z' })
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

  it('an unreadable landing row or location: 503', async () => {
    m.readErrors.landing_page_settings = { code: '57014' }
    expect((await call()).status).toBe(503)
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
