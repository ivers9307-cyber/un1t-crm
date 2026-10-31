// TRIALSTUDIO.2 — the studios the /trial page offers and what each one sells.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ logWarn: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: mocks.logWarn, logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/brands', () => ({ UN1T_GROUP_ORG_ID: 'org-un1t', resolveBrand: vi.fn(() => null) }))
vi.mock('@/lib/tenant-domains-edge', () => ({ resolveTenantOrgId: vi.fn(async () => null) }))

import { TRIAL_STUDIOS, studioByKey, loadTrialStudios, trialEntryFromRow, trialRedirectFor, readPaidTrialAccountEmailCopy } from './trial-studios'
import { PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT } from './paid-trial'

const STILLORGAN_BLOCK = { type: 'paid_trial', price_cents: 3900, currency: 'EUR', membership_id: 'm1', plan_code: 'p1', product_name: 'The 14 Day Reset' }
const HATCH_BLOCK = { type: 'paid_trial', un1t_product_id: 'p-1', product_name: 'The UN1T Trial' }
const PRODUCT = { un1t_id: 'p-1', status: 'active', type: 'one_time', price_cents: 3900, currency: 'eur' }

// A db serving the `trial` page (landing_pages by org + slug), its studio rows
// (landing_page_studios by page id), the studio pages' slugs (landing_pages by
// kind + primary location) and the un1t_products read. `pages` is one entry
// per studio: its location, public path, locations embed and the paid_trial
// block fields its row carries as its `offer`.
function fakeDb({ pages, pagesError = null, studiosError = null, noTrialPage = false, trialState = 'live', pageBlocks, product = { data: PRODUCT, error: null } }) {
  const calls = { pages: [], studios: [], paths: [], products: [] }
  const trialPage = {
    id: 'p-trial', organization_id: 'org-un1t', slug: 'trial', kind: 'campaign', scope: 'all', primary_location_id: null,
    offer_type: 'paid_trial', publish_state: trialState, chrome: {},
    blocks: pageBlocks || [{ id: 'pt', type: 'paid_trial' }],
  }
  const studioRows = (pages || []).map((p, i) => {
    const { id: _id, type: _type, ...offer } = (p.blocks || []).find((b) => b.type === 'paid_trial') || {}
    return { page_id: 'p-trial', location_id: p.location_id, enabled: p.enabled !== false, sort_order: p.sort_order ?? i, offer, attribution: p.attribution || {}, locations: p.locations }
  })
  const db = {
    from: (table) => {
      const eq = {}
      const q = {
        select: (cols) => { q.cols = cols; return q },
        eq: (c, v) => { eq[c] = v; if (table === 'un1t_products') calls.products.push([c, v]); return q },
        order: () => q,
        maybeSingle: async () => {
          if (table === 'landing_pages' && eq.primary_location_id) {
            calls.paths.push(eq)
            const hit = (pages || []).find((p) => p.location_id === eq.primary_location_id)
            return { data: hit?.public_path ? { slug: hit.public_path } : null, error: null }
          }
          if (table === 'landing_pages') {
            calls.pages.push({ cols: q.cols, eq })
            if (pagesError) return { data: null, error: pagesError }
            return { data: noTrialPage ? null : trialPage, error: null }
          }
          if (table === 'un1t_products') { calls.productCols = q.cols; return product }
          throw new Error(`unexpected table ${table}`)
        },
        then: (res, rej) => {
          if (table !== 'landing_page_studios') throw new Error(`unexpected table ${table}`)
          calls.studios.push({ cols: q.cols, eq })
          return Promise.resolve(studiosError ? { data: null, error: studiosError } : { data: studioRows, error: null }).then(res, rej)
        },
      }
      return q
    },
  }
  return { db, calls }
}
const rows = (hatchBlocks = [HATCH_BLOCK]) => [
  { location_id: 'loc-s', public_path: 'stillorgan', blocks: [STILLORGAN_BLOCK], locations: { membership_source: 'glofox' } },
  { location_id: 'loc-h', public_path: 'hatch-street', blocks: hatchBlocks, locations: { membership_source: 'un1t_online', settings: { un1t_online: { writes_enabled: true } } } },
]

beforeEach(() => vi.clearAllMocks())

