// REVPAY.3 — the Revolut pending-order reconcile: selection (window, backoff,
// budget) and the per-domain apply through the webhooks' own helpers.
//
// The DB is a small in-memory fake that understands the filters the lists and
// the car compare-and-set use. Every helper the webhooks share (race, class
// booking, trial, offer, donation) is mocked so each test pins only what this
// module decides: which rows, which helper, which side effect, how often.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/orders', () => ({ syncOrderFromCarDeposit: vi.fn(async () => {}) }))
vi.mock('@/lib/contact-events', () => ({
  emitEvent: vi.fn(async () => {}),
  EVENT_TYPES: { ORDER_COMPLETED: 'order.completed', ORDER_FAILED: 'order.failed', ORDER_ABANDONED: 'order.abandoned' },
}))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForOrderStatus: vi.fn(async () => {}) }))
vi.mock('@/lib/race-payments', () => ({
  resolveRacePaymentByProviderRef: vi.fn(),
  markRacePaymentStatus: vi.fn(),
}))
vi.mock('@/lib/race-payment-completed', () => ({ runRacePaymentCompletedEffects: vi.fn() }))
vi.mock('@/lib/class-booking-payments', () => ({
  resolveClassBookingPaymentByRef: vi.fn(),
  markClassBookingPaymentStatus: vi.fn(),
}))
vi.mock('@/lib/trial-purchase-payments', () => ({
  resolveTrialPurchaseByRef: vi.fn(),
  markTrialPurchasePaymentStatus: vi.fn(),
}))
vi.mock('@/lib/sale-offers', () => ({
  resolveOfferPurchaseByOrderId: vi.fn(),
  markOfferPurchaseState: vi.fn(),
}))
vi.mock('@/lib/offer-purchase-paid', () => ({ runOfferPaidSideEffects: vi.fn(async () => {}) }))
vi.mock('@/lib/donation-payments', () => ({
  DONATION_COLS: 'id, status',
  DONATION_EVENT_COLS: 'id, charity',
  resolveDonationByRef: vi.fn(),
  markDonationPaymentStatus: vi.fn(),
  runPaidDonationSideEffects: vi.fn(async () => ({})),
}))
vi.mock('@/lib/charity-donations', () => ({ resolveCharitySettings: () => ({ match_multiplier: 2 }) }))
vi.mock('@/lib/qstash', () => ({
  publishQueuePush: vi.fn(async () => {}),
  CLASS_BOOKINGS_WORKER_PATH: '/w/class-bookings',
  TRIAL_PURCHASES_WORKER_PATH: '/w/trial-purchases',
}))

import {
  isDue, selectBatch, stableHash, runRevolutReconcile,
  RECONCILE_TICK_MS, RECONCILE_MIN_AGE_MS, RECONCILE_MAX_AGE_MS,
} from './revolut-reconcile'
import { syncOrderFromCarDeposit } from '@/lib/orders'
import { resolveRacePaymentByProviderRef, markRacePaymentStatus } from '@/lib/race-payments'
import { runRacePaymentCompletedEffects } from '@/lib/race-payment-completed'
import { resolveClassBookingPaymentByRef, markClassBookingPaymentStatus } from '@/lib/class-booking-payments'
import { resolveTrialPurchaseByRef, markTrialPurchasePaymentStatus } from '@/lib/trial-purchase-payments'
import { resolveOfferPurchaseByOrderId, markOfferPurchaseState } from '@/lib/sale-offers'
import { runOfferPaidSideEffects } from '@/lib/offer-purchase-paid'
import { resolveDonationByRef, markDonationPaymentStatus, runPaidDonationSideEffects } from '@/lib/donation-payments'

