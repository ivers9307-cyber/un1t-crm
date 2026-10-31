// PAGES.1 — the one public page route: a landing_pages row (+ its studio rows)
// renders through the layout its offer type picks; the browser only ever gets
// client-safe props; a draft, a coming-soon page, a studio page (PR1) and an
// unreadable read are 404s; a retired page redirects with the query kept.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const h = vi.hoisted(() => ({
  host: 'www.un1tdublin.com',
  user: null,
  loaded: null,
  loadThrows: null,
  loadedByOrg: null,
  product: { un1t_id: 'UN1T-PROD-1', status: 'active', type: 'one_time', price_cents: 3900, currency: 'eur', title: 'Trial' },
  reviews: [],
  legacyBlocks: null,
  calls: { load: [], reviews: [], legacy: [] },
}))

vi.mock('next/headers', () => ({ headers: async () => new Map([['host', h.host]]) }))
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
  redirect: vi.fn((url) => { throw Object.assign(new Error('NEXT_REDIRECT'), { url }) }),
}))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => h.user),
  getUserLocationIds: (u) => u?.locationIds || [],
}))
vi.mock('@/lib/public-pages-edge', () => ({
  publicOrgIdForHost: vi.fn(async (host) => (host ? 'org-un1t' : 'org-un1t')),
}))

const PATHS = vi.hoisted(() => ({ 'loc-s': 'stillorgan', 'loc-h': 'hatch-street', 'loc-x': 'xtown' }))
vi.mock('@/lib/landing-pages', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    loadPageBySlug: vi.fn(async (db, args) => {
      h.calls.load.push(args)
      if (h.loadThrows) throw h.loadThrows
      if (h.loadedByOrg && args.orgId in h.loadedByOrg) return h.loadedByOrg[args.orgId]
      return h.loaded
    }),
    studioPublicPath: vi.fn(async (db, locationId) => PATHS[locationId] || null),
    locationIdForPublicPath: vi.fn(async (db, orgId, path) => Object.keys(PATHS).find((k) => PATHS[k] === path) || null),
  }
})

function makeDb() {
  const q = (table) => {
    const b = {
      select: () => b, eq: (c, v) => { if (table === 'google_reviews') h.calls.reviews.push([c, v]); return b },
      gte: () => b, not: () => b, order: () => b, limit: () => b, in: () => b,
      maybeSingle: async () => {
        if (table === 'un1t_products') return { data: h.product, error: null }
        if (table === 'landing_page_settings') return { data: h.legacyBlocks ? { blocks: h.legacyBlocks } : null, error: null }
        return { data: null, error: null }
      },
      then: (resolve, reject) => Promise.resolve(table === 'google_reviews' ? { data: h.reviews, error: null } : { data: null, error: null }).then(resolve, reject),
    }
    return b
  }
  return { from: (table) => q(table) }
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => makeDb() }))
vi.mock('@/lib/host-brand', () => ({
  resolveOrgChrome: vi.fn(async () => ({ companyName: 'UN1T', shortName: 'UN1T', studios: [], legalName: 'Champ Fitness Ltd' })),
  resolveLocationBrand: vi.fn(async ({ locationId }) => ({
    companyName: locationId === 'loc-h' ? 'UN1T Hatch Street' : 'UN1T Stillorgan',
    locationName: locationId === 'loc-h' ? 'Hatch Street' : 'Stillorgan',
    shortName: 'UN1T',
  })),
}))
vi.mock('@/lib/landing-logo', () => ({ getLandingLogo: vi.fn(async () => 'https://x/logo.png'), STILLORGAN_LANDING_LOGO: 'https://x/logo.png' }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn() }))

vi.mock('@/components/landing-page/PaidTrialFunnel', () => ({ default: (props) => <div data-testid="paid">{JSON.stringify(props)}</div> }))
vi.mock('@/components/landing-page/CampaignFunnel', () => ({ default: (props) => <div data-testid="campaign">{JSON.stringify(props)}</div> }))
vi.mock('@/components/landing-page/CorpPromoFunnel', () => ({ default: (props) => <div data-testid="corp">{JSON.stringify(props)}</div> }))
vi.mock('@/components/ClassFunnel', () => ({ default: (props) => <div data-testid="classfunnel">{JSON.stringify(props)}</div> }))
vi.mock('@/components/landing-page/EditModeOverlay', () => ({ default: (props) => <div data-testid="overlay">{JSON.stringify(props)}</div> }))
vi.mock('@/components/landing-page/RevealManager', () => ({ default: () => null }))
vi.mock('@/components/VisitOriginCapture', () => ({ default: () => null }))

