// REVPAY.1 — the refund route's money-safety edges: the idempotency key
// reaches the provider adapter; a refund the provider did not confirm says
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
const { POST } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const manager = {
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role: 'manager', profileRole: 'manager',
  activeLocation: { id: L1 },
  rolesByLocation: { [L1]: 'manager' },
  assignmentsByLocation: { [L1]: { role: 'manager', permissions: { orders: true } } },
  locations: [{ id: L1, role: 'manager', features: { orders: true } }],
}
const ORDER = {
  id: 'o1', status: 'completed', payment_provider: 'revolut', payment_provider_ref: 'ord-1',
  amount_cents: 1000, refunded_amount_cents: 0, currency: 'EUR',
  location_id: L1, source_type: 'car_deposit', source_id: 'car1', contact_id: null, contact_email: 'a@x.ie',
}

function fakeDb({ order = ORDER, writeErrors = {} } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {}
      for (const n of ['select', 'eq', 'update']) b[n] = (...a) => { q.ops.push([n, ...a]); return b }
      b.single = async () => ({ data: order, error: null })
      b.then = (res, rej) => Promise.resolve({ data: null, error: writeErrors[table] || null }).then(res, rej)
      return b
    },
  }
}
const post = (body = {}) => POST(new Request('http://localhost/api/orders/o1/refund', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: 'o1' }) })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(manager)
  refundPayment.mockResolvedValue({ refundId: 'rf1' })
})

describe('POST /api/orders/[id]/refund — REVPAY.1', () => {
  it('passes the cumulative-total idempotency key to the provider', async () => {
    createServerClient.mockReturnValue(fakeDb())
    const res = await post()
    expect(res.status).toBe(200)
    expect(refundPayment).toHaveBeenCalledWith('ord-1', expect.objectContaining({ amountCents: 1000, idempotencyKey: 'refund:o1:1000' }))
  })

  it('a second partial refund carries a different key (the new cumulative total)', async () => {
    createServerClient.mockReturnValue(fakeDb({ order: { ...ORDER, refunded_amount_cents: 300 } }))
    await post({ amount_cents: 200 })
    expect(refundPayment).toHaveBeenCalledWith('ord-1', expect.objectContaining({ idempotencyKey: 'refund:o1:500' }))
  })

  it('a provider timeout answers "may have gone through", never "failed", and writes nothing', async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    refundPayment.mockRejectedValue(new RevolutError('Revolut API timed out after 15000ms', 504, 'timeout'))
    const res = await post()
    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body.code).toBe('provider_outcome_unknown')
    expect(body.error).toMatch(/may have gone through/)
    expect(db.calls.filter((c) => c.ops.some(([op]) => op === 'update'))).toHaveLength(0)
  })

  it('a provider 4xx is still a plain failure', async () => {
    createServerClient.mockReturnValue(fakeDb())
    refundPayment.mockRejectedValue(new RevolutError('Refund amount too high', 422))
    const res = await post()
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('provider_error')
  })

  it('refund issued but the orders write failed → 500 refund_not_recorded, logged, no cascade, no event', async () => {
    const db = fakeDb({ writeErrors: { orders: { message: 'write failed' } } })
    createServerClient.mockReturnValue(db)
    const res = await post()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('refund_not_recorded')
    expect(body.data.refund_id).toBe('rf1')
    expect(body.error).toMatch(/went through/)
    expect(logError).toHaveBeenCalledWith('orders-refund', expect.stringMatching(/orders row was NOT updated/), expect.objectContaining({ orderId: 'o1', refundId: 'rf1' }))
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