const NOW = new Date('2026-10-25T12:00:00Z')
const ago = (ms, now = NOW) => new Date(now.getTime() - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN

// ── In-memory DB ─────────────────────────────────────────────────────────────
function makeDb(tables = {}, { failList = [] } = {}) {
  const data = Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]))
  const updates = []
  function from(table) {
    const b = { _op: 'select', _filters: [], _range: null, _payload: null, _returning: false }
    const matches = () => (data[table] || []).filter((r) => b._filters.every(([k, c, v]) => {
      if (k === 'eq') return r[c] === v
      if (k === 'is') return v === null ? r[c] == null : r[c] === v
      if (k === 'notnull') return r[c] != null
      if (k === 'gte') return r[c] != null && r[c] >= v
      if (k === 'lte') return r[c] != null && r[c] <= v
      return true
    }))
    const run = (single) => {
      if (b._op === 'select' && failList.includes(table) && !single) {
        return Promise.resolve({ data: null, error: { code: '57014', message: 'timeout' } })
      }
      if (b._op === 'update') {
        const hit = matches()
        for (const r of hit) Object.assign(r, b._payload)
        updates.push({ table, payload: b._payload, rows: hit.length })
        return Promise.resolve({ data: b._returning ? hit.map((r) => ({ id: r.id })) : null, error: null })
      }
      const rows = matches()
      if (single) return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null })
      const out = b._range ? rows.slice(b._range[0], b._range[1] + 1) : rows
      return Promise.resolve({ data: out.map((r) => ({ ...r })), error: null })
    }
    b.select = () => { if (b._op === 'update') b._returning = true; return b }
    b.update = (p) => { b._op = 'update'; b._payload = p; return b }
    b.eq = (c, v) => { b._filters.push(['eq', c, v]); return b }
    b.is = (c, v) => { b._filters.push(['is', c, v]); return b }
    b.not = (c, op, v) => { if (op === 'is' && v === null) b._filters.push(['notnull', c]); return b }
    b.gte = (c, v) => { b._filters.push(['gte', c, v]); return b }
    b.lte = (c, v) => { b._filters.push(['lte', c, v]); return b }
    b.order = () => b
    b.range = (a, z) => { b._range = [a, z]; return b }
    b.maybeSingle = () => run(true)
    b.then = (resolve, reject) => run(false).then(resolve, reject)
    return b
  }
  return { from, _data: data, _updates: updates }
}

const car = (id, over = {}) => ({
  id, location_id: 'loc-ccf', deposit_status: 'terms_accepted', deposit_paid_at: null,
  deposit_revolut_order_id: `ord-${id}`, deposit_terms_accepted_at: ago(30 * MIN), buyer_email: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Pure selection ──────────────────────────────────────────────────────────
describe('isDue — the window and the age-based backoff', () => {
  const nowMs = NOW.getTime()
  it('never inside the first 10 minutes, never past 7 days', () => {
    expect(isDue({ id: 'a', createdAtMs: nowMs - (RECONCILE_MIN_AGE_MS - 1), nowMs })).toBe(false)
    expect(isDue({ id: 'a', createdAtMs: nowMs - (RECONCILE_MAX_AGE_MS + 1), nowMs })).toBe(false)
    expect(isDue({ id: 'a', createdAtMs: Number.NaN, nowMs })).toBe(false)
  })
  it('every tick while under 2 hours old', () => {
    for (let t = 0; t < 8; t++) {
      const at = nowMs + t * RECONCILE_TICK_MS
      expect(isDue({ id: 'young', createdAtMs: at - 30 * MIN, nowMs: at })).toBe(true)
    }
  })
  it('one tick in 4 between 2 hours and a day; one in 24 up to a week', () => {
    const dueCount = (age, ticks) => {
      let n = 0
      for (let t = 0; t < ticks; t++) {
        const at = nowMs + t * RECONCILE_TICK_MS
        if (isDue({ id: 'row-1', createdAtMs: at - age, nowMs: at })) n++
      }
      return n
    }
    expect(dueCount(5 * HOUR, 4)).toBe(1)
    expect(dueCount(5 * HOUR, 40)).toBe(10)
    expect(dueCount(3 * 24 * HOUR, 24)).toBe(1)
    expect(dueCount(3 * 24 * HOUR, 72)).toBe(3)
  })
  it('the hash is stable and spreads ids', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'))
    const buckets = new Set(Array.from({ length: 40 }, (_, i) => stableHash(`id-${i}`) % 4))
    expect(buckets.size).toBe(4)
  })
})

describe('selectBatch — budget and order', () => {
  const nowMs = NOW.getTime()
  it('takes due rows oldest first, at most the budget, and counts the rest', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ domain: 'race_payment', id: `r${i}`, ref: `o${i}`, createdAt: ago((20 + i) * MIN) }))
    const { batch, due, overBudget } = selectBatch(rows, nowMs, 3)
    expect(due).toBe(7)
    expect(overBudget).toBe(4)
    expect(batch.map((r) => r.id)).toEqual(['r6', 'r5', 'r4'])
  })
  it('skips a row with no provider ref', () => {
    expect(selectBatch([{ domain: 'donation', id: 'd', ref: null, createdAt: ago(20 * MIN) }], nowMs).batch).toEqual([])
  })
  it('a backlog of forever-pending rows rotates: every row is reached, none blocks the queue', () => {
    // 120 abandoned checkouts, all ~5 h old: more than two budgets' worth.
    const rows = Array.from({ length: 120 }, (_, i) => ({ domain: 'race_payment', id: `stuck-${i}`, ref: `o${i}`, createdAt: ago(5 * HOUR) }))
    const seen = new Set()
    for (let t = 0; t < 4; t++) {
      const at = nowMs + t * RECONCILE_TICK_MS
      const shifted = rows.map((r) => ({ ...r, createdAt: new Date(Date.parse(r.createdAt) + t * RECONCILE_TICK_MS).toISOString() }))
      const { batch } = selectBatch(shifted, at, 50)
      expect(batch.length).toBeLessThanOrEqual(50)
      for (const r of batch) seen.add(r.id)
    }
    expect(seen.size).toBe(120)
  })
})