import Page, { generateMetadata } from './page.js'
import { notFound, redirect } from 'next/navigation'
import { logWarn } from '@/lib/log'
import { PageReadError } from '@/lib/landing-pages'

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
function propsOf(html, id) {
  const m = html.match(new RegExp(`data-testid="${id}">(.*?)</div>`))
  return m ? JSON.parse(unescape(m[1])) : null
}
const render = async ({ slug, rest, sp = {} }) => renderToStaticMarkup(await Page({ params: Promise.resolve({ slug, rest }), searchParams: Promise.resolve(sp) }))
const outcome = async (args) => {
  try { await render(args); return 'rendered' } catch (e) { return e.message === 'NEXT_REDIRECT' ? `redirect ${e.url}` : e.message }
}

// Server-only values that must never reach the browser.
const SECRETS = ['elite-m', 'elite-p', 'class_keywords', 'trial_membership_id', 'trial_plan_code', 'GLOFOX-MEM-S', 'GLOFOX-PLAN-S', 'UN1T-PROD-1',
  'membership_id', 'plan_code', 'un1t_product_id', 'stillorgan-50plus', 'meta_50plus', 'trial-tag', 'SEKRET', 'writes_enabled']
const expectClientSafe = (html) => { for (const s of SECRETS) expect(html, s).not.toContain(s) }

const loc = (id, membership_source, settings = { secret_token: 'SEKRET' }) => ({ id, name: PATHS[id], membership_source, settings })
const row = (location_id, over = {}) => ({ page_id: 'p', location_id, enabled: true, sort_order: 0, offer: {}, attribution: {}, locations: loc(location_id, 'glofox'), ...over })

const FIFTY = {
  id: 'p50', organization_id: 'org-un1t', slug: '50plus', title: 'The 50+ Club', kind: 'campaign', scope: 'one',
  primary_location_id: 'loc-s', offer_type: 'one_class', publish_state: 'live', redirect_to: null,
  chrome: { tone: 'light', noindex: true, meta_title: 'The 50+ Club Trial' },
  blocks: [
    { id: 'cf', type: 'campaign_funnel', heading: 'A free trial of The 50+ Club', video_url: 'https://x/v.mp4', poster_url: 'https://x/p.jpg' },
    { id: 's1', type: 'stats', items: [{ number: '4.9', label: 'Rating' }] },
    { id: 'v1', type: 'video_testimonials', items: [{ video_url: 'https://x/a.mp4', poster_url: 'https://x/a.jpg' }] },
  ],
}
const FIFTY_STUDIOS = [row('loc-s', {
  offer: { trial_membership_id: 'elite-m', trial_plan_code: 'elite-p', class_keywords: '50+' },
  attribution: { tag: 'stillorgan-50plus', lead_source: 'meta_50plus' },
})]

const TRIAL = {
  id: 'pt', organization_id: 'org-un1t', slug: 'trial', title: '14 Day Reset', kind: 'campaign', scope: 'all',
  primary_location_id: null, offer_type: 'paid_trial', publish_state: 'live', redirect_to: null,
  chrome: { logo_url: 'https://x/trial-logo.png', noindex: true, tone: 'dark' },
  blocks: [
    { id: 'pt1', type: 'paid_trial', heading: 'Start here', cta_label: 'Start my trial' },
    { id: 's1', type: 'stats', items: [{ number: '4.9', label: 'Rating' }] },
  ],
}
const TRIAL_STUDIOS_ROWS = [
  row('loc-s', { sort_order: 0, offer: { membership_id: 'GLOFOX-MEM-S', plan_code: 'GLOFOX-PLAN-S', price_cents: 3900 }, attribution: { tag: 'trial-tag' } }),
  row('loc-h', { sort_order: 1, offer: { un1t_product_id: 'UN1T-PROD-1' }, locations: loc('loc-h', 'un1t_online', { un1t_online: { writes_enabled: true }, secret_token: 'SEKRET' }) }),
  row('loc-x', { sort_order: 2, enabled: false, offer: { membership_id: 'm-x', plan_code: 'p-x', price_cents: 3900 } }),
]

