// UN1TREAD.2 — pure shaping for the un1t.online reads.
import { describe, it, expect } from 'vitest'
import {
  UN1T_CANCEL_TRACKING_START, glofoxInterval, shapeCounts, shapeMrr, shapeFlows,
  shapeRevenue, firstSales, engagementRows, isTrialProduct, cancelsComparable,
} from './un1t-online-shape'

const sub = (over = {}) => ({
  un1t_user_id: 'u1', status: 'active', price_cents: 18900,
  billing_interval: 'month', billing_interval_count: 1, paused_at: null, past_due_at: null, ...over,
})
const client = (over = {}) => ({ un1t_user_id: 'c1', credit_balance: 5, credit_unlimited: false, ...over })
const ptx = (over = {}) => ({
  un1t_user_id: 'c1', product_id: 'pk1', product_type: 'pack', amount_cents: 5400,
  remote_created_at: '2026-10-01T10:00:00Z', ...over,
})
const PRODUCTS = [
  { un1t_id: 'pk1', type: 'one_time', price_cents: 5400 },
  { un1t_id: 'trial', type: 'one_time', price_cents: 0, title: 'The UN1T Trial' },
]

describe('glofoxInterval', () => {
  it('spells Glofox intervals', () => {
    expect(glofoxInterval('month', 1)).toBe('1 month')
    expect(glofoxInterval('month', 3)).toBe('3 months')
    expect(glofoxInterval('month', 6)).toBe('6 months')
    expect(glofoxInterval('year', 1)).toBe('12 months')
    expect(glofoxInterval('week', 2)).toBe('2 weeks')
    expect(glofoxInterval(null, null)).toBe('1 month')
    expect(glofoxInterval('month', 0)).toBe('1 month')
  })
})

describe('counts', () => {
  it('active subs → monthly_recurring; paused or past-due excluded from active_recurring only', () => {
    const r = shapeCounts({
      subs: [
        sub({ un1t_user_id: 'a' }),
        sub({ un1t_user_id: 'b', paused_at: '2026-10-10T00:00:00Z' }),
        sub({ un1t_user_id: 'c', past_due_at: '2026-10-11T00:00:00Z' }),
        sub({ un1t_user_id: 'd', status: 'canceled' }),
      ],
    })
    expect(r.monthly_recurring).toBe(3)
    expect(r.active_recurring).toBe(1)
    expect(r.total_members).toBe(3)
    expect(r.payg).toBe(0)
    expect(r.dead_packs).toBe(0)
  })

  it('a €0 one_time product is a trial, never a class pack; a paid pack with balance > 0 and no sub is a class pack', () => {
    expect(isTrialProduct(PRODUCTS[1])).toBe(true)
    expect(isTrialProduct(PRODUCTS[0])).toBe(false)
    const r = shapeCounts({
      subs: [sub({ un1t_user_id: 'm' })],
      clients: [
        client({ un1t_user_id: 'paid' }),
        client({ un1t_user_id: 'trialist' }),
        client({ un1t_user_id: 'empty', credit_balance: 0 }),
        client({ un1t_user_id: 'unl', credit_unlimited: true }),
        client({ un1t_user_id: 'm' }), // holds a sub: not also a pack
      ],
      packTxs: [
        ptx({ un1t_user_id: 'paid' }),
        ptx({ un1t_user_id: 'trialist', product_id: 'trial', amount_cents: 0 }),
        ptx({ un1t_user_id: 'empty' }),
        ptx({ un1t_user_id: 'unl' }),
        ptx({ un1t_user_id: 'm' }),
      ],
      products: PRODUCTS,
    })
    expect(r.class_packs).toBe(1)
    expect(r.total_members).toBe(2) // 1 sub + 1 pack
  })

  it('uses the MOST RECENT pack: a trial bought after a paid pack means not a pack holder', () => {
    const r = shapeCounts({
      clients: [client()],
      packTxs: [
        ptx({ remote_created_at: '2026-09-01T00:00:00Z' }),
        ptx({ product_id: 'trial', amount_cents: 0, remote_created_at: '2026-10-05T00:00:00Z' }),
      ],
      products: PRODUCTS,
    })
    expect(r.class_packs).toBe(0)
  })

  it('a pack whose product is gone falls back to what was paid', () => {
    const r = shapeCounts({
      clients: [client({ un1t_user_id: 'x' }), client({ un1t_user_id: 'y' })],
      packTxs: [
        ptx({ un1t_user_id: 'x', product_id: 'gone', amount_cents: 2600 }),
        ptx({ un1t_user_id: 'y', product_id: 'gone', amount_cents: 0 }),
      ],
      products: PRODUCTS,
    })
    expect(r.class_packs).toBe(1)
  })

  it('tallies recurring_by_interval in the four Glofox keys', () => {
    const r = shapeCounts({
      subs: [
        sub({ un1t_user_id: 'a' }),
        sub({ un1t_user_id: 'b', billing_interval_count: 3 }),
        sub({ un1t_user_id: 'c', billing_interval: 'year' }),
        sub({ un1t_user_id: 'd', billing_interval: 'week' }), // not a Glofox key: in the total only
      ],
    })
    expect(r.detail.recurring_by_interval).toEqual({ '1 month': 1, '3 months': 1, '6 months': 0, '12 months': 1 })
    expect(r.monthly_recurring).toBe(4)
  })
})