// ── Runs ───────────────────────────────────────────────────────────────────
describe('runRevolutReconcile — car deposits (the real webhook helpers)', () => {
  it('pending → completed applies once: the car is paid and the orders sync runs once', async () => {
    const db = makeDb({ cars: [car('c1')] })
    const getOrder = vi.fn(async () => ({ state: 'completed', amount: 50000 }))
    const first = await runRevolutReconcile({ db, now: NOW, getOrder })
    expect(first.healthy).toBe(true)
    expect(first.counts).toMatchObject({ checked: 1, settled: 1, provider_calls: 1 })
    expect(db._data.cars[0]).toMatchObject({ deposit_status: 'paid', deposit_paid_amount: 500 })
    expect(typeof db._data.cars[0].deposit_paid_at).toBe('string')
    expect(syncOrderFromCarDeposit).toHaveBeenCalledTimes(1)

    // The next tick: the car left the pending set, so nothing is asked again.
    const second = await runRevolutReconcile({ db, now: new Date(NOW.getTime() + RECONCILE_TICK_MS), getOrder })
    expect(second.counts.candidates).toBe(0)
    expect(getOrder).toHaveBeenCalledTimes(1)
    expect(syncOrderFromCarDeposit).toHaveBeenCalledTimes(1)
  })

  it('still pending at Revolut → the row is left alone', async () => {
    const db = makeDb({ cars: [car('c1')] })
    const r = await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'pending' }) })
    expect(r.counts).toMatchObject({ checked: 1, still_pending: 1, settled: 0 })
    expect(db._updates).toHaveLength(0)
    expect(db._data.cars[0].deposit_status).toBe('terms_accepted')
  })

  it('the webhook settling the car mid-call wins: the compare-and-set writes nothing and no side effect runs', async () => {
    const db = makeDb({ cars: [car('c1')] })
    const getOrder = vi.fn(async () => {
      db._data.cars[0].deposit_status = 'paid' // the webhook lands while Revolut answers us
      return { state: 'completed', amount: 50000 }
    })
    const r = await runRevolutReconcile({ db, now: NOW, getOrder })
    expect(r.counts).toMatchObject({ checked: 1, not_applied: 1, settled: 0 })
    expect(db._updates[0].rows).toBe(0)
    expect(syncOrderFromCarDeposit).not.toHaveBeenCalled()
  })

  it('outside the window (5 min old, or 8 days old) is never listed', async () => {
    const db = makeDb({ cars: [
      car('young', { deposit_terms_accepted_at: ago(5 * MIN) }),
      car('old', { deposit_terms_accepted_at: ago(8 * 24 * HOUR) }),
      car('paid', { deposit_status: 'paid' }),
    ] })
    const getOrder = vi.fn()
    const r = await runRevolutReconcile({ db, now: NOW, getOrder })
    expect(r.counts.candidates).toBe(0)
    expect(getOrder).not.toHaveBeenCalled()
  })
})