const CLASSF = {
  id: 'pcf', organization_id: 'org-un1t', slug: 'hatch-classes', title: 'Hatch classes', kind: 'campaign', scope: 'one',
  primary_location_id: 'loc-h', offer_type: 'class_funnel', publish_state: 'live', redirect_to: null, chrome: {},
  blocks: [{ id: 'cf', type: 'class_funnel', heading: 'Book your first class', subhead: 'Pick a time', cta_label: 'Book now' }],
}
const CLASSF_STUDIOS = [row('loc-h', {
  offer: { trial_membership_id: 'elite-m', trial_plan_code: 'elite-p', price_cents: 0, timetable: 'Mon 07:00 HIIT' },
  attribution: { tag: 'trial-tag', lead_source: 'meta_50plus' },
  locations: loc('loc-h', 'un1t_online'),
})]

const CORP = {
  id: 'pc', organization_id: 'org-un1t', slug: 'corp', title: 'Corporate promo', kind: 'campaign', scope: 'one',
  primary_location_id: 'loc-h', offer_type: 'promo_credits', publish_state: 'live', redirect_to: null, chrome: { noindex: true },
  blocks: [{ id: 'cp', type: 'corp_promo', heading: '3 free classes at {studio_name}' }],
}
const CORP_STUDIOS = [row('loc-h', { offer: { promo_key: 'hatch-3-free' }, locations: loc('loc-h', 'un1t_online') })]

beforeEach(() => {
  vi.clearAllMocks()
  h.host = 'www.un1tdublin.com'
  h.user = null
  h.loaded = null
  h.loadThrows = null
  h.loadedByOrg = null
  h.reviews = []
  h.legacyBlocks = null
  h.calls = { load: [], reviews: [], legacy: [] }
})

