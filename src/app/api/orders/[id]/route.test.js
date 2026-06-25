// Route-level tests for GET /api/orders/[id] (Phase 3 follow-up).
//
// Same pattern as src/app/api/contacts/segments/[id]/route.test.js:
// hoisted vi.mock for auth + supabase, then call the handler with a
// fabricated Request + { params }.
//
// Coverage:
//   - 401 when no user
//   - 403 when user role isn't manager+
//   - 404 when user is manager+ but at the wrong location (IDOR)
//   - 404 when the order doesn't exist
//   - happy path: race_registration source — order + chain + events
//   - happy path: car_deposit source — car summary in source

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    }
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    }
    return null
  },
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    }
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    }
    return null
  },
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

// ─── DB chain mock ───────────────────────────────────────────────
//
// The route hits four Supabase paths in sequence:
//   1. orders.single() — looks up the order by id
//   2. orders.* — pulls the retry chain
//   3. contact_events.* — pulls the timeline
//   4. race_payments.* OR cars.* — source summary
//
// We dispatch on the table name in `from()` and return per-table
// chain stubs that resolve to whatever the test passes in.

function mockDb({
  order,
  retryChain = [],
  events = [],
  racePayment = null,
  car = null,
  orderError = null,
} = {}) {
  function tableChain(table) {
    if (table === 'orders') {
      // Two distinct shapes are used:
      //   .from('orders').select(...).eq('id', x).single()  — single
      //   .from('orders').select(...).eq(...).eq(...).gte(...).lte(...).order(...).limit(...) — list
      // Track whether the chain ends in single() vs an awaitable.
      const single = vi.fn(() =>
        Promise.resolve(orderError ? { data: null, error: orderError } : { data: order, error: null })
      )
      const listResult = { data: retryChain, error: null }
      const limit = vi.fn(() => Promise.resolve(listResult))
      const order_ = vi.fn(() => ({ limit }))
      const lte = vi.fn(() => ({ order: order_ }))
      const gte = vi.fn(() => ({ lte }))
      const eq2 = vi.fn(() => ({ gte }))
      const eq1 = vi.fn(() => ({ eq: eq2, single, gte }))
      // The single-lookup path is .from(...).select(...).eq('id', x).single()
      // — eq returns an object with `single`. The chain-list path also
      // calls .eq twice, then .gte/.lte/.order/.limit. The merged eq1
      // exposes both.
      const select = vi.fn(() => ({ eq: eq1 }))
      return { select }
    }
    if (table === 'contact_events') {
      const limit = vi.fn(() => Promise.resolve({ data: events, error: null }))
      const order_ = vi.fn(() => ({ limit }))
      const eq2 = vi.fn(() => ({ order: order_ }))
      const eq1 = vi.fn(() => ({ eq: eq2 }))
      const select = vi.fn(() => ({ eq: eq1 }))
      return { select }
    }
    if (table === 'race_payments') {
      const maybe = vi.fn(() => Promise.resolve({ data: racePayment, error: null }))
      const eq = vi.fn(() => ({ maybeSingle: maybe }))
      const select = vi.fn(() => ({ eq }))
      return { select }
    }
    if (table === 'cars') {
      const maybe = vi.fn(() => Promise.resolve({ data: car, error: null }))
      const eq = vi.fn(() => ({ maybeSingle: maybe }))
      const select = vi.fn(() => ({ eq }))
      return { select }
    }
    throw new Error(`unexpected table: ${table}`)
  }
  return { from: vi.fn(tableChain) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

const FAKE_REQUEST = new Request('https://example.com/api/orders/abc')

describe('GET /api/orders/[id]', () => {
  it('returns 401 when no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(FAKE_REQUEST, { params: { id: 'order-1' } })
    expect(res.status).toBe(401)
  })

  it('returns 403 when user role is not manager+', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', locations: [{ id: 'loc-A' }] })
    const res = await GET(FAKE_REQUEST, { params: { id: 'order-1' } })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the order is not found', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({ order: null, orderError: { message: 'not found' } }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'order-missing' } })
    expect(res.status).toBe(404)
  })

  it('returns 404 when user is manager+ but order is in a different location (IDOR)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({
      order: { id: 'order-1', location_id: 'loc-B', source_type: 'race_registration', source_id: 's1' },
    }))
    const res = await GET(FAKE_REQUEST, { params: { id: 'order-1' } })
    expect(res.status).toBe(404)
  })

  it('returns the order + chain + events + race source on the happy path', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    const order = {
      id: 'order-1', location_id: 'loc-A',
      source_type: 'race_registration', source_id: 'pay-1',
      contact_email: 'sarah@example.com',
      amount_cents: 5000, currency: 'EUR', status: 'completed',
      created_at: '2026-05-01T10:00:00Z',
    }
    const retryChain = [
      { id: 'order-0', status: 'failed', amount_cents: 5000, currency: 'EUR', created_at: '2026-04-29T00:00:00Z' },
      order,
    ]
    const events = [{ id: 'ev-1', event_type: 'order.completed', occurred_at: '2026-05-01T10:01:00Z' }]
    const racePayment = {
      id: 'pay-1',
      race: { id: 'r1', name: 'Hyrox May', slug: 'hyrox-may', race_date: '2026-05-15' },
      registration: { id: 'reg-1', status: 'confirmed', team_composition: 'all_members' },
    }
    createServerClient.mockReturnValue(mockDb({ order, retryChain, events, racePayment }))

    const res = await GET(FAKE_REQUEST, { params: { id: 'order-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.order.id).toBe('order-1')
    expect(body.data.retry_chain).toHaveLength(2)
    expect(body.data.events).toHaveLength(1)
    expect(body.data.source.kind).toBe('race_registration')
    expect(body.data.source.race_event.name).toBe('Hyrox May')
  })

  it('returns the car summary for a car_deposit source', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    const order = {
      id: 'order-1', location_id: 'loc-A',
      source_type: 'car_deposit', source_id: 'car-1',
      contact_email: 'buyer@example.com',
      amount_cents: 50000, currency: 'EUR', status: 'completed',
      created_at: '2026-05-01T00:00:00Z',
    }
    const car = {
      id: 'car-1', make: 'Volkswagen', model: 'Golf', irish_reg: '23-D-12345',
      buyer_email: 'buyer@example.com', deposit_status: 'paid', deposit_amount: 500,
    }
    createServerClient.mockReturnValue(mockDb({ order, car }))

    const res = await GET(FAKE_REQUEST, { params: { id: 'order-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.source.kind).toBe('car_deposit')
    expect(body.data.source.car.irish_reg).toBe('23-D-12345')
  })
})
