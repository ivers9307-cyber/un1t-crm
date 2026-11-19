// ORDERSVIEW.1 — totals by kind and studio, and the read behind them.
// A hand fake: order_refunds (mig 853) is newer than the schema snapshot.
import { describe, it, expect } from 'vitest'
import { summariseOrders, loadOrdersSummary, SUMMARY_PAGE } from './orders-summary.js'

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

function fakeDb({ orders = [], refunds = [], fail = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const c = { table, filters: [], range: null }
      calls.push(c)
      const b = {
        select: () => b, order: () => b, limit: () => b,
        eq: (k, v) => { c.filters.push(['eq', k, v]); return b },
        in: (k, v) => { c.filters.push(['in', k, v]); return b },
        gte: (k, v) => { c.filters.push(['gte', k, v]); return b },
        lte: (k, v) => { c.filters.push(['lte', k, v]); return b },
        range: (a, z) => { c.range = [a, z]; return b },
        then(res, rej) {
          if (fail === table) return Promise.resolve({ data: null, error: { message: 'down' } }).then(res, rej)
          let data = []
          if (table === 'orders') data = orders.slice(c.range[0], c.range[1] + 1)
          if (table === 'order_refunds') data = refunds
          if (table === 'locations') data = [{ id: 'L1', name: 'Hatch' }]
          return Promise.resolve({ data, error: null }).then(res, rej)
        },
      }
      return b
    },
  }
}

describe('loadOrdersSummary', () => {
  it('reads every page past the 1,000-row cap and scopes each read to the studio', async () => {
    const orders = Array.from({ length: SUMMARY_PAGE + 5 }, () => ({ location_id: 'L1', source_type: 'donation', status: 'completed', amount_cents: 100, currency: 'EUR' }))
    const db = fakeDb({ orders })
    const r = await loadOrdersSummary(db, { locationId: 'L1', from: '2026-11-01T00:00:00Z' })
    expect(r.totals[0].orders).toBe(SUMMARY_PAGE + 5)
    const orderCalls = db.calls.filter((c) => c.table === 'orders')
    expect(orderCalls).toHaveLength(2)
    for (const c of [...orderCalls, db.calls.find((c) => c.table === 'order_refunds')]) {
      expect(c.filters).toContainEqual(['eq', 'location_id', 'L1'])
      expect(c.filters).toContainEqual(['gte', 'created_at', '2026-11-01T00:00:00Z'])
    }
    expect(r.studios).toEqual([{ id: 'L1', name: 'Hatch' }])
  })

  it('flags a refund Revolut declined after it was recorded', async () => {
    const r = await loadOrdersSummary(fakeDb({ refunds: [{ id: 'r1', error: 'revolut_declined: Revolut failed this refund' }, { id: 'r2', error: null }] }), { locationId: 'L1' })
    expect(r.refunds.map((x) => x.declined)).toEqual([true, false])
  })

  it('a failed read throws rather than showing zero', async () => {
    await expect(loadOrdersSummary(fakeDb({ fail: 'orders' }), { locationId: 'L1' })).rejects.toBeTruthy()
    await expect(loadOrdersSummary(fakeDb({ fail: 'order_refunds' }), { locationId: 'L1' })).rejects.toBeTruthy()
  })
})
