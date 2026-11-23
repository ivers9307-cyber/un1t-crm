import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../tests/helpers/fake-db'

// The storefront's own gate (active, open, payment rail ready) and its stock
// read have their own tests; here they are stand-ins so each case says only
// what the storefront answered.
vi.mock('@/lib/sale-offers-block', () => ({ sellableSaleOffers: vi.fn() }))
vi.mock('@/lib/offer-stock', () => ({ readOfferStock: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { sellableSaleOffers } from '@/lib/sale-offers-block'
import { readOfferStock } from '@/lib/offer-stock'
import { readCurrentOffers } from './offer-read'

const ORG = '00000000-0000-4000-8000-0000000000a1'
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2'
const STILL = '00000000-0000-4000-8000-0000000000b1'
const HATCH = '00000000-0000-4000-8000-0000000000b2'
const BASE = 'https://crm.test'
const NOW = new Date('2026-11-25T12:00:00Z')

const location = (id, name, slug, extra = {}) => ({ id, name, slug, organization_id: ORG, timezone: 'Europe/Dublin', membership_source: 'glofox', settings: { glofox: { api_key: 'SECRET-SETTINGS' } }, ...extra })
const page = (id, slug, title, extra = {}) => ({
  id, organization_id: ORG, slug, title, kind: 'campaign', scope: 'all', primary_location_id: null,
  offer_type: 'none', blocks: [], chrome: {}, publish_state: 'live', redirect_to: null, ...extra,
})
const row = (pageId, locationId, offer = {}, extra = {}) => ({ page_id: pageId, location_id: locationId, enabled: true, offer, attribution: { tag: 'SECRET-TAG' }, sort_order: 0, ...extra })
const promo = (locationId, key, extra = {}) => ({
  id: `promo-${key}-${locationId.slice(-2)}`, location_id: locationId, key, name: key, platform: 'glofox', credits: 3, expires_in_days: 7,
  live: true, tag: 'SECRET-PROMO-TAG', lead_source: 'x', kind: 'promo', window_starts_on: null, window_ends_on: null, max_classes: null, max_per_day: null,
  glofox_membership_id: 'SECRET-MEMBERSHIP', glofox_plan_code: 'SECRET-PLAN', ...extra,
})

const TRIAL_OFFER = { membership_id: 'SECRET-MEMBERSHIP', plan_code: 'SECRET-PLAN', price_cents: 3900, currency: 'EUR', duration_days: 14 }

function seed({ pages = [], rows = [], promos = [], errors = {} } = {}) {
  return createFakeDb({
    tables: {
      locations: [location(STILL, 'UN1T Stillorgan', 'un1t-stillorgan'), location(HATCH, 'UN1T Hatch Street', 'un1t-hatch-street')],
      landing_pages: [
        page('p-still', 'stillorgan', 'UN1T Stillorgan', { kind: 'studio', scope: 'one', primary_location_id: STILL, offer_type: 'paid_trial', blocks: [{ id: 'b1', type: 'paid_trial' }] }),
        page('p-hatch', 'hatch-street', 'UN1T Hatch Street', { kind: 'studio', scope: 'one', primary_location_id: HATCH, offer_type: 'paid_trial', blocks: [{ id: 'b1', type: 'paid_trial' }] }),
        ...pages,
      ],
      landing_page_studios: [row('p-still', STILL, TRIAL_OFFER), row('p-hatch', HATCH, TRIAL_OFFER), ...rows],
      corp_promos: promos,
      un1t_products: [],
    },
    errors,
  })
}

const read = (db, opts = {}) => readCurrentOffers(db, { organizationId: ORG, threadLocationId: STILL, baseUrl: BASE, now: NOW, ...opts })
const studioOf = (res, name) => res.studios.find((s) => s.studio === name)
const titles = (res, name) => (studioOf(res, name)?.pages || []).map((p) => p.title)

beforeEach(() => {
  vi.mocked(sellableSaleOffers).mockReset().mockResolvedValue({ ok: true, studioKey: null, offers: [] })
  vi.mocked(readOfferStock).mockReset().mockResolvedValue(new Map())
})

const TRIAL_PAGE = page('p-trial', 'trial', '14 Day Reset', { offer_type: 'paid_trial', blocks: [{ id: 'b1', type: 'paid_trial', ticks: ['14 days of unlimited classes'] }] })
const OPEN_WEEK_PAGE = page('p-week', 'openweek', 'Open Week', { offer_type: 'promo_credits', blocks: [{ id: 'b1', type: 'corp_promo' }] })
const openWeekPromo = (loc, extra = {}) => promo(loc, 'open-week', { kind: 'open_week', window_starts_on: '2026-11-23', window_ends_on: '2026-11-29', max_classes: 5, max_per_day: 1, ...extra })

describe('readCurrentOffers: which pages are listed', () => {
  it('lists a live page switched on at the studio, with its link, the thread studio first', async () => {
    const res = await read(seed({ pages: [TRIAL_PAGE], rows: [row('p-trial', STILL, TRIAL_OFFER), row('p-trial', HATCH, TRIAL_OFFER)] }))
    expect(res.ok).toBe(true)
    expect(res.studios.map((s) => [s.studio, s.this_conversation])).toEqual([['UN1T Stillorgan', true], ['UN1T Hatch Street', false]])
    const trial = studioOf(res, 'UN1T Stillorgan').pages.find((p) => p.title === '14 Day Reset')
    expect(trial).toMatchObject({ price_label: '€39', ends_label: null, url: `${BASE}/trial?studio=stillorgan`, priority: 'lead' })
    const hatchTrial = studioOf(res, 'UN1T Hatch Street').pages.find((p) => p.title === '14 Day Reset')
    expect(hatchTrial.url).toBe(`${BASE}/trial?studio=hatch-street`)
  })

  it('leaves out a draft, a coming soon and a retired page, and a row switched off', async () => {
    const res = await read(seed({
      pages: [
        page('p-d', 'draft', 'Draft page', { publish_state: 'draft' }),
        page('p-c', 'soon', 'Soon page', { publish_state: 'coming_soon' }),
        page('p-r', 'old', 'Old page', { publish_state: 'retired' }),
        page('p-off', 'off', 'Off page'),
        page('p-on', 'on', 'On page'),
      ],
      rows: [row('p-d', STILL), row('p-c', STILL), row('p-r', STILL), row('p-off', STILL, {}, { enabled: false }), row('p-on', STILL)],
    }))
    expect(titles(res, 'UN1T Stillorgan').sort()).toEqual(['On page', 'UN1T Stillorgan'])
  })

  it("never lists another organisation's page", async () => {
    const res = await read(seed({ pages: [page('p-x', 'theirs', 'Their page', { organization_id: OTHER_ORG })], rows: [row('p-x', STILL)] }))
    expect(titles(res, 'UN1T Stillorgan')).not.toContain('Their page')
  })

  it('the trial appears once: on /trial with its price, the studio page without', async () => {
    const res = await read(seed({ pages: [TRIAL_PAGE], rows: [row('p-trial', STILL, TRIAL_OFFER)] }))
    const pages = studioOf(res, 'UN1T Stillorgan').pages
    expect(pages.find((p) => p.title === '14 Day Reset').price_label).toBe('€39')
    expect(pages.find((p) => p.title === 'UN1T Stillorgan')).toMatchObject({ price_label: null, url: `${BASE}/stillorgan` })
  })

  it('a studio page keeps its trial when no campaign page sells one there', async () => {
    const res = await read(seed())
    expect(studioOf(res, 'UN1T Stillorgan').pages).toEqual([expect.objectContaining({ title: 'UN1T Stillorgan', price_label: '€39', priority: 'lead' })])
  })

  it('a trial that cannot be sold (no plan set) is left out', async () => {
    const res = await read(seed({ pages: [TRIAL_PAGE], rows: [row('p-trial', STILL, { price_cents: 3900 })] }))
    expect(titles(res, 'UN1T Stillorgan')).not.toContain('14 Day Reset')
  })

  it('a page switched on only at the other studio sits under that studio', async () => {
    const only = page('p-corp', 'corp', 'Corporate promo', { scope: 'one', primary_location_id: HATCH, offer_type: 'promo_credits', blocks: [{ id: 'b1', type: 'corp_promo' }] })
    const res = await read(seed({ pages: [only], rows: [row('p-corp', HATCH, { promo_key: 'corp' })], promos: [promo(HATCH, 'corp')] }))
    expect(titles(res, 'UN1T Stillorgan')).not.toContain('Corporate promo')
    const hatch = studioOf(res, 'UN1T Hatch Street')
    expect(hatch.this_conversation).toBe(false)
    expect(hatch.pages.find((p) => p.title === 'Corporate promo')).toMatchObject({ price_label: 'Free', url: `${BASE}/corp` })
  })
})

describe('readCurrentOffers: promos and Open Week', () => {
  const withWeek = (promoExtra = {}) => seed({
    pages: [TRIAL_PAGE, OPEN_WEEK_PAGE],
    rows: [row('p-trial', STILL, TRIAL_OFFER), row('p-week', STILL, { promo_key: 'open-week' })],
    promos: [openWeekPromo(STILL, promoExtra)],
  })

  it('Open Week leads the paid trial while its window is open', async () => {
    const pages = studioOf(await read(withWeek()), 'UN1T Stillorgan').pages
    expect(pages.map((p) => [p.title, p.priority])).toEqual([['Open Week', 'lead'], ['14 Day Reset', 'normal'], ['UN1T Stillorgan', 'normal']])
    expect(pages[0]).toMatchObject({ price_label: 'Free', ends_label: 'Sun 29 Nov' })
  })

  it('the day after the window ends Open Week is gone and the trial leads', async () => {
    const pages = studioOf(await read(withWeek(), { now: new Date('2026-11-30T09:00:00Z') }), 'UN1T Stillorgan').pages
    expect(pages.map((p) => [p.title, p.priority])).toEqual([['14 Day Reset', 'lead'], ['UN1T Stillorgan', 'normal']])
  })

  it('it is still listed on the last day of the window, on the studio clock', async () => {
    const pages = studioOf(await read(withWeek(), { now: new Date('2026-11-29T23:30:00Z') }), 'UN1T Stillorgan').pages
    expect(pages[0].title).toBe('Open Week')
  })

  it('a promo that is switched off, or that the studio row does not name, is left out', async () => {
    expect(titles(await read(withWeek({ live: false })), 'UN1T Stillorgan')).not.toContain('Open Week')
    const noKey = seed({ pages: [OPEN_WEEK_PAGE], rows: [row('p-week', STILL, {})], promos: [openWeekPromo(STILL)] })
    expect(titles(await read(noKey), 'UN1T Stillorgan')).not.toContain('Open Week')
  })

  it('the operator override on a page changes the lead', async () => {
    const db = seed({
      pages: [{ ...TRIAL_PAGE, chrome: { mia_priority: 'lead' } }, { ...OPEN_WEEK_PAGE, chrome: { mia_priority: 'ask_only', mia_note: 'Only for people who ask about Open Week.' } }],
      rows: [row('p-trial', STILL, TRIAL_OFFER), row('p-week', STILL, { promo_key: 'open-week' })],
      promos: [openWeekPromo(STILL)],
    })
    const pages = studioOf(await read(db), 'UN1T Stillorgan').pages
    expect(pages.map((p) => [p.title, p.priority])).toEqual([['14 Day Reset', 'lead'], ['UN1T Stillorgan', 'normal'], ['Open Week', 'only_if_asked']])
    expect(pages[2].for).toBe('Only for people who ask about Open Week.')
  })
})

describe('readCurrentOffers: the store', () => {
  const OFFER = { id: 'SECRET-OFFER-ID', location_id: STILL, slug: '20-class-pack', category: 'class_pack', name: '20 Class Pack', bonus_headline: '+5 free classes', price_cents: 38000, currency: 'EUR', active: true, starts_at: null, ends_at: '2026-11-30T23:59:59Z', sort: 1, stock_limit: 50 }
  const storeAt = (loc, answer) => vi.mocked(sellableSaleOffers).mockImplementation(async (_db, id) => (id === loc ? answer : { ok: true, studioKey: null, offers: [] }))

  it('lists a sellable store offer with its storefront link', async () => {
    storeAt(STILL, { ok: true, studioKey: 'stillorgan', offers: [OFFER] })
    const store = studioOf(await read(seed()), 'UN1T Stillorgan').store
    expect(store).toEqual([{ name: '20 Class Pack', category: 'class_pack', bonus: '+5 free classes', price_label: '€380', ends_label: 'Mon 30 Nov, 23:59', opens_label: null, while_stocks_last: true, sold_out: false, url: `${BASE}/offers/stillorgan/20-class-pack` }])
  })

  it('a sold out offer stays, marked sold out', async () => {
    storeAt(STILL, { ok: true, studioKey: 'stillorgan', offers: [OFFER] })
    vi.mocked(readOfferStock).mockResolvedValue(new Map([['SECRET-OFFER-ID', { limit: 50, sold: 50, held: 0, left: 0, state: 'sold_out' }]]))
    expect(studioOf(await read(seed()), 'UN1T Stillorgan').store[0]).toMatchObject({ while_stocks_last: true, sold_out: true })
  })

  it('stock that cannot be read: still listed, flagged from its limit, not sold out', async () => {
    storeAt(STILL, { ok: true, studioKey: 'stillorgan', offers: [OFFER] })
    vi.mocked(readOfferStock).mockRejectedValue(new Error('boom'))
    expect(studioOf(await read(seed()), 'UN1T Stillorgan').store[0]).toMatchObject({ while_stocks_last: true, sold_out: false })
  })

  it('a studio with no storefront key lists no store offers', async () => {
    storeAt(STILL, { ok: true, studioKey: null, offers: [OFFER] })
    expect(studioOf(await read(seed()), 'UN1T Stillorgan').store).toEqual([])
  })

  it('a sale page is listed with its link and no price; its offers sit under store', async () => {
    storeAt(STILL, { ok: true, studioKey: 'stillorgan', offers: [OFFER] })
    const sale = page('p-sale', 'sale', 'Offers', { offer_type: 'sale', blocks: [{ id: 'b1', type: 'sale_offers' }] })
    const s = studioOf(await read(seed({ pages: [sale], rows: [row('p-sale', STILL, { offer_ids: ['SECRET-OFFER-ID'] })] })), 'UN1T Stillorgan')
    expect(s.pages.find((p) => p.title === 'Offers')).toMatchObject({ price_label: null, url: `${BASE}/sale?studio=stillorgan`, priority: 'normal' })
    expect(s.store).toHaveLength(1)
  })
})

describe('readCurrentOffers: a failed read is unknown, never empty', () => {
  const OFFER = { id: 'o1', location_id: STILL, slug: 'gift', category: 'gift_card', name: 'Gift Card', bonus_headline: null, price_cents: 10000, currency: 'EUR', starts_at: null, ends_at: null, stock_limit: null }

  it('the store unreadable: the pages are intact and the studio is flagged', async () => {
    vi.mocked(sellableSaleOffers).mockResolvedValue({ ok: false })
    const res = await read(seed())
    expect(res.ok).toBe(true)
    const s = studioOf(res, 'UN1T Stillorgan')
    expect(s.store_unreadable).toBe(true)
    expect(s.pages).toHaveLength(1)
  })

  it('the pages unreadable: the store is intact and each studio is flagged', async () => {
    vi.mocked(sellableSaleOffers).mockImplementation(async (_db, id) => (id === STILL ? { ok: true, studioKey: 'stillorgan', offers: [OFFER] } : { ok: true, studioKey: null, offers: [] }))
    const res = await read(seed({ errors: { landing_pages: { select: { message: 'boom', code: 'XX000' } } } }))
    expect(res.ok).toBe(true)
    const s = studioOf(res, 'UN1T Stillorgan')
    expect(s.pages_unreadable).toBe(true)
    expect(s.pages).toEqual([])
    expect(s.store).toHaveLength(1)
  })

  it("one studio's promo unreadable flags that studio's pages and keeps the rest", async () => {
    const db = seed({
      pages: [TRIAL_PAGE, OPEN_WEEK_PAGE],
      rows: [row('p-trial', STILL, TRIAL_OFFER), row('p-week', STILL, { promo_key: 'open-week' })],
      promos: [openWeekPromo(STILL)],
      errors: { corp_promos: { select: { message: 'boom', code: 'XX000' } } },
    })
    const s = studioOf(await read(db), 'UN1T Stillorgan')
    expect(s.pages_unreadable).toBe(true)
    expect(s.pages.map((p) => p.title)).toEqual(['14 Day Reset', 'UN1T Stillorgan'])
  })

  it("another studio's failed store read is still reported, never dropped", async () => {
    vi.mocked(sellableSaleOffers).mockImplementation(async (_db, id) => (id === HATCH ? { ok: false } : { ok: true, studioKey: null, offers: [] }))
    const db = seed()
    db.tables.landing_page_studios = db.tables.landing_page_studios.filter((r) => r.location_id !== HATCH)
    const hatch = studioOf(await read(db), 'UN1T Hatch Street')
    expect(hatch).toMatchObject({ this_conversation: false, pages: [], store: [], store_unreadable: true })
  })

  it('everything unreadable is not ok', async () => {
    vi.mocked(sellableSaleOffers).mockResolvedValue({ ok: false })
    expect(await read(seed({ errors: { landing_pages: { select: { message: 'boom' } } } }))).toEqual({ ok: false })
  })

  it('the studios themselves unreadable is not ok, and it never throws', async () => {
    expect(await read(seed({ errors: { locations: { select: { message: 'boom' } } } }))).toEqual({ ok: false })
    expect(await readCurrentOffers(null, { organizationId: ORG, threadLocationId: STILL, baseUrl: BASE })).toEqual({ ok: false })
    expect(await read(seed(), { organizationId: null })).toEqual({ ok: false })
  })
})

describe('readCurrentOffers: nothing internal leaves', () => {
  it('no key, code, id, tag or setting is in the result', async () => {
    vi.mocked(sellableSaleOffers).mockImplementation(async (_db, id) => (id === STILL
      ? { ok: true, studioKey: 'stillorgan', offers: [{ id: 'SECRET-OFFER-ID', slug: 'pack', category: 'class_pack', name: 'Pack', price_cents: 1000, currency: 'EUR', stock_limit: 7, starts_at: null, ends_at: null }] }
      : { ok: true, studioKey: null, offers: [] }))
    vi.mocked(readOfferStock).mockResolvedValue(new Map([['SECRET-OFFER-ID', { limit: 7, sold: 4, held: 1, left: 2, state: 'low' }]]))
    const db = seed({
      pages: [TRIAL_PAGE, OPEN_WEEK_PAGE],
      rows: [row('p-trial', STILL, TRIAL_OFFER), row('p-week', STILL, { promo_key: 'open-week' })],
      promos: [openWeekPromo(STILL)],
    })
    const text = JSON.stringify(await read(db))
    expect(text).not.toMatch(/SECRET/)
    expect(text).not.toContain('open-week')
    expect(text).not.toContain(STILL)
    expect(text).not.toContain('p-trial')
    expect(text).not.toMatch(/"(left|sold|held|limit)":/)
  })
})
