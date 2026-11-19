// ORDERSVIEW.1 — totals by kind and studio, and the read behind them.
// On the shared fake database, checked against the schema snapshot.
import { describe, it, expect } from 'vitest'
import { summariseOrders, loadOrdersSummary, SUMMARY_PAGE } from './orders-summary.js'
import { createFakeDb } from '../../tests/helpers/fake-db.js'

describe('summariseOrders', () => {
  const row = (o) => ({ location_id: 'L1', source_type: 'donation', status: 'completed', amount_cents: 1000, refunded_amount_cents: 0, currency: 'EUR', ...o })

  it('adds taken, refunded and kept per studio and kind', () => {
    const t = summariseOrders([row({}), row({ refunded_amount_cents: 400 }), row({ source_type: 'class_fee', amount_cents: 500 })])
    expect(t).toEqual([
      { location_id: 'L1', source_type: 'donation', currency: 'EUR', orders: 2, gross_cents: 2000, refunded_cents: 400, net_cents: 1600 },
      { location_id: 'L1', source_type: 'class_fee', currency: 'EUR', orders: 1, gross_cents: 500, refunded_cents: 0, net_cents: 500 },
    ])
  })

  it('a refunded order with no refunded total counts as fully refunded', () => {
    expect(summariseOrders([row({ status: 'refunded', refunded_amount_cents: null })])[0]).toMatchObject({ refunded_cents: 1000, net_cents: 0 })
  })

  it('leaves out unpaid orders and never adds currencies together', () => {
    const t = summariseOrders([row({ status: 'pending' }), row({ status: 'failed' }), row({ currency: 'GBP' }), row({})])
    expect(t.map((g) => g.currency).sort()).toEqual(['EUR', 'GBP'])
    expect(t.every((g) => g.orders === 1)).toBe(true)
  })

  it('splits studios', () => {
    expect(summariseOrders([row({}), row({ location_id: 'L2' })])).toHaveLength(2)
  })
})

const L1 = '00000000-0000-4000-8000-0000000000a1'
const L2 = '00000000-0000-4000-8000-0000000000a2'
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ord = (n, over = {}) => ({
  id: uuid(n), location_id: L1, source_type: 'donation', source_id: uuid(90000 + n), contact_email: 'a@x.ie',
  amount_cents: 100, currency: 'EUR', status: 'completed', created_at: '2026-11-10T00:00:00Z', ...over,
})
const fakeDb = ({ orders = [], refunds = [], errors = {} } = {}) => createFakeDb({
  tables: { locations: [{ id: L1, name: 'Hatch' }, { id: L2, name: 'Stillorgan' }], orders, order_refunds: refunds },
  errors,
})

describe('loadOrdersSummary', () => {
  it('reads every page past the 1,000-row cap, and only this studio and period', async () => {
    const orders = [
      ...Array.from({ length: SUMMARY_PAGE + 5 }, (_, i) => ord(i + 1)),
      ord(5001, { location_id: L2 }),
      ord(5002, { created_at: '2026-10-01T00:00:00Z' }),
      ord(5003, { status: 'pending' }),
    ]
    const r = await loadOrdersSummary(fakeDb({ orders }), { locationId: L1, from: '2026-11-01T00:00:00Z' })
    expect(r.totals).toHaveLength(1)
    expect(r.totals[0]).toMatchObject({ location_id: L1, orders: SUMMARY_PAGE + 5, gross_cents: (SUMMARY_PAGE + 5) * 100 })
    expect(r.studios).toEqual([{ id: L1, name: 'Hatch' }])
    expect(r.truncated).toBe(false)
  })

  it('every studio for a master, named', async () => {
    const r = await loadOrdersSummary(fakeDb({ orders: [ord(1), ord(2, { location_id: L2 })] }), { locationId: null })
    expect(r.totals.map((t) => t.location_id).sort()).toEqual([L1, L2].sort())
    expect(r.studios).toHaveLength(2)
  })

  it('lists this studio\'s refunds with their order, and flags one Revolut declined', async () => {
    const orders = [ord(1, { contact_name: 'Ann' })]
    const refunds = [
      { id: uuid(11), order_id: uuid(1), location_id: L1, amount_cents: 100, currency: 'EUR', reason: 'x', status: 'completed', idempotency_key: 'k1', error: 'revolut_declined: Revolut failed this refund', created_at: '2026-11-11T00:00:00Z' },
      { id: uuid(12), order_id: uuid(1), location_id: L1, amount_cents: 50, currency: 'EUR', reason: 'y', status: 'completed', idempotency_key: 'k2', error: null, created_at: '2026-11-12T00:00:00Z' },
      { id: uuid(13), order_id: uuid(1), location_id: L2, amount_cents: 50, currency: 'EUR', reason: 'z', status: 'completed', idempotency_key: 'k3', error: null, created_at: '2026-11-12T00:00:00Z' },
    ]
    const r = await loadOrdersSummary(fakeDb({ orders, refunds }), { locationId: L1 })
    expect(r.refunds.map((x) => [x.id, x.declined])).toEqual([[uuid(12), false], [uuid(11), true]])
    expect(r.refunds[0].order).toMatchObject({ contact_name: 'Ann', source_type: 'donation' })
  })

  it('a failed read throws rather than showing zero', async () => {
    await expect(loadOrdersSummary(fakeDb({ errors: { orders: { select: { message: 'down' } } } }), { locationId: L1 })).rejects.toBeTruthy()
    await expect(loadOrdersSummary(fakeDb({ errors: { order_refunds: { select: { message: 'down' } } } }), { locationId: L1 })).rejects.toBeTruthy()
  })
})