describe('runRevolutReconcile — provider failures, budget, list failures', () => {
  it('a getOrder failure is skipped, the next row still runs, and the run stays healthy', async () => {
    const db = makeDb({ cars: [car('c1', { deposit_terms_accepted_at: ago(40 * MIN) }), car('c2')] })
    const getOrder = vi.fn(async (ref) => {
      if (ref === 'ord-c1') throw Object.assign(new Error('Revolut API 503'), { name: 'RevolutError', status: 503 })
      return { state: 'completed', amount: 50000 }
    })
    const r = await runRevolutReconcile({ db, now: NOW, getOrder })
    expect(r.healthy).toBe(true)
    expect(r.counts).toMatchObject({ checked: 2, provider_failed: 1, settled: 1, errors: 0 })
    expect(db._data.cars.find((c) => c.id === 'c1').deposit_status).toBe('terms_accepted')
    expect(db._data.cars.find((c) => c.id === 'c2').deposit_status).toBe('paid')
  })

  it('every provider call failing is not a healthy run (a revoked key must page)', async () => {
    const db = makeDb({ cars: [car('c1')] })
    const r = await runRevolutReconcile({ db, now: NOW, getOrder: async () => { throw new Error('REVOLUT_API_KEY is not configured') } })
    expect(r.healthy).toBe(false)
    expect(r.counts.provider_failed).toBe(1)
  })

  it('a 404 about one order is skipped but does not page; a 401 does', async () => {
    const db = makeDb({ cars: [car('c1')] })
    const notFound = await runRevolutReconcile({ db, now: NOW, getOrder: async () => { throw Object.assign(new Error('Order not found'), { status: 404 }) } })
    expect(notFound).toMatchObject({ healthy: true, counts: { provider_failed: 1 } })
    const unauthorised = await runRevolutReconcile({ db, now: NOW, getOrder: async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }) } })
    expect(unauthorised.healthy).toBe(false)
  })

  it('nothing due is a healthy run', async () => {
    const r = await runRevolutReconcile({ db: makeDb({}), now: NOW, getOrder: vi.fn() })
    expect(r).toMatchObject({ healthy: true, counts: { candidates: 0, checked: 0 } })
  })

  it('the budget caps provider calls a tick, oldest first', async () => {
    const cars = Array.from({ length: 70 }, (_, i) => car(`c${String(i).padStart(2, '0')}`, { deposit_terms_accepted_at: ago((20 + i) * MIN) }))
    const db = makeDb({ cars })
    const getOrder = vi.fn(async () => ({ state: 'pending' }))
    const r = await runRevolutReconcile({ db, now: NOW, getOrder, budget: 50 })
    expect(getOrder).toHaveBeenCalledTimes(50)
    expect(r.counts).toMatchObject({ candidates: 70, due: 70, checked: 50, over_budget: 20 })
    expect(getOrder.mock.calls[0][0]).toBe('ord-c69')
  })

  it('an unreadable list is not healthy, and the other domains still run', async () => {
    const db = makeDb({ cars: [car('c1')] }, { failList: ['donations'] })
    const r = await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'completed', amount: 1 }) })
    expect(r.healthy).toBe(false)
    expect(r.counts.list_failed).toEqual(['donation'])
    expect(r.counts.settled).toBe(1)
  })

  it('a row that throws is counted and never stops the run', async () => {
    const db = makeDb({
      race_payments: [{ id: 'rp1', status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'ord-rp1', created_at: ago(40 * MIN) }],
      cars: [car('c1')],
    })
    resolveRacePaymentByProviderRef.mockRejectedValue(new Error('boom'))
    const r = await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'completed', amount: 50000 }) })
    expect(r.counts).toMatchObject({ errors: 1, settled: 1 })
    expect(r.healthy).toBe(true)
  })
})

