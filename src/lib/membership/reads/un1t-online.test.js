// UN1TREAD.2 — the un1t.online reads: scoping, pagination, failure contract
// and return envelopes (each identical to the Glofox function it mirrors).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { logWarn } from '@/lib/log'
import { un1tOnlineReads, freshCutoff, listLedgerTrials } from './un1t-online'

const HATCH = 'loc-hatch'
const STILLORGAN = 'loc-stillorgan'
const NOW = new Date('2026-10-17T12:00:00.000Z')
const SYNCED = '2026-10-17T11:50:00.000Z' // the last sync run stamps every row it pulled with one time

// ---------------------------------------------------------------------------
// A recording, in-memory supabase fake: select/eq/in/gt/gte/lt/order/range.
// `head:true` + `count:'exact'` selects answer { count }.
// ---------------------------------------------------------------------------
function makeDb(seed = {}, { fail = [] } = {}) {
  const log = []
  function builder(table) {
    const s = { filters: [], order: null, orders: [], desc: false, range: null, cols: null, opts: null }
    const run = () => {
      log.push({ table, cols: s.cols, filters: s.filters, order: s.order, orders: s.orders, range: s.range, opts: s.opts })
      if (fail.includes(table)) return { data: null, count: null, error: { message: `${table} boom` } }
      let rows = (seed[table] || []).filter((r) => s.filters.every(([k, c, v]) => {
        if (k === 'eq') return r[c] === v
        if (k === 'in') return v.includes(r[c])
        if (k === 'gt') return r[c] != null && r[c] > v
        if (k === 'gte') return r[c] != null && String(r[c]) >= String(v)
        if (k === 'lt') return r[c] != null && String(r[c]) < String(v)
        return true
      }))
      if (s.opts?.head) return { data: null, count: rows.length, error: null }
      if (s.order) {
        rows = [...rows].sort((a, b) => {
          for (const c of s.orders) {
            const d = String(a[c]).localeCompare(String(b[c]))
            if (d !== 0) return (s.desc ? -1 : 1) * d
          }
          return 0
        })
      }
      if (s.range) rows = rows.slice(s.range[0], s.range[1] + 1)
      return { data: rows.map((r) => ({ ...r })), count: null, error: null }
    }
    const api = {
      select(cols, opts) { s.cols = cols; s.opts = opts || null; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      gt(c, v) { s.filters.push(['gt', c, v]); return api },
      gte(c, v) { s.filters.push(['gte', c, v]); return api },
      lt(c, v) { s.filters.push(['lt', c, v]); return api },
      order(c, o) { if (s.order == null) { s.order = c; s.desc = o?.ascending === false } s.orders.push(c); return api },
      range(a, b) { s.range = [a, b]; return api },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej) },
    }
    return api
  }
  return { db: { from: (t) => builder(t) }, log }
}

const sub = (over = {}) => ({
  location_id: HATCH, un1t_user_id: 'u1', status: 'active', price_cents: 18900,
  billing_interval: 'month', billing_interval_count: 1, paused_at: null, past_due_at: null,
  remote_created_at: '2026-10-10T10:00:00Z', synced_at: SYNCED, ...over,
})

function seed(extra = {}) {
  return {
    un1t_subscriptions: [
      sub({ un1t_user_id: 'a' }),
      sub({ un1t_user_id: 'b', paused_at: '2026-10-12T00:00:00Z' }),
      sub({ un1t_user_id: 'c', status: 'canceled' }),
      sub({ location_id: STILLORGAN, un1t_user_id: 'other' }),
    ],
    un1t_clients: [
      { location_id: HATCH, un1t_user_id: 'a', credit_balance: 0, credit_unlimited: true, bookings_30d_attended: 8 },
      { location_id: HATCH, un1t_user_id: 'b', credit_balance: 0, credit_unlimited: true, bookings_30d_attended: 0 },
      { location_id: HATCH, un1t_user_id: 'p', credit_balance: 4, credit_unlimited: false, bookings_30d_attended: 1 },
      { location_id: STILLORGAN, un1t_user_id: 'o', credit_balance: 9, credit_unlimited: false, bookings_30d_attended: 5 },
    ],
    un1t_products: [
      { location_id: HATCH, un1t_id: 'pk', type: 'one_time', price_cents: 5400 },
      { location_id: HATCH, un1t_id: 'trial', type: 'one_time', price_cents: 0 },
    ],
    un1t_transactions: [
      { id: 't1', location_id: HATCH, un1t_id: 't1', un1t_user_id: 'p', product_id: 'pk', product_type: 'pack', type: 'one_time', amount_cents: 5400, refunded: false, remote_created_at: '2026-10-02T09:00:00Z' },
      { id: 't2', location_id: HATCH, un1t_id: 't2', un1t_user_id: 'a', product_id: 'm', product_type: 'subscription', type: 'sub_initial', amount_cents: 18900, refunded: false, remote_created_at: '2026-10-05T09:00:00Z' },
      { id: 't3', location_id: HATCH, un1t_id: 't3', un1t_user_id: 'a', product_id: 'm', product_type: 'subscription', type: 'sub_renewal', amount_cents: 18900, refunded: false, remote_created_at: '2026-10-12T09:00:00Z' },
      { id: 't4', location_id: HATCH, un1t_id: 't4', un1t_user_id: 'b', product_id: 'm', product_type: 'subscription', type: 'sub_initial', amount_cents: 18900, refunded: true, remote_created_at: '2026-10-06T09:00:00Z' },
      { id: 't5', location_id: HATCH, un1t_id: 't5', un1t_user_id: 'x', product_id: 'm', product_type: 'subscription', type: 'sub_initial', amount_cents: 18900, refunded: false, remote_created_at: '2026-09-14T09:00:00Z' },
      { id: 't6', location_id: STILLORGAN, un1t_id: 't6', un1t_user_id: 'o', product_id: 'm', product_type: 'subscription', type: 'sub_initial', amount_cents: 99999, refunded: false, remote_created_at: '2026-10-04T09:00:00Z' },
    ],
    contact_memberships: [
      { location_id: HATCH, source: 'un1t_online_api', status: 'ended', ended_at: '2026-10-16T08:00:00Z' },
      { location_id: HATCH, source: 'un1t_online_api', status: 'ended', ended_at: '2026-09-30T08:00:00Z' },
      { location_id: HATCH, source: 'un1t_online_export', status: 'ended', ended_at: '2026-10-16T08:00:00Z' },
      { location_id: STILLORGAN, source: 'un1t_online_api', status: 'ended', ended_at: '2026-10-16T08:00:00Z' },
    ],
    ...extra,
  }
}

const READS = ['membershipCounts', 'mrr', 'membershipFlows', 'growth', 'engagement', 'revenueMtd']
const call = (db, key) => ({
  membershipCounts: () => un1tOnlineReads.membershipCounts(db, HATCH),
  mrr: () => un1tOnlineReads.mrr(db, HATCH),
  membershipFlows: () => un1tOnlineReads.membershipFlows(db, HATCH, 3, NOW.getTime(), { zone: 'Europe/Dublin' }),
  growth: () => un1tOnlineReads.growth(db, HATCH, NOW),
  engagement: () => un1tOnlineReads.engagement(db, HATCH),
  revenueMtd: () => un1tOnlineReads.revenueMtd(db, HATCH, NOW, 'Europe/Dublin'),
})[key]()

beforeEach(() => vi.clearAllMocks())

describe('un1tOnlineReads surface', () => {
  it('implements six reads plus pastDue, paymentsFor, pipelineInputs, trialEligibility and the three radar reads, and deliberately no arrears', () => {
    expect(Object.keys(un1tOnlineReads).sort()).toEqual([...READS, 'pastDue', 'paymentsFor', 'pipelineInputs', 'trialEligibility', 'radarMembers', 'winbackContacts', 'leadContacts'].sort())
    expect(Object.isFrozen(un1tOnlineReads)).toBe(true)
    expect(un1tOnlineReads.arrears).toBeUndefined()
  })
})

describe('scoping', () => {
  it("every read filters .eq('location_id', loc) on every table it touches, and never reads contacts", async () => {
    for (const key of READS) {
      const { db, log } = makeDb(seed())
      await call(db, key)
      expect(log.length, key).toBeGreaterThan(0)
      for (const q of log) {
        expect(q.table, key).not.toBe('contacts')
        expect(q.filters, `${key} ${q.table}`).toContainEqual(['eq', 'location_id', HATCH])
      }
    }
  })

  it('a contact living at Stillorgan with an active Hatch subscription is counted at Hatch', async () => {
    // The membership row carries contact_id of a contact whose contacts.location_id is Stillorgan.
    const { db, log } = makeDb(seed({
      un1t_subscriptions: [sub({ un1t_user_id: 'dual', contact_id: 'contact-at-stillorgan' })],
      un1t_clients: [{ location_id: HATCH, un1t_user_id: 'dual', contact_id: 'contact-at-stillorgan', credit_balance: 0, credit_unlimited: true, bookings_30d_attended: 3 }],
    }))
    const counts = await un1tOnlineReads.membershipCounts(db, HATCH)
    expect(counts.monthly_recurring).toBe(1)
    expect(counts.total_members).toBe(1)
    expect((await un1tOnlineReads.mrr(db, HATCH)).data.mrrCents).toBe(18900)
    expect((await un1tOnlineReads.engagement(db, HATCH)).data.members).toBe(1)
    expect(log.some((q) => q.table === 'contacts')).toBe(false)
  })

  it("another studio's rows never leak in", async () => {
    const { db } = makeDb(seed())
    expect((await un1tOnlineReads.membershipCounts(db, HATCH)).monthly_recurring).toBe(2)
    expect((await un1tOnlineReads.revenueMtd(db, HATCH, NOW, 'Europe/Dublin')).data.totalCents).toBe(5400 + 18900 + 18900)
  })
})

