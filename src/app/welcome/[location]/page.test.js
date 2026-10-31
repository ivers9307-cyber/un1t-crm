// TRIALFIRST.1 — /welcome/[location] (served as /stillorgan, /hatch-street):
// a sellable paid trial puts its buy card in the hero and owns the CTA; a buyer
// redirected back from a checkout lands on the card; a return to a page that is
// gone goes on to /trial; the editor preview shows the card, disabled.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => ({
  row: null,
  entries: [],
  loadThrows: false,
  redirect: vi.fn(),
  notFound: vi.fn(() => { throw new Error('404') }),
  overlayProps: null,
  user: null,
}))
vi.mock('next/navigation', () => ({ redirect: (u) => { mocks.redirect(u); throw new Error('redirect') }, notFound: mocks.notFound }))
vi.mock('next/headers', () => ({ headers: async () => new Map([['host', 'un1tdublin.com']]) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.row, error: null }) }) }) }) }) }))
vi.mock('@/lib/trial-studios', async (orig) => ({
  ...(await orig()),
  loadTrialStudios: async () => { if (mocks.loadThrows) throw new Error('boom secret'); return mocks.entries },
}))
vi.mock('@/lib/host-brand', () => ({ resolveLocationBrand: async () => ({ companyName: 'UN1T Stillorgan', locationName: 'Stillorgan', shortName: 'UN1T' }), resolveOrgChrome: async () => ({ companyName: 'UN1T Dublin', studios: [], legalName: '' }) }))
vi.mock('@/lib/default-site-name', () => ({ resolveGymSiteName: async () => 'UN1T' }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
// EDITGATE.1 — the session the page asks for before honouring ?edit=1.
// `getUserLocationIds` mirrors the real one-liner (auth.js).
vi.mock('@/lib/auth', () => ({ getCurrentUser: async () => { if (mocks.user === 'throws') throw new Error('auth down'); return mocks.user }, getUserLocationIds: (u) => (u?.locations || []).map((l) => l.id) }))
vi.mock('@/components/landing-page/PaidTrialFunnel', () => ({ default: (p) => <div data-funnel={p.studios[0].key} data-resume={p.resumePurchaseId || ''} data-sellable={String(p.studios[0].sellable)} data-return={p.returnPath} data-preview={String(Boolean(p.preview))} /> }))
vi.mock('@/components/landing-page/RevealManager', () => ({ default: () => null }))
vi.mock('@/components/landing-page/reveal-arm', () => ({ RevealArmScript: () => null }))
vi.mock('@/components/landing-page/EditModeOverlay', () => ({ default: (p) => { mocks.overlayProps = p; return <div data-overlay="1" /> } }))

import StudioLandingPage from './page.js'
import { logWarn } from '@/lib/log'

const PURCHASE = '11111111-1111-1111-1111-111111111111'
const BLOCK = { id: 't', type: 'paid_trial', cta_label: 'Start my 14 Day Reset', membership_id: 'm', plan_code: 'p', price_cents: 3900 }
const STAFF = { id: 'u1', locations: [{ id: 'loc' }] }
// EDITGATE.1 — operator configuration the public page never shows; every
// value is distinctive so a leak into the markup is unmistakable.
const WITHHELD = {
  trial_membership_id: 'glofox-trial-mem-WITHHELD-1',
  trial_plan_code: 'glofox-trial-plan-WITHHELD-2',
  membership_id: 'glofox-mem-WITHHELD-3',
  plan_code: 'glofox-plan-WITHHELD-4',
  un1t_product_id: 'un1t-product-WITHHELD-5',
  class_keywords: 'keywords-WITHHELD-6',
  tag: 'tag-WITHHELD-7',
  lead_source: 'source-WITHHELD-8',
  event_source_url: 'https://example.test/WITHHELD-9',
}
const CONFIGURED_BLOCKS = [
  { id: 'h', type: 'hero', headline: 'Hi' },
  { id: 'cf', type: 'class_funnel', heading: 'Free classes', trial_membership_id: WITHHELD.trial_membership_id, trial_plan_code: WITHHELD.trial_plan_code, consult_slug: 'consult' },
  { id: 'pt', type: 'paid_trial', cta_label: 'Start', membership_id: WITHHELD.membership_id, plan_code: WITHHELD.plan_code, un1t_product_id: WITHHELD.un1t_product_id, tag: WITHHELD.tag, lead_source: WITHHELD.lead_source, event_source_url: WITHHELD.event_source_url, price_cents: 3900 },
  { id: 'lf', type: 'lead_form', heading: 'Keep me posted', tag: WITHHELD.tag, lead_source: WITHHELD.lead_source },
  // #2256's block type: not registered here yet, so blocksOrDefault drops it;
  // once it is, its attribution fields are withheld the same way.
  { id: 'cmp', type: 'campaign_funnel', heading: '50+', class_keywords: WITHHELD.class_keywords, tag: WITHHELD.tag, lead_source: WITHHELD.lead_source, event_source_url: WITHHELD.event_source_url, trial_membership_id: WITHHELD.trial_membership_id, trial_plan_code: WITHHELD.trial_plan_code },
]
const WITHHELD_KEYS = ['trial_membership_id', 'trial_plan_code', 'membership_id', 'plan_code', 'un1t_product_id', 'class_keywords', 'lead_source', 'event_source_url']
const sellable = { key: 'stillorgan', publicPath: 'stillorgan', locationId: 'loc', sellable: true, block: BLOCK, config: { provider: 'glofox', priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'Reset' } }
const page = (sp = {}, location = 'stillorgan') => StudioLandingPage({ params: Promise.resolve({ location }), searchParams: Promise.resolve(sp) })
const html = async (sp, location) => renderToStaticMarkup(await page(sp, location))

beforeEach(() => {
  mocks.redirect.mockClear()
  mocks.loadThrows = false
  mocks.overlayProps = null
  mocks.user = STAFF
  vi.mocked(logWarn).mockClear()
  mocks.row = { location_id: 'loc', public_path: 'stillorgan', publish_state: 'live', blocks: [{ id: 'h', type: 'hero', headline: 'Hi' }, BLOCK], locations: { id: 'loc', name: 'UN1T Stillorgan', organization_id: 'org' } }
  mocks.entries = [sellable, { key: 'hatch', publicPath: 'hatch-street', locationId: null, sellable: false, block: null, config: null }]
})

describe('/welcome/[location] trial-first (TRIALFIRST.1)', () => {
  it('a sellable trial renders the card in the hero and the CTA points at #trial', async () => {
    const out = await html()
    expect(out).toContain('id="trial"')
    expect(out).toContain('data-funnel="stillorgan"')
    expect(out).toContain('data-return="/stillorgan"')
    expect(out).toContain('data-preview="false"')
    expect(out).toContain('href="#trial"')
    expect(out).not.toContain('lp-marquee-track')
  })

  it('the card renders once even with two hero blocks', async () => {
    mocks.row.blocks = [{ id: 'h', type: 'hero', headline: 'Hi' }, BLOCK, { id: 'h2', type: 'hero', headline: 'Again' }]
    const out = await html()
    expect(out.match(/data-funnel=/g)).toHaveLength(1)
    expect(out.match(/id="trial"/g)).toHaveLength(1)
  })

  it('a page with no hero block still gets a hero for the card', async () => {
    mocks.row.blocks = [BLOCK]
    const out = await html()
    expect(out).toContain('id="trial"')
    expect(out).toContain('data-funnel="stillorgan"')
  })

  it('an unsellable trial renders the classic hero with no card', async () => {
    mocks.entries = [{ ...sellable, sellable: false, config: null }]
    const out = await html()
    expect(out).not.toContain('id="trial"')
    expect(out).toContain('lp-marquee-track')
    expect(out).toContain('href="#book"')
    expect(out).not.toContain('href="#trial"')
  })

  it('an unreadable trial config degrades to the classic hero and logs ids only', async () => {
    mocks.loadThrows = true
    const out = await html()
    expect(out).not.toContain('id="trial"')
    expect(out).toContain('lp-marquee-track')
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls[0])).not.toContain('boom secret')
  })

  it('a return with ?purchase= shows the card even when the trial is no longer sellable', async () => {
    mocks.entries = [{ ...sellable, sellable: false, config: null }]
    const out = await html({ purchase: PURCHASE })
    expect(out).toContain(`data-resume="${PURCHASE}"`)
    expect(out).toContain('data-sellable="false"')
  })

  it('a return still shows the card when the trial config could not be read', async () => {
    mocks.loadThrows = true
    const out = await html({ purchase: PURCHASE })
    expect(out).toContain(`data-resume="${PURCHASE}"`)
    expect(out).toContain('data-sellable="false"')
  })

  it('a missing row with ?purchase= redirects to /trial with the query intact', async () => {
    mocks.row = null
    await expect(page({ purchase: PURCHASE, cancelled: '1' })).rejects.toThrow('redirect')
    expect(mocks.redirect).toHaveBeenCalledWith(`/trial?purchase=${PURCHASE}&studio=stillorgan&cancelled=1`)
  })

  it('an unpublished Hatch Street page with ?purchase= redirects with studio=hatch', async () => {
    mocks.row = { ...mocks.row, public_path: 'hatch-street', publish_state: 'draft' }
    await expect(page({ purchase: PURCHASE }, 'hatch-street')).rejects.toThrow('redirect')
    expect(mocks.redirect).toHaveBeenCalledWith(`/trial?purchase=${PURCHASE}&studio=hatch`)
  })

  it('a missing row without a return still 404s', async () => {
    mocks.row = null
    await expect(page()).rejects.toThrow('404')
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

  it('the editor preview gets the card as a disabled preview, even when not sellable', async () => {
    mocks.entries = [{ ...sellable, sellable: false, config: null }]
    renderToStaticMarkup(await page({ edit: '1' }))
    const tp = mocks.overlayProps.trialPreview
    expect(tp).toMatchObject({ returnPath: '/stillorgan', resumePurchaseId: null, cancelled: false, hatchTerms: null, preview: true })
    expect(tp.studio).toMatchObject({ key: 'stillorgan', sellable: false })
    // Only the client-safe view travels: never the Glofox ids.
    expect(JSON.stringify(tp)).not.toContain('membership_id')
    expect(JSON.stringify(tp)).not.toContain('plan_code')
  })

  it('a page with no paid trial studio gets no editor preview card', async () => {
    mocks.row = { ...mocks.row, public_path: 'elsewhere' }
    renderToStaticMarkup(await page({ edit: '1' }, 'elsewhere'))
    expect(mocks.overlayProps.trialPreview).toBeNull()
  })

  describe('EDITGATE.1 — ?edit=1 is honoured only for a staff session at the studio', () => {
    beforeEach(() => { mocks.row.blocks = CONFIGURED_BLOCKS })

    it('an anonymous ?edit=1 request renders the public page without any withheld field', async () => {
      mocks.user = null
      const out = await html({ edit: '1' })
      expect(mocks.overlayProps).toBeNull()
      expect(out).not.toContain('data-overlay')
      // The public render, live card included.
      expect(out).toContain('data-preview="false"')
      for (const v of Object.values(WITHHELD)) expect(out).not.toContain(v)
      for (const k of WITHHELD_KEYS) expect(out).not.toContain(k)
      expect(out).not.toContain('"tag"')
    })

    it('an anonymous ?edit=1 request for a draft page 404s like any public request', async () => {
      mocks.user = null
      mocks.row.publish_state = 'draft'
      await expect(page({ edit: '1' })).rejects.toThrow('404')
      expect(mocks.overlayProps).toBeNull()
    })

    it('a staff session at another studio gets the public page too', async () => {
      mocks.user = { id: 'u2', locations: [{ id: 'other-loc' }] }
      const out = await html({ edit: '1' })
      expect(mocks.overlayProps).toBeNull()
      for (const v of Object.values(WITHHELD)) expect(out).not.toContain(v)
    })

    it('a failed session read is anonymous, never a preview', async () => {
      mocks.user = 'throws'
      const out = await html({ edit: '1' })
      expect(mocks.overlayProps).toBeNull()
      expect(out).toContain('data-preview="false"')
    })

    it('a staff session at the studio still gets the editor overlay, on a draft page too', async () => {
      mocks.row.publish_state = 'draft'
      const out = await html({ edit: '1' })
      expect(out).toContain('data-overlay')
      expect(mocks.overlayProps.initialBlocks.map((b) => b.id)).toEqual(['h', 'cf', 'pt', 'lf'])
      expect(mocks.overlayProps.initialLogoAlt).toBe('UN1T Stillorgan')
    })

    it('the overlay is seeded with client-safe blocks: the withheld fields never travel', async () => {
      await html({ edit: '1' })
      const seeded = JSON.stringify(mocks.overlayProps.initialBlocks)
      for (const v of Object.values(WITHHELD)) expect(seeded).not.toContain(v)
      for (const k of WITHHELD_KEYS) expect(seeded).not.toContain(k)
      expect(seeded).not.toContain('"tag"')
      // What the preview renders from is still there.
      expect(mocks.overlayProps.initialBlocks[1]).toMatchObject({ id: 'cf', heading: 'Free classes', consult_slug: 'consult' })
      expect(mocks.overlayProps.initialBlocks[2]).toMatchObject({ id: 'pt', cta_label: 'Start', price_cents: 3900 })
    })
  })
})