describe('runRevolutReconcile — race payments', () => {
  const rp = (over = {}) => ({ id: 'rp1', status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'ord-rp1', created_at: ago(30 * MIN), ...over })

  it('a Stripe Connect payment is never listed or asked about', async () => {
    const db = makeDb({ race_payments: [rp({ payment_provider: 'stripe_connect' })] })
    const getOrder = vi.fn()
    const r = await runRevolutReconcile({ db, now: NOW, getOrder })
    expect(r.counts.candidates).toBe(0)
    expect(getOrder).not.toHaveBeenCalled()
    expect(resolveRacePaymentByProviderRef).not.toHaveBeenCalled()
  })

  it('a fresh completion runs the webhook side effects once and waits for the Glofox push', async () => {
    const db = makeDb({ race_payments: [rp()] })
    const payment = rp({ kind: 'entry' })
    resolveRacePaymentByProviderRef.mockResolvedValue(payment)
    markRacePaymentStatus.mockResolvedValue({ applied: { status: 'completed' }, state_changed: true })
    let pushed = false
    runRacePaymentCompletedEffects.mockResolvedValue({ confirmations: {}, glofoxPush: () => new Promise((res) => setTimeout(() => { pushed = true; res() }, 0)) })
    const r = await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'COMPLETED', amount: 5000 }) })
    expect(markRacePaymentStatus).toHaveBeenCalledWith(expect.objectContaining({ payment, revolutState: 'completed', revolutAmount: 5000 }))
    expect(runRacePaymentCompletedEffects).toHaveBeenCalledTimes(1)
    expect(runRacePaymentCompletedEffects).toHaveBeenCalledWith(expect.objectContaining({ payment, applied: { status: 'completed' } }))
    expect(pushed).toBe(true)
    expect(r.counts.settled).toBe(1)
  })

  it('a failed status write is an error, never a settle, and runs no side effects', async () => {
    const db = makeDb({ race_payments: [rp()] })
    resolveRacePaymentByProviderRef.mockResolvedValue(rp())
    markRacePaymentStatus.mockResolvedValue({ applied: null, state_changed: false, error: { message: 'write failed' } })
    const r = await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'completed' }) })
    expect(runRacePaymentCompletedEffects).not.toHaveBeenCalled()
    expect(r.counts).toMatchObject({ errors: 1, settled: 0 })
  })

  it('resolves through the throwing read, so a failed read is an error, not "already settled"', async () => {
    const db = makeDb({ race_payments: [rp()] })
    resolveRacePaymentByProviderRef.mockResolvedValue(rp())
    markRacePaymentStatus.mockResolvedValue({ applied: null })
    await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'pending' }) })
    expect(resolveRacePaymentByProviderRef).toHaveBeenCalledWith(db, 'ord-rp1', { throwOnError: true })
  })

  it('the webhook already completed it (mark applies nothing) → no side effects', async () => {
    const db = makeDb({ race_payments: [rp()] })
    resolveRacePaymentByProviderRef.mockResolvedValue(rp())
    markRacePaymentStatus.mockResolvedValue({ applied: null, state_changed: false })
    const r = await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'completed' }) })
    expect(runRacePaymentCompletedEffects).not.toHaveBeenCalled()
    expect(r.counts.not_applied).toBe(1)
  })

  it('the row moved since listing → skipped before any provider call', async () => {
    const db = makeDb({ race_payments: [rp()] })
    resolveRacePaymentByProviderRef.mockResolvedValue(rp({ status: 'completed' }))
    const getOrder = vi.fn()
    const r = await runRevolutReconcile({ db, now: NOW, getOrder })
    expect(getOrder).not.toHaveBeenCalled()
    expect(r.counts.already_settled).toBe(1)
  })
})