// UN1TREAD.7 — which subscriptions count.
describe('status and staleness (UN1TREAD.7)', () => {
  const subsDb = (subs, extra = {}) => makeDb({ ...seed(extra), un1t_subscriptions: subs }).db

  it("past_due counts in monthly_recurring/total_members/engagement but not MRR/active_recurring; trialing counts nowhere", async () => {
    const subs = [
      sub({ un1t_user_id: 'a' }),
      sub({ un1t_user_id: 'pd', status: 'past_due' }),
      sub({ un1t_user_id: 'tr', status: 'trialing' }),
    ]
    const clients = [
      { location_id: HATCH, un1t_user_id: 'a', credit_balance: 0, credit_unlimited: true, bookings_30d_attended: 4 },
      { location_id: HATCH, un1t_user_id: 'pd', credit_balance: 0, credit_unlimited: true, bookings_30d_attended: 2 },
      { location_id: HATCH, un1t_user_id: 'tr', credit_balance: 0, credit_unlimited: true, bookings_30d_attended: 9 },
    ]
    const db = subsDb(subs, { un1t_clients: clients })
    const counts = await un1tOnlineReads.membershipCounts(db, HATCH)
    expect(counts).toMatchObject({ monthly_recurring: 2, total_members: 2, active_recurring: 1 })
    expect((await un1tOnlineReads.mrr(db, HATCH)).data).toEqual({ mrrCents: 18900, recurringMembers: 1, yieldCents: 18900 })
    expect((await un1tOnlineReads.engagement(db, HATCH)).data.members).toBe(2)
  })

  it("the subscription query asks for status IN ('active','past_due') only", async () => {
    const { db, log } = makeDb(seed())
    await un1tOnlineReads.membershipCounts(db, HATCH)
    const q = log.filter((x) => x.table === 'un1t_subscriptions' && x.filters.some((f) => f[0] === 'in'))
    expect(q.length).toBeGreaterThan(0)
    for (const x of q) expect(x.filters).toContainEqual(['in', 'status', ['active', 'past_due']])
  })

  it('a row 30 min older than the newest is a stale active (absent from the latest pull) and is excluded everywhere', async () => {
    const subs = [
      sub({ un1t_user_id: 'fresh' }),
      sub({ un1t_user_id: 'edge', synced_at: '2026-10-17T11:40:00.000Z' }), // exactly 10 min older: counted
      sub({ un1t_user_id: 'stale', synced_at: '2026-10-17T11:20:00.000Z' }), // 30 min older
    ]
    const clients = subs.map((x) => ({ location_id: HATCH, un1t_user_id: x.un1t_user_id, credit_balance: 0, credit_unlimited: true, bookings_30d_attended: 1 }))
    const db = subsDb(subs, { un1t_clients: clients })
    expect((await un1tOnlineReads.membershipCounts(db, HATCH)).monthly_recurring).toBe(2)
    expect((await un1tOnlineReads.mrr(db, HATCH)).data.mrrCents).toBe(2 * 18900)
    expect((await un1tOnlineReads.engagement(db, HATCH)).data.members).toBe(2)
  })

  it('the newest row decides, across every status: a canceled row that synced last keeps the rest fresh', async () => {
    const subs = [
      sub({ un1t_user_id: 'a', synced_at: '2026-10-17T11:30:00.000Z' }),
      sub({ un1t_user_id: 'x', status: 'canceled', synced_at: '2026-10-17T11:50:00.000Z' }),
    ]
    // 'a' is 20 min older than the newest row (the canceled one): stale
    expect((await un1tOnlineReads.membershipCounts(subsDb(subs), HATCH)).monthly_recurring).toBe(0)
  })

  it('all rows equally old (the sync stopped): all are counted, none excluded', async () => {
    const old = '2026-10-10T08:00:00.000Z'
    const subs = [sub({ un1t_user_id: 'a', synced_at: old }), sub({ un1t_user_id: 'b', synced_at: old })]
    const db = subsDb(subs)
    expect((await un1tOnlineReads.membershipCounts(db, HATCH)).monthly_recurring).toBe(2)
    expect((await un1tOnlineReads.mrr(db, HATCH)).data.mrrCents).toBe(2 * 18900)
  })

  it("the newest sync time is per location: Stillorgan's fresher rows do not age out Hatch", async () => {
    const subs = [
      sub({ un1t_user_id: 'a', synced_at: '2026-10-10T08:00:00.000Z' }),
      sub({ location_id: STILLORGAN, un1t_user_id: 'o', synced_at: '2026-10-17T11:50:00.000Z' }),
    ]
    expect((await un1tOnlineReads.membershipCounts(subsDb(subs), HATCH)).monthly_recurring).toBe(1)
  })

  it('no subscriptions at all is an honest zero (the failed-read contract below covers the freshness read too)', async () => {
    const empty = subsDb([])
    expect((await un1tOnlineReads.membershipCounts(empty, HATCH)).monthly_recurring).toBe(0)
    expect((await un1tOnlineReads.mrr(empty, HATCH)).data.mrrCents).toBe(0)
  })
})

describe('pagination', () => {
  it('lists paginate with range + order', async () => {
    const { db, log } = makeDb(seed())
    await un1tOnlineReads.membershipCounts(db, HATCH)
    await un1tOnlineReads.membershipFlows(db, HATCH, 3, NOW.getTime(), { zone: 'Europe/Dublin' })
    await un1tOnlineReads.engagement(db, HATCH)
    await un1tOnlineReads.revenueMtd(db, HATCH, NOW, 'Europe/Dublin')
    const lists = log.filter((q) => !q.opts?.head)
    expect(lists.length).toBeGreaterThan(0)
    for (const q of lists) {
      expect(q.range, q.table).not.toBeNull()
      expect(q.order, q.table).toBeTruthy()
    }
  })

  it('reads past the 1,000-row cap (a second page is fetched)', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => sub({ un1t_user_id: `u${String(i).padStart(4, '0')}` }))
    const { db, log } = makeDb(seed({ un1t_subscriptions: many, un1t_clients: [] }))
    const counts = await un1tOnlineReads.membershipCounts(db, HATCH)
    expect(counts.monthly_recurring).toBe(1500)
    // one freshness read, then two pages of subscriptions
    expect(log.filter((q) => q.table === 'un1t_subscriptions' && q.filters.some((f) => f[0] === 'in')).length).toBe(2)
  })
})

describe('return shapes (identical to the Glofox functions)', () => {
  it('membershipCounts → bare object', async () => {
    const { db } = makeDb(seed())
    expect(await un1tOnlineReads.membershipCounts(db, HATCH)).toEqual({
      total_members: 3, monthly_recurring: 2, class_packs: 1, payg: 0, active_recurring: 1, dead_packs: 0,
      detail: { recurring_by_interval: { '1 month': 2, '3 months': 0, '6 months': 0, '12 months': 0 } },
    })
  })

  it('mrr → { success, data: { mrrCents, recurringMembers, yieldCents } }', async () => {
    const { db } = makeDb(seed())
    expect(await un1tOnlineReads.mrr(db, HATCH)).toEqual({ success: true, data: { mrrCents: 18900, recurringMembers: 1, yieldCents: 18900 } })
  })

  it('membershipFlows → { months, cancelTrackingStart }', async () => {
    const { db } = makeDb(seed())
    expect(await un1tOnlineReads.membershipFlows(db, HATCH, 3, NOW.getTime(), { zone: 'Europe/Dublin' })).toEqual({
      months: [
        { month: '2026-08', sales: 0, cancellations: null },
        { month: '2026-09', sales: 1, cancellations: null },
        { month: '2026-10', sales: 2, cancellations: 1 }, // 'a' + 'b' (refund does not erase a sale); one api cancel
      ],
      cancelTrackingStart: '2026-10-16',
    })
  })

  it('growth → { success, data } over the 28-day windows; delta null while the previous window predates tracking', async () => {
    const { db } = makeDb(seed())
    const r = await un1tOnlineReads.growth(db, HATCH, NOW)
    expect(r).toEqual({
      success: true,
      data: { windowDays: 28, recurringStarts: 2, recurringCancels: 2, netRecurring: 0, netRecurringDelta: null },
    })
  })

  it('growth delta is real once the previous window is fully tracked', async () => {
    const { db } = makeDb(seed())
    const later = new Date('2026-12-20T12:00:00.000Z')
    const r = await un1tOnlineReads.growth(db, HATCH, later)
    expect(r.data.netRecurringDelta).toBe(0)
  })

  it('engagement → { success, data: { members, activeMembers, activeRatePct, visitsPerMemberWeek } }', async () => {
    const { db } = makeDb(seed())
    expect(await un1tOnlineReads.engagement(db, HATCH)).toEqual({
      success: true, data: { members: 2, activeMembers: 1, activeRatePct: 50, visitsPerMemberWeek: 0.9 },
    })
  })

  it('revenueMtd → { success, data: { totalCents, paidCount, deltaPct } }, refunds excluded', async () => {
    const { db } = makeDb(seed())
    const r = await un1tOnlineReads.revenueMtd(db, HATCH, NOW, 'Europe/Dublin')
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ totalCents: 43200, paidCount: 3 })
    expect(Object.keys(r.data).sort()).toEqual(['deltaPct', 'paidCount', 'totalCents'])
  })

  it('revenueMtd zone boundary: 2026-09-30T23:30:00Z is October in Europe/Dublin and September in UTC', async () => {
    const edge = [{ location_id: HATCH, un1t_id: 'edge', type: 'one_time', amount_cents: 7700, refunded: false, remote_created_at: '2026-09-30T23:30:00Z' }]
    const now = new Date('2026-10-17T12:00:00.000Z')
    const dublin = await un1tOnlineReads.revenueMtd(makeDb({ un1t_transactions: edge }).db, HATCH, now, 'Europe/Dublin')
    expect(dublin.data).toMatchObject({ totalCents: 7700, paidCount: 1 })
    const utc = await un1tOnlineReads.revenueMtd(makeDb({ un1t_transactions: edge }).db, HATCH, now, 'UTC')
    expect(utc.data).toMatchObject({ totalCents: 0, paidCount: 0 })
    // 30 Sep is outside the comparator (1-17 Sep) either way
    expect(utc.data.deltaPct).toBeNull()
  })

  it('revenueMtd deltaPct is null when the same window last month had nothing', async () => {
    const s0 = seed()
    s0.un1t_transactions = s0.un1t_transactions.filter((t) => t.un1t_id !== 't5')
    const r = await un1tOnlineReads.revenueMtd(makeDb(s0).db, HATCH, NOW, 'Europe/Dublin')
    expect(r.data.deltaPct).toBeNull()
  })

  it('revenueMtd deltaPct compares the same window last month', async () => {
    const { db } = makeDb(seed())
    // 1-17 Oct = 43200; 1-17 Sep holds t5 (14 Sep, 18900)
    const r = await un1tOnlineReads.revenueMtd(db, HATCH, NOW, 'Europe/Dublin')
    expect(r.data.deltaPct).toBeCloseTo(((43200 - 18900) / 18900) * 100)
  })
})

