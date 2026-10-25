// UN1TRADAR.1 — the un1t.online radar I/O: scope, pagination, chunking,
// freshness and the failure contract.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { logInfo } from '@/lib/log'
import { radarMembers, winbackContacts, leadContacts, radarPastDue, arrears } from './un1t-online-radar'
import { un1tOnlineReads } from './un1t-online'

const HATCH = 'loc-hatch'
const STILLORGAN = 'loc-stillorgan'
const NOW = Date.parse('2026-10-18T12:00:00.000Z')
const SYNCED = '2026-10-18T11:50:00.000Z'
const STALE = '2026-09-01T00:00:00.000Z'
const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString()

// A recording, in-memory supabase fake. Any write method throws, so a test
// fails loudly if the radar ever writes.
function makeDb(seed = {}, { fail = [] } = {}) {
  const log = []
  function builder(table) {
    const s = { filters: [], orders: [], desc: false, range: null, cols: null }
    const run = () => {
      log.push({ table, cols: s.cols, filters: s.filters, orders: s.orders, range: s.range })
      if (fail.includes(table)) return { data: null, error: { message: `${table} boom` } }
      let rows = (seed[table] || []).filter((r) => s.filters.every(([k, c, v]) => {
        if (k === 'eq') return r[c] === v
        if (k === 'in') return v.includes(r[c])
        if (k === 'gt') return r[c] != null && r[c] > v
        if (k === 'gte') return r[c] != null && String(r[c]) >= String(v)
        if (k === 'lte') return r[c] != null && String(r[c]) <= String(v)
        if (k === 'lt') return r[c] != null && String(r[c]) < String(v)
        return true
      }))
      if (s.orders.length) {
        rows = [...rows].sort((a, b) => {
          for (const c of s.orders) {
            const d = String(a[c]).localeCompare(String(b[c]))
            if (d !== 0) return (s.desc ? -1 : 1) * d
          }
          return 0
        })
      }
      if (s.range) rows = rows.slice(s.range[0], s.range[1] + 1)
      return { data: rows.map((r) => ({ ...r })), error: null }
    }
    const no = (m) => () => { throw new Error(`write: ${m} on ${table}`) }
    const api = {
      select(cols) { s.cols = cols; return api },
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      in(c, v) { s.filters.push(['in', c, v]); return api },
      gt(c, v) { s.filters.push(['gt', c, v]); return api },
      gte(c, v) { s.filters.push(['gte', c, v]); return api },
      lte(c, v) { s.filters.push(['lte', c, v]); return api },
      lt(c, v) { s.filters.push(['lt', c, v]); return api },
      order(c, o) { if (!s.orders.length) s.desc = o?.ascending === false; s.orders.push(c); return api },
      range(a, b) { s.range = [a, b]; return api },
      insert: no('insert'), update: no('update'), delete: no('delete'), upsert: no('upsert'),
      then(res, rej) { return Promise.resolve().then(run).then(res, rej) },
    }
    return api
  }
  return { db: { from: (t) => builder(t) }, log }
}

let n = 0
const id = () => `id-${String(++n).padStart(6, '0')}`
const sub = (over = {}) => ({
  id: id(), location_id: HATCH, un1t_id: `s${n}`, un1t_user_id: 'u1', contact_id: 'c1', status: 'active',
  product_title: 'Hatch plan', price_cents: 12000, billing_interval: 'month', billing_interval_count: 1,
  current_period_end: '2026-11-01T00:00:00Z', cancel_at_period_end: false, paused_at: null, paused_until: null,
  past_due_at: null, remote_created_at: '2026-08-20T00:00:00Z', synced_at: SYNCED, ...over,
})
const client = (over = {}) => ({
  id: id(), location_id: HATCH, un1t_user_id: 'u1', contact_id: 'c1', credit_balance: 0, credit_unlimited: false,
  last_attended_at: iso(NOW - 20 * DAY), bookings_30d_attended: 3, bookings_30d_no_show: 0, ltv_cents: 1000,
  remote_created_at: '2026-08-19T00:00:00Z', synced_at: SYNCED, ...over,
})
const contact = (over = {}) => ({ id: 'c1', name: 'Alex', email: 'alex@example.com', phone: null, lead_source: null, location_id: STILLORGAN, joined_at: null, created_at: '2026-08-01T00:00:00Z', ...over })

