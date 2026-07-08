// Host revenue aggregation (EVENTS-HOST.8) — pure sums over settled payments.

import { describe, it, expect } from 'vitest'
import { aggregateHostRevenue } from './host-revenue.js'

const events = [
  { id: 'ev1', name: 'Spring Hyrox', race_date: '2026-03-01' },
  { id: 'ev2', name: 'Summer Throwdown', race_date: '2026-06-01' },
]

// A stripe_connect payment: gross = fee + net (customer paid ticket + €2 fee).
const paid = (over = {}) => ({
  race_event_id: 'ev1', amount_cents: 4700, application_fee_cents: 200,
  net_to_host_cents: 4500, refunded_amount_cents: 0, status: 'completed', currency: 'EUR', ...over,
})

describe('aggregateHostRevenue', () => {
  it('returns zeros for no payments', () => {
    const r = aggregateHostRevenue([], events)
    expect(r.totals.paidCount).toBe(0)
    expect(r.totals.gross_cents).toBe(0)
    expect(r.totals.net_collected_cents).toBe(0)
    expect(r.perEvent).toEqual([])
    expect(r.currency).toBe('EUR')
  })

  it('sums completed payments (gross = fee + net) and ignores unsettled ones', () => {
    const r = aggregateHostRevenue([
      paid(),
      paid(),
      paid({ status: 'pending' }),     // not settled — ignored
      paid({ status: 'failed' }),      // not settled — ignored
      paid({ status: 'abandoned' }),   // not settled — ignored
    ], events)
    expect(r.totals.paidCount).toBe(2)
    expect(r.totals.gross_cents).toBe(9400)
    expect(r.totals.fee_cents).toBe(400)
    expect(r.totals.net_to_host_cents).toBe(9000)
    // internal consistency: gross == fee + net
    expect(r.totals.gross_cents).toBe(r.totals.fee_cents + r.totals.net_to_host_cents)
    expect(r.totals.net_collected_cents).toBe(9400)
  })

  it('counts refunded rows toward gross but tracks refunds and nets them out', () => {
    const r = aggregateHostRevenue([
      paid(),                                                   // full sale
      paid({ status: 'refunded', refunded_amount_cents: 4700 }), // fully refunded
      paid({ refunded_amount_cents: 1000 }),                     // partial refund, stays completed
    ], events)
    expect(r.totals.paidCount).toBe(3)
    expect(r.totals.gross_cents).toBe(14100)
    expect(r.totals.refunded_cents).toBe(5700)
    expect(r.totals.net_collected_cents).toBe(14100 - 5700)
  })

  it('treats a Revolut/internal host (null fee/net) as gross-only, no NaN', () => {
    const r = aggregateHostRevenue([
      { race_event_id: 'ev1', amount_cents: 5000, application_fee_cents: null, net_to_host_cents: null, refunded_amount_cents: null, status: 'completed', currency: 'EUR' },
    ], events)
    expect(r.totals.gross_cents).toBe(5000)
    expect(r.totals.fee_cents).toBe(0)
    expect(r.totals.net_to_host_cents).toBe(0)
    expect(Number.isNaN(r.totals.net_collected_cents)).toBe(false)
  })

  it('breaks down per event and sorts newest event first', () => {
    const r = aggregateHostRevenue([
      paid({ race_event_id: 'ev1' }),
      paid({ race_event_id: 'ev2' }),
      paid({ race_event_id: 'ev2' }),
    ], events)
    expect(r.perEvent.map((e) => e.event_id)).toEqual(['ev2', 'ev1']) // 2026-06 before 2026-03
    const ev2 = r.perEvent.find((e) => e.event_id === 'ev2')
    expect(ev2.paidCount).toBe(2)
    expect(ev2.name).toBe('Summer Throwdown')
    expect(ev2.gross_cents).toBe(9400)
  })

  it('labels an unknown event id gracefully', () => {
    const r = aggregateHostRevenue([paid({ race_event_id: 'ghost' })], events)
    expect(r.perEvent[0].name).toBe('Unknown event')
  })
})
