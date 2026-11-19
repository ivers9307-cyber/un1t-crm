// REFUNDCONFIRM.1 — Revolut refunds are confirmed from Revolut's own record.
// A hand fake: order_refunds (mig 853) is newer than the schema snapshot
// createFakeDb checks against (through mig 852).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
const applyRefundToSource = vi.fn(async () => ({ sourceKind: null }))
vi.mock('@/lib/order-refund-cascade', () => ({ applyRefundToSource: (...a) => applyRefundToSource(...a) }))

const { logError } = await import('@/lib/log')
const { sweepRevolutRefunds, judgeHeldRefund, DECLINED_MARKER } = await import('./revolut-refund-confirm.js')

const NOW = Date.parse('2026-11-20T12:00:00Z')
const ago = (min) => new Date(NOW - min * 60_000).toISOString()

function fakeDb({ held = [], completed = [], declinable = [], finishResult = { ok: true, is_full: true, refunded_total_cents: 1000 } } = {}) {
  const updates = []
  const rpcs = []
  const db = {
    updates, rpcs,
    from(table) {
      const q = { table, filters: [], op: 'select' }
      const b = {}
      for (const n of ['select', 'order', 'limit']) b[n] = () => b
      b.eq = (c, v) => { q.filters.push(['eq', c, v]); return b }
      b.in = (c, v) => { q.filters.push(['in', c, v]); return b }
      b.is = (c, v) => { q.filters.push(['is', c, v]); return b }
      b.not = () => b
      b.gte = () => b
      b.lte = () => b
      b.update = (u) => { q.op = 'update'; q.update = u; return b }
      b.then = (res, rej) => {
        let data
        const statusEq = q.filters.find(([k, c]) => k === 'eq' && c === 'status')?.[2]
        if (q.op === 'update') { updates.push(q); data = [{ id: 'x' }] }
        else if (q.filters.some(([k, c]) => k === 'in' && c === 'status')) data = held
        else if (statusEq === 'completed' && q.filters.some(([k, c]) => k === 'eq' && c === 'order_id')) data = completed
        else if (statusEq === 'completed') data = declinable
        return Promise.resolve({ data, error: null }).then(res, rej)
      }
      return b
    },
    async rpc(name, args) { rpcs.push([name, args]); return { data: finishResult, error: null } },
  }
  return db
}

const ORDER = { id: 'o1', source_type: 'donation', source_id: 'd1', payment_provider: 'revolut', payment_provider_ref: 'rev-o1', amount_cents: 1000, refunded_amount_cents: 0 }
const HELD = { id: 'r1', order_id: 'o1', amount_cents: 1000, status: 'unknown', created_at: ago(60), order: ORDER }

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
    const db = fakeDb({ held: [HELD] })
    const counts = {}
    await sweepRevolutRefunds({ db, getOrder: async () => ({ state: 'completed', refunded_amount: 1000 }), nowMs: NOW, counts })
    expect(db.rpcs).toEqual([['finish_order_refund', { p_refund_id: 'r1', p_status: 'completed', p_provider_refund_id: null, p_error: null }]])
    expect(applyRefundToSource).toHaveBeenCalledWith(db, ORDER, { isFull: true, refundedTotal: 1000 })
    expect(counts.refund_confirmed).toBe(1)
  })

  it('a held refund Revolut has not paid stays held: it is never marked failed', async () => {
    const db = fakeDb({ held: [HELD] })
    const counts = {}
    await sweepRevolutRefunds({ db, getOrder: async () => ({ state: 'completed', refunded_amount: 0 }), nowMs: NOW, counts })
    expect(db.rpcs).toEqual([])
    expect(applyRefundToSource).not.toHaveBeenCalled()
    expect(counts.refund_unconfirmed).toBe(1)
  })

  it('an earlier completed refund is counted before this one', async () => {
    const db = fakeDb({ held: [{ ...HELD, amount_cents: 300 }], completed: [{ amount_cents: 500 }] })
    const counts = {}
    await sweepRevolutRefunds({ db, getOrder: async () => ({ refunded_amount: 500 }), nowMs: NOW, counts })
    expect(counts.refund_unconfirmed).toBe(1)
    const db2 = fakeDb({ held: [{ ...HELD, amount_cents: 300 }], completed: [{ amount_cents: 500 }] })
    await sweepRevolutRefunds({ db: db2, getOrder: async () => ({ refunded_amount: 800 }), nowMs: NOW, counts: {} })
    expect(db2.rpcs).toHaveLength(1)
  })

  it('Revolut not answering leaves the refund held and the run going', async () => {
    const db = fakeDb({ held: [HELD] })
    const counts = {}
    await sweepRevolutRefunds({ db, getOrder: async () => { throw Object.assign(new Error('down'), { status: 503 }) }, nowMs: NOW, counts })
    expect(db.rpcs).toEqual([])
    expect(counts.refund_provider_failed).toBe(1)
  })
})

describe('declined refunds', () => {
  it('a recorded refund Revolut then failed is marked once and logged loudly, never reversed', async () => {
    const db = fakeDb({ declinable: [{ id: 'r2', order_id: 'o2', provider_refund_id: 'rev-refund-2', location_id: 'loc1' }] })
    const counts = {}
    await sweepRevolutRefunds({ db, getOrder: async (id) => (id === 'rev-refund-2' ? { state: 'failed' } : {}), nowMs: NOW, counts })
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0].update.error).toMatch(new RegExp(`^${DECLINED_MARKER}: Revolut failed`))
    expect(db.updates[0].filters).toContainEqual(['is', 'error', null])
    expect(db.rpcs).toEqual([])
    expect(counts.refund_declined).toBe(1)
    expect(logError).toHaveBeenCalledWith('revolut-refund-confirm', expect.stringMatching(/declined a refund/), expect.objectContaining({ refundId: 'r2' }))
  })

  it('a completed refund order is left alone', async () => {
    const db = fakeDb({ declinable: [{ id: 'r3', order_id: 'o3', provider_refund_id: 'rev-refund-3' }] })
    const counts = {}
    await sweepRevolutRefunds({ db, getOrder: async () => ({ state: 'completed' }), nowMs: NOW, counts })
    expect(db.updates).toEqual([])
    expect(counts.refund_settled_ok).toBe(1)
  })
})

describe('never throws', () => {
  it('a database that throws is counted, not raised', async () => {
    const db = { from() { throw new Error('boom') }, rpc: async () => ({}) }
    const counts = {}
    await expect(sweepRevolutRefunds({ db, getOrder: async () => ({}), nowMs: NOW, counts })).resolves.toBeUndefined()
    expect(counts.refund_errors).toBe(2)
  })
})
