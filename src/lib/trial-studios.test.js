// TRIALSTUDIO.2 — the studios the /trial page offers and what each one sells.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ logWarn: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: mocks.logWarn, logError: vi.fn(), logInfo: vi.fn() }))

import { TRIAL_STUDIOS, studioByKey, loadTrialStudios } from './trial-studios'

const STILLORGAN_BLOCK = { type: 'paid_trial', price_cents: 3900, currency: 'EUR', membership_id: 'm1', plan_code: 'p1', product_name: 'The 14 Day Reset' }
const HATCH_BLOCK = { type: 'paid_trial', un1t_product_id: 'p-1', product_name: 'The UN1T Trial' }
const PRODUCT = { un1t_id: 'p-1', status: 'active', price_cents: 3900, currency: 'eur' }

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
  { location_id: 'loc-h', public_path: 'hatch-street', blocks: hatchBlocks, locations: { membership_source: 'un1t_online' } },
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
    expect(calls.landing[0].cols).toContain('locations:location_id ( membership_source )')
    expect(calls.products).toEqual([['location_id', 'loc-h'], ['un1t_id', 'p-1']])
    expect(out.map((s) => s.key)).toEqual(['stillorgan', 'hatch'])
    expect(out[0]).toMatchObject({ publicPath: 'stillorgan', locationId: 'loc-s', membershipSource: 'glofox', sellable: true, product: null })
    expect(out[0].config).toMatchObject({ provider: 'glofox', priceCents: 3900 })
    expect(out[1]).toMatchObject({ publicPath: 'hatch-street', locationId: 'loc-h', membershipSource: 'un1t_online', sellable: true, product: PRODUCT })
    expect(out[1].config).toMatchObject({ provider: 'un1t_online', un1tProductId: 'p-1', priceCents: 3900, currency: 'EUR' })
    expect(out[1].block).toBe(HATCH_BLOCK)
  })
  it('accepts the locations embed as a one-element array', async () => {
    const pages = rows()
    pages[1].locations = [{ membership_source: 'un1t_online' }]
    const out = await loadTrialStudios(fakeDb({ pages }).db)
    expect(out[1].membershipSource).toBe('un1t_online')
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