describe('studioByKey', () => {
  it('maps hatch to hatch-street and refuses anything else', () => {
    expect(studioByKey('hatch').publicPath).toBe('hatch-street')
    expect(studioByKey('stillorgan').publicPath).toBe('stillorgan')
    expect(studioByKey('HATCH')).toBeNull()
    expect(studioByKey('')).toBeNull()
    expect(studioByKey(undefined)).toBeNull()
    expect(studioByKey('constructor')).toBeNull()
  })
  it('TRIAL_STUDIOS is frozen, Stillorgan first', () => {
    expect(Object.isFrozen(TRIAL_STUDIOS)).toBe(true)
    expect(TRIAL_STUDIOS.map((s) => s.key)).toEqual(['stillorgan', 'hatch'])
  })
})

describe('loadTrialStudios', () => {
  it('loads both studios from the trial page\'s rows: one page read, one studios read, one product read', async () => {
    const { db, calls } = fakeDb({ pages: rows() })
    const out = await loadTrialStudios(db)
    expect(calls.pages).toHaveLength(1)
    expect(calls.pages[0].eq).toEqual({ organization_id: 'org-un1t', slug: 'trial' })
    expect(calls.studios).toHaveLength(1)
    expect(calls.studios[0].eq).toEqual({ page_id: 'p-trial' })
    expect(calls.studios[0].cols).toContain('locations:location_id ( id, name, membership_source, settings, timezone )')
    // Each enabled row's public path is its studio page's slug.
    expect(calls.paths.map((e) => e.primary_location_id).sort()).toEqual(['loc-h', 'loc-s'])
    expect(calls.products).toEqual([['location_id', 'loc-h'], ['un1t_id', 'p-1']])
    // The product's type is read: only a one-off is for sale (F3).
    expect(calls.productCols.split(',').map((c) => c.trim())).toContain('type')
    expect(out.map((s) => s.key)).toEqual(['stillorgan', 'hatch'])
    expect(out[0]).toMatchObject({ publicPath: 'stillorgan', locationId: 'loc-s', membershipSource: 'glofox', sellable: true, product: null })
    expect(out[0].config).toMatchObject({ provider: 'glofox', priceCents: 3900 })
    expect(out[1]).toMatchObject({ publicPath: 'hatch-street', locationId: 'loc-h', membershipSource: 'un1t_online', sellable: true, product: PRODUCT })
    expect(out[1].config).toMatchObject({ provider: 'un1t_online', un1tProductId: 'p-1', priceCents: 3900, currency: 'EUR' })
    // The block is the page's block merged with the row's offer, the row's attribution on top (tag and lead source filled by default).
    expect(out[1].block).toMatchObject({ type: 'paid_trial', un1t_product_id: 'p-1', product_name: 'The UN1T Trial', tag: 'hatch-street-trial', lead_source: 'meta_trial' })
    expect(out[1].config).toMatchObject({ tag: 'hatch-street-trial', leadSource: 'meta_trial' })
  })
  it('a row\'s own attribution wins over the defaults', async () => {
    const pages = rows()
    pages[1].attribution = { tag: 'hatch-row-tag', lead_source: 'meta_hatch_trial', event_source_url: 'https://www.un1tdublin.com/hatch-trial' }
    const out = await loadTrialStudios(fakeDb({ pages }).db)
    expect(out[1].config).toMatchObject({ tag: 'hatch-row-tag', leadSource: 'meta_hatch_trial', eventSourceUrl: 'https://www.un1tdublin.com/hatch-trial' })
  })
  it('a switched-off row is not offered; the known key answers empty, and rows order by sort_order after the known keys', async () => {
    const pages = rows()
    pages[1].enabled = false
    const off = await loadTrialStudios(fakeDb({ pages }).db)
    expect(off[1]).toMatchObject({ key: 'hatch', locationId: null, sellable: false, config: null })
    expect(off[1].unreadable).toBeUndefined()
    // A third enabled studio rides after the two known ones, keyed by its path.
    const third = [...rows(), { location_id: 'loc-n', public_path: 'newtown', blocks: [STILLORGAN_BLOCK], locations: { membership_source: 'glofox' } }]
    const out = await loadTrialStudios(fakeDb({ pages: third }).db)
    expect(out.map((s) => s.key)).toEqual(['stillorgan', 'hatch', 'newtown'])
  })
  it('a studio with no studio page (no public path) is not offered', async () => {
    const pages = rows()
    pages[1].public_path = null
    const out = await loadTrialStudios(fakeDb({ pages }).db)
    expect(out[1]).toMatchObject({ key: 'hatch', locationId: null, sellable: false })
    expect(out[0].sellable).toBe(true)
  })
  it('only a live trial page sells: none, a draft, a retired or a coming_soon page answers every known studio empty (not unreadable)', async () => {
    for (const opts of [{ noTrialPage: true }, { trialState: 'draft' }, { trialState: 'retired' }, { trialState: 'coming_soon' }]) {
      const out = await loadTrialStudios(fakeDb({ pages: rows(), ...opts }).db)
      expect(out.map((s) => s.key)).toEqual(['stillorgan', 'hatch'])
      expect(out.every((s) => s.sellable === false && s.locationId === null && s.unreadable === undefined)).toBe(true)
    }
  })
  it('accepts the locations embed as a one-element array', async () => {
    const pages = rows()
    pages[1].locations = [{ membership_source: 'un1t_online', settings: { un1t_online: { writes_enabled: true } } }]
    const out = await loadTrialStudios(fakeDb({ pages }).db)
    expect(out[1].membershipSource).toBe('un1t_online')
  })
  it('a un1t.online studio with its writes off is not sellable (not unreadable), and its settings never leave the loader', async () => {
    for (const settings of [{ un1t_online: { writes_enabled: false } }, {}, null]) {
      const pages = rows()
      pages[1].locations = { membership_source: 'un1t_online', settings }
      const { db, calls } = fakeDb({ pages })
      const out = await loadTrialStudios(db)
      expect(out[1]).toMatchObject({ key: 'hatch', locationId: 'loc-h', membershipSource: 'un1t_online', sellable: false, config: null })
      expect(out[1].block).toMatchObject({ type: 'paid_trial', un1t_product_id: 'p-1' })
      expect(out[1]).not.toHaveProperty('unreadable')
      expect(calls.products).toEqual([])
      expect(out[0].sellable).toBe(true)
    }
    const out = await loadTrialStudios(fakeDb({ pages: rows() }).db)
    for (const s of out) {
      expect(s).not.toHaveProperty('settings')
      expect(JSON.stringify(s)).not.toContain('writes_enabled')
    }
  })
  it('a missing Hatch row or a page with no paid_trial block is not sellable', async () => {
    const noRow = await loadTrialStudios(fakeDb({ pages: [rows()[0]] }).db)
    expect(noRow[1]).toMatchObject({ key: 'hatch', locationId: null, membershipSource: null, block: null, product: null, sellable: false, config: null })
    expect(noRow[0].sellable).toBe(true)
    const { db, calls } = fakeDb({ pages: rows(), pageBlocks: [{ id: 'h', type: 'hero' }] })
    const noBlock = await loadTrialStudios(db)
    expect(noBlock[1]).toMatchObject({ locationId: 'loc-h', block: null, sellable: false, config: null })
    expect(noBlock[0]).toMatchObject({ locationId: 'loc-s', block: null, sellable: false })
    expect(calls.products).toEqual([])
    // A row with no product id on its offer holds a block but sells nothing, and reads no product.
    const bare = fakeDb({ pages: rows([{ type: 'paid_trial', product_name: 'x' }]) })
    const bareOut = await loadTrialStudios(bare.db)
    expect(bareOut[1]).toMatchObject({ locationId: 'loc-h', sellable: false, config: null })
    expect(bare.calls.products).toEqual([])
  })
  it('a un1t block with no mirrored product, or an inactive one, is not sellable', async () => {
    const none = await loadTrialStudios(fakeDb({ pages: rows(), product: { data: null, error: null } }).db)
    expect(none[1]).toMatchObject({ sellable: false, config: null, product: null })
    const inactive = await loadTrialStudios(fakeDb({ pages: rows(), product: { data: { ...PRODUCT, status: 'archived' }, error: null } }).db)
    expect(inactive[1]).toMatchObject({ sellable: false, config: null })
    // Nothing for sale is not the same as "could not read": no flag on these.
    expect(none[1].unreadable).toBeUndefined()
    expect(inactive[1].unreadable).toBeUndefined()
  })
  it('a recurring un1t.online product is not sellable', async () => {
    for (const type of ['recurring', 'subscription', undefined]) {
      const out = await loadTrialStudios(fakeDb({ pages: rows(), product: { data: { ...PRODUCT, type }, error: null } }).db)
      expect(out[1]).toMatchObject({ sellable: false, config: null })
      expect(out[1].unreadable).toBeUndefined()
    }
  })
  it('a product read error is not sellable and logs ids only', async () => {
    const { db } = fakeDb({ pages: rows(), product: { data: null, error: { message: 'boom secret' } } })
    const out = await loadTrialStudios(db)
    expect(out[1]).toMatchObject({ sellable: false, config: null })
    expect(out[0].sellable).toBe(true)
    expect(out[1].unreadable).toBe(true)
    expect(out[0].unreadable).toBeUndefined()
    expect(mocks.logWarn).toHaveBeenCalledTimes(1)
    const [, , meta] = mocks.logWarn.mock.calls[0]
    expect(meta).toMatchObject({ locationId: 'loc-h', un1tId: 'p-1' })
    expect(JSON.stringify(meta)).not.toContain('secret')
  })
  it('a trial page or studios read error marks every studio not sellable and unreadable', async () => {
    for (const opts of [{ pagesError: { message: 'down' } }, { studiosError: { message: 'down' } }]) {
      mocks.logWarn.mockClear()
      const out = await loadTrialStudios(fakeDb({ pages: rows(), ...opts }).db)
      expect(out.map((s) => s.sellable)).toEqual([false, false])
      expect(out.every((s) => s.config === null && s.block === null)).toBe(true)
      expect(out.every((s) => s.unreadable === true)).toBe(true)
      expect(mocks.logWarn).toHaveBeenCalledTimes(1)
    }
  })
})