function seed(extra = {}) {
  return {
    un1t_subscriptions: [sub(), sub({ location_id: STILLORGAN, un1t_user_id: 'x', contact_id: 'cx' })],
    un1t_clients: [client(), client({ location_id: STILLORGAN, un1t_user_id: 'x', contact_id: 'cx' })],
    un1t_transactions: [
      { id: id(), location_id: HATCH, un1t_user_id: 'u1', type: 'sub_renewal', product_type: 'subscription', amount_cents: 12000, refunded: false, remote_created_at: '2026-10-01T00:00:00Z' },
      { id: id(), location_id: HATCH, un1t_user_id: 'u1', type: 'sub_renewal', product_type: 'subscription', amount_cents: 12000, refunded: true, remote_created_at: '2026-10-10T00:00:00Z' },
    ],
    un1t_products: [],
    un1t_events: [{ id: id(), location_id: HATCH, un1t_id: 'e1', starts_at: iso(NOW - 2 * DAY) }],
    un1t_bookings: [{ id: id(), location_id: HATCH, un1t_user_id: 'u1', contact_id: 'c1', event_id: 'e1', status: 'attended', remote_created_at: iso(NOW - 3 * DAY) }],
    contacts: [contact(), contact({ id: 'cx', name: 'Other' })],
    contact_studios: [],
    un1t_write_events: [],
    ...extra,
  }
}

beforeEach(() => { vi.clearAllMocks(); n = 0 })

