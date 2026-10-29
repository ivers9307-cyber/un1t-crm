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
vi.mock('@/components/landing-page/PaidTrialFunnel', () => ({ default: (p) => <div data-funnel={p.studios[0].key} data-resume={p.resumePurchaseId || ''} data-sellable={String(p.studios[0].sellable)} data-return={p.returnPath} data-preview={String(Boolean(p.preview))} /> }))
vi.mock('@/components/landing-page/RevealManager', () => ({ default: () => null }))
vi.mock('@/components/landing-page/reveal-arm', () => ({ RevealArmScript: () => null }))
vi.mock('@/components/landing-page/EditModeOverlay', () => ({ default: (p) => { mocks.overlayProps = p; return <div data-overlay="1" /> } }))

import StudioLandingPage from './page.js'
import { logWarn } from '@/lib/log'

const PURCHASE = '11111111-1111-1111-1111-111111111111'
const BLOCK = { id: 't', type: 'paid_trial', cta_label: 'Start my 14 Day Reset', membership_id: 'm', plan_code: 'p', price_cents: 3900 }
const sellable = { key: 'stillorgan', publicPath: 'stillorgan', locationId: 'loc', sellable: true, block: BLOCK, config: { provider: 'glofox', priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'Reset' } }
const page = (sp = {}, location = 'stillorgan') => StudioLandingPage({ params: Promise.resolve({ location }), searchParams: Promise.resolve(sp) })
const html = async (sp, location) => renderToStaticMarkup(await page(sp, location))

beforeEach(() => {
  mocks.redirect.mockClear()
  mocks.loadThrows = false
  mocks.overlayProps = null
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
})
