// TRIALSTUDIO.2 — the studios the /trial page offers and what each one sells.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ logWarn: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: mocks.logWarn, logError: vi.fn(), logInfo: vi.fn() }))

import { TRIAL_STUDIOS, studioByKey, loadTrialStudios, trialEntryFromRow, trialRedirectFor, readPaidTrialAccountEmailCopy } from './trial-studios'
import { PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT } from './paid-trial'

const STILLORGAN_BLOCK = { type: 'paid_trial', price_cents: 3900, currency: 'EUR', membership_id: 'm1', plan_code: 'p1', product_name: 'The 14 Day Reset' }
const HATCH_BLOCK = { type: 'paid_trial', un1t_product_id: 'p-1', product_name: 'The UN1T Trial' }
const PRODUCT = { un1t_id: 'p-1', status: 'active', type: 'one_time', price_cents: 3900, currency: 'eur' }

// A db whose landing_page_settings read and un1t_products read are scripted.
function fakeDb({ pages, pagesError = null, product = { data: PRODUCT, error: null } }) {
  const calls = { landing: [], products: [] }
  const db = {
    from: (table) => {
      if (table === 'landing_page_settings') {
        return { select: (cols) => ({ in: async (col, vals) => { calls.landing.push({ cols, col, vals }); return { data: pages, error: pagesError } } }) }
      }
      if (table === 'un1t_products') {
        return { select: (cols) => { const q = { eq: (c, v) => { calls.products.push([c, v]); return q }, maybeSingle: async () => product }; calls.productCols = cols; return q } }
      }
      throw new Error(`unexpected table ${table}`)
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
  it('loads both studios with one landing read and one product read', async () => {
    const { db, calls } = fakeDb({ pages: rows() })
    const out = await loadTrialStudios(db)
    expect(calls.landing).toHaveLength(1)
    expect(calls.landing[0].vals).toEqual(['stillorgan', 'hatch-street'])
    expect(calls.landing[0].cols).toContain('locations:location_id ( membership_source, settings )')
    expect(calls.products).toEqual([['location_id', 'loc-h'], ['un1t_id', 'p-1']])
    // The product's type is read: only a one-off is for sale (F3).
    expect(calls.productCols.split(',').map((c) => c.trim())).toContain('type')
    expect(out.map((s) => s.key)).toEqual(['stillorgan', 'hatch'])
    expect(out[0]).toMatchObject({ publicPath: 'stillorgan', locationId: 'loc-s', membershipSource: 'glofox', sellable: true, product: null })
    expect(out[0].config).toMatchObject({ provider: 'glofox', priceCents: 3900 })
    expect(out[1]).toMatchObject({ publicPath: 'hatch-street', locationId: 'loc-h', membershipSource: 'un1t_online', sellable: true, product: PRODUCT })
    expect(out[1].config).toMatchObject({ provider: 'un1t_online', un1tProductId: 'p-1', priceCents: 3900, currency: 'EUR' })
    expect(out[1].block).toBe(HATCH_BLOCK)
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
      expect(out[1]).toMatchObject({ key: 'hatch', locationId: 'loc-h', membershipSource: 'un1t_online', block: HATCH_BLOCK, sellable: false, config: null })
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
  it('a missing Hatch row or block is not sellable', async () => {
    const noRow = await loadTrialStudios(fakeDb({ pages: [rows()[0]] }).db)
    expect(noRow[1]).toMatchObject({ key: 'hatch', locationId: null, membershipSource: null, block: null, product: null, sellable: false, config: null })
    expect(noRow[0].sellable).toBe(true)
    const { db, calls } = fakeDb({ pages: rows([{ type: 'hero' }]) })
    const noBlock = await loadTrialStudios(db)
    expect(noBlock[1]).toMatchObject({ locationId: 'loc-h', block: null, sellable: false, config: null })
    expect(calls.products).toEqual([])
  })
  it('a un1t block with no mirrored product, or an inactive one, is not sellable', async () => {
    const none = await loadTrialStudios(fakeDb({ pages: rows(), product: { data: null, error: null } }).db)
    expect(none[1]).toMatchObject({ sellable: false, config: null, product: null })
    const inactive = await loadTrialStudios(fakeDb({ pages: rows(), product: { data: { ...PRODUCT, status: 'archived' }, error: null } }).db)
    expect(inactive[1]).toMatchObject({ sellable: false, config: null })
    // Nothing for sale is not the same as "could not read": no flag on these.
    expect(none[1].unreadable).toBeUndefined()
    expect(inactive[1].unreadable).toBeUndefined()
    const noBlock = await loadTrialStudios(fakeDb({ pages: rows([{ type: 'hero' }]) }).db)
    expect(noBlock[1].unreadable).toBeUndefined()
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
  it('a landing read error marks every studio not sellable', async () => {
    const out = await loadTrialStudios(fakeDb({ pages: null, pagesError: { message: 'down' } }).db)
    expect(out.map((s) => s.sellable)).toEqual([false, false])
    expect(out.every((s) => s.config === null && s.block === null)).toBe(true)
    expect(out.every((s) => s.unreadable === true)).toBe(true)
    expect(mocks.logWarn).toHaveBeenCalledTimes(1)
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

// Final-review F2 — the settle sweep's explanation email copy, off the studio's block.
describe('readPaidTrialAccountEmailCopy', () => {
  function copyDb({ data = null, error = null, throws = false } = {}) {
    const calls = []
    const q = {
      select: (cols) => { calls.push(['select', cols]); return q },
      eq: (c, v) => { calls.push(['eq', c, v]); return q },
      in: async (c, v) => { calls.push(['in', c, v]); if (throws) throw new Error('net secret'); return { data, error } },
    }
    return { db: { from: (t) => { calls.push(['from', t]); return q } }, calls }
  }
  it("reads the location's trial landing rows and answers the block's copy", async () => {
    const { db, calls } = copyDb({ data: [{ public_path: 'hatch-street', blocks: [{ type: 'hero' }, { ...HATCH_BLOCK, account_email_subject: 'S {product_name}', account_email_body: 'B {product_name}' }] }] })
    expect(await readPaidTrialAccountEmailCopy(db, 'loc-h')).toEqual({ subject: 'S {product_name}', body: 'B {product_name}' })
    expect(calls).toContainEqual(['from', 'landing_page_settings'])
    expect(calls).toContainEqual(['eq', 'location_id', 'loc-h'])
    expect(calls).toContainEqual(['in', 'public_path', ['stillorgan', 'hatch-street']])
  })
  it('a blank field, a missing block, a read error or a throw answers the defaults and logs ids only', async () => {
    const defaults = { subject: PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT.account_email_subject, body: PAID_TRIAL_ACCOUNT_EMAIL_DEFAULT.account_email_body }
    expect(await readPaidTrialAccountEmailCopy(copyDb({ data: [{ blocks: [{ ...HATCH_BLOCK, account_email_subject: '  ' }] }] }).db, 'loc-h')).toEqual(defaults)
    expect(await readPaidTrialAccountEmailCopy(copyDb({ data: [] }).db, 'loc-h')).toEqual(defaults)
    expect(await readPaidTrialAccountEmailCopy(copyDb({ error: { code: 'XX000', message: 'secret' } }).db, 'loc-h')).toEqual(defaults)
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
