// REFUNDCONFIRM.1 — Revolut refunds are confirmed from Revolut's own record.
// On the shared fake database, checked against the schema snapshot (through
// migration 859, which has order_refunds).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db.js'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
const applyRefundToSource = vi.fn(async () => ({ sourceKind: null }))
vi.mock('@/lib/order-refund-cascade', () => ({ applyRefundToSource: (...a) => applyRefundToSource(...a) }))

const { logError } = await import('@/lib/log')
const { sweepRevolutRefunds, judgeHeldRefund, DECLINED_MARKER } = await import('./revolut-refund-confirm.js')

const NOW = Date.parse('2026-11-20T12:00:00Z')
const ago = (min) => new Date(NOW - min * 60_000).toISOString()
const LOC = '00000000-0000-4000-8000-0000000000aa'
const O1 = '00000000-0000-4000-8000-000000000001'
const O2 = '00000000-0000-4000-8000-000000000002'
const R1 = '00000000-0000-4000-8000-000000000011'
const R2 = '00000000-0000-4000-8000-000000000012'
const R0 = '00000000-0000-4000-8000-000000000010'

const order = (id, over = {}) => ({
  id, location_id: LOC, source_type: 'donation', source_id: '00000000-0000-4000-8000-0000000000dd', contact_email: 'a@x.ie',
  amount_cents: 1000, currency: 'EUR', status: 'completed', payment_provider: 'revolut', payment_provider_ref: `rev-${id.slice(-2)}`,
  refunded_amount_cents: 0, ...over,
})
const refund = (id, orderId, over = {}) => ({
  id, order_id: orderId, location_id: LOC, amount_cents: 1000, currency: 'EUR', reason: 'Asked', status: 'unknown',
  idempotency_key: `refund:${orderId}:${id}`, provider: 'revolut', is_full: true, created_at: ago(60), error: null, ...over,
})

function db({ orders = [order(O1)], refunds = [refund(R1, O1)], finish = { ok: true, is_full: true, refunded_total_cents: 1000 } } = {}) {
  const rpcCalls = []
  const d = createFakeDb({
    tables: { orders, order_refunds: refunds },
    rpc: { finish_order_refund: (args) => { rpcCalls.push(args); return finish } },
  })
  d.rpcCalls = rpcCalls
  return d
}

beforeEach(() => vi.clearAllMocks())

describe('judgeHeldRefund', () => {
  it('confirms only when Revolut has refunded the ledger total plus this refund', () => {
    expect(judgeHeldRefund({ revolutRefundedCents: 1000, completedCents: 0, heldCents: 1000 })).toBe('confirmed')
    expect(judgeHeldRefund({ revolutRefundedCents: 500, completedCents: 500, heldCents: 300 })).toBe('unconfirmed')
    expect(judgeHeldRefund({ revolutRefundedCents: 800, completedCents: 500, heldCents: 300 })).toBe('confirmed')
    expect(judgeHeldRefund({ revolutRefundedCents: null, completedCents: 0, heldCents: 100 })).toBe('unknown')
  })
})