describe('runRevolutReconcile — class bookings and trials', () => {
  it('a paid class booking is released through the webhook helper and nudged with its dedup id', async () => {
    const row = { id: 'cb1', status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'ord-cb1', created_at: ago(30 * MIN) }
    const db = makeDb({ class_booking_requests: [row] })
    resolveClassBookingPaymentByRef.mockResolvedValue(row)
    markClassBookingPaymentStatus.mockResolvedValue({ released: true })
    const publish = vi.fn(async () => {})
    const r = await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'completed', amount: 1500 }), publish })
    expect(markClassBookingPaymentStatus).toHaveBeenCalledWith(expect.objectContaining({ request: row, providerState: 'completed', providerAmount: 1500 }))
    expect(publish).toHaveBeenCalledWith({ path: '/w/class-bookings', body: { id: 'cb1' }, deduplicationId: 'class-booking-cb1' })
    expect(r.counts.settled).toBe(1)
  })

  it('a trial still pending is not released and not nudged', async () => {
    const row = { id: 't1', status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'ord-t1', created_at: ago(30 * MIN) }
    const db = makeDb({ trial_purchases: [row, { ...row, id: 't2', payment_provider: 'un1t_online', payment_provider_ref: 'u-2' }] })
    resolveTrialPurchaseByRef.mockResolvedValue(row)
    markTrialPurchasePaymentStatus.mockResolvedValue({ released: false })
    const publish = vi.fn()
    const r = await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'processing' }), publish })
    expect(r.counts).toMatchObject({ candidates: 1, still_pending: 1 })
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('runRevolutReconcile — offers and donations', () => {
  it('an offer is marked with the compare-and-set and its paid side effects run once', async () => {
    const row = { id: 'op1', state: 'created', revolut_order_id: 'ord-op1', created_at: ago(30 * MIN) }
    const db = makeDb({ offer_purchases: [row] })
    resolveOfferPurchaseByOrderId.mockResolvedValue(row)
    markOfferPurchaseState.mockResolvedValue({ changed: true, state: 'paid' })
    await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'completed' }) })
    expect(markOfferPurchaseState).toHaveBeenCalledWith(expect.objectContaining({ purchase: row, providerState: 'completed', casOnState: true }))
    expect(runOfferPaidSideEffects).toHaveBeenCalledTimes(1)
  })

  it('an offer the webhook settled first gets no second receipt', async () => {
    const row = { id: 'op1', state: 'created', revolut_order_id: 'ord-op1', created_at: ago(30 * MIN) }
    const db = makeDb({ offer_purchases: [row] })
    resolveOfferPurchaseByOrderId.mockResolvedValue(row)
    markOfferPurchaseState.mockResolvedValue({ changed: false, state: 'created' })
    const r = await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'completed' }) })
    expect(runOfferPaidSideEffects).not.toHaveBeenCalled()
    expect(r.counts.not_applied).toBe(1)
  })

  it('a paid donation is marked, re-read, and its side effects run as the winning observer', async () => {
    const row = { id: 'd1', status: 'awaiting_payment', payment_provider: 'revolut', payment_provider_ref: 'ord-d1', race_event_id: 'ev1', created_at: ago(30 * MIN) }
    const db = makeDb({ donations: [row], race_events: [{ id: 'ev1', charity: {} }] })
    resolveDonationByRef.mockResolvedValue(row)
    markDonationPaymentStatus.mockImplementation(async () => {
      db._data.donations[0].status = 'paid'
      return { status: 'paid', changed: true }
    })
    const r = await runRevolutReconcile({ db, now: NOW, getOrder: async () => ({ state: 'completed', amount: 2000 }) })
    expect(markDonationPaymentStatus).toHaveBeenCalledWith(expect.objectContaining({ providerState: 'completed', providerAmount: 2000, multiplier: 2 }))
    expect(runPaidDonationSideEffects).toHaveBeenCalledTimes(1)
    expect(runPaidDonationSideEffects).toHaveBeenCalledWith(expect.objectContaining({ observerWon: true, donation: expect.objectContaining({ status: 'paid' }) }))
    expect(r.counts.settled).toBe(1)
  })

  it('a Stripe donation is never listed', async () => {
    const db = makeDb({ donations: [{ id: 'd1', status: 'awaiting_payment', payment_provider: 'stripe_connect', payment_provider_ref: 'cs_1', created_at: ago(30 * MIN) }] })
    const getOrder = vi.fn()
    await runRevolutReconcile({ db, now: NOW, getOrder })
    expect(getOrder).not.toHaveBeenCalled()
  })
})
