// RAFFLE.3 — the order status poll: re-checks Revolut while pending, issues
// the tickets once paid, and never returns the buyer's name or email.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ID = 'a0000000-0000-4000-8000-0000000000a1'
let rows
const getPayment = vi.fn(async () => ({ state: 'completed', amountCents: 1000 }))
const markRaffleOrderPaymentStatus = vi.fn(async () => { rows.push({ ...rows[0], status: 'paid' }); return { status: 'paid', changed: true } })
const runPaidRaffleOrderEffects = vi.fn(async () => ({ tickets: 'issued', sale: { first_ticket: 12, last_ticket: 14 } }))
vi.mock('@/lib/payments', () => ({ paymentsFor: () => ({ getPayment: (...a) => getPayment(...a) }) }))
vi.mock('@/lib/raffle-online', () => ({
  RAFFLE_ORDER_COLS: 'id',
  markRaffleOrderPaymentStatus: (...a) => markRaffleOrderPaymentStatus(...a),
  runPaidRaffleOrderEffects: (...a) => runPaidRaffleOrderEffects(...a),
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: rows[rows.length - 1] || null, error: null }) }
      return q
    },
  }),
}))

const { GET } = await import('./route.js')
const call = (id = ID) => GET(new Request('http://x'), { params: Promise.resolve({ id }) })

beforeEach(() => {
  rows = [{ id: ID, status: 'awaiting_payment', payment_provider: 'revolut', payment_provider_ref: 'ord', buyer_name: 'Ann', buyer_email: 'ann@example.test', quantity: 3, amount_cents: 1000, currency: 'EUR' }]
  vi.clearAllMocks()
})

describe('GET /api/public/raffle-orders/[id]', () => {
  it('a pending order that Revolut reports completed comes back paid with its numbers', async () => {
    const body = await (await call()).json()
    expect(getPayment).toHaveBeenCalledWith('ord', {})
    expect(body.data).toMatchObject({ state: 'paid', paid: true, tickets: { first: 12, last: 14 }, checkout: null })
    expect(JSON.stringify(body)).not.toMatch(/ann@example|"Ann"/)
  })
  it('a still-pending order keeps its checkout and has no numbers', async () => {
    getPayment.mockResolvedValueOnce({ state: 'pending', amountCents: null })
    markRaffleOrderPaymentStatus.mockImplementationOnce(async () => ({ status: 'awaiting_payment', changed: false }))
    const body = await (await call()).json()
    expect(body.data).toMatchObject({ state: 'pending', paid: false, tickets: null })
    expect(runPaidRaffleOrderEffects).not.toHaveBeenCalled()
  })
  it('a bad id or a missing order is a 404', async () => {
    expect((await call('nope')).status).toBe(404)
    rows = []
    expect((await call()).status).toBe(404)
  })
})