describe('held refunds', () => {
  it('a held refund Revolut has paid is finished and its source follows', async () => {
    const d = db()
    const counts = {}
    await sweepRevolutRefunds({ db: d, getOrder: async () => ({ state: 'completed', refunded_amount: 1000 }), nowMs: NOW, counts })
    expect(d.rpcCalls).toEqual([{ p_refund_id: R1, p_status: 'completed', p_provider_refund_id: null, p_error: null }])
    expect(applyRefundToSource).toHaveBeenCalledWith(d, expect.objectContaining({ id: O1, source_type: 'donation' }), { isFull: true, refundedTotal: 1000 })
    expect(counts.refund_confirmed).toBe(1)
  })

  it('a held refund Revolut has not paid stays held: it is never marked failed', async () => {
    const d = db()
    const counts = {}
    await sweepRevolutRefunds({ db: d, getOrder: async () => ({ state: 'completed', refunded_amount: 0 }), nowMs: NOW, counts })
    expect(d.rpcCalls).toEqual([])
    expect(d.tables.order_refunds[0].status).toBe('unknown')
    expect(counts.refund_unconfirmed).toBe(1)
  })

  it('an earlier completed refund is counted before this one', async () => {
    const rows = () => [refund(R0, O1, { status: 'completed', amount_cents: 500, created_at: ago(600) }), refund(R1, O1, { amount_cents: 300 })]
    const d = db({ refunds: rows() })
    await sweepRevolutRefunds({ db: d, getOrder: async () => ({ refunded_amount: 500 }), nowMs: NOW, counts: {} })
    expect(d.rpcCalls).toHaveLength(0)
    const d2 = db({ refunds: rows() })
    await sweepRevolutRefunds({ db: d2, getOrder: async () => ({ refunded_amount: 800 }), nowMs: NOW, counts: {} })
    expect(d2.rpcCalls).toHaveLength(1)
  })

  it('a refund younger than ten minutes is left for the route', async () => {
    const d = db({ refunds: [refund(R1, O1, { created_at: ago(2) })] })
    const getOrder = vi.fn()
    await sweepRevolutRefunds({ db: d, getOrder, nowMs: NOW, counts: {} })
    expect(getOrder).not.toHaveBeenCalled()
  })

  it('Revolut not answering leaves the refund held and the run going', async () => {
    const d = db()
    const counts = {}
    await sweepRevolutRefunds({ db: d, getOrder: async () => { throw Object.assign(new Error('down'), { status: 503 }) }, nowMs: NOW, counts })
    expect(d.rpcCalls).toEqual([])
    expect(counts.refund_provider_failed).toBe(1)
  })
})

describe('declined refunds', () => {
  const done = (over = {}) => refund(R2, O2, { status: 'completed', provider_refund_id: 'rev-refund-2', finished_at: ago(60), ...over })

  it('a recorded refund Revolut then failed is marked once and logged loudly, never reversed', async () => {
    const d = db({ orders: [order(O2)], refunds: [done()] })
    const counts = {}
    const getOrder = async (id) => (id === 'rev-refund-2' ? { state: 'failed' } : {})
    await sweepRevolutRefunds({ db: d, getOrder, nowMs: NOW, counts })
    expect(d.tables.order_refunds[0].error).toMatch(new RegExp(`^${DECLINED_MARKER}: Revolut failed`))
    expect(d.tables.order_refunds[0].status).toBe('completed')
    expect(d.rpcCalls).toEqual([])
    expect(counts.refund_declined).toBe(1)
    expect(logError).toHaveBeenCalledWith('revolut-refund-confirm', expect.stringMatching(/declined a refund/), expect.objectContaining({ refundId: R2 }))
    // A second tick writes nothing: the error is already set.
    const again = {}
    await sweepRevolutRefunds({ db: d, getOrder, nowMs: NOW, counts: again })
    expect(again.refund_declined).toBeUndefined()
  })

  it('a completed refund order is left alone', async () => {
    const d = db({ orders: [order(O2)], refunds: [done()] })
    const counts = {}
    await sweepRevolutRefunds({ db: d, getOrder: async () => ({ state: 'completed' }), nowMs: NOW, counts })
    expect(d.tables.order_refunds[0].error).toBeNull()
    expect(counts.refund_settled_ok).toBe(1)
  })
})

describe('never throws', () => {
  it('a database that throws is counted, not raised', async () => {
    const d = { from() { throw new Error('boom') }, rpc: async () => ({}) }
    const counts = {}
    await expect(sweepRevolutRefunds({ db: d, getOrder: async () => ({}), nowMs: NOW, counts })).resolves.toBeUndefined()
    expect(counts.refund_errors).toBe(2)
  })
})