describe('radarMembers', () => {
  it('builds rows from Hatch rows only', async () => {
    const { db } = makeDb(seed())
    const rows = await radarMembers(db, HATCH, { nowMs: NOW })
    expect(rows.map((r) => r.id)).toEqual(['c1'])
    expect(rows[0]).toMatchObject({
      name: 'Alex', glofox_membership_status: 'member', total_attended_7d: 1, total_bookings_30d: 1,
      last_payment_at: '2026-10-01T00:00:00Z', last_booked_at: iso(NOW - 3 * DAY),
    })
  })

  it('every un1t_* query filters location_id = L and reads only', async () => {
    const { db, log } = makeDb(seed())
    await radarMembers(db, HATCH, { nowMs: NOW })
    const un1t = log.filter((q) => q.table.startsWith('un1t_'))
    expect(un1t.length).toBeGreaterThan(0)
    for (const q of un1t) expect(q.filters).toContainEqual(['eq', 'location_id', HATCH])
    // contacts are read by id, never by location
    for (const q of log.filter((x) => x.table === 'contacts')) {
      expect(q.filters.some(([k, c]) => k === 'in' && c === 'id')).toBe(true)
      expect(q.cols).toBe('id, name')
    }
  })

  it('every list read is ordered and ranged', async () => {
    const { db, log } = makeDb(seed())
    await radarMembers(db, HATCH, { nowMs: NOW })
    for (const q of log) {
      expect(q.orders.length).toBeGreaterThan(0)
      expect(q.range).not.toBeNull()
    }
  })

  it('radarMembers pages past 1000 clients', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `u${i}`)
    const { db, log } = makeDb(seed({
      un1t_subscriptions: many.map((u) => sub({ un1t_user_id: u, contact_id: `c-${u}` })),
      un1t_clients: many.map((u) => client({ un1t_user_id: u, contact_id: `c-${u}` })),
      contacts: many.map((u) => contact({ id: `c-${u}`, name: u })),
    }))
    const rows = await radarMembers(db, HATCH, { nowMs: NOW })
    expect(rows).toHaveLength(1001)
    const clientPages = log.filter((q) => q.table === 'un1t_clients').map((q) => q.range)
    expect(clientPages).toEqual([[0, 999], [1000, 1999]])
  })

  it('bookings read chunks event ids at 200', async () => {
    const events = Array.from({ length: 450 }, (_, i) => ({ id: id(), location_id: HATCH, un1t_id: `e${i}`, starts_at: iso(NOW - DAY) }))
    const { db, log } = makeDb(seed({ un1t_events: events }))
    await radarMembers(db, HATCH, { nowMs: NOW })
    const chunks = log.filter((q) => q.table === 'un1t_bookings' && q.filters.some(([k, c]) => k === 'in' && c === 'event_id'))
    expect(chunks.map((q) => q.filters.find(([k, c]) => k === 'in' && c === 'event_id')[2].length)).toEqual([200, 200, 50])
    for (const q of chunks) expect(q.filters).toContainEqual(['eq', 'location_id', HATCH])
  })

  it('contact ids are read in chunks of at most 300', async () => {
    const many = Array.from({ length: 650 }, (_, i) => `u${i}`)
    const { db, log } = makeDb(seed({
      un1t_subscriptions: many.map((u) => sub({ un1t_user_id: u, contact_id: `c-${u}` })),
      un1t_clients: many.map((u) => client({ un1t_user_id: u, contact_id: `c-${u}` })),
      contacts: many.map((u) => contact({ id: `c-${u}`, name: u })),
    }))
    await radarMembers(db, HATCH, { nowMs: NOW })
    const sizes = log.filter((q) => q.table === 'contacts').map((q) => q.filters.find(([k]) => k === 'in')[2].length)
    expect(sizes).toEqual([300, 300, 50])
  })

  it('a refunded payment is not the last payment', async () => {
    const { db } = makeDb(seed())
    const [row] = await radarMembers(db, HATCH, { nowMs: NOW })
    // the 10 Oct renewal was refunded; the 1 Oct one stands
    expect(row.last_payment_at).toBe('2026-10-01T00:00:00Z')
  })

  it('reaching the hard cap fails instead of returning a truncated radar', async () => {
    const big = Array.from({ length: 50_000 }, (_, i) => ({ id: `b${String(i).padStart(6, '0')}`, location_id: HATCH, un1t_user_id: 'u1', contact_id: 'c1', event_id: 'e0', status: 'booked', remote_created_at: '2026-10-01T00:00:00Z' }))
    const { db } = makeDb(seed({ un1t_bookings: big }))
    await expect(radarMembers(db, HATCH, { nowMs: NOW })).rejects.toThrow(/refusing a truncated radar/)
  })

  // last_booked_at reads un1t_bookings from now - 400 days only (never the
  // studio's whole booking history): 399 days counts, 401 does not.
  it('last_booked_at looks back 400 days: a booking at 399 days counts, 401 does not', async () => {
    const at = (days) => [{ id: id(), location_id: HATCH, un1t_user_id: 'u1', contact_id: 'c1', event_id: 'old', status: 'attended', remote_created_at: iso(NOW - days * DAY) }]
    const in399 = await radarMembers(makeDb(seed({ un1t_bookings: at(399) })).db, HATCH, { nowMs: NOW })
    expect(in399[0].last_booked_at).toBe(iso(NOW - 399 * DAY))
    const in401 = await radarMembers(makeDb(seed({ un1t_bookings: at(401) })).db, HATCH, { nowMs: NOW })
    expect(in401[0].last_booked_at).toBeNull()
    const { db, log } = makeDb(seed())
    await radarMembers(db, HATCH, { nowMs: NOW })
    const q = log.find((x) => x.table === 'un1t_bookings' && x.cols === 'un1t_user_id, contact_id, remote_created_at')
    expect(q.filters).toContainEqual(['gte', 'remote_created_at', iso(NOW - 400 * DAY)])
    expect(q.orders).toEqual(['id'])
    expect(q.range).not.toBeNull()
  })

  it('events are read for the 30-day window only', async () => {
    const { db, log } = makeDb(seed())
    await radarMembers(db, HATCH, { nowMs: NOW })
    const ev = log.find((q) => q.table === 'un1t_events')
    expect(ev.filters).toContainEqual(['gte', 'starts_at', iso(NOW - 30 * DAY)])
    expect(ev.filters).toContainEqual(['lte', 'starts_at', iso(NOW)])
  })

  it('radarMembers drops a subscription older than freshCutoff', async () => {
    const { db } = makeDb(seed({
      un1t_subscriptions: [sub(), sub({ un1t_user_id: 'u2', contact_id: 'c2', synced_at: STALE })],
      un1t_clients: [client(), client({ un1t_user_id: 'u2', contact_id: 'c2' })],
      contacts: [contact(), contact({ id: 'c2' })],
    }))
    const rows = await radarMembers(db, HATCH, { nowMs: NOW })
    expect(rows.map((r) => r.id)).toEqual(['c1'])
  })

  it('radarMembers keeps all rows when the sync stalled', async () => {
    // freshCutoff is relative to the newest synced_at, never the clock
    const { db } = makeDb(seed({
      un1t_subscriptions: [sub({ synced_at: STALE }), sub({ un1t_user_id: 'u2', contact_id: 'c2', synced_at: STALE })],
      un1t_clients: [client(), client({ un1t_user_id: 'u2', contact_id: 'c2' })],
      contacts: [contact(), contact({ id: 'c2' })],
    }))
    const rows = await radarMembers(db, HATCH, { nowMs: NOW })
    expect(rows.map((r) => r.id).sort()).toEqual(['c1', 'c2'])
  })

  it('no subscription rows at all → no members, no subscription list read', async () => {
    const { db } = makeDb(seed({ un1t_subscriptions: [] }))
    expect(await radarMembers(db, HATCH, { nowMs: NOW })).toEqual([])
  })

  it('a failed page throws (never an empty radar)', async () => {
    for (const table of ['un1t_subscriptions', 'un1t_clients', 'un1t_bookings', 'un1t_events', 'contacts', 'un1t_transactions']) {
      const { db } = makeDb(seed(), { fail: [table] })
      await expect(radarMembers(db, HATCH, { nowMs: NOW })).rejects.toThrow()
    }
  })

  it('build log carries counts and locationId only', async () => {
    const { db } = makeDb(seed())
    await radarMembers(db, HATCH, { nowMs: NOW })
    expect(logInfo).toHaveBeenCalledWith('churn-radar', 'un1t radar built', { locationId: HATCH, members: 1, packHolders: 0, unlinkedClients: 0 })
  })

  it('is registered on un1tOnlineReads', () => {
    expect(un1tOnlineReads.radarMembers).toBe(radarMembers)
    expect(un1tOnlineReads.winbackContacts).toBe(winbackContacts)
    expect(un1tOnlineReads.leadContacts).toBe(leadContacts)
  })
})

