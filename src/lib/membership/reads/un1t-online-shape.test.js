// UN1TREAD.2 — pure shaping for the un1t.online reads.
import { describe, it, expect } from 'vitest'
import { classifyContact } from '@shared/pipeline-classifier'
import { un1tDealDates } from './un1t-pipeline-dates'
import {
  UN1T_CANCEL_TRACKING_START, glofoxInterval, shapeCounts, shapeMrr, shapeFlows,
  shapeRevenue, firstSales, engagementRows, isTrialProduct, cancelsComparable,
  UN1T_ENDED_SUB_STATUSES, UN1T_LIVE_SUB_STATUSES, UN1T_RETRY_NET_WINDOW_MS, normaliseUn1tInvoiceStatus, shapePastDue,
  shapePipelineSnapshot, shapeTrialEligibility, splitUn1tCredits, shapePipelineDateEvidence,
  UN1T_AGGREGATOR_GYMPASS_SOURCES, UN1T_AGGREGATOR_MARKER,
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
    // a null price is unknown, not €0
    expect(isTrialProduct({ type: 'one_time', price_cents: null })).toBe(false)
    expect(isTrialProduct({ type: 'one_time' })).toBe(false)
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

  it('a null currency beside a non-null one is mixed → amountCents null', () => {
    const rows = shapePastDue({
      subs: [psub()],
      invoices: [
        inv({ un1t_id: 'o1', currency: 'eur', amount_cents: 100 }),
        inv({ un1t_id: 'o2', currency: null, amount_cents: 250, remote_created_at: '2026-10-02T10:00:00Z' }),
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amountCents: null, openInvoiceIds: ['o1', 'o2'] })
  })

  it('a mixed-currency row returns BOTH amountCents null and currency null (never a currency label on no amount)', () => {
    const named = shapePastDue({
      subs: [psub()],
      invoices: [inv({ un1t_id: 'o1', currency: 'eur' }), inv({ un1t_id: 'o2', currency: 'usd', remote_created_at: '2026-10-02T10:00:00Z' })],
    })
    expect(named[0]).toMatchObject({ amountCents: null, currency: null })
    const withNull = shapePastDue({
      subs: [psub()],
      invoices: [inv({ un1t_id: 'o1', currency: 'eur' }), inv({ un1t_id: 'o2', currency: null, remote_created_at: '2026-10-02T10:00:00Z' })],
    })
    expect(withNull[0]).toMatchObject({ amountCents: null, currency: null })
  })

  it('tolerates no arguments', () => {
    expect(shapePastDue({})).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// HATCHPIPE.2 — pipeline snapshot and trial eligibility (spec A §6.2).
// ---------------------------------------------------------------------------
const NOW = Date.parse('2026-10-18T12:00:00Z')
const DAY = 86_400_000
const daysAgo = (d) => new Date(NOW - d * DAY).toISOString()
const daysAhead = (d) => new Date(NOW + d * DAY).toISOString()
const HATCH = 'loc-hatch-0001'
const STILLORGAN = 'loc-still-0001'
const TRIAL = 'prod-trial'
const PACK5 = 'prod-pack5'
const PRODUCTS_BY_ID = new Map([
  [TRIAL, { un1t_id: TRIAL, type: 'one_time', price_cents: 0, credits_per_period: 3, title: 'The UN1T Trial' }],
  [PACK5, { un1t_id: PACK5, type: 'one_time', price_cents: 6000, credits_per_period: 5, title: '5 class pack' }],
  ['prod-monthly', { un1t_id: 'prod-monthly', type: 'subscription', price_cents: 18900, title: 'Unlimited' }],
])
const SNAPSHOT_KEYS = [
  'glofox_membership_status', 'glofox_membership_state', 'glofox_membership_expiry', 'last_attended_at',
  'total_attended_7d', 'total_attended_30d', 'last_payment_at', 'joined_at', 'created_at',
  'trial_credits_remaining', 'recent_bookings', 'converted_at', 'pack_customer_at',
  'pipeline_dismissed_at', 'last_lead_source_at', 'gympass_member_id',
]

const pclient = (over = {}) => ({
  un1t_user_id: 'u-1', credit_balance: 0, credit_unlimited: false, last_attended_at: null,
  remote_created_at: daysAgo(200), ...over,
})
const pcontact = (over = {}) => ({
  id: 'ct-1', location_id: HATCH, pipeline_dismissed_at: null, last_lead_source_at: null, ...over,
})
const tx = (over = {}) => ({
  type: 'one_time', product_type: 'pack', product_id: PACK5, amount_cents: 6000, refunded: false,
  remote_created_at: daysAgo(10), ...over,
})
const trialTx = (over = {}) => tx({ product_id: TRIAL, amount_cents: 0, ...over })
const booking = (over = {}) => ({
  status: 'booked', source: 'direct', credit_charged: false, external_member_ref: null,
  remote_created_at: daysAgo(5), starts_at: daysAgo(4), ...over,
})
const attended = (d, over = {}) => booking({ status: 'attended', starts_at: daysAgo(d), remote_created_at: daysAgo(d + 1), ...over })
const ended = (over = {}) => ({ source: 'un1t_online_api', status: 'ended', ended_at: daysAgo(100), ...over })
const fsub = (over = {}) => ({ un1t_user_id: 'u-1', status: 'active', paused_at: null, ...over })

const snap = (over = {}) => shapePipelineSnapshot({
  client: pclient(), contact: pcontact(), locationId: HATCH, productsById: PRODUCTS_BY_ID, now: NOW, ...over,
})
const stage = (s) => classifyContact(s, NOW)

describe('shapePipelineSnapshot', () => {
  it('has exactly the classifier input keys', () => {
    expect(Object.keys(snap()).sort()).toEqual([...SNAPSHOT_KEYS].sort())
  })

  it('fresh active subscription → member', () => {
    const s = snap({ freshSubs: [fsub()] })
    expect(s.glofox_membership_status).toBe('member')
    expect(stage(s)).toBe('member')
  })

  it('fresh past_due subscription → member', () => {
    const s = snap({ freshSubs: [fsub({ status: 'past_due' })] })
    expect(s.glofox_membership_status).toBe('member')
    expect(stage(s)).toBe('member')
  })

  it('paused subscription not ended → member', () => {
    const s = snap({ freshSubs: [fsub({ status: 'paused', paused_at: daysAgo(3) })] })
    expect(s.glofox_membership_status).toBe('member')
    expect(stage(s)).toBe('member')
    // a paused stamp on an ended subscription is history
    const gone = snap({ freshSubs: [fsub({ status: 'canceled', paused_at: daysAgo(3) })] })
    expect(gone.glofox_membership_status).toBe('lead')
  })

  it('a sub_initial within 60 days makes a member converted (converted_at = earliest sub_initial)', () => {
    const s = snap({
      freshSubs: [fsub()],
      transactions: [
        tx({ type: 'sub_renewal', product_type: 'subscription', product_id: 'prod-monthly', remote_created_at: daysAgo(5) }),
        tx({ type: 'sub_initial', product_type: 'subscription', product_id: 'prod-monthly', remote_created_at: daysAgo(20) }),
      ],
    })
    expect(s.converted_at).toBe(daysAgo(20))
    expect(stage(s)).toBe('converted')
  })

  it('fresh trialing → trial', () => {
    const s = snap({ client: pclient({ remote_created_at: daysAgo(5) }), freshSubs: [fsub({ status: 'trialing' })] })
    expect(s.glofox_membership_status).toBe('trial')
    expect(stage(s)).toBe('new_lead')
  })

  it('trial with 3 credits is trial, trial_credits_remaining 3, stage not pack_member', () => {
    const s = snap({
      client: pclient({ credit_balance: 3, remote_created_at: daysAgo(30) }),
      transactions: [trialTx({ remote_created_at: daysAgo(5) })],
    })
    expect(s.glofox_membership_status).toBe('trial')
    expect(s.trial_credits_remaining).toBe(3)
    expect(stage(s)).not.toBe('pack_member')
    expect(stage(s)).toBe('new_lead')
  })

  it('€0 trial pack transaction is not a pack customer (pack_customer_at null)', () => {
    const s = snap({
      client: pclient({ credit_balance: 3 }),
      // even a trial product's transaction carrying an amount is not a paid pack
      transactions: [trialTx({ remote_created_at: daysAgo(5) }), trialTx({ amount_cents: 500, remote_created_at: daysAgo(6) })],
    })
    expect(s.pack_customer_at).toBeNull()
    expect(stage(s)).not.toBe('pack_member')
  })

  it('paid pack, 0 credits → pack_customer_at set, stage pack_member', () => {
    const s = snap({
      transactions: [tx({ remote_created_at: daysAgo(40) }), tx({ remote_created_at: daysAgo(10) })],
    })
    expect(s.pack_customer_at).toBe(daysAgo(40))
    expect(s.glofox_membership_status).toBe('lead')
    expect(stage(s)).toBe('pack_member')
  })

  it('a refunded pack is not a paid pack', () => {
    const s = snap({ transactions: [tx({ refunded: true })] })
    expect(s.pack_customer_at).toBeNull()
  })

  it('ended membership, nothing since → ex_member, stage dormant', () => {
    const s = snap({ memberships: [ended()] })
    expect(s.glofox_membership_status).toBe('ex_member')
    expect(stage(s)).toBe('dormant')
    // a pack bought BEFORE it ended, now spent, does not lift them out
    const before = snap({ memberships: [ended()], transactions: [tx({ remote_created_at: daysAgo(150) })] })
    expect(before.glofox_membership_status).toBe('ex_member')
  })

  it('an ended membership beside an active one is not ex_member', () => {
    const s = snap({ memberships: [ended(), { source: 'un1t_online_api', status: 'active', ended_at: null }] })
    expect(s.glofox_membership_status).toBe('lead')
  })

  it('ex member who bought a paid pack after ending → pack_member', () => {
    const s = snap({ memberships: [ended()], transactions: [tx({ remote_created_at: daysAgo(10) })] })
    expect(s.glofox_membership_status).toBe('lead')
    expect(stage(s)).toBe('pack_member')
  })

  it('ex member holding paid credits → credit_member', () => {
    const s = snap({
      client: pclient({ credit_balance: 4 }),
      memberships: [ended({ ended_at: daysAgo(30) })],
      transactions: [tx({ remote_created_at: daysAgo(60) })],
    })
    expect(s.glofox_membership_status).toBe('credit_member')
    expect(stage(s)).toBe('member')
  })

  it('ex member who attended after ending → placed by attendance (first_class)', () => {
    const s = snap({ memberships: [ended()], bookings: [attended(3)] })
    expect(s.glofox_membership_status).toBe('lead')
    expect(stage(s)).toBe('first_class')
    // the client row's last_attended_at alone does it too
    const viaClient = snap({ memberships: [ended()], client: pclient({ last_attended_at: daysAgo(2) }) })
    expect(viaClient.glofox_membership_status).toBe('lead')
    expect(stage(viaClient)).toBe('first_class')
  })

  it('trial credits 3 and no paid pack → trial, not credit_member', () => {
    // a balance above the trial's credits is never read as paid credits without a paid pack
    const s = snap({
      client: pclient({ credit_balance: 5, remote_created_at: daysAgo(30) }),
      transactions: [trialTx({ remote_created_at: daysAgo(5) })],
    })
    expect(s.glofox_membership_status).toBe('trial')
    expect(s.trial_credits_remaining).toBe(3)
    expect(splitUn1tCredits({
      client: pclient({ credit_balance: 5 }), transactions: [trialTx({ remote_created_at: daysAgo(5) })], productsById: PRODUCTS_BY_ID,
    })).toMatchObject({ trialCreditsLeft: 3, paidCredits: 0, hasPaidPack: false })
  })

  it('trial then a 5-pack, balance 7, one credit used since the trial → credit_member, trial left 2, paid 5, trial_credits_remaining 7', () => {
    const input = {
      client: pclient({ credit_balance: 7 }),
      transactions: [trialTx({ remote_created_at: daysAgo(20) }), tx({ remote_created_at: daysAgo(10) })],
      bookings: [
        booking({ credit_charged: true, remote_created_at: daysAgo(15), starts_at: daysAgo(14), status: 'attended' }),
        // charged before the trial: not the trial's credit
        booking({ credit_charged: true, remote_created_at: daysAgo(25), starts_at: daysAgo(24), status: 'attended' }),
        // since the trial but not charged
        booking({ credit_charged: false, remote_created_at: daysAgo(12), starts_at: daysAgo(11), status: 'cancelled' }),
      ],
      productsById: PRODUCTS_BY_ID,
    }
    expect(splitUn1tCredits(input)).toMatchObject({ trialCreditsLeft: 2, paidCredits: 5, hasPaidPack: true })
    const s = snap(input)
    expect(s.glofox_membership_status).toBe('credit_member')
    expect(s.trial_credits_remaining).toBe(7)
    expect(stage(s)).toBe('member')
  })

  it('trial credits are floored at 0 and capped at credit_balance', () => {
    const used = Array.from({ length: 5 }, (_, i) => booking({ credit_charged: true, remote_created_at: daysAgo(4 - i * 0.1) }))
    expect(splitUn1tCredits({
      client: pclient({ credit_balance: 3 }), transactions: [trialTx({ remote_created_at: daysAgo(5) })], bookings: used, productsById: PRODUCTS_BY_ID,
    }).trialCreditsLeft).toBe(0)
    expect(splitUn1tCredits({
      client: pclient({ credit_balance: 1 }), transactions: [trialTx({ remote_created_at: daysAgo(5) })], productsById: PRODUCTS_BY_ID,
    }).trialCreditsLeft).toBe(1)
  })

  it('the newest trial whose product resolves sets the credit grant; an unreadable newer trial does not hide it', () => {
    const input = {
      client: pclient({ credit_balance: 3 }),
      transactions: [trialTx({ remote_created_at: daysAgo(10) }), trialTx({ product_id: 'prod-gone', remote_created_at: daysAgo(2) })],
      productsById: PRODUCTS_BY_ID,
    }
    expect(splitUn1tCredits(input)).toMatchObject({ trialCreditsLeft: 3, tookTrial: true })
    // with no resolvable trial at all the grant is 0, but a trial was still taken
    expect(splitUn1tCredits({ ...input, transactions: [trialTx({ product_id: 'prod-gone' })] }))
      .toMatchObject({ trialCreditsLeft: 0, tookTrial: true })
  })

  it('ledger trial with no transaction → trial (ledgerTrials [{ at, product_id: TRIAL }])', () => {
    const s = snap({ client: pclient({ credit_balance: 3 }), ledgerTrials: [{ at: daysAgo(1), product_id: TRIAL }] })
    expect(s.glofox_membership_status).toBe('trial')
    expect(s.trial_credits_remaining).toBe(3)
    expect(s.joined_at).toBe(daysAgo(1))
    expect(stage(s)).toBe('new_lead')
  })

  it('non-direct booking source → classpass_payg, stage classpass', () => {
    const s = snap({ bookings: [booking({ source: 'classpass' })] })
    expect(s.glofox_membership_status).toBe('classpass_payg')
    expect(s.gympass_member_id).toBeNull()
    expect(stage(s)).toBe('classpass')
    // a direct booking carrying an external member ref is an aggregator too
    const viaRef = snap({ bookings: [booking({ external_member_ref: 'ext-9' })] })
    expect(viaRef.glofox_membership_status).toBe('classpass_payg')
    // a booking with no source at all is not an aggregator
    expect(snap({ bookings: [booking({ source: null })] }).glofox_membership_status).toBe('lead')
  })

  it('wellhub source → gympass_member_id = external_member_ref, stage gympass; no ref → "un1t:aggregator"', () => {
    expect(UN1T_AGGREGATOR_GYMPASS_SOURCES).toEqual(['wellhub', 'gympass'])
    expect(UN1T_AGGREGATOR_MARKER).toBe('un1t:aggregator')
    const s = snap({ bookings: [booking({ source: 'wellhub', external_member_ref: 'wh-123' })] })
    expect(s.gympass_member_id).toBe('wh-123')
    expect(s.glofox_membership_status).toBe('lead')
    expect(stage(s)).toBe('gympass')
    const noRef = snap({ bookings: [booking({ source: 'Gympass' })] })
    expect(noRef.gympass_member_id).toBe('un1t:aggregator')
    expect(stage(noRef)).toBe('gympass')
  })

  it('aggregator who is also a fresh member → member', () => {
    const s = snap({ freshSubs: [fsub()], bookings: [booking({ source: 'classpass' })] })
    expect(s.glofox_membership_status).toBe('member')
    expect(stage(s)).toBe('member')
    const wh = snap({ freshSubs: [fsub()], bookings: [booking({ source: 'wellhub', external_member_ref: 'wh-1' })] })
    expect(stage(wh)).toBe('member')
  })

  it('1 / 2 / 3 attended within the window → first_class / second_class / trial_done', () => {
    const one = snap({ bookings: [attended(3)] })
    expect(one.last_attended_at).toBe(daysAgo(3))
    expect(stage(one)).toBe('first_class')
    expect(stage(snap({ bookings: [attended(3), attended(6)] }))).toBe('second_class')
    expect(stage(snap({ bookings: [attended(3), attended(6), attended(9)] }))).toBe('trial_done')
  })

  it('last_attended_at = later of the client row and the newest attended booking', () => {
    expect(snap({ client: pclient({ last_attended_at: daysAgo(1) }), bookings: [attended(3)] }).last_attended_at).toBe(daysAgo(1))
    expect(snap({ client: pclient({ last_attended_at: daysAgo(9) }), bookings: [attended(3)] }).last_attended_at).toBe(daysAgo(3))
    expect(snap({ bookings: [booking({ starts_at: daysAgo(1) })] }).last_attended_at).toBeNull()
  })

  it('upcoming booked class, nothing attended → new_lead', () => {
    const s = snap({ bookings: [booking({ status: 'booked', starts_at: daysAhead(2) })] })
    expect(s.recent_bookings).toEqual([{ attended: false, status: 'BOOKED', time_start: Math.floor(Date.parse(daysAhead(2)) / 1000) }])
    expect(stage(s)).toBe('new_lead')
  })

  it('lead aged out (joined 90 days ago) → dormant', () => {
    const s = snap({ client: pclient({ remote_created_at: daysAgo(90) }) })
    expect(s.glofox_membership_status).toBe('lead')
    expect(s.joined_at).toBe(daysAgo(90))
    expect(stage(s)).toBe('dormant')
    expect(stage(snap({ client: pclient({ remote_created_at: daysAgo(10) }) }))).toBe('new_lead')
  })

  it('recent_bookings = 10 latest by starts_at; no starts_at dropped; cancelled kept, not attended', () => {
    const bookings = [
      ...Array.from({ length: 11 }, (_, i) => booking({ status: 'cancelled', starts_at: daysAgo(i + 1) })),
      booking({ status: 'attended', starts_at: daysAgo(0.5) }),
      booking({ status: 'attended', starts_at: null }),
    ]
    const s = snap({ bookings })
    expect(s.recent_bookings).toHaveLength(10)
    expect(s.recent_bookings[0]).toEqual({ attended: true, status: 'ATTENDED', time_start: Math.floor(Date.parse(daysAgo(0.5)) / 1000) })
    expect(s.recent_bookings[1]).toEqual({ attended: false, status: 'CANCELLED', time_start: Math.floor(Date.parse(daysAgo(1)) / 1000) })
    expect(s.recent_bookings[9].time_start).toBe(Math.floor(Date.parse(daysAgo(9)) / 1000))
  })

  it('stale subscription row is not passed in freshSubs and never makes a member', () => {
    // the sync still holds an ACTIVE contact_memberships row driven by the stale subscription
    const s = snap({ freshSubs: [], memberships: [{ source: 'un1t_online_api', status: 'active', ended_at: null }] })
    expect(s.glofox_membership_status).toBe('lead')
    expect(stage(s)).toBe('dormant')
  })

  it('joined_at = later of client.remote_created_at and the newest trial', () => {
    const later = snap({
      client: pclient({ remote_created_at: daysAgo(100) }),
      transactions: [trialTx({ remote_created_at: daysAgo(40) }), trialTx({ remote_created_at: daysAgo(5) })],
    })
    expect(later.joined_at).toBe(daysAgo(5))
    expect(stage(later)).toBe('new_lead')
    const earlier = snap({ client: pclient({ remote_created_at: daysAgo(2) }), transactions: [trialTx({ remote_created_at: daysAgo(5) })] })
    expect(earlier.joined_at).toBe(daysAgo(2))
  })

  it('dual-studio contact: pipeline_dismissed_at and last_lead_source_at are null when contact.location_id differs', () => {
    const fields = { pipeline_dismissed_at: daysAgo(3), last_lead_source_at: daysAgo(4) }
    const away = snap({ contact: pcontact({ location_id: STILLORGAN, ...fields }) })
    expect(away.pipeline_dismissed_at).toBeNull()
    expect(away.last_lead_source_at).toBeNull()
    const own = snap({ contact: pcontact(fields), client: pclient({ remote_created_at: daysAgo(10) }) })
    expect(own.pipeline_dismissed_at).toBe(daysAgo(3))
    expect(own.last_lead_source_at).toBe(daysAgo(4))
    expect(stage(own)).toBe('cold_lead')
    // no locationId to compare against is never "owned"
    expect(snap({ locationId: undefined, contact: pcontact({ location_id: undefined, ...fields }) }).pipeline_dismissed_at).toBeNull()
  })

  it('a contacts row full of Glofox values passed as `contact` never reaches the snapshot', () => {
    // Review Focus 3: a Stillorgan-owned member who is also a Hatch client with nothing at Hatch.
    const glofoxRow = {
      id: 'ct-1', location_id: STILLORGAN, name: 'Test Person', email: 'person@example.test',
      glofox_membership_status: 'member', glofox_membership_state: 'active', glofox_membership_expiry: daysAhead(30),
      last_attended_at: daysAgo(1), total_attended_7d: 3, total_attended_30d: 12, last_payment_at: daysAgo(2),
      joined_at: daysAgo(3), created_at: daysAgo(400), trial_credits_remaining: 20,
      recent_bookings: [{ attended: true, status: 'ATTENDED', time_start: Math.floor((NOW - DAY) / 1000) }],
      converted_at: daysAgo(10), pack_customer_at: daysAgo(50), gympass_member_id: 'gp-1',
      pipeline_dismissed_at: daysAgo(5), last_lead_source_at: daysAgo(6),
    }
    const s = snap({ contact: glofoxRow })
    expect(s).toEqual({
      glofox_membership_status: 'lead', glofox_membership_state: null, glofox_membership_expiry: null,
      last_attended_at: null, total_attended_7d: null, total_attended_30d: null, last_payment_at: null,
      joined_at: daysAgo(200), created_at: null, trial_credits_remaining: 0, recent_bookings: [],
      converted_at: null, pack_customer_at: null, pipeline_dismissed_at: null, last_lead_source_at: null,
      gympass_member_id: null,
    })
    expect(stage(s)).toBe('dormant')
    // owned by Hatch: only the two named contact fields cross over
    const owned = snap({ contact: { ...glofoxRow, location_id: HATCH } })
    expect(owned).toEqual({ ...s, pipeline_dismissed_at: daysAgo(5), last_lead_source_at: daysAgo(6) })
  })

  it('unlimited credits → trial_credits_remaining null', () => {
    expect(snap({ client: pclient({ credit_unlimited: true, credit_balance: 3 }), transactions: [trialTx({ remote_created_at: daysAgo(5) })] })
      .trial_credits_remaining).toBeNull()
    expect(snap({ client: pclient({ credit_unlimited: true, credit_balance: 9 }), transactions: [tx()] })
      .trial_credits_remaining).toBeNull()
  })

  it('tolerates a bare client and no optional lists', () => {
    const s = shapePipelineSnapshot({ client: { un1t_user_id: 'u-9' }, contact: null, locationId: HATCH, now: NOW })
    expect(s.glofox_membership_status).toBe('lead')
    expect(stage(s)).toBe('dormant')
  })
})

describe('shapeTrialEligibility', () => {
  const elig = (over = {}) => shapeTrialEligibility({ productsById: PRODUCTS_BY_ID, ...over })

  it('new person → { eligible: true, reasons: [] }', () => {
    expect(elig()).toEqual({ eligible: true, reasons: [] })
    expect(shapeTrialEligibility()).toEqual({ eligible: true, reasons: [] })
  })

  it('any trial product used → trial_used', () => {
    expect(elig({ transactions: [trialTx()] })).toEqual({ eligible: false, reasons: ['trial_used'] })
    // a second trial product (e.g. the private one) counts too: keyed on product id, never the title
    const products = new Map([...PRODUCTS_BY_ID, ['prod-trial-private', { un1t_id: 'prod-trial-private', type: 'one_time', price_cents: 0, title: '1) The UN1T Trial' }]])
    expect(shapeTrialEligibility({ productsById: products, transactions: [trialTx({ product_id: 'prod-trial-private' })] }).reasons).toEqual(['trial_used'])
  })

  it('ledger trial → trial_used', () => {
    expect(elig({ ledgerTrials: [{ at: daysAgo(1), product_id: TRIAL }] })).toEqual({ eligible: false, reasons: ['trial_used'] })
  })

  it('ended or export-only membership → membership_history', () => {
    expect(elig({ memberships: [ended()] })).toEqual({ eligible: false, reasons: ['membership_history'] })
    expect(elig({ memberships: [{ source: 'un1t_online_export', status: 'active', ended_at: null }] }).reasons).toEqual(['membership_history'])
  })

  it('recurring transaction with no subscription row → membership_history', () => {
    for (const t of [
      tx({ type: 'sub_initial', product_type: 'subscription', product_id: 'prod-monthly' }),
      tx({ type: 'sub_renewal', product_type: null, product_id: 'prod-gone' }),
      tx({ type: 'one_time', product_type: 'subscription', product_id: 'prod-gone' }),
    ]) {
      expect(elig({ transactions: [t] })).toEqual({ eligible: false, reasons: ['membership_history'] })
    }
  })

  it('any subscription row, any status → membership_history', () => {
    for (const status of ['active', 'trialing', 'canceled', 'past_due', 'something_new', null]) {
      expect(elig({ subscriptions: [{ un1t_user_id: 'u-1', status }] }).reasons).toEqual(['membership_history'])
    }
  })

  it('paid pack → paid_pack', () => {
    expect(elig({ transactions: [tx()] })).toEqual({ eligible: false, reasons: ['paid_pack'] })
    // €0 pack and a refunded pack are not paid packs (the same definition as the snapshot)
    expect(elig({ transactions: [tx({ amount_cents: 0, product_id: PACK5 })] })).toEqual({ eligible: true, reasons: [] })
    expect(elig({ transactions: [tx({ refunded: true })] })).toEqual({ eligible: true, reasons: [] })
  })

  it('a €0 transaction whose product cannot be resolved counts as a trial taken (only ever denies)', () => {
    expect(elig({ transactions: [tx({ amount_cents: 0, product_id: 'prod-gone' })] })).toEqual({ eligible: false, reasons: ['trial_used'] })
    expect(elig({ transactions: [tx({ amount_cents: 0, product_id: null })] }).reasons).toEqual(['trial_used'])
    // an empty products map (the products read gave nothing) is the same unresolved case
    expect(shapeTrialEligibility({ transactions: [tx({ amount_cents: 0, product_id: TRIAL })] }).reasons).toEqual(['trial_used'])
    // a PAID transaction on an unresolved product is not a trial; an unknown amount is not €0
    expect(elig({ transactions: [tx({ amount_cents: 6000, product_id: 'prod-gone', product_type: null, type: 'one_time' })] }).reasons).not.toContain('trial_used')
    expect(elig({ transactions: [tx({ amount_cents: null, product_id: 'prod-gone', product_type: null })] }).reasons).not.toContain('trial_used')
  })

  it('a €0 transaction on a RESOLVED product whose price_cents is null also counts as trial_used (deny-only)', () => {
    const products = new Map([['prod-unpriced', { un1t_id: 'prod-unpriced', type: 'one_time', price_cents: null }]])
    expect(shapeTrialEligibility({ productsById: products, transactions: [tx({ product_id: 'prod-unpriced', amount_cents: 0, product_type: null })] }))
      .toEqual({ eligible: false, reasons: ['trial_used'] })
  })

  it('a product with a null price is not a trial product, so its transaction is not trial_used', () => {
    const products = new Map([['prod-unpriced', { un1t_id: 'prod-unpriced', type: 'one_time', price_cents: null }]])
    expect(shapeTrialEligibility({ productsById: products, transactions: [tx({ product_id: 'prod-unpriced', amount_cents: 500, product_type: null })] }))
      .toEqual({ eligible: true, reasons: [] })
  })

  it('reasons come in order trial_used, membership_history, paid_pack, each once', () => {
    const r = elig({
      transactions: [tx(), tx(), trialTx(), trialTx(), tx({ type: 'sub_initial', product_type: 'subscription', product_id: 'prod-monthly' })],
      ledgerTrials: [{ at: daysAgo(1), product_id: TRIAL }],
      subscriptions: [{ status: 'canceled' }],
      memberships: [ended()],
    })
    expect(r).toEqual({ eligible: false, reasons: ['trial_used', 'membership_history', 'paid_pack'] })
  })
})

// HATCHPIPE.5 — the evidence the date rules read, from the same rows as the snapshot.
describe('shapePipelineDateEvidence', () => {
  const args = (over = {}) => ({
    client: pclient(), contact: pcontact(), locationId: HATCH, productsById: PRODUCTS_BY_ID, now: NOW, ...over,
  })
  const evidence = (over = {}) => {
    const a = args(over)
    return shapePipelineDateEvidence({ ...a, snapshot: shapePipelineSnapshot(a) })
  }
  // classify the snapshot, then date the stage it lands in: the board's own path
  const placed = (over = {}) => {
    const a = args(over)
    const s = shapePipelineSnapshot(a)
    const slug = classifyContact(s, NOW)
    return { slug, ...un1tDealDates(slug, shapePipelineDateEvidence({ ...a, snapshot: s }), NOW) }
  }

  it('carries the client creation and the snapshot fields classify read', () => {
    const e = evidence()
    expect(e.client_created_at).toBe(daysAgo(200))
    expect(e.membership_status).toBe('lead')
    expect(e.attended_starts).toEqual([])
    expect(e.joined_at).toBe(daysAgo(200))
  })

  it('lists every attended booking start (not just the newest 10), oldest first, attended only', () => {
    const bookings = [
      attended(3), booking({ status: 'booked', starts_at: daysAhead(2) }), attended(30),
      booking({ status: 'cancelled', starts_at: daysAgo(12) }), attended(12),
      ...Array.from({ length: 12 }, (_, i) => booking({ status: 'booked', starts_at: daysAgo(i + 0.5) })),
      attended(40, { starts_at: null }),
    ]
    expect(evidence({ bookings }).attended_starts).toEqual([daysAgo(30), daysAgo(12), daysAgo(3)])
  })

  it('member_since: the earliest qualifying subscription start; an ended one does not count', () => {
    const e = evidence({ freshSubs: [
      fsub({ remote_created_at: daysAgo(70) }),
      fsub({ status: 'canceled', remote_created_at: daysAgo(300) }),
      fsub({ status: 'paused', paused_at: daysAgo(5), remote_created_at: daysAgo(80) }),
    ] })
    expect(e.member_since).toBe(daysAgo(80))
  })

  it('aggregator bookings date the classpass and gympass piles (first such booking)', () => {
    const e = evidence({ bookings: [
      booking({ source: 'classpass', starts_at: daysAgo(9) }),
      booking({ source: 'classpass', starts_at: daysAgo(19) }),
      booking({ source: 'wellhub', starts_at: daysAgo(4) }),
    ] })
    expect(e.classpass_since).toBe(daysAgo(19))
    expect(e.gympass_since).toBe(daysAgo(4))
  })

  it('the dismissal is lent only when this studio owns the contact', () => {
    expect(evidence({ contact: pcontact({ pipeline_dismissed_at: daysAgo(2) }) }).dismissed_at).toBe(daysAgo(2))
    expect(evidence({ contact: pcontact({ location_id: STILLORGAN, pipeline_dismissed_at: daysAgo(2) }) }).dismissed_at).toBeNull()
  })

  it('membership_ended_at: the latest end of this source\'s ended memberships', () => {
    const e = evidence({ memberships: [ended({ ended_at: daysAgo(100) }), ended({ ended_at: daysAgo(90) }), ended({ source: 'glofox', ended_at: daysAgo(1) })] })
    expect(e.membership_ended_at).toBe(daysAgo(90))
  })

  it('end to end: new_lead dates from the client row', () => {
    expect(placed({ client: pclient({ remote_created_at: daysAgo(6) }) }))
      .toEqual({ slug: 'new_lead', created_at: daysAgo(6), stage_entered_at: daysAgo(6) })
  })

  it('end to end: first, second and trial_done date from the 1st, 2nd and 3rd attended class', () => {
    const c = pclient({ remote_created_at: daysAgo(30) })
    expect(placed({ client: c, bookings: [attended(20)] })).toMatchObject({ slug: 'first_class', created_at: daysAgo(30), stage_entered_at: daysAgo(20) })
    expect(placed({ client: c, bookings: [attended(5), attended(20)] })).toMatchObject({ slug: 'second_class', stage_entered_at: daysAgo(5) })
    expect(placed({ client: c, bookings: [attended(1), attended(5), attended(20), attended(9)] }))
      .toMatchObject({ slug: 'trial_done', created_at: daysAgo(30), stage_entered_at: daysAgo(5) })
  })

  it('end to end: converted dates from the first sub_initial', () => {
    expect(placed({
      client: pclient({ remote_created_at: daysAgo(40) }),
      freshSubs: [fsub({ remote_created_at: daysAgo(15) })],
      transactions: [tx({ type: 'sub_initial', product_type: 'subscription', product_id: 'prod-monthly', remote_created_at: daysAgo(15) })],
    })).toEqual({ slug: 'converted', created_at: daysAgo(40), stage_entered_at: daysAgo(15) })
  })
})
