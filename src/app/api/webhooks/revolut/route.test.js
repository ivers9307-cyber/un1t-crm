// Route-level tests for the Revolut Merchant webhook receiver — the
// highest-consequence handler in the app (it flips a car's deposit to PAID
// off an inbound HTTP call). Revolut sends ORDER_AUTHORISED then
// ORDER_COMPLETED, and retries any delivery on a non-2xx, so the contract
// that matters is: **a re-delivery is a no-op and a terminal state is never
// reset**. These tests pin that contract.
//
// Two layers:
//   1. depositUpdateForOrder() — the pure state→updates mapping, incl. the
//      idempotency crown-jewel (a repeat ORDER_COMPLETED must not re-stamp
//      deposit_paid_at).
//   2. POST() — the orchestration guards: bad signature → 401; dedup short-
//      circuit, unknown order, and getOrder failure all → 200 with NO write;
//      transient states ignored; the terminal write is correct.
//
// The DB is a tiny in-memory mock that records every .update() so we can
// assert "no write happened" / "this exact patch happened". Everything else
// the handler reaches (receipt SMS, orders/events sync, sequences) is mocked
// to a no-op so a single test exercises only the path under assertion.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/revolut', () => ({ verifyWebhookSignature: vi.fn(), getOrder: vi.fn() }))
vi.mock('@/lib/deposit-receipts', () => ({ sendDepositReceiptSms: vi.fn(async () => ({ status: 'sent' })) }))
vi.mock('@/lib/orders', () => ({ syncOrderFromCarDeposit: vi.fn(async () => {}) }))
vi.mock('@/lib/contact-events', () => ({
  emitEvent: vi.fn(async () => {}),
  EVENT_TYPES: { ORDER_COMPLETED: 'order.completed', ORDER_FAILED: 'order.failed', ORDER_ABANDONED: 'order.abandoned' },
}))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForOrderStatus: vi.fn(async () => {}) }))
vi.mock('@/lib/webhook-events', () => ({
  recordWebhookEvent: vi.fn(async () => ({ seen: false })),
  WEBHOOK_PROVIDERS: { REVOLUT: 'revolut' },
}))

import { POST, depositUpdateForOrder } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { recordWebhookEvent } from '@/lib/webhook-events'

// ── In-memory DB mock — records every update for assertions ──────────
function makeDb({ car = null, contact = null } = {}) {
  const updates = []
  function from(table) {
    const b = { _op: 'select', _payload: null }
    b.select = () => b
    b.update = (payload) => { b._op = 'update'; b._payload = payload; return b }
    b.insert = () => b
    b.eq = () => b
    b.ilike = () => b
    b.maybeSingle = () => Promise.resolve({ data: table === 'cars' ? car : contact })
    b.then = (resolve) => {
      if (b._op === 'update') updates.push({ table, payload: b._payload })
      return resolve({ data: null, error: null })
    }
    return b
  }
  return { from, _updates: updates }
}

function makeRequest({
  body = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: 'ord-1' }),
  sig = 'v1=sig',
  ts = '12345',
} = {}) {
  const headers = { 'revolut-signature': sig, 'revolut-request-timestamp': ts }
  return {
    text: async () => body,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  }
}

const CAR = {
  id: 'car-1', location_id: 'loc-1', deposit_token: 'tok',
  deposit_status: 'sent', deposit_paid_at: null,
  deposit_amount: 500, deposit_paid_amount: null, deposit_receipt_sent_at: null,
  buyer_phone: '+353871234567', buyer_name: 'Sarah', buyer_email: null,
  make: 'Tesla', model: 'Model 3', irish_reg: '241-D-1',
  locations: { id: 'loc-1', name: 'CCF', car_deposit_receipt_sms_enabled: true, twilio_alpha_sender_id: 'CCFautos' },
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyWebhookSignature.mockReturnValue(true)
  recordWebhookEvent.mockResolvedValue({ seen: false })
})