describe('the [slug] page route', () => {
  it('a live one_class page renders CampaignHero, the funnel with client-safe copy only (no trial ids, no keywords), the expect strip and its own content blocks in light tone', async () => {
    h.loaded = { page: FIFTY, studios: FIFTY_STUDIOS }
    const html = await render({ slug: '50plus' })
    expect(h.calls.load[0]).toEqual({ orgId: 'org-un1t', slug: '50plus' })
    expect(html).toContain('A free trial of The 50+ Club')
    expect(html).toContain('https://x/v.mp4')
    expect(html).toContain('Built for where you are now') // the expect strip's default
    expect(html).toContain('4.9')
    expect(html).toMatch(/^(<link [^>]*>)?<div class="min-h-screen bg-white text-black/)
    expect(html).toMatch(/<section class="bg-lp-pale text-black[^"]*"><div class="max-w-6xl mx-auto px-6">/)
    expectClientSafe(html)
    const funnel = propsOf(html, 'campaign')
    expect(funnel).toMatchObject({ publicPath: 'stillorgan', campaign: '50plus', page: '50plus', locationName: 'UN1T Stillorgan' })
    expect(funnel.copy.heading).toBe('A free trial of The 50+ Club')
    expect(funnel.copy.trial_membership_id).toBeUndefined()
    expect(funnel.copy.class_keywords).toBeUndefined()
  })

  it('the backfilled /50plus row renders the same hero copy, video and tiles the old route did', async () => {
    // The row shape mig 792 produces for 50plus: the page half of the
    // campaign_funnel block first, then the studio's content blocks; one
    // Stillorgan studio row holding the offer and the attribution.
    h.loaded = {
      page: {
        ...FIFTY,
        chrome: { tone: 'light', noindex: true },
        blocks: [
          { id: 'cf', type: 'campaign_funnel', campaign: '50plus', heading: 'A free trial of The 50+ Club', video_url: 'https://x/v.mp4', poster_url: 'https://x/p.jpg' },
          { id: 's1', type: 'stats', items: [{ number: '4.9', label: 'Rating' }] },
          { id: 'v1', type: 'video_testimonials', items: [{ video_url: 'https://x/a.mp4', poster_url: 'https://x/a.jpg' }] },
          { id: 'r1', type: 'reviews', min_rating: 4 },
        ],
      },
      studios: FIFTY_STUDIOS,
    }
    const html = await render({ slug: '50plus' })
    expect(html).toContain('A free trial of The 50+ Club')
    expect(html).toContain('https://x/v.mp4')
    expect(html).toContain('Built for where you are now')
    expect(html).toContain('4.9') // stats tile
    expect(html).toContain('https://x/a.jpg') // video testimonial poster
    expect(html).toMatch(/^(<link [^>]*>)?<div class="min-h-screen bg-white text-black/)
    expectClientSafe(html)
    const funnel = propsOf(html, 'campaign')
    expect(funnel).toMatchObject({ publicPath: 'stillorgan', campaign: '50plus', page: '50plus' })
    expect(funnel.copy.heading).toBe('A free trial of The 50+ Club')
    expect(funnel.copy.trial_membership_id).toBeUndefined()
    expect(funnel.copy.class_keywords).toBeUndefined()
    const meta = await generateMetadata({ params: Promise.resolve({ slug: '50plus' }), searchParams: Promise.resolve({}) })
    expect(meta.robots).toEqual({ index: false, follow: false })
  })

  it('the backfilled /corp row renders the promo copy with {credits} filled from the registry, and /corp/hatch-3-free selects that promo', async () => {
    h.loaded = {
      page: { ...CORP, blocks: [{ id: 'cp', type: 'corp_promo', heading: '{credits} free classes at {studio_name}', ticks: ['{credits} coach-led classes, free'] }] },
      studios: CORP_STUDIOS,
    }
    const root = propsOf(await render({ slug: 'corp' }), 'corp')
    expect(root.promoKey).toBe('hatch-3-free')
    expect(root.copy.heading).toBe('3 free classes at Hatch Street')
    expect(root.copy.ticks).toEqual(['3 coach-led classes, free'])
    expect(root.copy.title).toBe('Exclusive Corporate Trial') // untouched fields keep the registry default
    const sub = await render({ slug: 'corp', rest: ['hatch-3-free'] })
    expect(propsOf(sub, 'corp')).toMatchObject({ promoKey: 'hatch-3-free', page: 'corp', studio: 'hatch-street' })
    expect(propsOf(sub, 'corp').copy.heading).toBe('3 free classes at Hatch Street')
    expectClientSafe(sub)
  })

  it('a live paid_trial all-studios page with no ?studio renders the picker over enabled rows only; ?studio=hatch preselects Hatch; ?studio=<disabled> falls back to the picker', async () => {
    h.loaded = { page: TRIAL, studios: TRIAL_STUDIOS_ROWS }
    const html = await render({ slug: 'trial' })
    const paid = propsOf(html, 'paid')
    expect(paid.studios.map((s) => s.key)).toEqual(['stillorgan', 'hatch'])
    expect(paid.studios.map((s) => s.sellable)).toEqual([true, true])
    expect(paid.studios[0]).toMatchObject({ priceCents: 3900, label: 'UN1T Stillorgan' })
    expect(paid.initialStudio).toBeNull()
    expect(paid.returnPath).toBe('/trial')
    expect(paid.page).toBe('trial')
    expect(paid.studios.map((s) => s.publicPath)).toEqual(['stillorgan', 'hatch-street'])
    expect(paid.hatchTerms).toMatchObject({ required: true, terms_url: '/legal/un1t/hatch-street/terms' })
    expect(html).toContain('https://x/trial-logo.png')
    expect(html).toContain('4.9')
    expect(html).not.toContain('xtown')
    expectClientSafe(html)

    const hatch = propsOf(await render({ slug: 'trial', sp: { studio: 'hatch' } }), 'paid')
    expect(hatch.initialStudio).toBe('hatch')
    const hatchPath = propsOf(await render({ slug: 'trial', sp: { studio: 'hatch-street' } }), 'paid')
    expect(hatchPath.initialStudio).toBe('hatch')

    const disabled = propsOf(await render({ slug: 'trial', sp: { studio: 'xtown' } }), 'paid')
    expect(disabled.initialStudio).toBeNull()
    expect(disabled.studios.map((s) => s.key)).toEqual(['stillorgan', 'hatch'])
  })

  it('the un1t.online terms tick keeps the studio\'s own wording from its legacy class_funnel block (nothing visible changes)', async () => {
    h.loaded = { page: TRIAL, studios: TRIAL_STUDIOS_ROWS }
    h.legacyBlocks = [{ type: 'class_funnel', terms_label: 'CUSTOM {studio_name} {terms}', terms_link_label: 'the rules' }]
    const paid = propsOf(await render({ slug: 'trial' }), 'paid')
    expect(paid.hatchTerms).toMatchObject({ label: 'CUSTOM Hatch Street {terms}', terms_link_label: 'the rules', terms_url: '/legal/un1t/hatch-street/terms' })
    h.loaded = { page: CORP, studios: CORP_STUDIOS }
    const corp = propsOf(await render({ slug: 'corp' }), 'corp')
    expect(corp.terms).toMatchObject({ label: 'CUSTOM Hatch Street {terms}', terms_link_label: 'the rules' })
  })

  it('a checkout return carries the purchase and the cancel flag to the card', async () => {
    h.loaded = { page: TRIAL, studios: TRIAL_STUDIOS_ROWS }
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const paid = propsOf(await render({ slug: 'trial', sp: { purchase: id, studio: 'hatch', cancelled: '1' } }), 'paid')
    expect(paid).toMatchObject({ resumePurchaseId: id, cancelled: true, initialStudio: 'hatch' })
  })

  it('a draft page 404s; a retired page redirects with the query kept; coming_soon 404s', async () => {
    h.loaded = { page: { ...FIFTY, publish_state: 'draft' }, studios: FIFTY_STUDIOS }
    expect(await outcome({ slug: '50plus' })).toBe('NEXT_NOT_FOUND')
    h.loaded = { page: { ...FIFTY, publish_state: 'coming_soon' }, studios: FIFTY_STUDIOS }
    expect(await outcome({ slug: '50plus' })).toBe('NEXT_NOT_FOUND')
    h.loaded = { page: { ...FIFTY, slug: 'start', offer_type: 'none', blocks: [], publish_state: 'retired', redirect_to: '/trial?studio=stillorgan' }, studios: [] }
    expect(await outcome({ slug: 'start', rest: ['hatch-street'], sp: { utm_campaign: 'x' } })).toBe('redirect /trial?studio=hatch-street&utm_campaign=x')
    expect(redirect).toHaveBeenCalledWith('/trial?studio=hatch-street&utm_campaign=x')
    // /start/hatch (the old alias) and an incoming ?studio= the target sets: one studio, the path's.
    expect(await outcome({ slug: 'start', rest: ['hatch'], sp: { studio: 'stillorgan', fbclid: 'f' } })).toBe('redirect /trial?studio=hatch-street&fbclid=f')
    expect(await outcome({ slug: 'start', rest: [], sp: { studio: 'hatch' } })).toBe('redirect /trial?studio=stillorgan')
    // A retired page with nowhere to go is a 404, never a 500.
    h.loaded = { page: { ...FIFTY, publish_state: 'retired', redirect_to: null }, studios: [] }
    expect(await outcome({ slug: '50plus' })).toBe('NEXT_NOT_FOUND')
    h.loaded = null
    expect(await outcome({ slug: 'nothing-here' })).toBe('NEXT_NOT_FOUND')
  })

  it('a studio-kind page 404s in PR1 (left to /welcome/[location])', async () => {
    h.loaded = { page: { ...TRIAL, kind: 'studio', slug: 'stillorgan', scope: 'one', primary_location_id: 'loc-s' }, studios: [TRIAL_STUDIOS_ROWS[0]] }
    expect(await outcome({ slug: 'stillorgan' })).toBe('NEXT_NOT_FOUND')
  })

  it('an unreadable landing_pages read renders nothing but still never throws: notFound()', async () => {
    h.loadThrows = new PageReadError('Could not read the page', { message: 'boom' })
    expect(await outcome({ slug: 'trial' })).toBe('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('public-page', expect.any(String), expect.objectContaining({ slug: 'trial' }))
    h.loadThrows = new Error('network')
    expect(await outcome({ slug: 'trial' })).toBe('NEXT_NOT_FOUND')
    // Metadata on the same failure is the defaults, not a throw.
    await expect(generateMetadata({ params: Promise.resolve({ slug: 'trial' }), searchParams: Promise.resolve({}) })).resolves.toEqual({})
  })

  it('a page switched on at no studio 404s (a disabled studio is never offered); a content-only page needs none', async () => {
    h.loaded = { page: FIFTY, studios: [{ ...FIFTY_STUDIOS[0], enabled: false }] }
    expect(await outcome({ slug: '50plus' })).toBe('NEXT_NOT_FOUND')
    h.loaded = { page: TRIAL, studios: TRIAL_STUDIOS_ROWS.map((r) => ({ ...r, enabled: false })) }
    expect(await outcome({ slug: 'trial' })).toBe('NEXT_NOT_FOUND')
    h.loaded = { page: { ...TRIAL, slug: 'january', offer_type: 'none', blocks: [{ id: 's1', type: 'stats', items: [{ number: '7', label: 'Days' }] }] }, studios: [] }
    const html = await render({ slug: 'january' })
    expect(html).toContain('Days')
    expect(html).not.toContain('data-testid="paid"')
  })

  it('a class_funnel page hands ClassFunnel named words only, posting against the studio\'s own path', async () => {
    h.loaded = { page: CLASSF, studios: CLASSF_STUDIOS }
    const html = await render({ slug: 'hatch-classes' })
    const props = propsOf(html, 'classfunnel')
    const ALLOWED = ['classDoneBody', 'classDoneTitle', 'consentLabel', 'consultDoneBody', 'consultDoneTitle', 'consultSlug', 'heading', 'locationName', 'page', 'publicPath', 'subhead']
    for (const k of Object.keys(props)) expect(ALLOWED, k).toContain(k)
    expect(html).not.toContain('Mon 07:00 HIIT') // the studio's typed timetable stays on the server
    expect(props).toMatchObject({ publicPath: 'hatch-street', page: 'hatch-classes', locationName: 'Hatch Street', heading: 'Book your first class', subhead: 'Pick a time', consultSlug: '' })
    expect(html).toContain('href="#start"')
    expectClientSafe(html)
  })

  it('a class_funnel or one_class page whose studio has no public path is not for sale: 404 (never Stillorgan, never ?path=null); edit mode still previews', async () => {
    h.loaded = { page: { ...CLASSF, primary_location_id: 'loc-z' }, studios: [{ ...CLASSF_STUDIOS[0], location_id: 'loc-z' }] }
    expect(await outcome({ slug: 'hatch-classes' })).toBe('NEXT_NOT_FOUND')
    h.loaded = { page: { ...FIFTY, primary_location_id: 'loc-z' }, studios: [{ ...FIFTY_STUDIOS[0], location_id: 'loc-z' }] }
    expect(await outcome({ slug: '50plus' })).toBe('NEXT_NOT_FOUND')
    expect(logWarn).toHaveBeenCalledWith('public-page', expect.stringContaining('no public path'), expect.objectContaining({ locationId: 'loc-z' }))
    h.user = { id: 'u1', isMaster: true, activeOrganization: { id: 'org-un1t' } }
    const html = await render({ slug: '50plus', sp: { edit: '1' } })
    expect(html).toContain('data-testid="overlay"')
    expect(html).not.toContain('data-testid="campaign"')
    // No live card that would book at a fallback studio: a notice instead.
    expect(propsOf(html, 'overlay').offerLayout.offer.props.children).toContain('no public path yet')
  })

  it('anything under a slug that the page does not serve 404s', async () => {
    h.loaded = { page: FIFTY, studios: FIFTY_STUDIOS }
    expect(await outcome({ slug: '50plus', rest: ['x'] })).toBe('NEXT_NOT_FOUND')
  })

  it('a promo_credits page sells the sub-path promo, else the row\'s; an unknown promo is not available', async () => {
    h.loaded = { page: CORP, studios: CORP_STUDIOS }
    const root = propsOf(await render({ slug: 'corp' }), 'corp')
    expect(root.promoKey).toBe('hatch-3-free')
    expect(root).toMatchObject({ page: 'corp', studio: 'hatch-street' })
    expect(root.copy.heading).toBe('3 free classes at Hatch Street')
    expect(root.terms).toMatchObject({ required: true, terms_url: '/legal/un1t/hatch-street/terms' })
    const sub = propsOf(await render({ slug: 'corp', rest: ['hatch-3-free'] }), 'corp')
    expect(sub.promoKey).toBe('hatch-3-free')
    const unknown = propsOf(await render({ slug: 'corp', rest: ['nope'] }), 'corp')
    expect(unknown.promoKey).toBeNull()
    expect(unknown.copy.unavailable_text).toBe('This offer is not available right now.')
    // The page offers only its row's promo: a sub-path naming another key,
    // even a live one in the registry, is not available (the claim refuses it).
    h.loaded = { page: CORP, studios: [row('loc-h', { offer: { promo_key: 'acme-5-free' }, locations: loc('loc-h', 'un1t_online') })] }
    const other = propsOf(await render({ slug: 'corp', rest: ['hatch-3-free'] }), 'corp')
    expect(other.promoKey).toBeNull()
    expect(other.copy.unavailable_text).toBe('This offer is not available right now.')
  })

  it('reads reviews for the resolved studio when the page has a reviews block', async () => {
    h.loaded = { page: { ...FIFTY, blocks: [...FIFTY.blocks, { id: 'r1', type: 'reviews', min_rating: 4 }] }, studios: FIFTY_STUDIOS }
    await render({ slug: '50plus' })
    expect(h.calls.reviews).toContainEqual(['location_id', 'loc-s'])
  })

  it('?edit=1 mounts EditModeOverlay with the merged blocks', async () => {
    h.user = { id: 'u1', isMaster: true, activeOrganization: { id: 'org-other' } }
    h.loaded = { page: { ...FIFTY, organization_id: 'org-other', publish_state: 'draft' }, studios: FIFTY_STUDIOS }
    const html = await render({ slug: '50plus', sp: { edit: '1' } })
    expect(h.calls.load[0]).toEqual({ orgId: 'org-other', slug: '50plus' })
    const overlay = propsOf(html, 'overlay')
    expect(overlay.initialBlocks.map((b) => b.id)).toEqual(['cf', 's1', 'v1'])
    expect(overlay.initialBlocks[0]).toMatchObject({ type: 'campaign_funnel', campaign: '50plus' })
    // EDITGATE.1 parity: the studio half (ids, plan codes, keywords, attribution) is withheld.
    expect(overlay.initialBlocks[0]).not.toHaveProperty('class_keywords')
    expectClientSafe(html)
    expect(overlay.initialLogoUrl).toBe('https://x/logo.png')
    expect(overlay.footer).toMatchObject({ brand: 'UN1T', legalName: 'Champ Fitness Ltd' })
  })

  it('edit mode on a one_class page passes offerLayout with the hero copy and the offer block id', async () => {
    h.user = { id: 'u1', isMaster: true, activeOrganization: { id: 'org-un1t' } }
    h.loaded = { page: { ...FIFTY, publish_state: 'draft' }, studios: FIFTY_STUDIOS }
    const html = await render({ slug: '50plus', sp: { edit: '1' } })
    const overlay = propsOf(html, 'overlay')
    expect(overlay.offerLayout).toMatchObject({
      kind: 'one_class',
      offerBlockId: 'cf',
      cta: { href: '#book', label: 'Book a free class' },
      hero: { videoUrl: 'https://x/v.mp4', posterUrl: 'https://x/p.jpg', soundLabel: 'Tap for sound', heading: 'A free trial of The 50+ Club', eyebrow: 'The 50+ Club · Stillorgan' },
      expect: { eyebrow: 'What to expect', heading: 'Built for where you are now' },
    })
    expect(overlay.offerLayout.expect.cards).toHaveLength(3)
    // The live booking card, built exactly as the public page builds it.
    expect(overlay.offerLayout.offer.props).toMatchObject({ publicPath: 'stillorgan', campaign: '50plus', page: '50plus', locationName: 'UN1T Stillorgan' })
    expect(overlay.offerLayout.offer.props.copy.heading).toBe('A free trial of The 50+ Club')
    expect(overlay.offerLayout.offer.props.copy).not.toHaveProperty('class_keywords')
    // The trial card hand-off is the legacy overlay's; a page passes its layout instead.
    expect(overlay.trialPreview ?? null).toBeNull()
    expectClientSafe(html)
  })

  it('edit mode on a paid_trial page renders the trial card as preview', async () => {
    h.user = { id: 'u1', isMaster: true, activeOrganization: { id: 'org-un1t' } }
    h.loaded = { page: TRIAL, studios: TRIAL_STUDIOS_ROWS }
    // Choose on page: no ?studio=, the picker over every enabled studio.
    const picker = propsOf(await render({ slug: 'trial', sp: { edit: '1' } }), 'overlay')
    expect(picker.offerLayout).toMatchObject({ kind: 'frosted', anchor: 'trial', offerBlockId: 'pt1', cta: { href: '#trial', label: 'Start my trial' } })
    expect(picker.offerLayout.offer.props).toMatchObject({ preview: true, initialStudio: null, resumePurchaseId: null, cancelled: false, returnPath: '/trial', page: 'trial' })
    expect(picker.offerLayout.offer.props.studios.map((s) => s.publicPath)).toEqual(['stillorgan', 'hatch-street'])
    // A previewed studio: its card, still disabled.
    const html = await render({ slug: 'trial', sp: { edit: '1', studio: 'hatch-street', purchase: 'abc' } })
    const one = propsOf(html, 'overlay')
    expect(one.offerLayout.offer.props).toMatchObject({ preview: true, initialStudio: 'hatch', resumePurchaseId: null })
    expectClientSafe(html)
  })

  it('a signed-in user who may not view the page gets no overlay: a draft 404s, a live page is the public render with nothing secret', async () => {
    h.user = { id: 'u2', isMaster: false, role: 'staff', activeOrganization: { id: 'org-un1t' }, locationIds: ['loc-h'] }
    h.loaded = { page: { ...FIFTY, publish_state: 'draft' }, studios: FIFTY_STUDIOS }
    expect(await outcome({ slug: '50plus', sp: { edit: '1' } })).toBe('NEXT_NOT_FOUND')
    h.loaded = { page: FIFTY, studios: FIFTY_STUDIOS }
    const html = await render({ slug: '50plus', sp: { edit: '1' } })
    expect(html).not.toContain('data-testid="overlay"')
    expect(html).toContain('data-testid="campaign"')
    expectClientSafe(html)
  })

  it('a signed-in user of another org with ?edit=1 sees the host\'s live page as a visitor (no overlay)', async () => {
    h.user = { id: 'u3', isMaster: false, role: 'staff', activeOrganization: { id: 'org-other' }, locationIds: [] }
    h.loadedByOrg = { 'org-other': null, 'org-un1t': { page: FIFTY, studios: FIFTY_STUDIOS } }
    const html = await render({ slug: '50plus', sp: { edit: '1' } })
    expect(h.calls.load).toEqual([
      { orgId: 'org-other', slug: '50plus' },
      { orgId: 'org-un1t', slug: '50plus' },
    ])
    expect(html).not.toContain('data-testid="overlay"')
    expect(html).toContain('data-testid="campaign"')
    expectClientSafe(html)
  })

  it('a signed-in user of another org whose own org has no such page and the host has none either still gets a 404', async () => {
    h.user = { id: 'u3', isMaster: false, role: 'staff', activeOrganization: { id: 'org-other' }, locationIds: [] }
    h.loadedByOrg = { 'org-other': null, 'org-un1t': null }
    expect(await outcome({ slug: '50plus', sp: { edit: '1' } })).toBe('NEXT_NOT_FOUND')
  })

  it('a signed-in editor of the page\'s org still gets the overlay (one read, no fallback)', async () => {
    h.user = { id: 'u1', isMaster: true, activeOrganization: { id: 'org-un1t' } }
    h.loaded = { page: { ...FIFTY, publish_state: 'draft' }, studios: FIFTY_STUDIOS }
    const html = await render({ slug: '50plus', sp: { edit: '1' } })
    expect(html).toContain('data-testid="overlay"')
    expect(h.calls.load).toEqual([{ orgId: 'org-un1t', slug: '50plus' }])
  })

  it('an anonymous ?edit=1 is an ordinary visit: the host\'s organisation, and a draft 404s', async () => {
    h.loaded = { page: { ...FIFTY, publish_state: 'draft' }, studios: FIFTY_STUDIOS }
    expect(await outcome({ slug: '50plus', sp: { edit: '1' } })).toBe('NEXT_NOT_FOUND')
    expect(h.calls.load[0]).toEqual({ orgId: 'org-un1t', slug: '50plus' })
  })

  it('a meta_title that already carries the brand is not suffixed twice', async () => {
    h.loaded = { page: { ...FIFTY, chrome: { meta_title: 'The 50+ Club | UN1T' } }, studios: FIFTY_STUDIOS }
    const meta = await generateMetadata({ params: Promise.resolve({ slug: '50plus' }), searchParams: Promise.resolve({}) })
    expect(meta.title).toBe('The 50+ Club | UN1T')
    h.loaded = { page: { ...FIFTY, chrome: { meta_title: '  The 50+ Club | un1t  ' } }, studios: FIFTY_STUDIOS }
    const loose = await generateMetadata({ params: Promise.resolve({ slug: '50plus' }), searchParams: Promise.resolve({}) })
    expect(loose.title).toBe('The 50+ Club | un1t')
  })

  it('metadata: the meta title, else the page title, then the brand; noindex follows the chrome', async () => {
    h.loaded = { page: FIFTY, studios: FIFTY_STUDIOS }
    const meta = await generateMetadata({ params: Promise.resolve({ slug: '50plus' }), searchParams: Promise.resolve({}) })
    expect(meta).toMatchObject({ title: 'The 50+ Club Trial | UN1T', robots: { index: false, follow: false } })
    h.loaded = { page: { ...TRIAL, chrome: { meta_description: 'Pay once.' } }, studios: TRIAL_STUDIOS_ROWS }
    const indexed = await generateMetadata({ params: Promise.resolve({ slug: 'trial' }), searchParams: Promise.resolve({}) })
    expect(indexed).toMatchObject({ title: '14 Day Reset | UN1T', description: 'Pay once.', robots: { index: true, follow: true } })
    expect(indexed.title).not.toContain('—')
    h.loaded = { page: { ...TRIAL, publish_state: 'draft' }, studios: [] }
    expect(await generateMetadata({ params: Promise.resolve({ slug: 'trial' }), searchParams: Promise.resolve({}) })).toEqual({})
  })
})
