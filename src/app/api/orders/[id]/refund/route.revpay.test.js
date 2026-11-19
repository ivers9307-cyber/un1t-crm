// REVPAY.1 / REFUNDLEDGER.1 — the refund route's money-safety edges: it claims
// the refund (claim_order_refund) before the provider is called, and the
// claim's idempotency key reaches the provider adapter; a refund the provider did not confirm says
// "may have gone through" rather than "failed"; a refund that went through but
// could not be recorded says so (and emits nothing, so the safe retry emits
// once); a failed cars cascade is logged, not swallowed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/revolut', () => ({
  RevolutError: class RevolutError extends Error {
    constructor(message, status, code) { super(message); this.status = status; if (code) this.code = code }
  },
}))
const refundPayment = vi.fn()
vi.mock('@/lib/payments', () => ({ paymentsFor: vi.fn(() => ({ refundPayment })) }))
vi.mock('@/lib/contact-events', () => ({ emitEvent: vi.fn(async () => {}), applyTagRules: vi.fn(async () => {}), EVENT_TYPES: { ORDER_REFUNDED: 'order.refunded' } }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { RevolutError } = await import('@/lib/revolut')
const { emitEvent } = await import('@/lib/contact-events')
const { logError } = await import('@/lib/log')
const { POST, refundOutcomeUnknown } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const owner = {
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role: 'owner', profileRole: 'owner',
  activeLocation: { id: L1 },
  rolesByLocation: { [L1]: 'owner' },
  assignmentsByLocation: { [L1]: { role: 'owner', permissions: { orders: true } } },
  locations: [{ id: L1, role: 'owner', features: { orders: true } }],
}
const manager = {
  ...owner, role: 'manager', profileRole: 'manager', rolesByLocation: { [L1]: 'manager' },
  assignmentsByLocation: { [L1]: { role: 'manager', permissions: { orders: true } } },
  locations: [{ id: L1, role: 'manager', features: { orders: true } }],
}
const ORDER = {
  id: 'o1', status: 'completed', payment_provider: 'revolut', payment_provider_ref: 'ord-1',
  amount_cents: 1000, refunded_amount_cents: 0, currency: 'EUR',
  location_id: L1, source_type: 'car_deposit', source_id: 'car1', contact_id: null, contact_email: 'a@x.ie',
}

function fakeDb({ order = ORDER, writeErrors = {}, claimResult = null, finishError = null } = {}) {
  const calls = []
  const rpcs = []
  return {
    calls,
    rpcs,
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {}
      for (const n of ['select', 'eq', 'update']) b[n] = (...a) => { q.ops.push([n, ...a]); return b }
      b.single = async () => ({ data: order, error: null })
      b.then = (res, rej) => Promise.resolve({ data: null, error: writeErrors[table] || null }).then(res, rej)
      return b
    },
    async rpc(name, args) {
      rpcs.push([name, args])
      if (name === 'claim_order_refund') {
        const amount = args.p_amount_cents ?? (order.amount_cents - (order.refunded_amount_cents || 0))
        return { data: claimResult ?? { ok: true, resumed: false, refund_id: 'r1', amount_cents: amount,
          idempotency_key: 'refund:o1:r1', is_full: amount + (order.refunded_amount_cents || 0) >= order.amount_cents }, error: null }
      }
      if (name === 'finish_order_refund') {
        if (finishError && args.p_status === 'completed') return { data: null, error: finishError }
        const total = (order.refunded_amount_cents || 0) + 1000
        return { data: { ok: true, refunded_total_cents: total, is_full: total >= order.amount_cents }, error: null }
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } }
    },
  }
}
const post = (body = { reason: 'Customer asked' }) => POST(new Request('http://localhost/api/orders/o1/refund', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: 'o1' }) })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(owner)
  refundPayment.mockResolvedValue({ refundId: 'rf1' })
})