describe('winbackContacts', () => {
  it('adds an ex-member from a stale-active row and an ended membership row, Hatch only', async () => {
    const { db, log } = makeDb(seed({
      un1t_subscriptions: [sub(), sub({ un1t_user_id: 'u2', contact_id: 'c2', synced_at: STALE })],
      un1t_clients: [client(), client({ un1t_user_id: 'u2', contact_id: 'c2', last_attended_at: iso(NOW - 60 * DAY) })],
      // ORGCONTACTS.7 (mig 770): ex-members are relationship rows with an ended membership at THIS studio
      contact_studios: [
        { id: id(), location_id: HATCH, contact_id: 'c3', membership_plan: 'Old plan', membership_status: 'ended', membership_since: '2026-01-01T00:00:00Z', membership_ended_at: '2026-08-01T00:00:00Z' },
        { id: id(), location_id: STILLORGAN, contact_id: 'c4', membership_plan: 'Glofox', membership_status: 'ended', membership_since: '2026-01-01T00:00:00Z', membership_ended_at: '2026-08-01T00:00:00Z' },
        { id: id(), location_id: HATCH, contact_id: 'c5', membership_plan: null, membership_status: null, membership_since: null, membership_ended_at: null },
      ],
      contacts: [contact(), contact({ id: 'c2', name: 'Bea' }), contact({ id: 'c3', name: 'Cal' }), contact({ id: 'c4' })],
    }))
    const rows = await winbackContacts(db, HATCH, { nowMs: NOW })
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId.c1.glofox_membership_status).toBe('member')
    expect(byId.c2).toMatchObject({ glofox_membership_status: 'ex_member', name: 'Bea' })
    expect(byId.c3).toMatchObject({ glofox_membership_status: 'ex_member', glofox_membership_plan: 'Old plan', name: 'Cal' })
    expect(byId.c4).toBeUndefined()
    expect(byId.c5).toBeUndefined()
    const cm = log.find((q) => q.table === 'contact_studios')
    expect(cm.filters).toContainEqual(['eq', 'location_id', HATCH])
    expect(cm.filters).toContainEqual(['eq', 'membership_status', 'ended'])
    expect(log.some((q) => q.table === 'contact_memberships')).toBe(false)
  })

  it('a failed read throws', async () => {
    const { db } = makeDb(seed(), { fail: ['contact_studios'] })
    await expect(winbackContacts(db, HATCH, { nowMs: NOW })).rejects.toThrow()
  })
})

