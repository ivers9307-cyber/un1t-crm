// REFUNDCONFIRM.1 — the one place a recorded refund reaches the source row.
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
const markDonationRefunded = vi.fn(async () => ({ changed: true }))
vi.mock('@/lib/donation-payments', () => ({ markDonationRefunded: (...a) => markDonationRefunded(...a) }))
const { logError } = await import('@/lib/log')
const { applyRefundToSource } = await import('./order-refund-cascade.js')

function db({ error = null, kind = 'entry' } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      const w = { table, filters: [] }
      const b = {
        update(u) { w.update = u; writes.push(w); return b },
        eq(c, v) { w.filters.push([c, v]); return b },
        select() { return Promise.resolve({ data: error ? null : [{ kind }], error }) },
        then(res, rej) { return Promise.resolve({ error }).then(res, rej) },
      }
      return b
    },
  }
}
beforeEach(() => vi.clearAllMocks())

describe('applyRefundToSource', () => {
  it('race payments follow the refunded total and answer their kind', async () => {
    const d = db({ kind: 'move_gap' })
    const r = await applyRefundToSource(d, { id: 'o', source_type: 'race_registration', source_id: 'p1' }, { isFull: false, refundedTotal: 300, nowIso: 'T' })
    expect(d.writes[0]).toMatchObject({ table: 'race_payments', update: { status: 'completed', refunded_at: 'T', refunded_amount_cents: 300 } })
    expect(r.sourceKind).toBe('move_gap')
  })
  it('a full donation refund marks the donation refunded; a partial does not', async () => {
    await applyRefundToSource(db(), { id: 'o', source_type: 'donation', source_id: 'd1' }, { isFull: false, refundedTotal: 100 })
    expect(markDonationRefunded).not.toHaveBeenCalled()
    await applyRefundToSource(db(), { id: 'o', source_type: 'donation', source_id: 'd1' }, { isFull: true, refundedTotal: 1000, actorId: 'u1' })
    expect(markDonationRefunded).toHaveBeenCalledWith(expect.objectContaining({ donationId: 'd1', byProfileId: 'u1' }))
  })
  it('a full car deposit refund marks the deposit refunded', async () => {
    const d = db()
    await applyRefundToSource(d, { id: 'o', source_type: 'car_deposit', source_id: 'c1' }, { isFull: true, refundedTotal: 50000 })
    expect(d.writes[0]).toMatchObject({ table: 'cars', update: { deposit_status: 'refunded' }, filters: [['id', 'c1']] })
  })
  it('a trial, offer, booking, link or fee changes nothing', async () => {
    for (const t of ['trial_purchase', 'offer_purchase', 'class_booking', 'staff_payment_link', 'class_fee']) {
      const d = db()
      await applyRefundToSource(d, { id: 'o', source_type: t, source_id: 's' }, { isFull: true, refundedTotal: 1 })
      expect(d.writes).toEqual([])
    }
  })
  it('a failed write is logged, never thrown', async () => {
    await expect(applyRefundToSource(db({ error: { message: 'down' } }), { id: 'o', source_type: 'car_deposit', source_id: 'c1' }, { isFull: true, refundedTotal: 1 })).resolves.toEqual({ sourceKind: null })
    expect(logError).toHaveBeenCalled()
  })
})
