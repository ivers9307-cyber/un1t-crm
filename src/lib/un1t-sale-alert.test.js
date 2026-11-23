// SALEALERT.1 — new in-app purchases at Hatch (un1t.online) ring the "sale" push.
// Fixtures follow the shapes read from production on 23 Nov 2026 (no customer data).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./sale-alert', () => ({ notifyNewSale: vi.fn() }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { notifyNewSale } from './sale-alert'
import { alertPayLinkSale } from './sale-alert-sources'
import { logError, logWarn } from './log'
import {
  UN1T_SALE_ALERT_FROM, UN1T_SALE_ALERT_WINDOW_MS, un1tTransactionIsNewSale, alertUn1tSales,
} from './un1t-sale-alert'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const tx = (over = {}) => ({
  un1t_id: '9001', contact_id: null, product_title: 'Sample 10 Pack', type: 'one_time', product_type: 'pack',
  amount_cents: 9000, refunded: false, remote_created_at: '2026-11-25T11:30:00Z', ...over,
})

describe('un1tTransactionIsNewSale', () => {
  it('cutover is the agreed instant and the window is a day', () => {
    expect(UN1T_SALE_ALERT_FROM).toBe('2026-11-24T00:00:00Z')
    expect(UN1T_SALE_ALERT_WINDOW_MS).toBe(24 * 60 * 60 * 1000)
  })
  it('a product purchase (one_time) rings', () => {
    expect(un1tTransactionIsNewSale(tx(), NOW)).toBe(true)
  })
  it('a first subscription payment (sub_initial) rings', () => {
    expect(un1tTransactionIsNewSale(tx({ type: 'sub_initial', product_type: 'subscription' }), NOW)).toBe(true)
  })
  it.each([
    ['a renewal', { type: 'sub_renewal', product_type: 'subscription' }],
    ['a staff manual charge (the type a class-fee charge lands as)', { type: 'manual', product_type: 'manual' }],
    ['an unknown new type', { type: 'something_new' }],
    ['a null type', { type: null }],
    ['a refunded purchase', { refunded: true }],
    ['a refunded first payment', { type: 'sub_initial', refunded: true }],
    ['a free trial (EUR 0)', { amount_cents: 0 }],
    ['a null amount', { amount_cents: null }],
    ['a row before the cutover', { remote_created_at: '2026-11-23T23:59:59Z' }],
    ['a row older than 24 hours', { remote_created_at: '2026-11-24T11:59:59Z' }],
    ['a row with no date', { remote_created_at: null }],
    ['a row dated in the future', { remote_created_at: '2026-11-25T12:00:01Z' }],
  ])('does not ring %s', (_name, over) => {
    expect(un1tTransactionIsNewSale(tx(over), NOW)).toBe(false)
  })
  it('a row exactly at the cutover rings while inside the day', () => {
    const now = Date.parse('2026-11-24T10:00:00Z')
    expect(un1tTransactionIsNewSale(tx({ remote_created_at: '2026-11-24T00:00:00Z' }), now)).toBe(true)
  })
})

// A chainable stub: records calls, resolves a fixed result when awaited.
function stub(result) {
  const calls = []
  const q = { calls }
  for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'order', 'range']) q[m] = (...a) => { calls.push([m, ...a]); return q }
  q.then = (res, rej) => Promise.resolve(result).then(res, rej)
  return q
}
function makeDb({ txs = { data: [], error: null }, contacts = { data: [], error: null } } = {}) {
  const queries = { un1t_transactions: stub(txs), contacts: stub(contacts) }
  return { queries, from: vi.fn((t) => queries[t]) }
}