describe('failure contract (same as the Glofox function each mirrors)', () => {
  it('membershipCounts and membershipFlows THROW', async () => {
    for (const table of ['un1t_subscriptions', 'un1t_clients', 'un1t_transactions', 'un1t_products']) {
      await expect(un1tOnlineReads.membershipCounts(makeDb(seed(), { fail: [table] }).db, HATCH)).rejects.toThrow(/boom/)
    }
    await expect(un1tOnlineReads.membershipFlows(makeDb(seed(), { fail: ['un1t_transactions'] }).db, HATCH, 3, NOW.getTime(), { zone: 'Europe/Dublin' })).rejects.toThrow(/boom/)
    await expect(un1tOnlineReads.membershipFlows(makeDb(seed(), { fail: ['contact_memberships'] }).db, HATCH, 3, NOW.getTime(), { zone: 'Europe/Dublin' })).rejects.toThrow(/boom/)
  })

  it('mrr, growth, engagement and revenueMtd RETURN { success:false, error }', async () => {
    const cases = [
      ['mrr', 'un1t_subscriptions'],
      ['growth', 'un1t_transactions'],
      ['growth', 'contact_memberships'],
      ['engagement', 'un1t_clients'],
      ['engagement', 'un1t_subscriptions'],
      ['revenueMtd', 'un1t_transactions'],
    ]
    for (const [key, table] of cases) {
      const r = await call(makeDb(seed(), { fail: [table] }).db, key)
      expect(r, `${key}/${table}`).toEqual({ success: false, error: `${table} boom` })
    }
  })

  it('the fetch-style reads refuse a missing location without querying', async () => {
    const { db, log } = makeDb(seed())
    expect(await un1tOnlineReads.mrr(db, null)).toEqual({ success: false, error: 'No location' })
    expect(await un1tOnlineReads.growth(db, '', NOW)).toEqual({ success: false, error: 'No location' })
    expect(await un1tOnlineReads.engagement(db, undefined)).toEqual({ success: false, error: 'No location' })
    expect(log).toEqual([])
  })
})

// HATCHPIPE.2 — the freshness cutoff, shared by every un1t read that must ignore rows the sync stopped returning.
describe('freshCutoff', () => {
  const at = (loc, iso) => ({ location_id: loc, synced_at: iso })

  it('returns the newest synced_at minus 10 minutes, per location', async () => {
    const { db } = makeDb({
      un1t_subscriptions: [
        at(HATCH, '2026-10-17T11:50:00.000Z'), at(HATCH, '2026-10-17T11:35:00.000Z'),
        at(STILLORGAN, '2026-10-16T08:00:00.000Z'),
      ],
    })
    expect(await freshCutoff(db, 'un1t_subscriptions', HATCH)).toBe('2026-10-17T11:40:00.000Z')
    expect(await freshCutoff(db, 'un1t_subscriptions', STILLORGAN)).toBe('2026-10-16T07:50:00.000Z')
  })

  it('works for the invoice and client tables', async () => {
    const { db } = makeDb({
      un1t_invoices: [at(HATCH, '2026-10-17T11:50:00.000Z')],
      un1t_clients: [at(HATCH, '2026-10-17T10:00:00.000Z')],
    })
    expect(await freshCutoff(db, 'un1t_invoices', HATCH)).toBe('2026-10-17T11:40:00.000Z')
    expect(await freshCutoff(db, 'un1t_clients', HATCH)).toBe('2026-10-17T09:50:00.000Z')
  })

  it('is null when the table has no rows at that location', async () => {
    const { db } = makeDb({ un1t_invoices: [at(STILLORGAN, '2026-10-17T11:50:00.000Z')] })
    expect(await freshCutoff(db, 'un1t_invoices', HATCH)).toBeNull()
  })

  it('throws on a read error', async () => {
    const { db } = makeDb({ un1t_invoices: [at(HATCH, SYNCED)] }, { fail: ['un1t_invoices'] })
    await expect(freshCutoff(db, 'un1t_invoices', HATCH)).rejects.toThrow(/boom/)
  })

  it('refuses any other table', async () => {
    const { db, log } = makeDb({})
    await expect(freshCutoff(db, 'contacts', HATCH)).rejects.toThrow(/un1t_/)
    expect(log).toHaveLength(0)
  })

  it('reads one row, newest first, scoped to the location', async () => {
    const { db, log } = makeDb({ un1t_subscriptions: [at(HATCH, SYNCED)] })
    await freshCutoff(db, 'un1t_subscriptions', HATCH)
    expect(log[0]).toMatchObject({ table: 'un1t_subscriptions', cols: 'synced_at', order: 'synced_at', range: [0, 0] })
    expect(log[0].filters).toContainEqual(['eq', 'location_id', HATCH])
  })
})

