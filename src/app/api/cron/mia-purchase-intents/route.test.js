// MIAHATCH.6 (Task 23) — the mirror-only watcher cron. The real settle module
// runs against a recording fake db; un1t.online is never called: the member
// reader and the live entitlement read are spies that must stay untouched, and
// the write primitives are fakes. Fictional ids only (the repo is public).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null, send: null, refund: null, book: null }))

vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/un1t-online-write-ops', async () => {
  const { fakeUn1tWrite } = await import('@/lib/agent/un1t-fakes.test-helpers')
  const { vi: v } = await import('vitest')
  h.book = v.fn(async () => ({ verdict: 'done', sent: true, id: 'bk-1' }))
  return fakeUn1tWrite({ book: h.book })['@/lib/un1t-online-write-ops']()
})
vi.mock('@/lib/agent/un1t-member-read', async (importOriginal) => ({
  ...(await importOriginal()),
  openUn1tMemberReader: vi.fn(async () => ({ ok: false, reason: 'read_failed' })),
  fetchLiveEntitlement: vi.fn(async () => ({ ok: true, balance: 99, unlimited: true, liveSubscriptionIds: ['sub-live'] })),
}))
vi.mock('@/lib/agent/notify', async (importOriginal) => {
  const { vi: v } = await import('vitest')
  h.send = v.fn(async () => ({ sent: true }))
  return { ...(await importOriginal()), sendAgentThreadMessage: h.send }
})
vi.mock('@/lib/un1t-online-approval', async (importOriginal) => {
  const { vi: v } = await import('vitest')
  h.refund = v.fn(async () => ({ approvalId: 'appr-double-1' }))
  return { ...(await importOriginal()), fileRefundCard: h.refund }
})
vi.mock('@/lib/agent/settings-resolve', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveAgentSettings: async () => ({ ok: true, settings: { booking_mode: 'auto' } }),
}))
vi.mock('@/lib/agent/approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))
// The real settle functions, wrapped so a test can make one throw.
vi.mock('@/lib/agent/purchase-settle', async (importOriginal) => {
  const actual = await importOriginal()
  const { vi: v } = await import('vitest')
  return {
    ...actual,
    settlePurchaseIntent: v.fn(actual.settlePurchaseIntent),
    markStuckPaidIntent: v.fn(actual.markStuckPaidIntent),
    recheckDoublePayment: v.fn(actual.recheckDoublePayment),
    expireStaleIntents: v.fn(actual.expireStaleIntents),
  }
})

const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { openUn1tMemberReader, fetchLiveEntitlement } = await import('@/lib/agent/un1t-member-read')
const settle = await import('@/lib/agent/purchase-settle')
const { GET } = await import('./route.js')

const HATCH = 'a1000000-0000-0000-0000-000000000002'
const CONTACT = 'c1000000-0000-0000-0000-000000000002'
const USER = 'u-test-1'
const PRODUCT = 'prod-pack-10'
const NOW = Date.parse('2026-10-20T09:00:00Z')
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const intentId = (n) => `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SNAP0 = Object.freeze({ ok: true, balance: 0, unlimited: false, live_subscription_ids: [] })

const intent = (n, over = {}) => ({
  id: intentId(n), location_id: HATCH, contact_id: CONTACT, conversation_id: `conv-${n}`, channel: 'whatsapp',
  un1t_user_id: `${USER}-${n}`, un1t_product_id: PRODUCT, product_title: '10 Class Pack', status: 'link_sent',
  entitlement_snapshot: SNAP0, event_un1t_id: null, class_name: null, class_time: null, starts_at: null, outcome: null,
  created_at: iso(NOW - 60 * MIN), expires_at: iso(NOW + 60 * MIN), paid_detected_at: null, ...over,
})
const tx = (n, over = {}) => ({
  location_id: HATCH, un1t_id: `tx-${n}`, un1t_user_id: USER, product_id: PRODUCT, product_title: '10 Class Pack',
  type: 'one_time', amount_cents: 12500, remote_created_at: iso(NOW - 10 * MIN), ...over,
})

// A recording fake db: .eq/.in/.gt/.gte/.lt/.lte filter, .order sorts, .range caps.
// `fail[table][op]` answers a PostgREST error.
function fakeDb(tables = {}, { fail = {} } = {}) {
  const data = {
    locations: [{ id: HATCH, timezone: 'Europe/Dublin' }],
    mia_purchase_intents: [], un1t_transactions: [], un1t_clients: [], un1t_subscriptions: [], un1t_events: [],
    agent_membership_requests: [], class_bookings: [],
    ...tables,
  }
  const calls = []
  let next = 1
  const from = (table) => {
    const st = { op: 'select', filters: [], orders: [], limit: null, single: false, row: null, patch: null, returning: false }
    const pick = (rows) => rows.filter((r) => st.filters.every((f) => f(r)))
    const finish = () => {
      calls.push({ table, op: st.op })
      if (fail[table]?.[st.op]) return { data: null, error: { message: 'fictional failure', code: 'XX000' } }
      if (st.op === 'insert') {
        const id = `90000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
        data[table] = [...(data[table] || []), { id, ...st.row }]
        return { data: st.single ? { id } : [{ id }], error: null }
      }
      if (st.op === 'update') {
        const hit = pick(data[table] || [])
        for (const r of hit) Object.assign(r, st.patch)
        return { data: st.returning ? hit.map((r) => ({ id: r.id })) : null, error: null }
      }
      let rows = pick(data[table] || [])
      for (const [col, asc] of [...st.orders].reverse()) {
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
      }
      if (st.limit != null) rows = rows.slice(0, st.limit)
      return { data: st.single ? (rows[0] ?? null) : rows, error: null }
    }
    const b = {
      select: () => { if (st.op !== 'select') st.returning = true; return b },
      insert: (row) => { st.op = 'insert'; st.row = row; return b },
      update: (patch) => { st.op = 'update'; st.patch = patch; return b },
      eq: (c, v) => { st.filters.push((r) => r[c] === v); return b },
      in: (c, vs) => { st.filters.push((r) => vs.includes(r[c])); return b },
      gt: (c, v) => { st.filters.push((r) => r[c] != null && r[c] > v); return b },
      gte: (c, v) => { st.filters.push((r) => r[c] != null && r[c] >= v); return b },
      lt: (c, v) => { st.filters.push((r) => r[c] != null && r[c] < v); return b },
      lte: (c, v) => { st.filters.push((r) => r[c] != null && r[c] <= v); return b },
      contains: (c, obj) => { st.filters.push((r) => Object.entries(obj).every(([k, v]) => r[c]?.[k] === v)); return b },
      order: (c, { ascending = true } = {}) => { st.orders.push([c, ascending]); return b },
      range: (a, z) => { st.limit = z - a + 1; return b },
      limit: (n) => { st.limit = n; return b },
      maybeSingle: () => { st.single = true; return b },
      single: () => { st.single = true; return b },
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return b
  }
  return { db: { from }, data, calls }
}