describe('alertUn1tSales', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notifyNewSale.mockResolvedValue({ sent: true })
  })

  it('reads one location, ordered and capped, from the later of cutover and 24h ago', async () => {
    const db = makeDb()
    await alertUn1tSales(db, { locationId: 'hatch', locationName: 'Hatch Street', nowMs: NOW })
    const calls = db.queries.un1t_transactions.calls
    expect(calls).toContainEqual(['eq', 'location_id', 'hatch'])
    expect(calls).toContainEqual(['gte', 'remote_created_at', '2026-11-24T12:00:00.000Z'])
    expect(calls).toContainEqual(['order', 'remote_created_at', { ascending: false }])
    expect(calls).toContainEqual(['order', 'un1t_id', { ascending: false }])
    expect(calls).toContainEqual(['in', 'type', ['one_time', 'sub_initial']])
    expect(calls).toContainEqual(['gt', 'amount_cents', 0])
    expect(calls).toContainEqual(['range', 0, 199])
  })

  it('never reads before the cutover', async () => {
    const db = makeDb()
    await alertUn1tSales(db, { locationId: 'hatch', nowMs: Date.parse('2026-11-24T10:00:00Z') })
    expect(db.queries.un1t_transactions.calls).toContainEqual(['gte', 'remote_created_at', '2026-11-24T00:00:00.000Z'])
  })

  it('rings each qualifying row once, with the un1t source, item name and buyer first name', async () => {
    const db = makeDb({
      txs: { data: [tx({ contact_id: 'c1' }), tx({ un1t_id: '9002', type: 'sub_renewal' }), tx({ un1t_id: '9003', amount_cents: 0 })], error: null },
      contacts: { data: [{ id: 'c1', first_name: 'Ava' }], error: null },
    })
    const res = await alertUn1tSales(db, { locationId: 'hatch', locationName: 'Hatch Street', nowMs: NOW })
    expect(res).toEqual({ rung: 1 })
    expect(notifyNewSale).toHaveBeenCalledTimes(1)
    expect(notifyNewSale).toHaveBeenCalledWith(db, {
      source: 'un1t', saleId: '9001', locationId: 'hatch', locationName: 'Hatch Street',
      itemName: 'Sample 10 Pack', amountCents: 9000, buyerFirstName: 'Ava', contactId: 'c1',
    })
  })

  it('falls back to "Purchase" when the product has no title', async () => {
    const db = makeDb({ txs: { data: [tx({ product_title: null })], error: null } })
    await alertUn1tSales(db, { locationId: 'hatch', nowMs: NOW })
    expect(notifyNewSale).toHaveBeenCalledWith(db, expect.objectContaining({ itemName: 'Purchase', buyerFirstName: undefined, contactId: undefined }))
  })

  it('does not count a row notifyNewSale declined (already rung or no recipients)', async () => {
    notifyNewSale.mockResolvedValue({ sent: false, reason: 'duplicate' })
    const db = makeDb({ txs: { data: [tx()], error: null } })
    expect(await alertUn1tSales(db, { locationId: 'hatch', nowMs: NOW })).toEqual({ rung: 0 })
  })

  it('uses the same key as the pay-link path for the same un1t transaction id', async () => {
    const SHARED = '48213'
    await alertUn1tSales(makeDb({ txs: { data: [tx({ un1t_id: SHARED })], error: null } }), { locationId: 'hatch', nowMs: NOW })
    await alertPayLinkSale({}, { location_id: 'hatch', paid_transaction_id: SHARED, product_title: 'x', price_cents: 100 })
    const [a, b] = notifyNewSale.mock.calls.map((c) => c[1])
    expect([a.source, a.saleId]).toEqual([b.source, b.saleId])
    expect(`${a.source}:${a.saleId}`).toBe(`un1t:${SHARED}`)
  })

  it('a failed transactions read rings nothing and does not throw', async () => {
    const db = makeDb({ txs: { data: null, error: { message: 'boom', code: 'XX' } } })
    await expect(alertUn1tSales(db, { locationId: 'hatch', nowMs: NOW })).resolves.toEqual({ rung: 0 })
    expect(logError).toHaveBeenCalled()
    expect(notifyNewSale).not.toHaveBeenCalled()
  })

  it('a failed contacts read still rings, without a buyer name', async () => {
    const db = makeDb({ txs: { data: [tx({ contact_id: 'c1' })], error: null }, contacts: { data: null, error: { message: 'x' } } })
    const res = await alertUn1tSales(db, { locationId: 'hatch', nowMs: NOW })
    expect(res).toEqual({ rung: 1 })
    expect(notifyNewSale).toHaveBeenCalledWith(db, expect.objectContaining({ buyerFirstName: undefined, contactId: 'c1' }))
    expect(logError).toHaveBeenCalled()
  })

  it('one failing alert is counted and the rest still ring', async () => {
    notifyNewSale.mockRejectedValueOnce(new Error('push down')).mockResolvedValue({ sent: true })
    const db = makeDb({ txs: { data: [tx(), tx({ un1t_id: '9002' })], error: null } })
    expect(await alertUn1tSales(db, { locationId: 'hatch', nowMs: NOW })).toEqual({ rung: 1 })
    expect(logError).toHaveBeenCalled()
  })

  it('logs when the 200-row cap is hit', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => tx({ un1t_id: String(i), type: 'sub_renewal' }))
    await alertUn1tSales(makeDb({ txs: { data: rows, error: null } }), { locationId: 'hatch', nowMs: NOW })
    expect(logWarn).toHaveBeenCalled()
  })

  it('never throws, even when the db client itself throws', async () => {
    const db = { from: () => { throw new Error('no client') } }
    await expect(alertUn1tSales(db, { locationId: 'hatch', nowMs: NOW })).resolves.toEqual({ rung: 0 })
  })

  it('does nothing without a location', async () => {
    const db = makeDb()
    expect(await alertUn1tSales(db, { nowMs: NOW })).toEqual({ rung: 0 })
    expect(db.from).not.toHaveBeenCalled()
  })
})