// ---------------------------------------------------------------------------
// HATCHPIPE.2 — pastDue and paymentsFor
// ---------------------------------------------------------------------------
describe('pastDue and paymentsFor', () => {
  const psub = (over = {}) => ({
    location_id: HATCH, un1t_id: 's1', un1t_user_id: 'u1', contact_id: 'c1', product_title: 'Unlimited',
    status: 'active', price_cents: 18900, currency: 'eur', billing_interval: 'month', billing_interval_count: 1,
    current_period_end: '2026-11-01T00:00:00Z', cancel_at_period_end: false, paused_at: null, paused_until: null,
    past_due_at: null, synced_at: SYNCED, ...over,
  })
  const pinv = (over = {}) => ({
    id: over.un1t_id ?? 'i1', location_id: HATCH, un1t_id: 'i1', un1t_user_id: 'u1', contact_id: 'c1', subscription_id: 's1',
    status: 'open', amount_cents: 18900, currency: 'eur', remote_created_at: '2026-10-01T10:00:00Z', synced_at: SYNCED, ...over,
  })
  const ptx = (over = {}) => ({
    id: over.un1t_id ?? 't1', location_id: HATCH, un1t_id: 't1', un1t_user_id: 'u1', contact_id: 'c1', product_title: 'Unlimited',
    type: 'sub_renewal', amount_cents: 18900, currency: 'eur', refunded: false, remote_created_at: '2026-10-01T09:00:00Z', ...over,
  })
  const ids = (rows) => rows.map((r) => r.subscriptionId)

  const base = () => ({
    un1t_subscriptions: [
      psub({ id: 'a', status: 'past_due', past_due_at: '2026-10-05T09:00:00Z' }),
      psub({ id: 'b', un1t_id: 's2', un1t_user_id: 'u2', contact_id: 'c2', status: 'past_due', past_due_at: '2026-10-06T09:00:00Z' }),
      psub({ id: 'c', location_id: STILLORGAN, un1t_id: 's9', un1t_user_id: 'o', contact_id: 'c9', status: 'past_due', past_due_at: '2026-10-07T09:00:00Z' }),
    ],
    un1t_invoices: [pinv({ id: 'x' })],
    un1t_transactions: [ptx()],
  })

  it('pastDue and paymentsFor filter .eq("location_id", loc) on every table and never read contacts', async () => {
    for (const run of [
      (db) => un1tOnlineReads.pastDue(db, HATCH),
      (db) => un1tOnlineReads.pastDue(db, HATCH, { contactIds: ['c1'] }),
      (db) => un1tOnlineReads.paymentsFor(db, HATCH, ['c1']),
    ]) {
      const { db, log } = makeDb(base())
      const out = await run(db)
      expect(out.success).toBe(true)
      expect(log.length).toBeGreaterThan(0)
      for (const q of log) {
        expect(q.table).not.toBe('contacts')
        expect(q.filters, q.table).toContainEqual(['eq', 'location_id', HATCH])
      }
    }
  })

  it('pastDue returns rows for the studio, and honours contactIds (only those contacts)', async () => {
    const { db, log } = makeDb(base())
    const all = await un1tOnlineReads.pastDue(db, HATCH)
    expect(all.success).toBe(true)
    expect(ids(all.data)).toEqual(['s1', 's2'])
    const some = await un1tOnlineReads.pastDue(db, HATCH, { contactIds: ['c2'] })
    expect(ids(some.data)).toEqual(['s2'])
    const scoped = log.filter((q) => q.filters.some(([k, c]) => k === 'in' && c === 'contact_id'))
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.map((q) => q.table).sort()).toEqual(['un1t_invoices', 'un1t_subscriptions'])
  })

  it('pastDue with an empty contactIds list succeeds with no rows and no query; a non-array refuses', async () => {
    const { db, log } = makeDb(base())
    expect(await un1tOnlineReads.pastDue(db, HATCH, { contactIds: [] })).toEqual({ success: true, data: [] })
    expect(log).toHaveLength(0)
    const bad = await un1tOnlineReads.pastDue(db, HATCH, { contactIds: 'c1' })
    expect(bad.success).toBe(false)
    expect(log).toHaveLength(0)
  })

  it('pastDue refuses a missing location without querying', async () => {
    const { db, log } = makeDb(base())
    expect(await un1tOnlineReads.pastDue(db, null)).toMatchObject({ success: false })
    expect(await un1tOnlineReads.paymentsFor(db, undefined, ['c1'])).toMatchObject({ success: false })
    expect(log).toHaveLength(0)
  })

  it('pastDue paginates past 1,000 rows with range + order', async () => {
    const invoices = Array.from({ length: 1100 }, (_, n) => pinv({
      id: `inv-${String(n).padStart(4, '0')}`, un1t_id: `inv-${n}`, un1t_user_id: `u${n}`, contact_id: `c${n}`,
      subscription_id: `s${n}`,
    }))
    const { db, log } = makeDb({ un1t_subscriptions: [psub()], un1t_invoices: invoices })
    const out = await un1tOnlineReads.pastDue(db, HATCH)
    expect(out.success).toBe(true)
    expect(out.data).toHaveLength(1100)
    const pages = log.filter((q) => q.table === 'un1t_invoices' && q.cols !== 'synced_at')
    expect(pages.map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
    for (const q of pages) expect(q.order).toBe('id')
  })

  it('pastDue chunks a long contactIds list and keeps every chunk scoped', async () => {
    const contactIds = Array.from({ length: 650 }, (_, n) => `c${n}`)
    const { db, log } = makeDb({ un1t_subscriptions: [psub({ contact_id: 'c649', status: 'past_due', past_due_at: '2026-10-05T09:00:00Z' })], un1t_invoices: [] })
    const out = await un1tOnlineReads.pastDue(db, HATCH, { contactIds })
    expect(ids(out.data)).toEqual(['s1'])
    const subPages = log.filter((q) => q.table === 'un1t_subscriptions' && q.cols !== 'synced_at')
    expect(subPages).toHaveLength(3)
    for (const q of subPages) expect(q.filters).toContainEqual(['eq', 'location_id', HATCH])
  })

  it('pastDue ignores a stale past_due subscription row (older than the freshness window)', async () => {
    const { db } = makeDb({
      un1t_subscriptions: [
        psub({ un1t_id: 'live', un1t_user_id: 'ua', contact_id: 'ca' }), // the newest row sets the cutoff
        psub({ un1t_id: 'gone', un1t_user_id: 'ub', contact_id: 'cb', status: 'past_due', past_due_at: '2026-10-01T00:00:00Z', synced_at: '2026-10-17T11:00:00.000Z' }),
      ],
      un1t_invoices: [pinv({ un1t_id: 'live-inv', synced_at: SYNCED })],
    })
    const out = await un1tOnlineReads.pastDue(db, HATCH)
    expect(ids(out.data)).toEqual(['s1']) // the invoice's own subscription id, not the stale 'gone'
    expect(out.data.every((r) => r.un1tUserId !== 'ub')).toBe(true)
  })

  it('pastDue ignores a stale open invoice too', async () => {
    const { db } = makeDb({
      un1t_subscriptions: [psub()],
      un1t_invoices: [pinv({ un1t_id: 'new', status: 'paid' }), pinv({ un1t_id: 'old', synced_at: '2026-10-17T10:00:00.000Z' })],
    })
    expect((await un1tOnlineReads.pastDue(db, HATCH)).data).toEqual([])
  })

  it('pastDue is an empty list when the studio has no subscription or invoice rows', async () => {
    const { db } = makeDb({})
    expect(await un1tOnlineReads.pastDue(db, HATCH)).toEqual({ success: true, data: [] })
  })

  it('paymentsFor returns the documented shape; transactions newest first, capped at limit; refunded flag kept', async () => {
    const { db } = makeDb({
      un1t_subscriptions: [psub({ paused_until: '2026-11-15T00:00:00Z', cancel_at_period_end: true, status: 'past_due', past_due_at: '2026-10-05T09:00:00Z' })],
      un1t_invoices: [
        pinv({ un1t_id: 'i1', status: 'paid', remote_created_at: '2026-09-01T10:00:00Z' }),
        pinv({ un1t_id: 'i2', remote_created_at: '2026-10-01T10:00:00Z' }),
        pinv({ un1t_id: 'i3', status: 'paid', remote_created_at: '2026-08-01T10:00:00Z' }),
      ],
      un1t_transactions: [
        ptx({ un1t_id: 't1', remote_created_at: '2026-08-01T09:00:00Z' }),
        ptx({ un1t_id: 't2', remote_created_at: '2026-10-01T09:00:00Z', refunded: true, type: 'sub_initial' }),
        ptx({ un1t_id: 't3', remote_created_at: '2026-09-01T09:00:00Z' }),
        ptx({ un1t_id: 't4', contact_id: 'c-other', remote_created_at: '2026-10-09T09:00:00Z' }),
      ],
    })
    const out = await un1tOnlineReads.paymentsFor(db, HATCH, ['c1'], { limit: 2 })
    expect(out.success).toBe(true)
    expect(out.data.subscriptions).toEqual([{
      productTitle: 'Unlimited', status: 'past_due', priceCents: 18900, currency: 'EUR', interval: '1 month',
      periodEnd: '2026-11-01T00:00:00Z', cancelAtPeriodEnd: true, pausedUntil: '2026-11-15T00:00:00Z', pastDueAt: '2026-10-05T09:00:00Z',
    }])
    expect(out.data.transactions).toEqual([
      { at: '2026-10-01T09:00:00Z', productTitle: 'Unlimited', type: 'sub_initial', amountCents: 18900, currency: 'EUR', refunded: true },
      { at: '2026-09-01T09:00:00Z', productTitle: 'Unlimited', type: 'sub_renewal', amountCents: 18900, currency: 'EUR', refunded: false },
    ])
    expect(out.data.invoices.map((i) => i.at)).toEqual(['2026-10-01T10:00:00Z', '2026-09-01T10:00:00Z'])
    expect(out.data.pastDues).toHaveLength(1)
    expect(out.data.pastDues[0]).toMatchObject({ subscriptionId: 's1', since: '2026-10-01T10:00:00Z', amountCents: 18900 })
    // The single-row field is gone: nothing reads it any more.
    expect(out.data).not.toHaveProperty('pastDue')
  })

  it('paymentsFor returns EVERY past-due row, earliest since first: a member with two overdue subscriptions at one studio keeps both', async () => {
    const { db } = makeDb({
      un1t_subscriptions: [
        psub({ id: 'a', un1t_id: 's1', status: 'past_due', past_due_at: '2026-10-05T09:00:00Z' }),
        psub({ id: 'b', un1t_id: 's2', product_title: 'Pack', price_cents: 4000, status: 'past_due', past_due_at: '2026-09-20T09:00:00Z' }),
      ],
      un1t_invoices: [
        pinv({ un1t_id: 'i1', subscription_id: 's1', amount_cents: 18900, remote_created_at: '2026-10-01T10:00:00Z' }),
        pinv({ un1t_id: 'i2', subscription_id: 's2', amount_cents: 4000, remote_created_at: '2026-09-20T10:00:00Z' }),
      ],
    })
    const out = await un1tOnlineReads.paymentsFor(db, HATCH, ['c1'])
    expect(out.success).toBe(true)
    expect(out.data.pastDues.map((p) => [p.subscriptionId, p.amountCents, p.currency])).toEqual([
      ['s2', 4000, 'EUR'],
      ['s1', 18900, 'EUR'],
    ])
  })

  it('paymentsFor upper-cases currency on subscriptions, transactions and invoices; a null currency stays null', async () => {
    const { db } = makeDb({
      un1t_subscriptions: [psub({ currency: 'eur' }), psub({ un1t_id: 's2', currency: null })],
      un1t_invoices: [pinv({ un1t_id: 'i1', status: 'paid', currency: 'eur', remote_created_at: '2026-10-01T10:00:00Z' }), pinv({ un1t_id: 'i2', status: 'paid', currency: null, remote_created_at: '2026-09-01T10:00:00Z' })],
      un1t_transactions: [ptx({ un1t_id: 't1', currency: 'eur', remote_created_at: '2026-10-01T09:00:00Z' }), ptx({ un1t_id: 't2', currency: null, remote_created_at: '2026-09-01T09:00:00Z' })],
    })
    const out = await un1tOnlineReads.paymentsFor(db, HATCH, ['c1'])
    expect(out.success).toBe(true)
    expect(out.data.subscriptions.map((s) => s.currency).sort()).toEqual(['EUR', null])
    expect(out.data.transactions.map((t) => t.currency)).toEqual(['EUR', null])
    expect(out.data.invoices.map((i) => i.currency)).toEqual(['EUR', null])
  })

  it('paymentsFor defaults to 25, and pastDues is empty when nothing is owed', async () => {
    const txs = Array.from({ length: 30 }, (_, n) => ptx({ un1t_id: `t${n}`, remote_created_at: `2026-09-${String(n + 1).padStart(2, '0')}T09:00:00Z` }))
    const { db } = makeDb({ un1t_subscriptions: [psub()], un1t_invoices: [pinv({ status: 'paid' })], un1t_transactions: txs })
    const out = await un1tOnlineReads.paymentsFor(db, HATCH, ['c1'])
    expect(out.data.transactions).toHaveLength(25)
    expect(out.data.transactions[0].at).toBe('2026-09-30T09:00:00Z')
    expect(out.data.pastDues).toEqual([])
  })

  it('paymentsFor drops stale subscription and invoice rows', async () => {
    const { db } = makeDb({
      un1t_subscriptions: [psub(), psub({ un1t_id: 'old', product_title: 'Gone', synced_at: '2026-10-17T10:00:00.000Z' })],
      un1t_invoices: [pinv({ status: 'paid' }), pinv({ un1t_id: 'old-inv', status: 'open', synced_at: '2026-10-17T10:00:00.000Z' })],
    })
    const out = await un1tOnlineReads.paymentsFor(db, HATCH, ['c1'])
    expect(out.data.subscriptions.map((s) => s.productTitle)).toEqual(['Unlimited'])
    expect(out.data.invoices).toHaveLength(1)
    expect(out.data.pastDues).toEqual([])
  })

  it('paymentsFor with no contacts succeeds with empty lists and no query', async () => {
    const { db, log } = makeDb(base())
    const out = await un1tOnlineReads.paymentsFor(db, HATCH, [])
    expect(out).toEqual({ success: true, data: { subscriptions: [], transactions: [], invoices: [], pastDues: [] } })
    expect(log).toHaveLength(0)
  })

  it('paymentsFor invoices carry normalised status and rawStatus; an unknown status logs once with { locationId, status }', async () => {
    const { db } = makeDb({
      un1t_subscriptions: [psub()],
      un1t_invoices: [
        pinv({ un1t_id: 'i1', status: 'Past_Due', remote_created_at: '2026-10-03T10:00:00Z' }),
        pinv({ un1t_id: 'i2', status: 'weird', remote_created_at: '2026-10-02T10:00:00Z' }),
        pinv({ un1t_id: 'i3', status: 'weird', remote_created_at: '2026-10-01T10:00:00Z' }),
        pinv({ un1t_id: 'i4', status: 'paid', amount_cents: 5, remote_created_at: '2026-09-01T10:00:00Z' }),
      ],
    })
    const out = await un1tOnlineReads.paymentsFor(db, HATCH, ['c1'])
    expect(out.data.invoices.map((i) => [i.status, i.rawStatus])).toEqual([
      ['open', 'Past_Due'], ['unknown', 'weird'], ['unknown', 'weird'], ['paid', 'paid'],
    ])
    expect(out.data.invoices[0]).toEqual({ at: '2026-10-03T10:00:00Z', status: 'open', rawStatus: 'Past_Due', amountCents: 18900, currency: 'EUR' })
    const warns = logWarn.mock.calls.filter((c) => c[1] === 'unknown invoice status')
    expect(warns).toEqual([['un1t-billing', 'unknown invoice status', { locationId: HATCH, status: 'weird' }]])
  })

  it('pastDue logs an unknown invoice status once per call', async () => {
    const { db } = makeDb({
      un1t_subscriptions: [psub()],
      un1t_invoices: [pinv({ un1t_id: 'i1', status: 'weird' }), pinv({ un1t_id: 'i2', status: 'weird' })],
    })
    await un1tOnlineReads.pastDue(db, HATCH)
    expect(logWarn).toHaveBeenCalledTimes(1)
    await un1tOnlineReads.pastDue(db, HATCH)
    expect(logWarn).toHaveBeenCalledTimes(2)
  })

  it('a failed page returns { success:false, error }, never throws', async () => {
    for (const table of ['un1t_subscriptions', 'un1t_invoices']) {
      const { db } = makeDb(base(), { fail: [table] })
      expect(await un1tOnlineReads.pastDue(db, HATCH)).toEqual({ success: false, error: `${table} boom` })
      expect(await un1tOnlineReads.pastDue(db, HATCH, { contactIds: ['c1'] })).toMatchObject({ success: false })
      expect(await un1tOnlineReads.paymentsFor(db, HATCH, ['c1'])).toMatchObject({ success: false })
    }
    const { db } = makeDb(base(), { fail: ['un1t_transactions'] })
    expect(await un1tOnlineReads.paymentsFor(db, HATCH, ['c1'])).toEqual({ success: false, error: 'un1t_transactions boom' })
  })
})

describe('paymentsFor argument hygiene (Task 5 review)', () => {
  it('refuses a non-array contactIds without querying, as pastDue does', async () => {
    for (const bad of ['c1', { 0: 'c1' }, 42, null, undefined]) {
      const { db, log } = makeDb({})
      expect(await un1tOnlineReads.paymentsFor(db, HATCH, bad)).toEqual({ success: false, error: 'contactIds must be an array' })
      expect(log).toHaveLength(0)
    }
  })

  it('clamps limit to 1000 (a larger limit asks the transactions page for at most 1000 rows)', async () => {
    const { db, log } = makeDb({ un1t_subscriptions: [{ location_id: HATCH, un1t_id: 's1', un1t_user_id: 'u1', contact_id: 'c1', status: 'active', synced_at: SYNCED }] })
    await un1tOnlineReads.paymentsFor(db, HATCH, ['c1'], { limit: 5_000_000 })
    const txQuery = log.find((q) => q.table === 'un1t_transactions')
    expect(txQuery.range).toEqual([0, 999])
  })
})