describe('leadContacts', () => {
  it('lists a un1t lead from the pipeline snapshot and an owned contact with no client', async () => {
    const { db } = makeDb(seed({
      un1t_subscriptions: [],
      un1t_clients: [client({ last_attended_at: iso(NOW - 5 * DAY) })],
      contacts: [
        contact({ glofox_membership_status: 'member' }), // a Stillorgan member: a Hatch lead
        contact({ id: 'own', name: 'Owned', location_id: HATCH, lead_source: 'form', created_at: '2026-10-10T00:00:00Z' }),
      ],
    }))
    const rows = await leadContacts(db, HATCH, { nowMs: NOW })
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId.c1).toMatchObject({ glofox_membership_status: 'lead', email: 'alex@example.com', last_booked_at: iso(NOW - 3 * DAY) })
    expect(byId.own).toMatchObject({ glofox_membership_status: 'lead', joined_at: '2026-10-10T00:00:00Z', lead_source: 'form' })
  })

  it('leadContacts last_booked_at looks back 400 days: 399 counts, 401 does not', async () => {
    const run = async (days) => {
      const { db } = makeDb(seed({
        un1t_subscriptions: [],
        un1t_clients: [client({ last_attended_at: null })],
        un1t_bookings: [{ id: id(), location_id: HATCH, un1t_user_id: 'u1', contact_id: 'c1', event_id: 'old', status: 'attended', remote_created_at: iso(NOW - days * DAY) }],
        contacts: [contact({ glofox_membership_status: 'member' })],
      }))
      const rows = await leadContacts(db, HATCH, { nowMs: NOW })
      return rows.find((r) => r.id === 'c1')?.last_booked_at ?? null
    }
    expect(await run(399)).toBe(iso(NOW - 399 * DAY))
    expect(await run(401)).toBeNull()
  })

  it('leadContacts throws when pipelineInputs returns success:false', async () => {
    // un1t_products is read only by pipelineInputs here, which answers success:false on it
    const { db } = makeDb(seed(), { fail: ['un1t_products'] })
    await expect(leadContacts(db, HATCH, { nowMs: NOW })).rejects.toThrow()
  })

  it('an owned contact whose only client row is stale is not listed as a lead', async () => {
    const { db } = makeDb(seed({
      un1t_subscriptions: [],
      un1t_clients: [client(), client({ un1t_user_id: 'old', contact_id: 'own', synced_at: STALE })],
      contacts: [contact(), contact({ id: 'own', location_id: HATCH })],
    }))
    const rows = await leadContacts(db, HATCH, { nowMs: NOW })
    expect(rows.map((r) => r.id)).not.toContain('own')
  })

  it('owned contacts are read by location; everything else by id', async () => {
    const { db, log } = makeDb(seed({ un1t_subscriptions: [] }))
    await leadContacts(db, HATCH, { nowMs: NOW })
    const byLocation = log.filter((q) => q.table === 'contacts' && q.filters.some(([k, c]) => k === 'eq' && c === 'location_id'))
    expect(byLocation.length).toBe(1)
    expect(byLocation[0].filters).toContainEqual(['eq', 'location_id', HATCH])
  })
})