describe('POST /api/orders/[id]/refund — REVPAY.1 / REFUNDLEDGER.1', () => {
  it('claims first, then passes the claim\'s own idempotency key to the provider', async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    const res = await post()
    expect(res.status).toBe(200)
    expect(db.rpcs[0]).toEqual(['claim_order_refund', { p_order_id: 'o1', p_amount_cents: null, p_reason: 'Customer asked', p_actor_id: 'u1' }])
    expect(refundPayment).toHaveBeenCalledWith('ord-1', expect.objectContaining({ amountCents: 1000, idempotencyKey: 'refund:o1:r1' }))
    expect(db.rpcs[1]).toEqual(['finish_order_refund', { p_refund_id: 'r1', p_status: 'completed', p_provider_refund_id: 'rf1', p_error: null }])
  })

  it('a refund already in flight on the order is refused, and the provider is not called', async () => {
    createServerClient.mockReturnValue(fakeDb({ claimResult: { ok: false, code: 'refund_in_progress', amount_cents: 1000 } }))
    const res = await post({ amount_cents: 500, reason: 'Other' })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('refund_in_progress')
    expect(refundPayment).not.toHaveBeenCalled()
  })

  it('a reason is required', async () => {
    createServerClient.mockReturnValue(fakeDb())
    const res = await post({})
    expect(res.status).toBe(400)
    expect(refundPayment).not.toHaveBeenCalled()
  })

  it('a manager can no longer refund; an owner can', async () => {
    getCurrentUser.mockResolvedValue(manager)
    createServerClient.mockReturnValue(fakeDb())
    const res = await post()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/owners and masters/)
    expect(refundPayment).not.toHaveBeenCalled()
  })

  it('a provider timeout answers "may have gone through", keeps the claim held, and writes no order', async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    refundPayment.mockRejectedValue(new RevolutError('Revolut API timed out after 15000ms', 504, 'timeout'))
    const res = await post()
    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body.code).toBe('provider_outcome_unknown')
    expect(body.error).toMatch(/may have gone through/)
    expect(db.rpcs[1]).toEqual(['finish_order_refund', expect.objectContaining({ p_status: 'unknown' })])
    expect(db.calls.filter((c) => c.ops.some(([op]) => op === 'update'))).toHaveLength(0)
  })

  it('a provider 4xx is a plain failure and releases the claim', async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    refundPayment.mockRejectedValue(new RevolutError('Refund amount too high', 422))
    const res = await post()
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('provider_error')
    expect(db.rpcs[1]).toEqual(['finish_order_refund', expect.objectContaining({ p_status: 'failed' })])
  })

  it('refund issued but not recorded → 500 refund_not_recorded, logged, no cascade, no event', async () => {
    const db = fakeDb({ finishError: { message: 'write failed' } })
    createServerClient.mockReturnValue(db)
    const res = await post()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('refund_not_recorded')
    expect(body.data.refund_id).toBe('rf1')
    expect(body.error).toMatch(/went through/)
    expect(logError).toHaveBeenCalledWith('orders-refund', expect.stringMatching(/NOT recorded/), expect.objectContaining({ orderId: 'o1', providerRefundId: 'rf1' }))
    expect(db.calls.some((c) => c.table === 'cars')).toBe(false)
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('a failed cars cascade is logged and the refund still answers 200', async () => {
    createServerClient.mockReturnValue(fakeDb({ writeErrors: { cars: { message: 'write failed' } } }))
    const res = await post()
    expect(res.status).toBe(200)
    expect(logError).toHaveBeenCalledWith('orders-refund', expect.stringMatching(/cars\.deposit_status was NOT updated/), expect.objectContaining({ carId: 'car1' }))
    expect(emitEvent).toHaveBeenCalled()
  })
})

// REFUNDLEDGER.1 (security review) — only a definite refusal frees a claim.
describe('refundOutcomeUnknown', () => {
  it.each([
    ['a Revolut timeout', new RevolutError('timed out', 504, 'timeout'), true],
    ['a Revolut 5xx', new RevolutError('boom', 502), true],
    ['a Revolut 4xx', new RevolutError('too high', 422), false],
    ['a Stripe connection error', Object.assign(new Error('socket'), { type: 'StripeConnectionError' }), true],
    ['a Stripe API error', Object.assign(new Error('api'), { type: 'StripeAPIError', statusCode: 500 }), true],
    ['a Stripe 400', Object.assign(new Error('invalid'), { type: 'StripeInvalidRequestError', statusCode: 400 }), false],
    ['a 429', Object.assign(new Error('slow down'), { statusCode: 429 }), true],
    ['an error with no status', new Error('?'), true],
  ])('%s → unknown is %s', (_label, err, want) => {
    expect(refundOutcomeUnknown(err)).toBe(want)
  })

  it('a Stripe timeout keeps the claim held, never failed', async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    refundPayment.mockRejectedValue(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
    const res = await post()
    expect((await res.json()).code).toBe('provider_outcome_unknown')
    expect(db.rpcs[1]).toEqual(['finish_order_refund', expect.objectContaining({ p_status: 'unknown' })])
  })

  it('a refund held too long asks staff to check the provider and sends nothing', async () => {
    createServerClient.mockReturnValue(fakeDb({ claimResult: { ok: false, code: 'refund_needs_check', amount_cents: 1000 } }))
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/Check the payment provider/)
    expect(refundPayment).not.toHaveBeenCalled()
  })
})