// PAGES.1 — one entry from a landing_page_studios row and its merged block.
describe('trialEntryFromRow', () => {
  const studioRow = (over = {}) => ({ location_id: 'loc-h', locations: { id: 'loc-h', name: 'Hatch', membership_source: 'un1t_online', settings: { un1t_online: { writes_enabled: true } } }, ...over })
  it('builds the loadTrialStudios shape: TRIAL_STUDIOS key for a known path, the product read, the config', async () => {
    const { db, calls } = fakeDb({ pages: [] })
    const out = await trialEntryFromRow(db, { row: studioRow(), publicPath: 'hatch-street', mergedBlock: HATCH_BLOCK })
    expect(out).toMatchObject({ key: 'hatch', publicPath: 'hatch-street', locationId: 'loc-h', membershipSource: 'un1t_online', block: HATCH_BLOCK, product: PRODUCT, sellable: true })
    expect(out.config).toMatchObject({ provider: 'un1t_online', priceCents: 3900 })
    expect(calls.products).toEqual([['location_id', 'loc-h'], ['un1t_id', 'p-1']])
    expect(JSON.stringify(out)).not.toContain('writes_enabled')
  })
  it('an unknown path keys by the path; no block or writes off is not sellable; a product error is unreadable', async () => {
    const glofox = { location_id: 'loc-n', locations: { membership_source: 'glofox' } }
    const other = await trialEntryFromRow(fakeDb({ pages: [] }).db, { row: glofox, publicPath: 'newtown', mergedBlock: STILLORGAN_BLOCK })
    expect(other).toMatchObject({ key: 'newtown', sellable: true })
    const none = await trialEntryFromRow(fakeDb({ pages: [] }).db, { row: glofox, publicPath: 'newtown', mergedBlock: null })
    expect(none).toMatchObject({ key: 'newtown', block: null, sellable: false, config: null })
    const off = await trialEntryFromRow(fakeDb({ pages: [] }).db, { row: studioRow({ locations: { membership_source: 'un1t_online', settings: {} } }), publicPath: 'hatch-street', mergedBlock: HATCH_BLOCK })
    expect(off).toMatchObject({ sellable: false, config: null })
    expect(off.unreadable).toBeUndefined()
    const err = await trialEntryFromRow(fakeDb({ pages: [], product: { data: null, error: { message: 'x' } } }).db, { row: studioRow(), publicPath: 'hatch-street', mergedBlock: HATCH_BLOCK })
    expect(err).toMatchObject({ sellable: false, unreadable: true })
  })
})