describe('mrr', () => {
  it('a paused and a past-due active sub are excluded from mrr but still counted in monthly_recurring / total_members', () => {
    const subs = [
      sub({ un1t_user_id: 'a' }),
      sub({ un1t_user_id: 'b', paused_at: '2026-10-10T00:00:00Z' }),
      sub({ un1t_user_id: 'c', past_due_at: '2026-10-11T00:00:00Z' }),
    ]
    expect(shapeMrr(subs)).toEqual({ mrrCents: 18900, recurringMembers: 1, yieldCents: 18900 })
    const c = shapeCounts({ subs })
    expect(c.monthly_recurring).toBe(3)
    expect(c.total_members).toBe(3)
    expect(c.active_recurring).toBe(1)
  })

  it('one member with two active monthly subs is ONE member; MRR still sums both prices', () => {
    const subs = [
      sub({ un1t_user_id: 'a', price_cents: 18900 }),
      sub({ un1t_user_id: 'a', price_cents: 9900 }),
    ]
    expect(shapeMrr(subs)).toEqual({ mrrCents: 28800, recurringMembers: 1, yieldCents: 28800 })
    const c = shapeCounts({ subs })
    expect(c.monthly_recurring).toBe(1)
    expect(c.active_recurring).toBe(1)
    expect(c.total_members).toBe(1)
    expect(c.detail.recurring_by_interval['1 month']).toBe(1)
  })

  it('a 3-month €567 sub adds 18900/month; a 12-month €2268 sub adds 18900/month', () => {
    expect(shapeMrr([sub({ price_cents: 56700, billing_interval_count: 3 })]).mrrCents).toBe(18900)
    expect(shapeMrr([sub({ price_cents: 226800, billing_interval: 'year', billing_interval_count: 1 })]).mrrCents).toBe(18900)
    expect(shapeMrr([sub({ price_cents: 226800, billing_interval_count: 12 })]).mrrCents).toBe(18900)
  })

  it('returns computeMrr\'s shape over active subs only', () => {
    const r = shapeMrr([sub(), sub({ un1t_user_id: 'b' }), sub({ un1t_user_id: 'c', status: 'canceled' })])
    expect(r).toEqual({ mrrCents: 37800, recurringMembers: 2, yieldCents: 18900 })
    expect(shapeMrr([])).toEqual({ mrrCents: 0, recurringMembers: 0, yieldCents: null })
  })
})

describe('flows', () => {
  const keys = ['2026-08', '2026-09', '2026-10']
  const tx = (id, user, at, type = 'sub_initial') => ({ un1t_id: id, un1t_user_id: user, type, remote_created_at: at })

  it('first sub_initial per user only', () => {
    const first = firstSales([
      tx('t2', 'u1', '2026-10-05T10:00:00Z'),
      tx('t1', 'u1', '2026-09-02T10:00:00Z'),
      tx('t3', 'u1', '2026-10-09T10:00:00Z', 'sub_renewal'),
      tx('t4', 'u2', '2026-10-03T10:00:00Z'),
    ])
    expect(first.map((t) => t.un1t_id)).toEqual(['t1', 't4'])
  })

  it('a month before 2026-10 has cancellations null; ended_at buckets by local month', () => {
    expect(UN1T_CANCEL_TRACKING_START).toBe('2026-10-16')
    const r = shapeFlows({
      keys, zone: 'Europe/Dublin',
      saleTxs: [
        tx('t1', 'u1', '2026-09-02T10:00:00Z'),
        tx('t2', 'u1', '2026-10-05T10:00:00Z'), // u1's second: not a sale
        tx('t3', 'u2', '2026-10-03T10:00:00Z'),
      ],
      // 23:30Z on 30 Sep is 00:30 on 1 Oct in Dublin (BST)
      endedRows: [{ ended_at: '2026-09-30T23:30:00Z' }, { ended_at: '2026-10-17T09:00:00Z' }],
    })
    expect(r.cancelTrackingStart).toBe('2026-10-16')
    expect(r.months).toEqual([
      { month: '2026-08', sales: 0, cancellations: null },
      { month: '2026-09', sales: 1, cancellations: null },
      { month: '2026-10', sales: 1, cancellations: 2 },
    ])
  })

  it('cancelsComparable gates on the tracking start', () => {
    expect(cancelsComparable('2026-10-01T00:00:00.000Z')).toBe(false)
    expect(cancelsComparable('2026-10-16T00:00:00.000Z')).toBe(true)
  })
})

describe('engagement rows', () => {
  it('only clients holding an active subscription', () => {
    const rows = engagementRows({
      subs: [sub({ un1t_user_id: 'a' }), sub({ un1t_user_id: 'z', status: 'canceled' })],
      clients: [
        { un1t_user_id: 'a', bookings_30d_attended: 4 },
        { un1t_user_id: 'z', bookings_30d_attended: 9 },
        { un1t_user_id: 'q', bookings_30d_attended: 1 },
      ],
    })
    expect(rows).toEqual([{ total_attended_30d: 4 }])
  })
})

describe('revenueMtd', () => {
  it('refunded excluded; deltaPct null when last month is 0', () => {
    const r = shapeRevenue({
      current: [
        { amount_cents: 18900, refunded: false },
        { amount_cents: 5400, refunded: true },
        { amount_cents: 0, refunded: false },
        { amount_cents: 2600, refunded: null },
      ],
      previous: [],
    })
    expect(r).toEqual({ totalCents: 21500, paidCount: 2, deltaPct: null })
  })

  it('deltaPct against the same window last month', () => {
    const r = shapeRevenue({ current: [{ amount_cents: 11000 }], previous: [{ amount_cents: 10000 }] })
    expect(r.deltaPct).toBeCloseTo(10)
  })
})