// ---------------------------------------------------------------------------
// HATCHPIPE.2 Task 7 — pipelineInputs and trialEligibility
// ---------------------------------------------------------------------------
describe('pipelineInputs and trialEligibility', () => {
  const OLD = '2026-10-17T10:00:00.000Z' // 110 min before the newest pull: stale
  const client = (over = {}) => ({
    id: over.un1t_user_id ?? 'u1', location_id: HATCH, un1t_user_id: 'u1', contact_id: 'c1', credit_balance: 0,
    credit_unlimited: false, last_attended_at: null, remote_created_at: '2026-01-05T10:00:00Z', synced_at: SYNCED, ...over,
  })
  const csub = (over = {}) => ({ id: over.un1t_id ?? 's1', location_id: HATCH, un1t_id: 's1', un1t_user_id: 'u1', contact_id: 'c1', status: 'active', paused_at: null, synced_at: SYNCED, ...over })
  const ctx = (over = {}) => ({
    id: over.un1t_id ?? 'x1', location_id: HATCH, un1t_id: 'x1', un1t_user_id: 'u1', contact_id: 'c1', product_id: 'trial', product_type: 'pack',
    type: 'one_time', amount_cents: 0, refunded: false, remote_created_at: '2026-10-01T09:00:00Z', ...over,
  })
  const contact = (over = {}) => ({ id: 'c1', name: 'Test One', email: 'one@example.test', location_id: HATCH, pipeline_dismissed_at: null, last_lead_source_at: null, ...over })
  const prod = (over = {}) => ({ id: over.un1t_id, location_id: HATCH, un1t_id: 'trial', type: 'one_time', price_cents: 0, credits_per_period: 3, title: 'Trial', ...over })

  const world = (over = {}) => ({
    un1t_clients: [client(), client({ un1t_user_id: 'u2', contact_id: 'c2' }), client({ un1t_user_id: 'u3', contact_id: null }),
      client({ location_id: STILLORGAN, un1t_user_id: 'o1', contact_id: 'c9' })],
    un1t_subscriptions: [csub({ un1t_user_id: 'u2', contact_id: 'c2', un1t_id: 's2' })],
    un1t_transactions: [ctx()],
    un1t_products: [prod(), prod({ un1t_id: 'pack5', type: 'one_time', price_cents: 6000, credits_per_period: 5 }), prod({ location_id: STILLORGAN, un1t_id: 'other' })],
    un1t_events: [{ id: 'e1', location_id: HATCH, un1t_id: 'e1', starts_at: '2026-10-10T18:00:00Z' }],
    un1t_bookings: [{ id: 'b1', location_id: HATCH, un1t_id: 'b1', un1t_user_id: 'u1', contact_id: 'c1', event_id: 'e1', status: 'attended', source: 'direct', credit_charged: true, external_member_ref: null, remote_created_at: '2026-10-09T10:00:00Z' }],
    contact_memberships: [{ id: 'm1', location_id: HATCH, contact_id: 'c1', source: 'un1t_online_api', status: 'ended', ended_at: '2026-09-01T00:00:00Z' }],
    contacts: [contact(), contact({ id: 'c2', name: 'Test Two', email: 'two@example.test' }), contact({ id: 'c9', location_id: STILLORGAN })],
    ...over,
  })

  describe('pipelineInputs', () => {
    it('population is fresh un1t_clients with a contact; unlinked counts null contact_id', async () => {
      const { db } = makeDb(world({
        un1t_clients: [...world().un1t_clients, client({ un1t_user_id: 'stale', contact_id: 'c2', synced_at: OLD })],
      }))
      const out = await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
      expect(out.success).toBe(true)
      expect(out.data.contacts.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
      expect([...out.data.snapshots.keys()].sort()).toEqual(['c1', 'c2'])
      expect(out.data.unlinked).toBe(1)
      expect(out.data.contacts.find((c) => c.id === 'c1')).toEqual({ id: 'c1', name: 'Test One', email: 'one@example.test', location_id: HATCH })
    })

    it('shapes each client from its own rows (bookings get starts_at from the event, history from transactions)', async () => {
      const { db } = makeDb(world())
      const out = await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
      const one = out.data.snapshots.get('c1')
      expect(one.glofox_membership_status).toBe('lead')
      expect(one.recent_bookings).toEqual([{ attended: true, status: 'ATTENDED', time_start: Math.floor(Date.parse('2026-10-10T18:00:00Z') / 1000) }])
      expect(one.last_attended_at).toBe('2026-10-10T18:00:00Z')
      expect(out.data.snapshots.get('c2').glofox_membership_status).toBe('member')
      expect(out.data.snapshots.get('c2').recent_bookings).toEqual([])
    })

    it('a booking with no un1t_user_id is filed under the client its contact_id names', async () => {
      const w = world()
      w.un1t_bookings = [{ ...w.un1t_bookings[0], un1t_user_id: null, contact_id: 'c1' }]
      const { db } = makeDb(w)
      const out = await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
      expect(out.data.snapshots.get('c1').recent_bookings).toHaveLength(1)
      expect(out.data.snapshots.get('c2').recent_bookings).toHaveLength(0)
    })

    it('every un1t table filtered by location_id; contacts read by id only, with the six named columns, no Glofox column', async () => {
      const { db, log } = makeDb(world())
      await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
      const tables = new Set(log.map((q) => q.table))
      expect([...tables].sort()).toEqual(['contact_memberships', 'contacts', 'un1t_bookings', 'un1t_clients', 'un1t_events', 'un1t_products', 'un1t_subscriptions', 'un1t_transactions', 'un1t_write_events'])
      for (const q of log.filter((x) => x.table !== 'contacts')) {
        expect(q.filters, q.table).toContainEqual(['eq', 'location_id', HATCH])
      }
      const contactQueries = log.filter((q) => q.table === 'contacts')
      expect(contactQueries.length).toBeGreaterThan(0)
      for (const q of contactQueries) {
        expect(q.cols).toBe('id, name, email, location_id, pipeline_dismissed_at, last_lead_source_at')
        expect(q.filters.map((f) => [f[0], f[1]])).toEqual([['in', 'id']])
        expect(q.cols).not.toMatch(/glofox/)
      }
      expect(log.some((q) => q.table === 'contact_memberships' && q.filters.some((f) => f[1] === 'source' && f[2] === 'un1t_online_api'))).toBe(true)
    })

    it('a dual-studio contact (contacts.location_id = Stillorgan) is in the population; their Stillorgan dismissal is not lent', async () => {
      const w = world({
        un1t_clients: [client({ contact_id: 'cd' })],
        un1t_subscriptions: [], un1t_transactions: [], un1t_bookings: [], contact_memberships: [],
        contacts: [contact({ id: 'cd', location_id: STILLORGAN, pipeline_dismissed_at: '2026-10-01T00:00:00Z', last_lead_source_at: '2026-10-02T00:00:00Z' })],
      })
      const { db } = makeDb(w)
      const out = await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
      expect(out.data.contacts).toEqual([{ id: 'cd', name: 'Test One', email: 'one@example.test', location_id: STILLORGAN }])
      const s = out.data.snapshots.get('cd')
      expect(s.pipeline_dismissed_at).toBeNull()
      expect(s.last_lead_source_at).toBeNull()
    })

    it('a stale subscription row does not make a member', async () => {
      const w = world()
      w.un1t_subscriptions = [csub({ un1t_user_id: 'u2', contact_id: 'c2', un1t_id: 's2' }), csub({ un1t_id: 'old', synced_at: OLD })]
      const { db } = makeDb(w)
      const out = await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
      expect(out.data.snapshots.get('c1').glofox_membership_status).not.toBe('member')
      expect(out.data.snapshots.get('c2').glofox_membership_status).toBe('member')
    })

    it('two fresh clients linked to one contact are ONE person: rows unioned, credits summed, earliest sign-up', async () => {
      const w = world({
        un1t_clients: [
          client({ un1t_user_id: 'a1', contact_id: 'c1', credit_balance: 2, remote_created_at: '2026-03-01T00:00:00Z', last_attended_at: '2026-09-01T00:00:00Z' }),
          client({ un1t_user_id: 'a2', contact_id: 'c1', credit_balance: 3, remote_created_at: '2026-05-01T00:00:00Z', last_attended_at: '2026-10-01T00:00:00Z' }),
        ],
        un1t_subscriptions: [csub({ un1t_user_id: 'a2', contact_id: null, un1t_id: 's2' })],
        un1t_transactions: [ctx({ un1t_user_id: 'a1', un1t_id: 'x1', product_id: 'pack5', amount_cents: 6000, product_type: 'pack' })],
        un1t_bookings: [
          { id: 'b1', location_id: HATCH, un1t_id: 'b1', un1t_user_id: 'a1', contact_id: null, event_id: 'e1', status: 'attended', source: 'direct', credit_charged: false, external_member_ref: null, remote_created_at: '2026-10-09T10:00:00Z' },
          { id: 'b2', location_id: HATCH, un1t_id: 'b2', un1t_user_id: 'a2', contact_id: null, event_id: 'e1', status: 'booked', source: 'direct', credit_charged: false, external_member_ref: null, remote_created_at: '2026-10-09T11:00:00Z' },
        ],
        contact_memberships: [], contacts: [contact()],
      })
      const { db } = makeDb(w)
      const out = await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
      expect(out.data.contacts).toHaveLength(1)
      expect(out.data.snapshots.size).toBe(1)
      const s = out.data.snapshots.get('c1')
      expect(s.glofox_membership_status).toBe('member') // a2's subscription
      expect(s.pack_customer_at).toBe('2026-10-01T09:00:00Z') // a1's pack
      expect(s.recent_bookings).toHaveLength(2) // both accounts' bookings
      expect(s.last_attended_at).toBe('2026-10-10T18:00:00Z') // the attended booking's class (after both client stamps)
      expect(s.trial_credits_remaining).toBe(5) // 2 + 3, paid pack present
      expect(s.joined_at).toBe('2026-03-01T00:00:00Z')
    })

    it('a linked client whose contacts row cannot be read is counted and logged once, ids never named', async () => {
      const w = world({
        un1t_clients: [client(), client({ un1t_user_id: 'g1', contact_id: 'gone' }), client({ un1t_user_id: 'g2', contact_id: 'gone2' })],
      })
      const { db } = makeDb(w)
      const out = await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
      expect(out.data.contacts.map((c) => c.id)).toEqual(['c1'])
      expect(out.data.skipped_no_contact).toBe(2)
      expect(logWarn.mock.calls.filter((c) => c[1] === 'client contact missing')).toEqual([['un1t-pipeline', 'client contact missing', { locationId: HATCH, count: 2 }]])
      // nothing missing → no log, count 0
      vi.clearAllMocks()
      const ok = await un1tOnlineReads.pipelineInputs(makeDb(world()).db, HATCH, { now: NOW.getTime() })
      expect(ok.data.skipped_no_contact).toBe(0)
      expect(logWarn).not.toHaveBeenCalled()
    })

    it('a studio with no client rows is an empty answer', async () => {
      const { db } = makeDb({})
      expect(await un1tOnlineReads.pipelineInputs(db, HATCH)).toEqual({ success: true, data: { contacts: [], snapshots: new Map(), evidence: new Map(), unlinked: 0, skipped_no_contact: 0 } })
    })

    it('refuses a missing location without querying', async () => {
      const { db, log } = makeDb(world())
      expect(await un1tOnlineReads.pipelineInputs(db, null)).toEqual({ success: false, error: 'No location' })
      expect(log).toHaveLength(0)
    })

    it('any failed read → { success:false }', async () => {
      for (const table of ['un1t_clients', 'un1t_subscriptions', 'un1t_transactions', 'un1t_products', 'un1t_bookings', 'un1t_events', 'contact_memberships', 'contacts']) {
        const { db } = makeDb(world(), { fail: [table] })
        expect(await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() }), table).toEqual({ success: false, error: `${table} boom` })
      }
    })

    it('paginates past 1,000 bookings with range + order', async () => {
      const w = world()
      w.un1t_bookings = Array.from({ length: 1200 }, (_, i) => ({
        id: `b${String(i).padStart(5, '0')}`, location_id: HATCH, un1t_id: `b${i}`, un1t_user_id: 'u1', contact_id: 'c1',
        event_id: 'e1', status: 'booked', source: 'direct', credit_charged: false, external_member_ref: null, remote_created_at: '2026-10-09T10:00:00Z',
      }))
      const { db, log } = makeDb(w)
      const out = await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
      expect(out.success).toBe(true)
      const pages = log.filter((q) => q.table === 'un1t_bookings')
      expect(pages.map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
      for (const q of pages) expect(q.order).toBe('id')
      // the shaper saw all of them: only the ten newest are kept, so assert via the cap
      expect(out.data.snapshots.get('c1').recent_bookings).toHaveLength(10)
    })

    // HATCHPIPE.5 — the board's real dates.
    it('returns date evidence per contact: client creation, every attended start, the member subscription start', async () => {
      const w = world()
      w.un1t_subscriptions = [csub({ un1t_user_id: 'u2', contact_id: 'c2', un1t_id: 's2', remote_created_at: '2026-09-02T08:00:00Z' })]
      w.un1t_events = [...w.un1t_events, { id: 'e0', location_id: HATCH, un1t_id: 'e0', starts_at: '2026-10-03T18:00:00Z' }]
      w.un1t_bookings = [...w.un1t_bookings, { ...w.un1t_bookings[0], id: 'b0', un1t_id: 'b0', event_id: 'e0' }]
      const { db, log } = makeDb(w)
      const out = await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
      expect(out.data.evidence).toBeInstanceOf(Map)
      expect([...out.data.evidence.keys()].sort()).toEqual(['c1', 'c2'])
      const one = out.data.evidence.get('c1')
      expect(one.client_created_at).toBe('2026-01-05T10:00:00Z')
      expect(one.attended_starts).toEqual(['2026-10-03T18:00:00Z', '2026-10-10T18:00:00Z'])
      expect(out.data.evidence.get('c2').member_since).toBe('2026-09-02T08:00:00Z')
      const subCols = log.filter((q) => q.table === 'un1t_subscriptions').map((q) => q.cols)
      expect(subCols.some((c) => c.split(', ').includes('remote_created_at'))).toBe(true)
    })

    it('counts only done ledger rows as a trial (a sent, unknown or refused row is not on the board)', async () => {
      // 3 credits on the account: with the trial known, they are trial credits (status 'trial')
      const base = {
        un1t_transactions: [], contact_memberships: [], un1t_bookings: [],
        un1t_clients: [client({ credit_balance: 3 }), client({ un1t_user_id: 'u2', contact_id: 'c2' })],
      }
      const trialOf = (stage) => ledger({ un1t_user_id: 'u1', stage, method: 'free_checkout' })
      for (const stage of ['sent', 'unknown', 'refused']) {
        const { db } = makeDb(world({ ...base, un1t_write_events: [trialOf(stage)] }))
        const out = await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
        expect(out.data.snapshots.get('c1').glofox_membership_status, stage).toBe('lead')
      }
      const { db, log } = makeDb(world({ ...base, un1t_write_events: [trialOf('done')] }))
      const out = await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() })
      const one = out.data.snapshots.get('c1')
      expect(one.glofox_membership_status).toBe('trial')
      expect(one.joined_at).toBe('2026-10-16T09:00:00Z')
      // only the person who took it, and the read asks for done rows only
      expect(out.data.snapshots.get('c2').glofox_membership_status).toBe('member')
      const q = log.find((x) => x.table === 'un1t_write_events')
      expect(q.filters).toContainEqual(['in', 'stage', ['done']])
      expect(q.filters).toContainEqual(['eq', 'location_id', HATCH])
    })

    it('a done ledger trial reaches the person through ANY of their linked accounts', async () => {
      const w = world({
        un1t_clients: [client({ un1t_user_id: 'a1', contact_id: 'c1', credit_balance: 1 }), client({ un1t_user_id: 'a2', contact_id: 'c1', credit_balance: 2 })],
        un1t_subscriptions: [], un1t_transactions: [], un1t_bookings: [], contact_memberships: [],
        un1t_write_events: [ledger({ un1t_user_id: 'a2', stage: 'done', method: 'charge' })],
      })
      const out = await un1tOnlineReads.pipelineInputs(makeDb(w).db, HATCH, { now: NOW.getTime() })
      expect(out.data.snapshots.get('c1').glofox_membership_status).toBe('trial')
    })

    it("a done ledger trial keyed by contact_id (the account not yet mirrored into un1t_clients) is the contact's trial; a sent one is not", async () => {
      const w = (stage) => world({
        un1t_clients: [client({ credit_balance: 3 })],
        un1t_subscriptions: [], un1t_transactions: [], un1t_bookings: [], contact_memberships: [],
        un1t_write_events: [ledger({ un1t_user_id: 'brand-new-account', contact_id: 'c1', stage })],
      })
      const done = await un1tOnlineReads.pipelineInputs(makeDb(w('done')).db, HATCH, { now: NOW.getTime() })
      expect(done.data.snapshots.get('c1').glofox_membership_status).toBe('trial')
      const sent = await un1tOnlineReads.pipelineInputs(makeDb(w('sent')).db, HATCH, { now: NOW.getTime() })
      expect(sent.data.snapshots.get('c1').glofox_membership_status).toBe('lead')
    })

    it('a done ledger row reaching a person by both user id and contact id is counted once', async () => {
      const w = world({
        un1t_clients: [client({ credit_balance: 3 })],
        un1t_subscriptions: [], un1t_transactions: [], un1t_bookings: [], contact_memberships: [],
        un1t_write_events: [ledger({ un1t_user_id: 'u1', contact_id: 'c1', stage: 'done' })],
      })
      const out = await un1tOnlineReads.pipelineInputs(makeDb(w).db, HATCH, { now: NOW.getTime() })
      expect(out.data.snapshots.get('c1').glofox_membership_status).toBe('trial')
    })

    it('a failed ledger read fails the run: { success:false }, never a board built without the ledger', async () => {
      const { db } = makeDb(world(), { fail: ['un1t_write_events'] })
      expect(await un1tOnlineReads.pipelineInputs(db, HATCH, { now: NOW.getTime() }))
        .toEqual({ success: false, error: 'un1t_write_events boom' })
    })

    it('a studio with no linked client reads no ledger rows', async () => {
      const { db, log } = makeDb({})
      await un1tOnlineReads.pipelineInputs(db, HATCH)
      expect(log.some((q) => q.table === 'un1t_write_events')).toBe(false)
    })
  })

  describe('trialEligibility', () => {
    it('a new person is eligible', async () => {
      const { db } = makeDb(world())
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { un1tUserId: 'nobody', contactId: 'nobody' })).toEqual({ success: true, data: { eligible: true, reasons: [] } })
    })

    it('reads the person\'s transactions, subscriptions and the studio\'s FULL products map; a trial product keyed by id → trial_used', async () => {
      const { db, log } = makeDb(world())
      const out = await un1tOnlineReads.trialEligibility(db, HATCH, { un1tUserId: 'u1' })
      expect(out).toEqual({ success: true, data: { eligible: false, reasons: ['trial_used'] } })
      for (const q of log) expect(q.filters, q.table).toContainEqual(['eq', 'location_id', HATCH])
      const tx = log.find((q) => q.table === 'un1t_transactions')
      const subs = log.find((q) => q.table === 'un1t_subscriptions')
      expect(tx.filters).toContainEqual(['in', 'un1t_user_id', ['u1']])
      expect(subs.filters).toContainEqual(['in', 'un1t_user_id', ['u1']])
      // the products read is the whole studio's, not narrowed to this person's transactions
      expect(log.find((q) => q.table === 'un1t_products').filters).toEqual([['eq', 'location_id', HATCH]])
      expect(log.some((q) => q.table === 'contact_memberships')).toBe(false)
    })

    it('a €0 transaction whose product is not in the studio\'s products counts as a trial taken', async () => {
      const w = world({ un1t_transactions: [ctx({ product_id: 'deleted-upstream' })] })
      const { db } = makeDb(w)
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { un1tUserId: 'u1' })).toEqual({ success: true, data: { eligible: false, reasons: ['trial_used'] } })
    })

    it('history older than the freshness window still counts (stale subscription row → membership_history)', async () => {
      const w = world({ un1t_transactions: [], un1t_subscriptions: [csub({ un1t_id: 'old', status: 'canceled', synced_at: OLD }), csub({ un1t_user_id: 'u2', contact_id: 'c2', un1t_id: 's2' })] })
      const { db } = makeDb(w)
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { un1tUserId: 'u1' })).toEqual({ success: true, data: { eligible: false, reasons: ['membership_history'] } })
    })

    it('with a contactId: memberships at the studio from api and export sources, any status', async () => {
      const w = world({
        un1t_transactions: [], un1t_subscriptions: [],
        contact_memberships: [
          { id: 'm1', location_id: HATCH, contact_id: 'c1', source: 'un1t_online_export', status: 'active', ended_at: null },
          { id: 'm2', location_id: STILLORGAN, contact_id: 'c2', source: 'un1t_online_api', status: 'ended', ended_at: '2026-09-01T00:00:00Z' },
          { id: 'm3', location_id: HATCH, contact_id: 'c2', source: 'glofox', status: 'ended', ended_at: '2026-09-01T00:00:00Z' },
        ],
      })
      const { db, log } = makeDb(w)
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { contactId: 'c1' })).toEqual({ success: true, data: { eligible: false, reasons: ['membership_history'] } })
      // Stillorgan's row and a non-un1t source are not this studio's un1t.online history
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { contactId: 'c2' })).toEqual({ success: true, data: { eligible: true, reasons: [] } })
      const q = log.find((x) => x.table === 'contact_memberships')
      expect(q.filters).toContainEqual(['in', 'source', ['un1t_online_api', 'un1t_online_export']])
      expect(q.filters).toContainEqual(['eq', 'location_id', HATCH])
    })

    it('a contact-only call finds the trial through the contact\'s un1t accounts (contact-only → trial_used)', async () => {
      const { db, log } = makeDb(world({ contact_memberships: [], un1t_subscriptions: [] }))
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { contactId: 'c1' })).toEqual({ success: true, data: { eligible: false, reasons: ['trial_used'] } })
      const clientsQ = log.find((q) => q.table === 'un1t_clients')
      expect(clientsQ.filters).toEqual([['eq', 'location_id', HATCH], ['in', 'contact_id', ['c1']]])
    })

    it('a trial row with a null un1t_user_id but a matching contact_id denies', async () => {
      const w = world({
        un1t_clients: [], un1t_subscriptions: [], contact_memberships: [],
        un1t_transactions: [ctx({ un1t_user_id: null, contact_id: 'c1' })],
      })
      const { db } = makeDb(w)
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { contactId: 'c1' })).toEqual({ success: true, data: { eligible: false, reasons: ['trial_used'] } })
      // and another contact's userless row does not
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { contactId: 'c2' })).toEqual({ success: true, data: { eligible: true, reasons: [] } })
    })

    it('a contact with two accounts, the trial on the second → not eligible; a subscription on the second → membership_history', async () => {
      const w = world({
        un1t_clients: [client({ un1t_user_id: 'a1', contact_id: 'c1' }), client({ un1t_user_id: 'a2', contact_id: 'c1' }), client({ un1t_user_id: 'z', contact_id: 'c2' })],
        un1t_transactions: [ctx({ un1t_user_id: 'a2', contact_id: null })],
        un1t_subscriptions: [csub({ un1t_user_id: 'a2', contact_id: null, status: 'canceled' })],
        contact_memberships: [],
      })
      const { db } = makeDb(w)
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { contactId: 'c1' })).toEqual({ success: true, data: { eligible: false, reasons: ['trial_used', 'membership_history'] } })
      // passing the first account too unions the sets
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { un1tUserId: 'a1', contactId: 'c1' })).toMatchObject({ data: { eligible: false } })
      // another person is untouched
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { contactId: 'c2' })).toEqual({ success: true, data: { eligible: true, reasons: [] } })
    })

    it('a row found by both user id and contact id is counted once', async () => {
      const w = world({ un1t_subscriptions: [], contact_memberships: [], un1t_transactions: [ctx(), ctx({ un1t_id: 'x2', product_id: 'pack5', amount_cents: 6000, product_type: 'pack' })] })
      const { db } = makeDb(w)
      expect((await un1tOnlineReads.trialEligibility(db, HATCH, { un1tUserId: 'u1', contactId: 'c1' })).data.reasons).toEqual(['trial_used', 'paid_pack'])
    })

    it('a failed read → { success:false }, never eligible', async () => {
      for (const [table, ids] of [
        ['un1t_transactions', { un1tUserId: 'u1' }], ['un1t_subscriptions', { un1tUserId: 'u1' }],
        ['un1t_products', { un1tUserId: 'u1' }], ['contact_memberships', { contactId: 'c1' }],
        ['un1t_clients', { contactId: 'c1' }], ['un1t_transactions', { contactId: 'c1' }], ['un1t_subscriptions', { contactId: 'c1' }],
      ]) {
        const { db } = makeDb(world(), { fail: [table] })
        const out = await un1tOnlineReads.trialEligibility(db, HATCH, ids)
        expect(out, table).toEqual({ success: false, error: `${table} boom` })
        expect(out.data).toBeUndefined()
      }
    })

    it('neither id → { success:false } with no query', async () => {
      const { db, log } = makeDb(world())
      expect(await un1tOnlineReads.trialEligibility(db, HATCH)).toMatchObject({ success: false })
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, {})).toMatchObject({ success: false })
      expect(await un1tOnlineReads.trialEligibility(db, null, { un1tUserId: 'u1' })).toMatchObject({ success: false })
      expect(log).toHaveLength(0)
    })

    it('counts a sent or unknown ledger row as trial_used (a trial in flight or in doubt is used)', async () => {
      for (const stage of ['sent', 'unknown', 'done']) {
        for (const method of ['charge', 'free_checkout']) {
          const w = world({ un1t_transactions: [], un1t_subscriptions: [], contact_memberships: [], un1t_write_events: [ledger({ un1t_user_id: 'u1', stage, method })] })
          const out = await un1tOnlineReads.trialEligibility(makeDb(w).db, HATCH, { un1tUserId: 'u1' })
          expect(out, `${stage} ${method}`).toEqual({ success: true, data: { eligible: false, reasons: ['trial_used'] } })
        }
      }
    })

    it('a refused ledger row, another op, another person and another studio do not deny', async () => {
      const w = world({
        un1t_transactions: [], un1t_subscriptions: [], contact_memberships: [],
        un1t_write_events: [
          ledger({ un1t_user_id: 'u1', stage: 'refused' }),
          ledger({ un1t_user_id: 'u1', op: 'book', method: null, target: 'event-1', stage: 'done' }),
          ledger({ un1t_user_id: 'someone-else', stage: 'done' }),
          ledger({ un1t_user_id: 'u1', stage: 'done', location_id: STILLORGAN }),
        ],
      })
      expect(await un1tOnlineReads.trialEligibility(makeDb(w).db, HATCH, { un1tUserId: 'u1' })).toEqual({ success: true, data: { eligible: true, reasons: [] } })
    })

    it('finds the ledger trial through the contact\'s other un1t account', async () => {
      const w = world({
        un1t_clients: [client({ un1t_user_id: 'a1', contact_id: 'c1' }), client({ un1t_user_id: 'a2', contact_id: 'c1' })],
        un1t_transactions: [], un1t_subscriptions: [], contact_memberships: [],
        un1t_write_events: [ledger({ un1t_user_id: 'a2', stage: 'unknown' })],
      })
      const { db, log } = makeDb(w)
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { un1tUserId: 'a1', contactId: 'c1' }))
        .toEqual({ success: true, data: { eligible: false, reasons: ['trial_used'] } })
      expect(log.find((q) => q.table === 'un1t_write_events').filters).toContainEqual(['in', 'un1t_user_id', ['a1', 'a2']])
    })

    it('a CRM-created account not yet mirrored into un1t_clients: a ledger trial keyed by contact_id denies a contactId-only call', async () => {
      for (const stage of ['done', 'sent', 'unknown']) {
        const w = world({
          un1t_clients: [], un1t_transactions: [], un1t_subscriptions: [], contact_memberships: [],
          un1t_write_events: [ledger({ un1t_user_id: 'brand-new-account', contact_id: 'c1', stage })],
        })
        const { db, log } = makeDb(w)
        expect(await un1tOnlineReads.trialEligibility(db, HATCH, { contactId: 'c1' }), stage)
          .toEqual({ success: true, data: { eligible: false, reasons: ['trial_used'] } })
        const q = log.filter((x) => x.table === 'un1t_write_events').map((x) => x.filters.find((f) => f[1] === 'contact_id'))
        expect(q).toContainEqual(['in', 'contact_id', ['c1']])
      }
      // another contact's unmirrored account does not deny
      const other = world({
        un1t_clients: [], un1t_transactions: [], un1t_subscriptions: [], contact_memberships: [],
        un1t_write_events: [ledger({ un1t_user_id: 'brand-new-account', contact_id: 'c2', stage: 'done' })],
      })
      expect(await un1tOnlineReads.trialEligibility(makeDb(other).db, HATCH, { contactId: 'c1' })).toEqual({ success: true, data: { eligible: true, reasons: [] } })
    })

    it("a un1tUserId-only call also finds a ledger trial keyed by that account's contact (a second, unmirrored account)", async () => {
      const w = world({
        un1t_clients: [client({ un1t_user_id: 'a1', contact_id: 'c1' })],
        un1t_transactions: [], un1t_subscriptions: [], contact_memberships: [],
        un1t_write_events: [ledger({ un1t_user_id: 'brand-new-account', contact_id: 'c1', stage: 'done' })],
      })
      expect(await un1tOnlineReads.trialEligibility(makeDb(w).db, HATCH, { un1tUserId: 'a1' }))
        .toEqual({ success: true, data: { eligible: false, reasons: ['trial_used'] } })
    })

    it("a un1tUserId-only call widens to the person's sibling accounts: a trial row on a2 with a NULL contact_id still denies a1", async () => {
      const siblings = [client({ un1t_user_id: 'a1', contact_id: 'c1' }), client({ un1t_user_id: 'a2', contact_id: 'c1' })]
      for (const stage of ['done', 'sent', 'unknown']) {
        const w = world({
          un1t_clients: siblings, un1t_transactions: [], un1t_subscriptions: [], contact_memberships: [],
          un1t_write_events: [ledger({ un1t_user_id: 'a2', contact_id: null, stage })],
        })
        expect(await un1tOnlineReads.trialEligibility(makeDb(w).db, HATCH, { un1tUserId: 'a1' }), stage)
          .toEqual({ success: true, data: { eligible: false, reasons: ['trial_used'] } })
      }
    })

    it("a un1tUserId-only call reads the sibling account's transactions and subscriptions too", async () => {
      const siblings = [client({ un1t_user_id: 'a1', contact_id: 'c1' }), client({ un1t_user_id: 'a2', contact_id: 'c1' })]
      const w = world({
        un1t_clients: siblings, contact_memberships: [], un1t_write_events: [],
        un1t_transactions: [ctx({ un1t_user_id: 'a2', contact_id: null })],
        un1t_subscriptions: [csub({ un1t_user_id: 'a2', contact_id: null, status: 'canceled' })],
      })
      const { db, log } = makeDb(w)
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { un1tUserId: 'a1' }))
        .toEqual({ success: true, data: { eligible: false, reasons: ['trial_used', 'membership_history'] } })
      expect(log.find((q) => q.table === 'un1t_write_events').filters).toContainEqual(['in', 'un1t_user_id', ['a1', 'a2']])
    })

    it("a un1tUserId-only call does not widen to another person's accounts", async () => {
      const w = world({
        un1t_clients: [client({ un1t_user_id: 'a1', contact_id: 'c1' }), client({ un1t_user_id: 'z', contact_id: 'c2' })],
        un1t_transactions: [], un1t_subscriptions: [], contact_memberships: [],
        un1t_write_events: [ledger({ un1t_user_id: 'z', stage: 'done' })],
      })
      expect(await un1tOnlineReads.trialEligibility(makeDb(w).db, HATCH, { un1tUserId: 'a1' })).toEqual({ success: true, data: { eligible: true, reasons: [] } })
    })

    it("a failed read of the account's own un1t_clients row (for its contact) → { success:false }, never eligible", async () => {
      const { db } = makeDb(world(), { fail: ['un1t_clients'] })
      expect(await un1tOnlineReads.trialEligibility(db, HATCH, { un1tUserId: 'u1' })).toEqual({ success: false, error: 'un1t_clients boom' })
    })

    it('a row found by both user id and contact id is one trial (de-duplicated by ledger row)', async () => {
      const w = world({
        un1t_clients: [client({ un1t_user_id: 'a1', contact_id: 'c1' })],
        un1t_transactions: [], un1t_subscriptions: [], contact_memberships: [],
        un1t_write_events: [ledger({ un1t_user_id: 'a1', contact_id: 'c1', stage: 'done' })],
      })
      const { db } = makeDb(w)
      const out = await listLedgerTrials(db, HATCH, { un1tUserIds: ['a1'], contactIds: ['c1'] })
      expect(out.byUser.get('a1')).toHaveLength(1)
      expect(out.byContact.get('c1')).toHaveLength(1)
      expect(out.byContact.get('c1')[0]).toBe(out.byUser.get('a1')[0])
    })

    it('a failed ledger read → { success:false }, never eligible (it does not read as "no trial")', async () => {
      for (const ids of [{ un1tUserId: 'u1' }, { contactId: 'c1' }, { un1tUserId: 'u1', contactId: 'c1' }]) {
        const { db } = makeDb(world(), { fail: ['un1t_write_events'] })
        const out = await un1tOnlineReads.trialEligibility(db, HATCH, ids)
        expect(out).toEqual({ success: false, error: 'un1t_write_events boom' })
        expect(out.data).toBeUndefined()
      }
    })

    it('reads the ledger with the same studio and person scope as the other tables', async () => {
      const { db, log } = makeDb(world())
      await un1tOnlineReads.trialEligibility(db, HATCH, { un1tUserId: 'u1' })
      const q = log.find((x) => x.table === 'un1t_write_events')
      expect(q.filters).toContainEqual(['eq', 'location_id', HATCH])
      expect(q.filters).toContainEqual(['eq', 'op', 'trial'])
      expect(q.filters).toContainEqual(['in', 'stage', ['done', 'sent', 'unknown']])
    })
  })
})