// Final-review F2 — the settle sweep's explanation email copy, off the studio page's block.
describe('readPaidTrialAccountEmailCopy', () => {
  const STUDIO_PAGE = {
    id: 'p-h', organization_id: 'org-un1t', slug: 'hatch-street', kind: 'studio', scope: 'one', primary_location_id: 'loc-h',
    offer_type: 'paid_trial', publish_state: 'live', chrome: {}, blocks: [{ type: 'hero' }, { id: 'pt', type: 'paid_trial', account_email_subject: 'S {product_name}', account_email_body: 'B {product_name}' }],
  }
  const STUDIO_ROW = { page_id: 'p-h', location_id: 'loc-h', enabled: true, sort_order: 0, offer: { product_name: 'The UN1T Trial' }, attribution: {} }
  function copyDb({ page = STUDIO_PAGE, studios = [STUDIO_ROW], pageError = null, throws = false } = {}) {
    const calls = []
    const db = {
      from: (table) => {
        const eq = {}
        calls.push({ table, eq })
        const q = {
          select: () => q,
          eq: (c, v) => { eq[c] = v; return q },
          order: () => q,
          maybeSingle: async () => { if (throws) throw new Error('net secret'); return { data: pageError ? null : page, error: pageError } },
          then: (res, rej) => Promise.resolve({ data: studios, error: null }).then(res, rej),
        }
        return q
      },
    }
    return { db, calls }
  }
  it("reads the studio's page by location and answers its paid_trial block's copy", async () => {
    const { db, calls } = copyDb()
    expect(await readPaidTrialAccountEmailCopy(db, 'loc-h')).toEqual({ subject: 'S {product_name}', body: 'B {product_name}' })
    expect(calls[0]).toEqual({ table: 'landing_pages', eq: { kind: 'studio', primary_location_id: 'loc-h' } })
    expect(calls.map((c) => c.table)).toEqual(['landing_pages', 'landing_page_studios'])
  })
  it('the row\'s offer is merged over the block before the copy is read', async () => {
    const out = await readPaidTrialAccountEmailCopy(copyDb({ studios: [{ ...STUDIO_ROW, offer: { account_email_subject: 'Row subject' } }] }).db, 'loc-h')
    expect(out.subject).toBe('Row subject')
  })
  it('a blank field, a missing block or page, a read error or a throw answers the defaults and logs ids only', async () => {
    const defaults = { subject: PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT.account_email_subject, body: PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT.account_email_body }
    expect(await readPaidTrialAccountEmailCopy(copyDb({ page: { ...STUDIO_PAGE, blocks: [{ id: 'pt', type: 'paid_trial', account_email_subject: '  ' }] }, studios: [] }).db, 'loc-h')).toEqual(defaults)
    expect(await readPaidTrialAccountEmailCopy(copyDb({ page: { ...STUDIO_PAGE, blocks: [{ type: 'hero' }] } }).db, 'loc-h')).toEqual(defaults)
    expect(await readPaidTrialAccountEmailCopy(copyDb({ page: null }).db, 'loc-h')).toEqual(defaults)
    expect(mocks.logWarn).not.toHaveBeenCalled()
    expect(await readPaidTrialAccountEmailCopy(copyDb({ pageError: { code: 'XX000', message: 'secret' } }).db, 'loc-h')).toEqual(defaults)
    expect(await readPaidTrialAccountEmailCopy(copyDb({ throws: true }).db, 'loc-h')).toEqual(defaults)
    expect(mocks.logWarn).toHaveBeenCalledTimes(2)
    for (const [, , meta] of mocks.logWarn.mock.calls) {
      expect(meta.locationId).toBe('loc-h')
      expect(JSON.stringify(meta)).not.toContain('secret')
    }
  })
})

