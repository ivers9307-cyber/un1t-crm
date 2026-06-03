// Route-level tests for the PUBLIC deposit accept-and-pay endpoint — the
// order-CREATION side of the money flow (buyer accepts T&Cs → we create a
// Revolut order). The safety contract: reject expired tokens (410), stale
// terms (409) and already-paid cars (409); on a retry REUSE the existing
// order rather than creating a second one; and always create with a stable
// idempotency key so even a double-submit can't mint two orders.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/revolut', () => {
  class RevolutError extends Error {
    constructor(message, status) { super(message); this.status = status }
  }
  return { createOrder: vi.fn(), getOrder: vi.fn(), RevolutError }
})
vi.mock('@/lib/app-url', () => ({
  getDepositBaseUrl: vi.fn(() => 'https://pay.ccfautos.com'),
  getRequestOrigin: vi.fn(() => 'https://pay.ccfautos.com'),
}))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { createOrder, getOrder, RevolutError } from '@/lib/revolut'

function makeDb({ car }) {
  const updates = []
  function from() {
    const b = { _op: 'select', _payload: null }
    b.select = () => b
    b.update = (p) => { b._op = 'update'; b._payload = p; return b }
    b.eq = () => b
    b.maybeSingle = () => Promise.resolve({ data: car })
    b.then = (resolve) => { if (b._op === 'update') updates.push(b._payload); return resolve({ data: null, error: null }) }
    return b
  }
  return { from, _updates: updates }
}

function makeReq({ body = { terms_version: 1 } } = {}) {
  return { json: async () => body, headers: { get: (k) => ({ 'x-forwarded-for': '1.2.3.4' }[k.toLowerCase()] ?? null) } }
}
const props = (token = 'tok-1') => ({ params: { token } })

const FUTURE = new Date(Date.now() + 3600e3).toISOString()
const PAST = new Date(Date.now() - 3600e3).toISOString()

const CAR = {
  id: 'car-1', make: 'Tesla', model: 'Model 3', location_id: 'loc-1',
  deposit_token: 'tok-1', deposit_token_expires_at: FUTURE,
  deposit_amount: 500, deposit_status: 'sent',
  deposit_revolut_order_id: null, deposit_revolut_checkout_url: null,
  locations: { id: 'loc-1', car_deposit_terms_version: 1 },
}

beforeEach(() => {
  vi.clearAllMocks()
  createOrder.mockResolvedValue({ token: 'sdk-tok', checkout_url: 'https://co/x', id: 'ord-new' })
  getOrder.mockResolvedValue({ token: 'existing-sdk-tok' })
})

describe('POST /api/public/deposit/[token]/accept-and-pay', () => {
  it('missing terms_version → 400 before any DB', async () => {
    const res = await POST(makeReq({ body: {} }), props())
    expect(res.status).toBe(400)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('invalid token (no car) → 404', async () => {
    createServerClient.mockReturnValue(makeDb({ car: null }))
    const res = await POST(makeReq(), props('nope'))
    expect(res.status).toBe(404)
    expect(createOrder).not.toHaveBeenCalled()
  })

  it('expired token → 410 TOKEN_EXPIRED, no order created', async () => {
    createServerClient.mockReturnValue(makeDb({ car: { ...CAR, deposit_token_expires_at: PAST } }))
    const res = await POST(makeReq(), props())
    const body = await res.json()
    expect(res.status).toBe(410)
    expect(body.code).toBe('TOKEN_EXPIRED')
    expect(createOrder).not.toHaveBeenCalled()
  })

  it('stale terms_version → 409 TERMS_VERSION_MISMATCH', async () => {
    createServerClient.mockReturnValue(makeDb({ car: { ...CAR, locations: { car_deposit_terms_version: 2 } } }))
    const res = await POST(makeReq({ body: { terms_version: 1 } }), props())
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('TERMS_VERSION_MISMATCH')
    expect(createOrder).not.toHaveBeenCalled()
  })

  it('already paid → 409, no order created', async () => {
    createServerClient.mockReturnValue(makeDb({ car: { ...CAR, deposit_status: 'paid' } }))
    const res = await POST(makeReq(), props())
    expect(res.status).toBe(409)
    expect(createOrder).not.toHaveBeenCalled()
  })

  it('IDEMPOTENCY: a retry with an existing order REUSES it (getOrder, no createOrder)', async () => {
    const db = makeDb({ car: { ...CAR, deposit_status: 'terms_accepted', deposit_revolut_order_id: 'ord-existing', deposit_revolut_checkout_url: 'https://co/existing' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq(), props())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(getOrder).toHaveBeenCalledWith('ord-existing')
    expect(createOrder).not.toHaveBeenCalled()
    expect(body.order_id).toBe('ord-existing')
    expect(body.public_id).toBe('existing-sdk-tok')
  })

  it('fresh order → createOrder with a stable idempotency key; car linked to the new order', async () => {
    const db = makeDb({ car: CAR })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq(), props())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(createOrder).toHaveBeenCalledTimes(1)
    expect(createOrder.mock.calls[0][0].idempotencyKey).toBe('deposit-tok-1')
    expect(body.order_id).toBe('ord-new')
    expect(body.public_id).toBe('sdk-tok')
    const stamp = db._updates.find(u => u.deposit_revolut_order_id === 'ord-new')
    expect(stamp).toBeTruthy()
    expect(stamp.deposit_terms_accepted_version).toBe(1)
  })

  it('createOrder failure → still stamps the buyer acceptance, returns the provider status', async () => {
    const db = makeDb({ car: CAR })
    createServerClient.mockReturnValue(db)
    createOrder.mockRejectedValue(new RevolutError('card declined', 402))
    const res = await POST(makeReq(), props())
    expect(res.status).toBe(402)
    // consent must not be lost just because Revolut failed
    expect(db._updates.some(u => u.deposit_terms_accepted_at)).toBe(true)
  })
})
