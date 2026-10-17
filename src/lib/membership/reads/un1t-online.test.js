// UN1TREAD.2 — the un1t.online reads: scoping, pagination, failure contract
// and return envelopes (each identical to the Glofox function it mirrors).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { logWarn } from '@/lib/log'
import { un1tOnlineReads, freshCutoff } from './un1t-online'

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
    const s = { filters: [], order: null, desc: false, range: null, cols: null, opts: null }
    const run = () => {
      log.push({ table, cols: s.cols, filters: s.filters, order: s.order, range: s.range, opts: s.opts })
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
      if (s.order) rows = [...rows].sort((a, b) => (s.desc ? -1 : 1) * String(a[s.order]).localeCompare(String(b[s.order])))
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
      order(c, o) { s.order = c; s.desc = o?.ascending === false; return api },
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
  it('implements six reads plus pastDue and paymentsFor, and deliberately no arrears', () => {
    expect(Object.keys(un1tOnlineReads).sort()).toEqual([...READS, 'pastDue', 'paymentsFor'].sort())
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
      productTitle: 'Unlimited', status: 'past_due', priceCents: 18900, currency: 'eur', interval: '1 month',
      periodEnd: '2026-11-01T00:00:00Z', cancelAtPeriodEnd: true, pausedUntil: '2026-11-15T00:00:00Z', pastDueAt: '2026-10-05T09:00:00Z',
    }])
    expect(out.data.transactions).toEqual([
      { at: '2026-10-01T09:00:00Z', productTitle: 'Unlimited', type: 'sub_initial', amountCents: 18900, currency: 'eur', refunded: true },
      { at: '2026-09-01T09:00:00Z', productTitle: 'Unlimited', type: 'sub_renewal', amountCents: 18900, currency: 'eur', refunded: false },
    ])
    expect(out.data.invoices.map((i) => i.at)).toEqual(['2026-10-01T10:00:00Z', '2026-09-01T10:00:00Z'])
    expect(out.data.pastDue).toMatchObject({ subscriptionId: 's1', since: '2026-10-01T10:00:00Z', amountCents: 18900 })
  })

  it('paymentsFor defaults to 25, and pastDue is null when nothing is owed', async () => {
    const txs = Array.from({ length: 30 }, (_, n) => ptx({ un1t_id: `t${n}`, remote_created_at: `2026-09-${String(n + 1).padStart(2, '0')}T09:00:00Z` }))
    const { db } = makeDb({ un1t_subscriptions: [psub()], un1t_invoices: [pinv({ status: 'paid' })], un1t_transactions: txs })
    const out = await un1tOnlineReads.paymentsFor(db, HATCH, ['c1'])
    expect(out.data.transactions).toHaveLength(25)
    expect(out.data.transactions[0].at).toBe('2026-09-30T09:00:00Z')
    expect(out.data.pastDue).toBeNull()
  })

  it('paymentsFor drops stale subscription and invoice rows', async () => {
    const { db } = makeDb({
      un1t_subscriptions: [psub(), psub({ un1t_id: 'old', product_title: 'Gone', synced_at: '2026-10-17T10:00:00.000Z' })],
      un1t_invoices: [pinv({ status: 'paid' }), pinv({ un1t_id: 'old-inv', status: 'open', synced_at: '2026-10-17T10:00:00.000Z' })],
    })
    const out = await un1tOnlineReads.paymentsFor(db, HATCH, ['c1'])
    expect(out.data.subscriptions.map((s) => s.productTitle)).toEqual(['Unlimited'])
    expect(out.data.invoices).toHaveLength(1)
    expect(out.data.pastDue).toBeNull()
  })

  it('paymentsFor with no contacts succeeds with empty lists and no query', async () => {
    const { db, log } = makeDb(base())
    const out = await un1tOnlineReads.paymentsFor(db, HATCH, [])
    expect(out).toEqual({ success: true, data: { subscriptions: [], transactions: [], invoices: [], pastDue: null } })
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
    expect(out.data.invoices[0]).toEqual({ at: '2026-10-03T10:00:00Z', status: 'open', rawStatus: 'Past_Due', amountCents: 18900, currency: 'eur' })
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