const call = (auth = 'Bearer cron-secret') => GET(new Request('https://crm.test/api/cron/mia-purchase-intents', { headers: auth ? { authorization: auth } : {} }))
const install = (...args) => {
  const f = fakeDb(...args)
  h.db = f.db
  return f
}
const ZERO = Object.freeze({
  settled: {}, stuck_marked: 0, double_payment_cards: 0, expired: 0, errors: 0,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 'cron-secret'
})
afterEach(() => { vi.useRealTimers() })

describe('GET /api/cron/mia-purchase-intents', () => {
  it('401 without the secret', async () => {
    const { calls } = install()
    expect((await call(null)).status).toBe(401)
    expect((await call('Bearer wrong')).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await call('Bearer undefined')).status).toBe(401)
    expect(calls).toHaveLength(0)
    expect(settle.settlePurchaseIntent).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an empty run is a few cheap reads, healthy, and stamps zeros', async () => {
    const { calls } = install()
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, data: ZERO })
    expect(stampHeartbeat).toHaveBeenCalledWith('mia-purchase-intents', ZERO)
    // live list, stuck list, recent-settled list, expiry read: nothing else.
    expect(calls).toEqual([
      { table: 'mia_purchase_intents', op: 'select' },
      { table: 'mia_purchase_intents', op: 'select' },
      { table: 'mia_purchase_intents', op: 'select' },
      { table: 'mia_purchase_intents', op: 'select' },
    ])
  })

  it('settles each live intent from the mirror, never opens a un1t reader', async () => {
    const paidUser = `${USER}-1`
    const { data } = install({
      mia_purchase_intents: [intent(1), intent(2), intent(3, { status: 'booked', paid_detected_at: iso(NOW - 3 * 24 * 60 * MIN) })],
      un1t_transactions: [tx(1, { un1t_user_id: paidUser })],
    })
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(settle.settlePurchaseIntent).toHaveBeenCalledTimes(2)
    for (const [, id, opts] of settle.settlePurchaseIntent.mock.calls) {
      expect([intentId(1), intentId(2)]).toContain(id)
      expect(opts).toMatchObject({ detectedBy: 'watcher', source: 'mirror' })
    }
    // Intent 1: the mirror dates a purchase inside its window -> paid, no class -> no_class, one message.
    expect(data.mia_purchase_intents[0]).toMatchObject({ status: 'no_class', detected_by: 'watcher' })
    expect(h.send).toHaveBeenCalledTimes(1)
    // Intent 2: nothing in the mirror (the live read would say paid: never asked).
    expect(data.mia_purchase_intents[1].status).toBe('link_sent')
    expect(openUn1tMemberReader).not.toHaveBeenCalled()
    expect(fetchLiveEntitlement).not.toHaveBeenCalled()
    expect(h.book).not.toHaveBeenCalled()
    expect(body.data.settled).toEqual({ paid_no_class: 1, not_paid: 1 })
  })

  it('one intent throwing does not stop the rest', async () => {
    install({
      mia_purchase_intents: [
        intent(1), intent(2), intent(3),
        intent(4, { status: 'paid', paid_detected_at: iso(NOW - 20 * MIN) }),
        intent(5, { status: 'paid', paid_detected_at: iso(NOW - 25 * MIN) }),
      ],
    })
    settle.settlePurchaseIntent.mockImplementationOnce(async () => { throw new TypeError('fictional') })
    settle.markStuckPaidIntent.mockImplementationOnce(async () => { throw new TypeError('fictional') })
    const res = await call()
    expect(res.status).toBe(200)
    expect(settle.settlePurchaseIntent).toHaveBeenCalledTimes(3)
    expect(settle.markStuckPaidIntent).toHaveBeenCalledTimes(2)
    const body = await res.json()
    expect(body.data).toMatchObject({ settled: { not_paid: 2 }, stuck_marked: 1, errors: 2 })
    expect(settle.expireStaleIntents).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('a settle that answers error is counted, and the run still completes', async () => {
    install({ mia_purchase_intents: [intent(1), intent(2)] })
    settle.settlePurchaseIntent.mockImplementationOnce(async () => ({ outcome: 'error', sent: false }))
    const body = await (await call()).json()
    expect(body.data).toMatchObject({ settled: { error: 1, not_paid: 1 }, errors: 1 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('pages the live list under the row cap with an explicit order', async () => {
    const many = Array.from({ length: 1203 }, (_, i) => intent(i + 1))
    install({ mia_purchase_intents: many })
    const body = await (await call()).json()
    expect(settle.settlePurchaseIntent).toHaveBeenCalledTimes(1203)
    expect(new Set(settle.settlePurchaseIntent.mock.calls.map((c) => c[1])).size).toBe(1203)
    expect(body.data.settled).toEqual({ not_paid: 1203 })
  })

  it('carry A: an intent stuck in paid for over 10 minutes is closed book_failed with one card, never rebooked', async () => {
    const { data } = install({
      mia_purchase_intents: [
        intent(1, { status: 'paid', paid_detected_at: iso(NOW - 15 * MIN), outcome: { source: 'mirror' } }),
        intent(2, { status: 'paid', paid_detected_at: iso(NOW - 5 * MIN), outcome: { source: 'mirror' } }),
      ],
    })
    const body = await (await call()).json()
    expect(settle.markStuckPaidIntent).toHaveBeenCalledTimes(1)
    expect(settle.markStuckPaidIntent).toHaveBeenCalledWith(expect.anything(), intentId(1), { code: 'watcher_stuck_paid', now: NOW })
    expect(data.mia_purchase_intents[0]).toMatchObject({ status: 'book_failed' })
    expect(data.mia_purchase_intents[0].outcome).toMatchObject({ result: 'paid_booking_failed', error: { code: 'watcher_stuck_paid' } })
    expect(data.mia_purchase_intents[1].status).toBe('paid')
    expect(data.agent_membership_requests.filter((r) => r.status === 'pending')).toHaveLength(1)
    expect(h.book).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    expect(body.data.stuck_marked).toBe(1)
  })

  it('carry B: a double payment that lands after the settle files ONE card; a repeat run is a no-op', async () => {
    const user = `${USER}-1`
    const { data } = install({
      mia_purchase_intents: [
        intent(1, { status: 'booked', paid_detected_at: iso(NOW - 60 * MIN), outcome: { source: 'mirror', result: 'paid_booked' } }),
        // Settled two days ago: outside the re-check window.
        intent(2, { status: 'booked', paid_detected_at: iso(NOW - 48 * 60 * MIN), created_at: iso(NOW - 49 * 60 * MIN) }),
        // Its card is already on the outcome: not asked again.
        intent(3, { status: 'no_class', paid_detected_at: iso(NOW - 30 * MIN), outcome: { double_payment: { transaction_ids: ['tx-a', 'tx-b'], approval_id: 'appr-old' } } }),
      ],
      un1t_transactions: [
        tx(1, { un1t_user_id: user }), tx(2, { un1t_user_id: user, remote_created_at: iso(NOW - 2 * MIN) }),
        tx(3, { un1t_user_id: `${USER}-2` }), tx(4, { un1t_user_id: `${USER}-2` }),
        tx(5, { un1t_user_id: `${USER}-3` }), tx(6, { un1t_user_id: `${USER}-3` }),
      ],
    })
    const body = await (await call()).json()
    expect(settle.recheckDoublePayment.mock.calls.map((c) => c[1]).sort()).toEqual([intentId(1), intentId(3)])
    expect(h.refund).toHaveBeenCalledTimes(1)
    expect(h.refund).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reason: 'double_payment', originRef: intentId(1), transactionIds: ['tx-1', 'tx-2'], locationId: HATCH,
    }))
    expect(data.mia_purchase_intents[0].status).toBe('booked')
    expect(data.mia_purchase_intents[0].outcome).toMatchObject({ result: 'paid_booked', double_payment: { approval_id: 'appr-double-1' } })
    expect(body.data.double_payment_cards).toBe(1)
    expect(h.send).not.toHaveBeenCalled()

    vi.clearAllMocks()
    const again = await (await call()).json()
    expect(h.refund).not.toHaveBeenCalled()
    expect(again.data.double_payment_cards).toBe(0)
  })

  it('expires stale intents (after settling them from the mirror)', async () => {
    const { data } = install({
      mia_purchase_intents: [intent(1, { created_at: iso(NOW - 25 * 60 * MIN), expires_at: iso(NOW - 60 * MIN) })],
    })
    const body = await (await call()).json()
    expect(data.mia_purchase_intents[0].status).toBe('expired')
    expect(body.data).toMatchObject({ settled: { expired: 1 }, expired: 1 })
    expect(settle.expireStaleIntents).toHaveBeenCalledWith(expect.anything(), { now: NOW })
    expect(h.send).not.toHaveBeenCalled()
    // Settle first, expire last.
    expect(settle.settlePurchaseIntent.mock.invocationCallOrder[0]).toBeLessThan(settle.expireStaleIntents.mock.invocationCallOrder[0])
  })

  it('stamps the heartbeat with counts only (no ids, no PII)', async () => {
    install({
      mia_purchase_intents: [
        intent(1), intent(2, { status: 'paid', paid_detected_at: iso(NOW - 20 * MIN) }),
        intent(3, { created_at: iso(NOW - 25 * 60 * MIN), expires_at: iso(NOW - 60 * MIN) }),
      ],
      un1t_transactions: [tx(1, { un1t_user_id: `${USER}-1` })],
    })
    await call()
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    const [name, outcome] = stampHeartbeat.mock.calls[0]
    expect(name).toBe('mia-purchase-intents')
    expect(Object.keys(outcome).sort()).toEqual(['double_payment_cards', 'errors', 'expired', 'settled', 'stuck_marked'])
    const flat = JSON.stringify(outcome)
    for (const needle of [HATCH, CONTACT, USER, PRODUCT, 'conv-', 'tx-', '80000000', 'appr-']) expect(flat).not.toContain(needle)
    const numbers = [...Object.values(outcome.settled), ...Object.entries(outcome).filter(([k]) => k !== 'settled').map(([, v]) => v)]
    for (const v of numbers) expect(Number.isInteger(v)).toBe(true)
    expect(outcome).toMatchObject({ settled: { paid_no_class: 1, expired: 1 }, stuck_marked: 1, expired: 1 })
  })

  it('a list that cannot be read: every other step still runs, a 500 with the counts, no stamp', async () => {
    install({ mia_purchase_intents: [intent(1)] }, { fail: { mia_purchase_intents: { select: true } } })
    const res = await call()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.data.errors).toBeGreaterThanOrEqual(3)
    expect(settle.expireStaleIntents).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an expiry sweep that failed is counted and leaves the heartbeat unstamped', async () => {
    install()
    settle.expireStaleIntents.mockImplementationOnce(async () => ({ expired: 2, error: true }))
    const res = await call()
    expect(res.status).toBe(500)
    expect((await res.json()).data).toMatchObject({ expired: 2, errors: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
