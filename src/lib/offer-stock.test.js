import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

import { offerStockStatus, offerStockLine, readOfferStock, stockRefusalState, OFFER_LOW_STOCK_AT } from './offer-stock'
import { DEFAULT_OFFERS_PAGE_COPY as copy, offersPageCopy, offerPageMode } from './offer-studios'

describe('offerStockStatus', () => {
  const at = (stock_limit, sold, held = 0) => offerStockStatus({ stock_limit }, { sold, held })

  it('has nothing to say about an offer with no limit or no counts', () => {
    expect(at(null, 3)).toBeNull()
    expect(offerStockStatus({ stock_limit: 4 }, undefined)).toBeNull()
  })
  it('stays quiet until few are left', () => {
    expect(at(20, 2).state).toBe('available')
    expect(at(20, 20 - OFFER_LOW_STOCK_AT)).toMatchObject({ state: 'low', left: OFFER_LOW_STOCK_AT })
  })
  it('counts checkouts in progress as taken', () => {
    expect(at(4, 1, 2)).toMatchObject({ state: 'low', left: 1 })
  })
  it('separates all-held from really sold out', () => {
    expect(at(4, 3, 1)).toMatchObject({ state: 'all_reserved', left: 0 })
    expect(at(4, 4)).toMatchObject({ state: 'sold_out', left: 0 })
  })
  it('never shows a negative number when sales pass the limit', () => {
    expect(at(4, 6, 1)).toMatchObject({ state: 'sold_out', left: 0 })
  })
})

describe('offerStockLine', () => {
  it('states the real number', () => {
    expect(offerStockLine({ state: 'low', left: 4 }, copy)).toBe('Only 4 left')
  })
  it('takes the studio wording', () => {
    const c = offersPageCopy({ settings: { offers_page: { stockLeft: '{n} remaining' } } })
    expect(offerStockLine({ state: 'low', left: 2 }, c)).toBe('2 remaining')
  })
  it('says nothing when stock is plentiful or unknown', () => {
    expect(offerStockLine({ state: 'available', left: 9 }, copy)).toBeNull()
    expect(offerStockLine(null, copy)).toBeNull()
  })
})

describe('readOfferStock', () => {
  it('asks only about offers with a limit', async () => {
    const rpc = vi.fn(async () => ({ data: [{ offer_id: 'a', sold: 1, held: 0 }], error: null }))
    const out = await readOfferStock({ rpc }, [{ id: 'a', stock_limit: 2 }, { id: 'b', stock_limit: null }])
    expect(rpc.mock.calls[0][1].p_offer_ids).toEqual(['a'])
    expect(out.get('a')).toMatchObject({ left: 1 })
    expect(out.has('b')).toBe(false)
  })
  it('makes no call when nothing is limited', async () => {
    const rpc = vi.fn()
    await readOfferStock({ rpc }, [{ id: 'b', stock_limit: null }])
    expect(rpc).not.toHaveBeenCalled()
  })
  it('shows nothing, not a wrong number, when the read fails', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'x' } }))
    expect((await readOfferStock({ rpc }, [{ id: 'a', stock_limit: 2 }])).size).toBe(0)
  })
})

describe('stockRefusalState', () => {
  it('reads only the two trigger codes', () => {
    expect(stockRefusalState({ code: 'OFS01' })).toBe('sold_out')
    expect(stockRefusalState({ code: 'OFS02' })).toBe('all_reserved')
    expect(stockRefusalState({ code: '23505' })).toBeNull()
    expect(stockRefusalState(null)).toBeNull()
  })
})

describe('offerPageMode when sold out', () => {
  it('replaces the form', () => {
    expect(offerPageMode({ open: true, upcoming: false, soldOut: true })).toBe('sold_out')
  })
  it('still confirms a buyer returning from payment', () => {
    expect(offerPageMode({ open: true, upcoming: false, purchase: 'p', soldOut: true })).toBe('resume')
  })
})

describe('mig 850', () => {
  const sql = readFileSync(path.resolve(import.meta.dirname, '../../supabase/migrations/850_offer_stock_limits.sql'), 'utf8')
  it('only limits new page checkouts, never a recorded payment', () => {
    expect(sql).toContain("IF NEW.origin <> 'page' OR NEW.state <> 'created' THEN")
  })
  it('locks the offer before counting', () => {
    expect(sql.indexOf('FOR NO KEY UPDATE;')).toBeLessThan(sql.indexOf('FROM public.offer_stock_counts(ARRAY[NEW.offer_id]'))
    expect(sql.indexOf('FOR NO KEY UPDATE;')).toBeGreaterThan(-1)
  })
  it('raises the codes the app reads', () => {
    expect(sql).toContain("ERRCODE = 'OFS01'")
    expect(sql).toContain("ERRCODE = 'OFS02'")
  })
})
