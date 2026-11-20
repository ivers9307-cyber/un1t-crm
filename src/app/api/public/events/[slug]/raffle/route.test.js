// RAFFLE.3 — buying raffle tickets online: the server prices it, a closed or
// switched-off raffle refuses, and no contact is ever created.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let raffle
let inserted
let hostId = null
let db
const createRaffleOrderPayment = vi.fn(async () => ({ orderId: 'o1', checkout: { provider: 'revolut', token: 'tok', url: null } }))
vi.mock('@/lib/raffle-online', async (importOriginal) => ({
  ...(await importOriginal()),
  loadRaffleForEvent: vi.fn(async () => raffle),
  createRaffleOrderPayment: (...a) => createRaffleOrderPayment(...a),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: () => '1.2.3.4',
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/host-events', () => ({ eventIsPublic: () => true }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: async () => 'https://crm.example.test' }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

const { POST } = await import('./route.js')

function makeDb() {
  const calls = []
  return {
    calls,
    from(table) {
      calls.push(table)
      const q = {
        select: () => q, eq: () => q,
        single: async () => {
          if (table === 'race_events') return { data: { id: 'e1', slug: 'day', name: 'Day', location_id: 'L1', active: true, status: 'published', host_id: hostId, host: hostId ? { id: hostId, payment_provider: 'revolut' } : null }, error: null }
          return { data: { id: 'o1', ...inserted }, error: null }
        },
        insert: (row) => { inserted = row; return q },
        update: () => q,
      }
      return q
    },
  }
}

const RAFFLE = {
  id: 'r1', name: 'Raffle', currency: 'EUR', ticket_price_cents: 500, sales_open: true,
  ticket_options: [{ tickets: 3, price_cents: 1000 }], online_enabled: true,
  online_closes_at: new Date(Date.now() + 3600_000).toISOString(),
}
const req = (body) => new Request('http://x/api/public/events/day/raffle', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const params = { params: Promise.resolve({ slug: 'day' }) }

beforeEach(() => { hostId = null; raffle = { ...RAFFLE }; inserted = null; db = makeDb(); createRaffleOrderPayment.mockClear() })

describe('POST /api/public/events/[slug]/raffle', () => {
  it('prices 3 tickets at the option price, not anything the client sends', async () => {
    const res = await POST(req({ quantity: 3, name: 'Ann Kelly', email: 'Ann@Example.test', amount_cents: 1 }), params)
    expect(res.status).toBe(200)
    expect(inserted).toMatchObject({ quantity: 3, amount_cents: 1000, option_label: '3 for €10', buyer_email: 'ann@example.test', status: 'awaiting_payment' })
    expect(inserted).not.toHaveProperty('contact_id')
    expect(db.calls).not.toContain('contacts')
    expect((await res.json()).data.order.checkout.token).toBe('tok')
  })
  it('prices any other number as the cheapest mix of deals and singles', async () => {
    await POST(req({ quantity: 4, name: 'Ann', email: 'ann@example.test' }), params)
    expect(inserted).toMatchObject({ amount_cents: 1500, option_label: '3 for €10 + 1 single' })
  })
  it('refuses after the closing time', async () => {
    raffle = { ...RAFFLE, online_closes_at: new Date(Date.now() - 1000).toISOString() }
    const res = await POST(req({ quantity: 1, name: 'Ann', email: 'ann@example.test' }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('closed')
    expect(inserted).toBeNull()
  })
  it('refuses when online sales are off', async () => {
    raffle = { ...RAFFLE, online_enabled: false }
    expect((await POST(req({ quantity: 1, name: 'Ann', email: 'ann@example.test' }), params)).status).toBe(400)
  })
  it('caps an online order at 50 tickets', async () => {
    expect((await POST(req({ quantity: 51, name: 'Ann', email: 'ann@example.test' }), params)).status).toBe(400)
  })
  it("refuses a third-party host's event even when the host is on Revolut", async () => {
    hostId = 'h1'
    const res = await POST(req({ quantity: 1, name: 'Ann', email: 'ann@example.test' }), params)
    expect(res.status).toBe(400)
    expect(inserted).toBeNull()
    expect(createRaffleOrderPayment).not.toHaveBeenCalled()
  })
})
