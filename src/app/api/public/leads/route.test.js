// PAGES.1 — POST /api/public/leads with `page` + `studio`: the studio, the
// tag and the lead source come from the page's studio row (its lead_form
// block's own tag / lead_source when it sets them, else the row's
// attribution), never the body. Without `page`, public_path names a studio
// page by slug (the resolver's legacy branch) and its lead_form block decides.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  rateLimit: vi.fn(), contact: vi.fn(), stamp: vi.fn(), tag: vi.fn(), deal: vi.fn(), capi: vi.fn(), consent: vi.fn(),
  resolve: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: m.rateLimit, getClientIp: () => '1.2.3.4', rateLimitResponse: () => new Response('rate', { status: 429 }) }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: m.contact }))
vi.mock('@/lib/lead-source-stamp', () => ({ stampLeadSource: m.stamp }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: m.tag }))
vi.mock('@/lib/waitlist-entry', () => ({ placeWaitlistEntry: m.deal }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: m.capi }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: m.consent }))
vi.mock('@/lib/automations/glofox-lead-provisioning', () => ({ maybeProvisionLeadInGlofox: vi.fn() }))
vi.mock('@/lib/sequences/triggers', () => ({ triggerSequencesForContactCreated: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/landing-pages', async (orig) => {
  const actual = await orig()
  return { ...actual, resolvePublicPageRequest: vi.fn((db, args) => m.resolve(db, args)) }
})
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const q = {
        select: () => q, eq: () => q, is: () => q, update: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
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
  m.rateLimit.mockResolvedValue({ allowed: true })
  m.contact.mockResolvedValue('c1')
  m.stamp.mockResolvedValue({})
  m.tag.mockResolvedValue({ alreadyPresent: false })
})

describe('POST /api/public/leads — page (PAGES.1)', () => {
  it('page+studio sets tag/lead_source from the row\'s attribution; the body cannot set them', async () => {
    m.resolve.mockResolvedValueOnce(pageOk())
    const r = await POST(req({ ...BODY, page: 'founders', studio: 'hatch-street', public_path: 'stillorgan', campaign: 'anything', tag: 'evil', lead_source: 'evil' }))
    expect(r.status).toBe(200)
    expect(resolvePublicPageRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ page: 'founders', studio: 'hatch-street' }))
    expect(m.rateLimit).toHaveBeenCalledWith(expect.anything(), 'lead:hatch-street:1.2.3.4', expect.anything())
    expect(m.contact).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc-h' }))
    expect(m.stamp).toHaveBeenCalledWith(expect.anything(), { contactId: 'c1', locationId: 'loc-h', leadSource: 'meta_founders' })
    expect(m.tag).toHaveBeenCalledWith(expect.anything(), { contactId: 'c1', locationId: 'loc-h', tag: 'hatch-street-founders' })
    expect(m.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventSourceUrl: 'https://www.un1tdublin.com/founders' }))
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

  it('no page: public_path names a studio page by slug; its lead_form block carries the tag and lead source', async () => {
    m.resolve.mockResolvedValueOnce(pageOk([{ type: 'lead_form', tag: 'still-tag', lead_source: 'still-src' }], { locationId: 'loc-s', publicPath: 'stillorgan' }))
    const r = await POST(req({ ...BODY, public_path: 'stillorgan' }))
    expect(r.status).toBe(200)
    expect(resolvePublicPageRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ legacyPath: 'stillorgan' }))
    expect(resolvePublicPageRequest.mock.calls[0][1].page).toBeUndefined()
    expect(m.rateLimit).toHaveBeenCalledWith(expect.anything(), 'lead:stillorgan:1.2.3.4', expect.anything())
    expect(m.tag).toHaveBeenCalledWith(expect.anything(), { contactId: 'c1', locationId: 'loc-s', tag: 'still-tag' })
    expect(m.stamp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ leadSource: 'still-src' }))
    expect(m.capi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventSourceUrl: 'https://www.un1tdublin.com/stillorgan' }))
  })

  it('no page: a studio page with no lead_form block takes the lead defaults, and a campaign key is ignored', async () => {
    m.resolve.mockResolvedValueOnce(pageOk([], { locationId: 'loc-s', publicPath: 'stillorgan' }))
    await POST(req({ ...BODY, public_path: 'stillorgan', campaign: 'stillorgan-free-class' }))
    expect(m.tag).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ tag: 'hatch-founding-member' }))
    expect(m.stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ leadSource: 'hatch_launch' }))
  })

  it('no page: an unknown studio page is a 400, a failed read a 503, before any capture', async () => {
    m.resolve.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    const none = await POST(req({ ...BODY, public_path: 'galway' }))
    expect(none.status).toBe(400)
    expect(await none.json()).toEqual({ success: false, error: 'This studio is not accepting sign-ups right now.' })
    m.resolve.mockResolvedValueOnce({ ok: false, reason: 'unreadable' })
    const failed = await POST(req({ ...BODY, public_path: 'stillorgan' }))
    expect(failed.status).toBe(503)
    expect(m.contact).not.toHaveBeenCalled()
  })

  it('legacy: a body with neither page nor public_path is a 400', async () => {
    expect((await POST(req(BODY))).status).toBe(400)
    expect(m.rateLimit).not.toHaveBeenCalled()
  })
})