// TRIALSTUDIO.11 — /start and /start/<studio> redirect here with the studio preselected.
describe('trialRedirectFor', () => {
  it('maps the studio and keeps the query', () => {
    expect(trialRedirectFor('hatch-street', new URLSearchParams('utm_campaign=x&fbclid=y'))).toBe('/trial?studio=hatch&utm_campaign=x&fbclid=y')
    expect(trialRedirectFor('stillorgan', new URLSearchParams(''))).toBe('/trial?studio=stillorgan')
    expect(trialRedirectFor('somewhere', new URLSearchParams('a=1'))).toBe('/trial?a=1')
  })
  it('accepts the plain object Next hands a page, repeating a key for an array value', () => {
    expect(trialRedirectFor('hatch-street', { utm_campaign: 'x', a: ['1', '2'] })).toBe('/trial?studio=hatch&utm_campaign=x&a=1&a=2')
    expect(trialRedirectFor('stillorgan', {})).toBe('/trial?studio=stillorgan')
    expect(trialRedirectFor('stillorgan', undefined)).toBe('/trial?studio=stillorgan')
  })
  it('drops an incoming studio and puts the mapped one first', () => {
    expect(trialRedirectFor('hatch-street', new URLSearchParams('utm_campaign=x&studio=stillorgan'))).toBe('/trial?studio=hatch&utm_campaign=x')
    expect(trialRedirectFor('somewhere', { studio: 'hatch' })).toBe('/trial')
  })
})
