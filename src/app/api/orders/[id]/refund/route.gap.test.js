// EVENT-MOVE.5 — refunding the order of a move_gap payment (a moved entry's
// price difference) skips tag rules: they are written for entry payments.
// ORDER_REFUNDED is still emitted, and an entry refund is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/revolut', () => ({ RevolutError: class RevolutError extends Error {} }))
vi.mock('@/lib/payments', () => ({ paymentsFor: vi.fn(() => ({ refundPayment: vi.fn(async () => ({ refundId: 'rf1' })) })) }))
vi.mock('@/lib/contact-events', () => ({ emitEvent: vi.fn(async () => {}), applyTagRules: vi.fn(async () => {}), EVENT_TYPES: { ORDER_REFUNDED: 'order.refunded' } }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { emitEvent, applyTagRules } = await import('@/lib/contact-events')
const { POST } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const manager = {
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role: 'manager', profileRole: 'manager',
  activeLocation: { id: L1 },
  rolesByLocation: { [L1]: 'manager' },
  assignmentsByLocation: { [L1]: { role: 'manager', permissions: { orders: true } } },
  locations: [{ id: L1, role: 'manager', features: { orders: true } }],
}
const ORDER = { id: 'o1', status: 'completed', payment_provider: 'revolut', payment_provider_ref: 'ord-1', amount_cents: 1000, currency: 'EUR',
  location_id: L1, source_type: 'race_registration', source_id: 'gp1', contact_id: 'c1', contact_email: 'aoife@x.ie' }

function fakeDb({ sourceKind = 'move_gap', sourceError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {}
      for (const n of ['select', 'eq', 'update']) b[n] = (...a) => { q.ops.push([n, ...a]); return b }
      const answer = () => {
        if (table === 'race_payments') return sourceError ? { data: null, error: sourceError } : { data: [{ kind: sourceKind }], error: null }
        return { data: null, error: null }
      }
      b.single = async () => (table === 'orders' ? { data: ORDER, error: null } : answer())
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  }
}
const post = () => POST(new Request('http://localhost/api/orders/o1/refund', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), { params: Promise.resolve({ id: 'o1' }) })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(manager)
})

describe('POST /api/orders/[id]/refund — a move_gap source', () => {
  it('refunds, marks the payment refunded, emits ORDER_REFUNDED, and applies NO tag rules', async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    const res = await post()
    expect(res.status).toBe(200)
    const pay = db.calls.find((c) => c.table === 'race_payments')
    expect(pay.ops).toContainEqual(['update', expect.objectContaining({ status: 'refunded' })])
    expect(pay.ops).toContainEqual(['select', 'kind'])
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'order.refunded', sourceId: 'gp1' }))
    expect(applyTagRules).not.toHaveBeenCalled()
  })
  it('an entry source still applies tag rules', async () => {
    createServerClient.mockReturnValue(fakeDb({ sourceKind: 'entry' }))
    await post()
    expect(applyTagRules).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c1' }))
  })
  it('an unreadable source kind applies tag rules as before (fails open)', async () => {
    createServerClient.mockReturnValue(fakeDb({ sourceError: { message: 'down' } }))
    const res = await post()
    expect(res.status).toBe(200)
    expect(applyTagRules).toHaveBeenCalled()
  })
})
