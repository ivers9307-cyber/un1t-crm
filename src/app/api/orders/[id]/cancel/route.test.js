// Route-level tests for POST /api/orders/[id]/cancel (ORDERS-CANCEL.1).
//
// Same hoisted-mock pattern as ../route.test.js. Coverage:
//   - 401 when no user
//   - 403 when role isn't manager+
//   - 403 when the order is in a different location (IDOR)
//   - 404 when the order doesn't exist
//   - 409 when the order isn't pending
//   - happy path race_registration → status cancelled + source cascade
//   - happy path car_deposit → status cancelled + cars cascade
//   - no contact_event is emitted (the tag engine must stay unfed)

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
}))

vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => true),
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

// A thenable that also exposes a chainable `.eq` (for the two-`.eq`
// race_payments cascade) so `await update().eq().eq()` resolves.
function thenableEq(result, sink) {
  const obj = {
    eq: vi.fn((col, val) => {
      sink?.push({ col, val })
      return obj
    }),
    then: (resolve) => resolve(result),
  }
  return obj
}

function mockDb({ order, orderError = null, updateError = null } = {}) {
  const calls = { ordersUpdate: [], racePaymentsUpdate: [], carsUpdate: [] }

  function from(table) {
    if (table === 'orders') {
      // Lookup: .select('*').eq('id', x).single()
      const single = vi.fn(() =>
        Promise.resolve(orderError ? { data: null, error: orderError } : { data: order, error: null })
      )
      const selectEq = vi.fn(() => ({ single }))
      const select = vi.fn(() => ({ eq: selectEq }))
      // Update: .update(obj).eq('id', x)
      const update = vi.fn((payload) => {
        calls.ordersUpdate.push(payload)
        return thenableEq({ error: updateError })
      })
      return { select, update }
    }
    if (table === 'race_payments') {
      const update = vi.fn((payload) => {
        calls.racePaymentsUpdate.push(payload)
        return thenableEq({ error: null })
      })
      return { update }
    }
    if (table === 'cars') {
      const update = vi.fn((payload) => {
        calls.carsUpdate.push(payload)
        return thenableEq({ error: null })
      })
      return { update }
    }
    throw new Error(`unexpected table: ${table}`)
  }

  return { from: vi.fn(from), __calls: calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
})

function req(body) {
  return new Request('https://example.com/api/orders/o1/cancel', {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/orders/[id]/cancel', () => {
  it('returns 401 when no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req(), { params: { id: 'o1' } })
    expect(res.status).toBe(401)
  })

  it('returns 403 when role is not manager+', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', locations: [{ id: 'loc-A' }] })
    const res = await POST(req(), { params: { id: 'o1' } })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the order is not found', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({ order: null, orderError: { message: 'not found' } }))
    const res = await POST(req(), { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })

  it('returns 403 when the order is in a different location (IDOR)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({
      order: { id: 'o1', location_id: 'loc-B', status: 'pending', source_type: 'race_registration', source_id: 's1' },
    }))
    const res = await POST(req(), { params: { id: 'o1' } })
    expect(res.status).toBe(403)
  })

  it('returns 409 when the order is not pending', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    createServerClient.mockReturnValue(mockDb({
      order: { id: 'o1', location_id: 'loc-A', status: 'completed', source_type: 'race_registration', source_id: 's1' },
    }))
    const res = await POST(req(), { params: { id: 'o1' } })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('invalid_status')
  })

  it('cancels a pending race order, stamps metadata, and cascades to race_payments', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    const db = mockDb({
      order: { id: 'o1', location_id: 'loc-A', status: 'pending', source_type: 'race_registration', source_id: 'pay-1', metadata: { foo: 'bar' } },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ reason: 'duplicate' }), { params: { id: 'o1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.status).toBe('cancelled')
    // orders row updated to cancelled with audit metadata preserved
    expect(db.__calls.ordersUpdate).toHaveLength(1)
    expect(db.__calls.ordersUpdate[0].status).toBe('cancelled')
    expect(db.__calls.ordersUpdate[0].metadata.foo).toBe('bar')
    expect(db.__calls.ordersUpdate[0].metadata.cancelled_by_user_id).toBe('u1')
    expect(db.__calls.ordersUpdate[0].metadata.cancel_reason).toBe('duplicate')
    // source cascade hit race_payments → abandoned, NOT cars
    expect(db.__calls.racePaymentsUpdate).toHaveLength(1)
    expect(db.__calls.racePaymentsUpdate[0].status).toBe('abandoned')
    expect(db.__calls.carsUpdate).toHaveLength(0)
    // no contact_events table was ever touched (tag engine stays unfed)
    expect(db.from).not.toHaveBeenCalledWith('contact_events')
  })

  it('cancels a pending car deposit order and cascades to cars', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    const db = mockDb({
      order: { id: 'o1', location_id: 'loc-A', status: 'pending', source_type: 'car_deposit', source_id: 'car-1' },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), { params: { id: 'o1' } })
    expect(res.status).toBe(200)
    expect(db.__calls.carsUpdate).toHaveLength(1)
    expect(db.__calls.carsUpdate[0].deposit_status).toBe('cancelled')
    expect(db.__calls.racePaymentsUpdate).toHaveLength(0)
  })

  it('returns 403 when the orders feature is disabled at the location', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'manager', locations: [{ id: 'loc-A' }] })
    hasPermission.mockReturnValue(false)
    const res = await POST(req(), { params: { id: 'o1' } })
    expect(res.status).toBe(403)
  })
})