// ── Pure: depositUpdateForOrder ──────────────────────────────────────
describe('depositUpdateForOrder (pure state → updates)', () => {
  const NOW = new Date('2026-06-03T10:00:00Z')

  it('completed + never paid → status paid, stamps paid_at + paid_amount (minor→major)', () => {
    const { state, updates } = depositUpdateForOrder({ order: { state: 'completed', amount: 50000 }, car: { deposit_paid_at: null }, now: NOW })
    expect(state).toBe('completed')
    expect(updates).toEqual({ deposit_status: 'paid', deposit_paid_at: NOW.toISOString(), deposit_paid_amount: 500 })
  })

  it('IDEMPOTENCY: completed + already paid → does NOT re-stamp deposit_paid_at', () => {
    const { updates } = depositUpdateForOrder({ order: { state: 'completed', amount: 50000 }, car: { deposit_paid_at: '2026-01-01T00:00:00Z' }, now: NOW })
    expect(updates.deposit_status).toBe('paid')
    expect('deposit_paid_at' in updates).toBe(false)
    expect(updates.deposit_paid_amount).toBe(500)
  })

  it('completed with non-numeric amount → omits deposit_paid_amount', () => {
    const { updates } = depositUpdateForOrder({ order: { state: 'completed' }, car: { deposit_paid_at: null }, now: NOW })
    expect('deposit_paid_amount' in updates).toBe(false)
    expect(updates.deposit_status).toBe('paid')
  })

  it('cancelled / failed → status only', () => {
    expect(depositUpdateForOrder({ order: { state: 'cancelled' }, car: {} }).updates).toEqual({ deposit_status: 'cancelled' })
    expect(depositUpdateForOrder({ order: { state: 'FAILED' }, car: {} }).updates).toEqual({ deposit_status: 'failed' })
  })

  it('transient states (pending / processing / authorised) → updates null (caller skips)', () => {
    for (const s of ['pending', 'processing', 'authorised', 'weird', '']) {
      expect(depositUpdateForOrder({ order: { state: s }, car: {} }).updates).toBeNull()
    }
  })
})

// ── Handler: POST orchestration + idempotency guards ─────────────────
describe('POST /api/webhooks/revolut', () => {
  it('rejects an invalid signature with 401 and never touches the DB', async () => {
    verifyWebhookSignature.mockReturnValue(false)
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('returns 200 for an empty body (verification ping) without a DB client', async () => {
    const res = await POST(makeRequest({ body: '' }))
    expect(res.status).toBe(200)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('returns 200 when order_id/event are missing, before creating a DB client', async () => {
    const res = await POST(makeRequest({ body: JSON.stringify({ event: 'ORDER_COMPLETED' }) }))
    expect(res.status).toBe(200)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('DEDUP: a re-delivered event short-circuits to 200 with no write', async () => {
    recordWebhookEvent.mockResolvedValue({ seen: true })
    const db = makeDb({ car: CAR })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.deduped).toBe(true)
    expect(db._updates).toHaveLength(0)
    expect(getOrder).not.toHaveBeenCalled()
  })

  it('unknown order (no matching car) → 200 and no write', async () => {
    const db = makeDb({ car: null })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.skipped).toBe('unknown_order')
    expect(db._updates).toHaveLength(0)
    expect(getOrder).not.toHaveBeenCalled()
  })

  it('getOrder failure → 200 and no write (lets Revolut retry)', async () => {
    const db = makeDb({ car: CAR })
    createServerClient.mockReturnValue(db)
    getOrder.mockRejectedValue(new Error('revolut down'))
    const res = await POST(makeRequest())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.skipped).toBe('getorder_failed')
    expect(db._updates).toHaveLength(0)
  })

  it('transient state (authorised) → 200 ignored, no write', async () => {
    const db = makeDb({ car: CAR })
    createServerClient.mockReturnValue(db)
    getOrder.mockResolvedValue({ state: 'authorised' })
    const res = await POST(makeRequest())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ignored_state).toBe('authorised')
    expect(db._updates).toHaveLength(0)
  })

  it('completed (fresh) → writes paid + paid_at + paid_amount', async () => {
    const db = makeDb({ car: CAR })
    createServerClient.mockReturnValue(db)
    getOrder.mockResolvedValue({ state: 'completed', amount: 50000 })
    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(db._updates).toHaveLength(1)
    const patch = db._updates[0].payload
    expect(patch.deposit_status).toBe('paid')
    expect(patch.deposit_paid_amount).toBe(500)
    expect(typeof patch.deposit_paid_at).toBe('string')
  })

  it('IDEMPOTENCY: completed re-delivery on an already-paid car never re-stamps paid_at', async () => {
    const db = makeDb({ car: { ...CAR, deposit_paid_at: '2026-01-01T00:00:00Z' } })
    createServerClient.mockReturnValue(db)
    getOrder.mockResolvedValue({ state: 'completed', amount: 50000 })
    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(db._updates).toHaveLength(1)
    const patch = db._updates[0].payload
    expect(patch.deposit_status).toBe('paid')
    expect('deposit_paid_at' in patch).toBe(false) // original timestamp preserved
  })
})