// ---------------------------------------------------------------------------
// UN1TWRITE.9 — listLedgerTrials: the ledger's trial rows into A's ledgerTrials seam.
// ---------------------------------------------------------------------------
function ledger(over = {}) {
  return {
    id: `w-${Math.random().toString(36).slice(2)}`, location_id: HATCH, op: 'trial', un1t_user_id: 'u1', contact_id: null, target: 'trial',
    stage: 'done', method: 'charge', created_at: '2026-10-16T09:00:00Z', ...over,
  }
}

describe('listLedgerTrials', () => {
  it('reads only op trial rows in done, sent or unknown, paged past 1,000', async () => {
    const rows = [
      ...Array.from({ length: 1100 }, (_, i) => ledger({
        id: `w-${String(i).padStart(5, '0')}`, un1t_user_id: `user-${i}`, stage: ['done', 'sent', 'unknown'][i % 3],
        method: i % 2 ? 'charge' : 'free_checkout', created_at: `2026-10-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
      })),
      ledger({ id: 'w-refused', un1t_user_id: 'refused-user', stage: 'refused' }),
      ledger({ id: 'w-book', un1t_user_id: 'book-user', op: 'book', method: null, target: 'event-1' }),
      ledger({ id: 'w-other', un1t_user_id: 'other-studio-user', location_id: STILLORGAN }),
    ]
    const { db, log } = makeDb({ un1t_write_events: rows })
    const out = await listLedgerTrials(db, HATCH)
    expect(out.ok).toBe(true)
    expect(out.byUser.size).toBe(1100)
    expect(out.byUser.has('refused-user')).toBe(false)
    expect(out.byUser.has('book-user')).toBe(false)
    expect(out.byUser.has('other-studio-user')).toBe(false)

    const pages = log.filter((q) => q.table === 'un1t_write_events')
    expect(pages.map((q) => q.range)).toEqual([[0, 999], [1000, 1999]])
    for (const q of pages) {
      expect(q.cols).toBe('id, un1t_user_id, contact_id, target, stage, created_at')
      expect(q.orders[0]).toBe('created_at')
      expect(q.filters).toContainEqual(['eq', 'location_id', HATCH])
      expect(q.filters).toContainEqual(['eq', 'op', 'trial'])
      expect(q.filters).toContainEqual(['in', 'stage', ['done', 'sent', 'unknown']])
    }
  })

  it('pages with a unique tie-break after created_at, so equal timestamps never double-count or skip', async () => {
    const { db, log } = makeDb({ un1t_write_events: [ledger()] })
    await listLedgerTrials(db, HATCH)
    expect(log[0].orders).toEqual(['created_at', 'id'])
  })

  it('shapes each row as { at, product_id, stage } keyed by un1t user; both methods; a person with two rows keeps both', async () => {
    const { db } = makeDb({
      un1t_write_events: [
        ledger({ un1t_user_id: 'u1', target: 'trial', stage: 'unknown', method: 'charge', created_at: '2026-10-10T08:00:00Z' }),
        ledger({ un1t_user_id: 'u1', target: 'trial', stage: 'done', method: 'free_checkout', created_at: '2026-10-11T08:00:00Z' }),
        ledger({ un1t_user_id: 'u2', target: 'trial-b', stage: 'sent', method: 'charge', created_at: '2026-10-12T08:00:00Z' }),
      ],
    })
    const out = await listLedgerTrials(db, HATCH)
    expect(out.byUser.get('u1')).toEqual([
      { at: '2026-10-10T08:00:00Z', product_id: 'trial', stage: 'unknown' },
      { at: '2026-10-11T08:00:00Z', product_id: 'trial', stage: 'done' },
    ])
    expect(out.byUser.get('u2')).toEqual([{ at: '2026-10-12T08:00:00Z', product_id: 'trial-b', stage: 'sent' }])
  })

  it('stages narrows the read (the board asks for done only)', async () => {
    const { db, log } = makeDb({
      un1t_write_events: [ledger({ un1t_user_id: 'u1', stage: 'done' }), ledger({ un1t_user_id: 'u2', stage: 'sent' })],
    })
    const out = await listLedgerTrials(db, HATCH, { stages: ['done'] })
    expect([...out.byUser.keys()]).toEqual(['u1'])
    expect(log[0].filters).toContainEqual(['in', 'stage', ['done']])
  })

  it('un1tUserIds narrows to those people, de-duplicated, in .in() chunks of at most 150', async () => {
    const ids = Array.from({ length: 320 }, (_, i) => `user-${i}`)
    const { db, log } = makeDb({ un1t_write_events: [ledger({ un1t_user_id: 'user-300' }), ledger({ un1t_user_id: 'not-asked' })] })
    const out = await listLedgerTrials(db, HATCH, { un1tUserIds: [...ids, ...ids.slice(0, 10), null, ''] })
    expect(out.ok).toBe(true)
    expect([...out.byUser.keys()]).toEqual(['user-300'])
    const chunks = log.filter((q) => q.table === 'un1t_write_events').map((q) => q.filters.find((f) => f[0] === 'in' && f[1] === 'un1t_user_id')[2])
    expect(chunks.map((c) => c.length)).toEqual([150, 150, 20])
    expect(chunks.flat()).toEqual(ids)
  })

  it('contactIds are read too: chunked at 150, de-duplicated, byContact keyed by contact; a row with both keys is one object in both maps', async () => {
    const ids = Array.from({ length: 160 }, (_, i) => `contact-${i}`)
    const { db, log } = makeDb({ un1t_write_events: [
      ledger({ un1t_user_id: 'new-1', contact_id: 'contact-155' }),
      ledger({ un1t_user_id: 'u1', contact_id: 'contact-1' }),
      ledger({ un1t_user_id: 'u9', contact_id: 'not-asked' }),
    ] })
    const out = await listLedgerTrials(db, HATCH, { un1tUserIds: ['u1'], contactIds: [...ids, ids[0], null] })
    expect(out.ok).toBe(true)
    expect([...out.byContact.keys()].sort()).toEqual(['contact-1', 'contact-155'])
    expect([...out.byUser.keys()].sort()).toEqual(['new-1', 'u1'])
    expect(out.byUser.get('u1')[0]).toBe(out.byContact.get('contact-1')[0])
    const chunks = log.map((q) => q.filters.find((f) => f[0] === 'in' && f[1] === 'contact_id')?.[2]).filter(Boolean)
    expect(chunks.map((c) => c.length)).toEqual([150, 10])
  })

  it('contactIds alone narrows to those contacts; an empty contactIds with no user ids is an empty answer; a non-array is refused', async () => {
    const { db, log } = makeDb({ un1t_write_events: [ledger({ contact_id: 'c1' })] })
    expect((await listLedgerTrials(db, HATCH, { contactIds: [] })).byUser.size).toBe(0)
    expect(log).toHaveLength(0)
    expect(await listLedgerTrials(db, HATCH, { contactIds: 'c1' })).toMatchObject({ ok: false })
    expect([...(await listLedgerTrials(db, HATCH, { contactIds: ['c1'] })).byContact.keys()]).toEqual(['c1'])
  })

  it('an empty un1tUserIds list is an empty answer with no query; a non-array is refused, never widened to the studio', async () => {
    const { db, log } = makeDb({ un1t_write_events: [ledger()] })
    const empty = await listLedgerTrials(db, HATCH, { un1tUserIds: [] })
    expect(empty.ok).toBe(true)
    expect(empty.byUser.size).toBe(0)
    expect(await listLedgerTrials(db, HATCH, { un1tUserIds: 'u1' })).toMatchObject({ ok: false })
    expect(log).toHaveLength(0)
  })

  it('refuses a missing location without querying', async () => {
    const { db, log } = makeDb({ un1t_write_events: [ledger()] })
    expect(await listLedgerTrials(db, null)).toMatchObject({ ok: false })
    expect(log).toHaveLength(0)
  })

  it('a failed page is { ok:false, error }, never an empty map and never a throw', async () => {
    const { db } = makeDb({ un1t_write_events: [ledger()] }, { fail: ['un1t_write_events'] })
    const out = await listLedgerTrials(db, HATCH)
    expect(out).toEqual({ ok: false, error: 'un1t_write_events boom' })
    expect(out.byUser).toBeUndefined()
  })
})
