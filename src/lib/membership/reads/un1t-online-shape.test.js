// UN1TREAD.2 — pure shaping for the un1t.online reads.
import { describe, it, expect } from 'vitest'
import {
  UN1T_CANCEL_TRACKING_START, glofoxInterval, shapeCounts, shapeMrr, shapeFlows,
  shapeRevenue, firstSales, engagementRows, isTrialProduct, cancelsComparable,
  UN1T_ENDED_SUB_STATUSES, UN1T_LIVE_SUB_STATUSES, UN1T_RETRY_NET_WINDOW_MS, normaliseUn1tInvoiceStatus, shapePastDue,
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

// UN1TREAD.7 — a member whose card failed (status 'past_due') still holds the
// membership; 'trialing' is not a paying member here and counts nowhere.
describe('status handling (UN1TREAD.7)', () => {
  const subs = [
    sub({ un1t_user_id: 'a' }),
    sub({ un1t_user_id: 'pd', status: 'past_due' }),
    sub({ un1t_user_id: 'tr', status: 'trialing' }),
    sub({ un1t_user_id: 'gone', status: 'canceled' }),
  ]
  it("counts: past_due is a member (monthly_recurring, total_members, interval) but not active_recurring; trialing counts nowhere", () => {
    const r = shapeCounts({ subs })
    expect(r.monthly_recurring).toBe(2)
    expect(r.total_members).toBe(2)
    expect(r.active_recurring).toBe(1)
    expect(r.detail.recurring_by_interval['1 month']).toBe(2)
  })
  it('a trialing member with a paid pack is still a pack holder (not shadowed by the trial)', () => {
    const r = shapeCounts({
      subs: [sub({ un1t_user_id: 'tr', status: 'trialing' })],
      clients: [client({ un1t_user_id: 'tr' })],
      packTxs: [ptx({ un1t_user_id: 'tr' })],
      products: PRODUCTS,
    })
    expect(r.monthly_recurring).toBe(0)
    expect(r.class_packs).toBe(1)
  })
  it('MRR and recurringMembers: only status active, not paused, not past due', () => {
    const r = shapeMrr(subs)
    expect(r).toEqual({ mrrCents: 18900, recurringMembers: 1, yieldCents: 18900 })
  })
  it('engagement rows include a past_due holder, never a trialing one', () => {
    const rows = engagementRows({
      subs,
      clients: [
        { un1t_user_id: 'a', bookings_30d_attended: 4 },
        { un1t_user_id: 'pd', bookings_30d_attended: 2 },
        { un1t_user_id: 'tr', bookings_30d_attended: 9 },
      ],
    })
    expect(rows).toEqual([{ total_attended_30d: 4 }, { total_attended_30d: 2 }])
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

// HATCHPIPE.2 — invoice status normaliser and past-due shaping.
describe('normaliseUn1tInvoiceStatus', () => {
  it.each([
    ['paid', 'paid'], ['PAID', 'paid'], ['open', 'open'], ['past_due', 'open'], ['unpaid', 'open'],
    ['failed', 'open'], ['uncollectible', 'open'], ['void', 'void'], ['draft', 'void'],
    ['deleted', 'void'], ['refunded', 'refunded'], ['weird', 'unknown'], [null, 'unknown'],
    [undefined, 'unknown'], ['  Open ', 'open'],
  ])('normaliseUn1tInvoiceStatus(%s) → %s', (raw, want) => {
    expect(normaliseUn1tInvoiceStatus(raw)).toBe(want)
  })
})

describe('UN1T_ENDED_SUB_STATUSES', () => {
  it('is a frozen list of the ended spellings', () => {
    expect(Object.isFrozen(UN1T_ENDED_SUB_STATUSES)).toBe(true)
    expect(UN1T_ENDED_SUB_STATUSES).toEqual(['canceled', 'cancelled', 'ended', 'expired', 'incomplete_expired'])
  })
})

describe('shapePastDue', () => {
  const psub = (over = {}) => ({
    un1t_id: 's1', un1t_user_id: 'u1', contact_id: 'c1', product_title: 'Unlimited', status: 'active',
    currency: 'eur', past_due_at: null, cancel_at_period_end: false, paused_until: null, ...over,
  })
  const inv = (over = {}) => ({
    un1t_id: 'i1', un1t_user_id: 'u1', contact_id: 'c1', subscription_id: 's1', status: 'open',
    amount_cents: 18900, currency: 'eur', remote_created_at: '2026-10-01T10:00:00Z', ...over,
  })

  it('past_due subscription with no open invoice → amountCents null, since = past_due_at', () => {
    const rows = shapePastDue({
      subs: [psub({ status: 'past_due', past_due_at: '2026-10-05T09:00:00Z' })], invoices: [],
    })
    expect(rows).toEqual([{
      contactId: 'c1', un1tUserId: 'u1', subscriptionId: 's1', productTitle: 'Unlimited',
      since: '2026-10-05T09:00:00Z', amountCents: null, currency: 'EUR', openInvoiceIds: [],
      cancelAtPeriodEnd: false, pausedUntil: null,
    }])
  })

  it('an open invoice with no netting paid invoice is owed', () => {
    const rows = shapePastDue({ subs: [psub()], invoices: [inv()] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amountCents: 18900, openInvoiceIds: ['i1'], since: '2026-10-01T10:00:00Z' })
  })

  it('open invoice netted by a later paid invoice of the same amount on the same subscription → no row', () => {
    const rows = shapePastDue({
      subs: [psub()],
      invoices: [inv(), inv({ un1t_id: 'i2', status: 'paid', remote_created_at: '2026-10-01T10:05:00Z' })],
    })
    expect(rows).toEqual([])
  })

  it('an equal-amount paid invoice 30 days after the open one does NOT net it (outside the retry window)', () => {
    const rows = shapePastDue({
      subs: [psub()],
      invoices: [inv(), inv({ un1t_id: 'p1', status: 'paid', remote_created_at: '2026-10-31T10:00:00Z' })],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].openInvoiceIds).toEqual(['i1'])
  })

  it('the retry window is the Glofox arrears one: a payment just inside nets, just past does not', () => {
    const at = (ms) => new Date(Date.parse('2026-10-01T10:00:00Z') + ms).toISOString()
    const run = (ms) => shapePastDue({ subs: [psub()], invoices: [inv(), inv({ un1t_id: 'p1', status: 'paid', remote_created_at: at(ms) })] })
    expect(run(UN1T_RETRY_NET_WINDOW_MS)).toEqual([])
    expect(run(UN1T_RETRY_NET_WINDOW_MS + 1000)).toHaveLength(1)
  })

  it('invoices naming neither a member nor a subscription each stand alone, never in a shared bucket', () => {
    const orphan = (over) => inv({ un1t_user_id: null, subscription_id: null, contact_id: null, ...over })
    const rows = shapePastDue({
      subs: [],
      invoices: [
        orphan({ un1t_id: 'o1', amount_cents: 100, remote_created_at: '2026-10-01T10:00:00Z' }),
        orphan({ un1t_id: 'o2', amount_cents: 100, remote_created_at: '2026-10-02T10:00:00Z' }),
        // a paid orphan of the same amount must not net a different orphan
        orphan({ un1t_id: 'p1', status: 'paid', amount_cents: 100, remote_created_at: '2026-10-01T10:05:00Z' }),
      ],
    })
    expect(rows.map((r) => r.openInvoiceIds)).toEqual([['o1'], ['o2']])
    expect(rows.every((r) => r.contactId === null && r.un1tUserId === null && r.subscriptionId === null)).toBe(true)
  })

  it('identity comes from the group\'s own rows: the subscription first, else an invoice of the same member', () => {
    const fromSub = shapePastDue({
      subs: [psub({ contact_id: 'c-sub' })],
      invoices: [inv({ contact_id: 'c-invoice' })],
    })
    expect(fromSub[0]).toMatchObject({ contactId: 'c-sub', un1tUserId: 'u1' })
    const fromInvoice = shapePastDue({ subs: [], invoices: [inv({ contact_id: null }), inv({ un1t_id: 'i2', contact_id: 'c-late' })] })
    expect(fromInvoice[0]).toMatchObject({ contactId: 'c-late', un1tUserId: 'u1' })
  })

  it('a status with stray case/whitespace is normalised; an ended one carrying past_due_at raises no row', () => {
    expect(shapePastDue({ subs: [psub({ status: ' canceled ', past_due_at: '2026-10-05T09:00:00Z' })], invoices: [] })).toEqual([])
    expect(shapePastDue({ subs: [psub({ status: ' Canceled', past_due_at: '2026-10-05T09:00:00Z' })], invoices: [] })).toEqual([])
    const live = shapePastDue({ subs: [psub({ status: ' PAST_DUE ' })], invoices: [] })
    expect(live).toHaveLength(1)
  })

  it('an unrecognised subscription status fails closed: its past_due_at raises no row, but an open invoice still does', () => {
    const sub = psub({ status: 'mystery', past_due_at: '2026-10-05T09:00:00Z' })
    expect(shapePastDue({ subs: [sub], invoices: [] })).toEqual([])
    expect(shapePastDue({ subs: [psub({ status: null, past_due_at: '2026-10-05T09:00:00Z' })], invoices: [] })).toEqual([])
    const withInvoice = shapePastDue({ subs: [sub], invoices: [inv()] })
    expect(withInvoice).toHaveLength(1)
    expect(withInvoice[0]).toMatchObject({ openInvoiceIds: ['i1'], since: '2026-10-01T10:00:00Z' })
    for (const status of UN1T_LIVE_SUB_STATUSES.filter((x) => x !== 'past_due')) {
      expect(shapePastDue({ subs: [psub({ status, past_due_at: '2026-10-05T09:00:00Z' })], invoices: [] })).toHaveLength(1)
    }
  })

  it('a paid invoice of a different amount does not net', () => {
    const rows = shapePastDue({
      subs: [psub()],
      invoices: [inv(), inv({ un1t_id: 'i2', status: 'paid', amount_cents: 5000, remote_created_at: '2026-10-03T10:00:00Z' })],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].openInvoiceIds).toEqual(['i1'])
  })

  it('an earlier paid invoice, or one on another subscription, does not net', () => {
    const rows = shapePastDue({
      subs: [psub()],
      invoices: [
        inv(),
        inv({ un1t_id: 'p1', status: 'paid', remote_created_at: '2026-09-20T10:00:00Z' }),
        inv({ un1t_id: 'p2', status: 'paid', subscription_id: 's2', remote_created_at: '2026-10-03T10:00:00Z' }),
      ],
    })
    expect(rows.map((r) => r.subscriptionId)).toEqual(['s1'])
  })

  it('a paid invoice in another currency does not net, and currency is compared upper-cased', () => {
    const other = shapePastDue({
      subs: [psub()],
      invoices: [inv(), inv({ un1t_id: 'p1', status: 'paid', currency: 'usd', remote_created_at: '2026-10-01T10:05:00Z' })],
    })
    expect(other).toHaveLength(1)
    expect(other[0].openInvoiceIds).toEqual(['i1'])
    const same = shapePastDue({
      subs: [psub()],
      invoices: [inv({ currency: 'EUR' }), inv({ un1t_id: 'p1', status: 'paid', currency: 'eur', remote_created_at: '2026-10-01T10:05:00Z' })],
    })
    expect(same).toEqual([])
  })

  it('surviving open invoices in more than one currency → amountCents null (amounts sum only across like currencies)', () => {
    const rows = shapePastDue({
      subs: [psub()],
      invoices: [
        inv({ un1t_id: 'o1', currency: 'eur', amount_cents: 100 }),
        inv({ un1t_id: 'o2', currency: 'EUR', amount_cents: 250, remote_created_at: '2026-10-02T10:00:00Z' }),
        inv({ un1t_id: 'o3', currency: 'usd', amount_cents: 400, remote_created_at: '2026-10-03T10:00:00Z' }),
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].amountCents).toBeNull()
    expect(rows[0].openInvoiceIds).toEqual(['o1', 'o2', 'o3'])
    // like currencies (case aside) still sum
    const like = shapePastDue({
      subs: [psub()],
      invoices: [inv({ un1t_id: 'o1', currency: 'eur', amount_cents: 100 }), inv({ un1t_id: 'o2', currency: 'EUR', amount_cents: 250 })],
    })
    expect(like[0].amountCents).toBe(350)
  })

  it('one paid invoice nets only one of two equal open invoices → amountCents = one amount, since = the surviving one', () => {
    const rows = shapePastDue({
      subs: [psub()],
      invoices: [
        inv({ un1t_id: 'o1', remote_created_at: '2026-09-01T10:00:00Z' }),
        inv({ un1t_id: 'o2', remote_created_at: '2026-10-01T10:00:00Z' }),
        inv({ un1t_id: 'p1', status: 'paid', remote_created_at: '2026-10-01T12:00:00Z' }),
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amountCents: 18900, openInvoiceIds: ['o1'], since: '2026-09-01T10:00:00Z' })
  })

  it('since = earliest of past_due_at and oldest surviving open invoice; openInvoiceIds lists survivors', () => {
    const early = shapePastDue({
      subs: [psub({ status: 'past_due', past_due_at: '2026-09-15T00:00:00Z' })],
      invoices: [
        inv({ un1t_id: 'o1', remote_created_at: '2026-10-01T10:00:00Z', amount_cents: 100 }),
        inv({ un1t_id: 'o2', remote_created_at: '2026-10-08T10:00:00Z', amount_cents: 250 }),
      ],
    })
    expect(early[0]).toMatchObject({ since: '2026-09-15T00:00:00Z', amountCents: 350, openInvoiceIds: ['o1', 'o2'] })
    const late = shapePastDue({
      subs: [psub({ status: 'past_due', past_due_at: '2026-10-09T00:00:00Z' })],
      invoices: [inv({ un1t_id: 'o1', remote_created_at: '2026-10-01T10:00:00Z' })],
    })
    expect(late[0].since).toBe('2026-10-01T10:00:00Z')
  })

  it('a canceled subscription carrying past_due_at and no open invoice → no row', () => {
    for (const status of UN1T_ENDED_SUB_STATUSES) {
      expect(shapePastDue({ subs: [psub({ status, past_due_at: '2026-10-05T09:00:00Z' })], invoices: [] })).toEqual([])
    }
  })

  it('a canceled subscription that still has a surviving open invoice keeps the money owed', () => {
    const rows = shapePastDue({
      subs: [psub({ status: 'canceled', past_due_at: '2026-09-01T00:00:00Z' })],
      invoices: [inv()],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amountCents: 18900, since: '2026-10-01T10:00:00Z' })
  })

  it('unknown invoice status is never owed', () => {
    expect(shapePastDue({ subs: [psub()], invoices: [inv({ status: 'weird' }), inv({ un1t_id: 'i2', status: null })] })).toEqual([])
  })

  it('void and refunded invoices are never owed', () => {
    expect(shapePastDue({ subs: [psub()], invoices: [inv({ status: 'void' }), inv({ un1t_id: 'i2', status: 'refunded' })] })).toEqual([])
  })

  it('currency is upper-cased: eur → EUR', () => {
    const rows = shapePastDue({ subs: [psub()], invoices: [inv({ currency: 'eur' })] })
    expect(rows[0].currency).toBe('EUR')
  })

  it('carries cancelAtPeriodEnd and pausedUntil from the subscription', () => {
    const rows = shapePastDue({
      subs: [psub({ cancel_at_period_end: true, paused_until: '2026-11-01T00:00:00Z' })], invoices: [inv()],
    })
    expect(rows[0]).toMatchObject({ cancelAtPeriodEnd: true, pausedUntil: '2026-11-01T00:00:00Z' })
  })

  it('groups by (user, subscription) and sorts by since ascending', () => {
    const rows = shapePastDue({
      subs: [psub(), psub({ un1t_id: 's2', un1t_user_id: 'u2', contact_id: 'c2' })],
      invoices: [
        inv({ un1t_id: 'a', remote_created_at: '2026-10-09T00:00:00Z' }),
        inv({ un1t_id: 'b', un1t_user_id: 'u2', contact_id: 'c2', subscription_id: 's2', remote_created_at: '2026-10-02T00:00:00Z' }),
      ],
    })
    expect(rows.map((r) => r.un1tUserId)).toEqual(['u2', 'u1'])
  })

  it('an open invoice whose subscription row is missing still shows, with a null product title', () => {
    const rows = shapePastDue({ subs: [], invoices: [inv()] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ productTitle: null, contactId: 'c1', cancelAtPeriodEnd: false, pausedUntil: null })
  })

  it('tolerates no arguments', () => {
    expect(shapePastDue({})).toEqual([])
  })
})
