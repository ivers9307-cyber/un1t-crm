import { describe, it, expect, vi } from 'vitest'

vi.mock('../registry', () => ({ viewerActiveLocationId: (user) => user?.activeLocation?.id || null }))

import { offerPurchasesProvider } from './offer-purchases'

const user = { activeLocation: { id: 'loc1' } }

function makeDb(rows, { count = rows.length } = {}) {
  const calls = { eqs: [], is: [] }
  const chain = {
    from() { return this },
    select(sel, opts) { this._head = opts?.head; return this },
    eq(col, val) { calls.eqs.push([col, val]); return this },
    is(col, val) { calls.is.push([col, val]); return this },
    order() { return this },
    limit() { return Promise.resolve({ data: rows, error: null }) },
    then(resolve) { resolve({ count, error: null }) }, // head-count await path
  }
  return { db: chain, calls }
}

describe('offerPurchasesProvider', () => {
  it('maps paid+unfulfilled rows to inbox items scoped to the active location', async () => {
    const rows = [{
      id: 'p1', buyer_name: 'Jane Doe', buyer_email: 'j@e.com', amount_cents: 49700,
      currency: 'EUR', paid_at: '2026-08-08T12:00:00Z', location_id: 'loc1',
      offer: { id: 'o1', name: '3 Month Membership', bonus_headline: '+2 WEEKS FREE' },
      location: { id: 'loc1', name: 'UN1T Stillorgan' },
    }]
    const { db, calls } = makeDb(rows)
    const { count, items } = await offerPurchasesProvider.fetchPending(db, user)
    expect(count).toBe(1)
    expect(items[0]).toEqual(expect.objectContaining({
      id: 'p1', title: 'Jane Doe', subtitle: '3 Month Membership · €497',
      meta: 'UN1T Stillorgan', reviewUrl: '/offer-sales?focus=p1',
    }))
    expect(calls.eqs).toContainEqual(['state', 'paid'])
    expect(calls.eqs).toContainEqual(['location_id', 'loc1'])
    expect(calls.is).toContainEqual(['fulfilled_at', null])
  })
  it('no active location → empty, no query', async () => {
    expect(await offerPurchasesProvider.fetchPending({}, {})).toEqual({ count: 0, items: [] })
    expect(await offerPurchasesProvider.countPending({}, {})).toBe(0)
  })
  it('countPending counts with the same filters', async () => {
    const { db, calls } = makeDb([], { count: 3 })
    expect(await offerPurchasesProvider.countPending(db, user)).toBe(3)
    expect(calls.eqs).toContainEqual(['state', 'paid'])
    expect(calls.eqs).toContainEqual(['location_id', 'loc1'])
  })
  it('declares the per-category permission key', () => {
    expect(offerPurchasesProvider.permissionKey).toBe('approvals_offer_purchases')
    expect(offerPurchasesProvider.key).toBe('offer_purchases')
  })
})
