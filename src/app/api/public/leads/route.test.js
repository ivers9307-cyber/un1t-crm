// PAGES.1 — POST /api/public/leads with `page` + `studio`: the studio, the
// tag and the lead source come from the page's studio row (its lead_form
// block's own tag / lead_source when it sets them, else the row's
// attribution), never the body. Without `page` the legacy public_path +
// LEAD_CAMPAIGNS path is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  rateLimit: vi.fn(), contact: vi.fn(), stamp: vi.fn(), tag: vi.fn(), deal: vi.fn(), capi: vi.fn(), consent: vi.fn(),
  welcome: vi.fn(), resolve: vi.fn(), legacyRow: null,
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: m.rateLimit, getClientIp: () => '1.2.3.4', rateLimitResponse: () => new Response('rate', { status: 429 }) }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: m.contact }))
vi.mock('@/lib/lead-source-stamp', () => ({ stampLeadSource: m.stamp }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: m.tag }))
vi.mock('@/lib/waitlist-entry', () => ({ placeWaitlistEntry: m.deal }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: m.capi }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: m.consent }))
vi.mock('@/lib/automations/meta-ad-whatsapp-welcome', () => ({ maybeSendCampaignWhatsappWelcome: m.welcome }))
vi.mock('@/lib/automations/glofox-lead-provisioning', () => ({ maybeProvisionLeadInGlofox: vi.fn() }))
vi.mock('@/lib/sequences/triggers', () => ({ triggerSequencesForContactCreated: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/landing-pages', async (orig) => {
  const actual = await orig()
  return { ...actual, resolvePublicPageRequest: vi.fn((db, args) => (args.page ? m.resolve(db, args) : actual.resolvePublicPageRequest(db, args))) }
})
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      const q = {
        select: () => q, eq: () => q, is: () => q, update: () => q,
        maybeSingle: async () => (table === 'landing_page_settings' ? { data: m.legacyRow, error: null } : { data: null, error: null }),
        then: (ok, no) => Promise.resolve({ data: null, error: null }).then(ok, no),
      }
      return q
    },
  }),
}))

import { POST } from './route'
import { resolvePublicPageRequest } from '@/lib/landing-pages'

const BODY = { first_name: 'Ann', email: 'Ann@Example.com', phone: '0871234567', consent: true }
const req = (body) => new Request('http://x/api/public/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const pageOk = (blocks = [], extra = {}) => ({
  ok: true, pageId: 'page-1', page: { id: 'page-1', slug: 'founders', offer_type: 'none' }, studioRow: {},
  locationId: 'loc-h', publicPath: 'hatch-street', blocks,
  attribution: { tag: 'hatch-street-founders', lead_source: 'meta_founders' }, ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  m.legacyRow = { location_id: 'loc-s', blocks: [{ type: 'lead_form', tag: 'still-tag', lead_source: 'still-src' }] }
  m.rateLimit.mockResolvedValue({ allowed: true })
  m.contact.mockResolvedValue('c1')
  m.stamp.mockResolvedValue({})
  m.tag.mockResolvedValue({ alreadyPresent: false })
})

describe('POST /api/public/leads — page (PAGES.1)', () => {
  it('page+studio sets tag/lead_source from the row\'s attribution; the body cannot set them', async () => {
    m.resolve.mockResolvedValueOnce(pageOk())
    const r = await POST(req({ ...BODY, page: 'founders', studio: 'hatch-street', public_path: 'stillorgan', campaign: 'stillorgan-free-class', tag: 'evil', lead_source: 'evil' }))
    expect(r.status).toBe(200)
    expect(resolvePublicPageRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ page: 'founders', studio: 'hatch-street' }))
    expect(m.rateLimit).toHaveBeenCalledWith(expect.anything(), 'lead:hatch-street:1.2.3.4', expect.anything())
    expect(m.contact).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc-h' }))
    expect(m.stamp).toHaveBeenCalledWith(expect.anything(), { contactId: 'c1', locationId: 'loc-h', leadSource: 'meta_founders' })
    expect(m.tag).toHaveBeenCalledWith(expect.anything(), { contactId: 'c1', locationId: 'loc-h', tag: 'hatch-street-founders' })
    expect(m.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventSourceUrl: 'https://www.un1tdublin.com/founders' }))
    // LEAD_CAMPAIGNS is the legacy path only: no campaign welcome from a page.
    expect(m.welcome).not.toHaveBeenCalled()
  })

  it("the page's lead_form block's own tag and lead source win", async () => {
    m.resolve.mockResolvedValueOnce(pageOk([{ type: 'lead_form', tag: 'form-tag', lead_source: ' ' }], { attribution: { tag: 'a', lead_source: 'b', event_source_url: 'https://x.example/f' } }))
    expect((await POST(req({ ...BODY, page: 'founders' }))).status).toBe(200)
    expect(m.tag).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: 'form-tag' }))
    expect(m.stamp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ leadSource: 'b' }))
    expect(m.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventSourceUrl: 'https://x.example/f' }))
  })

  it('refusals: not_found 404, studio_required 400, unreadable 503, before any capture', async () => {
    m.resolve.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    let r = await POST(req({ ...BODY, page: 'founders', studio: 'galway' }))
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ success: false, error: 'not_found' })
    m.resolve.mockResolvedValueOnce({ ok: false, reason: 'studio_required' })
    expect((await POST(req({ ...BODY, page: 'founders' }))).status).toBe(400)
    m.resolve.mockResolvedValueOnce({ ok: false, reason: 'unreadable' })
    expect((await POST(req({ ...BODY, page: 'founders' }))).status).toBe(503)
    expect(m.contact).not.toHaveBeenCalled()
    expect(m.rateLimit).toHaveBeenCalledWith(expect.anything(), 'lead:unresolved:1.2.3.4', expect.anything())
  })

  it('legacy: public_path and the campaign allowlist, as before', async () => {
    const r = await POST(req({ ...BODY, public_path: 'stillorgan' }))
    expect(r.status).toBe(200)
    expect(m.rateLimit).toHaveBeenCalledWith(expect.anything(), 'lead:stillorgan:1.2.3.4', expect.anything())
    expect(m.tag).toHaveBeenCalledWith(expect.anything(), { contactId: 'c1', locationId: 'loc-s', tag: 'still-tag' })
    expect(m.stamp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ leadSource: 'still-src' }))
    expect(m.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventSourceUrl: 'https://www.un1tdublin.com/stillorgan' }))

    await POST(req({ ...BODY, public_path: 'stillorgan', campaign: 'stillorgan-free-class' }))
    expect(m.tag).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ tag: 'stillorgan-free-trial' }))

    m.legacyRow = null
    const none = await POST(req({ ...BODY, public_path: 'galway' }))
    expect(none.status).toBe(400)
    expect(await none.json()).toEqual({ success: false, error: 'This studio is not accepting sign-ups right now.' })
  })

  it('legacy: a body with neither page nor public_path is a 400', async () => {
    expect((await POST(req(BODY))).status).toBe(400)
    expect(m.rateLimit).not.toHaveBeenCalled()
  })
})