// UN1TRADAR.2 — arrears from spec A's pastDue (un1t_invoices + subscriptions).
describe('radarPastDue and arrears', () => {
  const pdSeed = (extra = {}) => seed({
    un1t_subscriptions: [
      sub({ un1t_id: 's1', status: 'past_due', past_due_at: '2026-10-01T00:00:00Z', price_cents: 12000 }),
      sub({ un1t_id: 's2', un1t_user_id: 'u2', contact_id: 'c2', price_cents: 9000 }),
    ],
    un1t_invoices: [
      { id: id(), location_id: HATCH, un1t_id: 'i9', un1t_user_id: 'u2', contact_id: 'c2', subscription_id: 's2', status: 'open', amount_cents: 9000, currency: 'eur', remote_created_at: '2026-10-05T00:00:00Z', synced_at: SYNCED },
    ],
    ...extra,
  })

  it('folds past-due rows: a flagged sub with no invoice is an estimate at its price; an open invoice is exact', async () => {
    const { db } = makeDb(pdSeed())
    const f = await radarPastDue(db, HATCH, { nowMs: NOW })
    expect(f.membershipById.get('c1')).toEqual({ amountCents: 12000, count: 1, oldestDueAt: '2026-10-01T00:00:00Z', amountEstimated: true })
    expect(f.membershipById.get('c2')).toEqual({ amountCents: 9000, count: 1, oldestDueAt: '2026-10-05T00:00:00Z' })
    expect(f.unavailable).toEqual(['unpaidCharges', 'awaitingAuth'])
    expect(f.profileById.get('c1').last_attended_at).toBe(client().last_attended_at)
  })

  it('every read is location-scoped', async () => {
    const { db, log } = makeDb(pdSeed())
    await radarPastDue(db, HATCH, { nowMs: NOW })
    for (const q of log) expect(q.filters).toContainEqual(['eq', 'location_id', HATCH])
  })

  it('radarPastDue throws on success:false (never "nobody owes")', async () => {
    const { db } = makeDb(pdSeed(), { fail: ['un1t_invoices'] })
    await expect(radarPastDue(db, HATCH, { nowMs: NOW })).rejects.toThrow()
  })

  it('arrears has fetchArrearsSummary\'s envelope, plus estimated', async () => {
    const { db } = makeDb(pdSeed())
    expect(await arrears(db, HATCH)).toEqual({ success: true, data: { totalCents: 21000, memberCount: 2, estimated: true } })
    const { db: bad } = makeDb(pdSeed(), { fail: ['un1t_invoices'] })
    expect(await arrears(bad, HATCH)).toMatchObject({ success: false })
  })

  it('un1tOnlineReads exposes radarPastDue, arrears and pinArrears true', () => {
    expect(un1tOnlineReads.radarPastDue).toBe(radarPastDue)
    expect(un1tOnlineReads.arrears).toBe(arrears)
    expect(un1tOnlineReads.pinArrears).toBe(true)
  })
})
