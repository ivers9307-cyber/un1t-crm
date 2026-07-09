import { describe, it, expect } from 'vitest'
import { refundPatchFromCharge } from './stripe-refund-sync'

describe('refundPatchFromCharge', () => {
  const payment = { amount_cents: 5000, refunded_amount_cents: 0, refunded_at: null }
  it('partial refund: absolute amount, status stays completed', () => {
    const p = refundPatchFromCharge({ amount_refunded: 2000 }, payment, '2026-07-09T10:00:00.000Z')
    expect(p).toEqual({ refunded_amount_cents: 2000, refunded_at: '2026-07-09T10:00:00.000Z', status: 'completed' })
  })
  it('full refund flips status to refunded', () => {
    const p = refundPatchFromCharge({ amount_refunded: 5000 }, payment, 'T')
    expect(p.status).toBe('refunded')
  })
  it('re-delivery with same amount is a no-op (returns null)', () => {
    expect(refundPatchFromCharge({ amount_refunded: 2000 }, { ...payment, refunded_amount_cents: 2000, refunded_at: 'X' }, 'T')).toBeNull()
  })
  it('keeps the existing refunded_at when increasing the amount', () => {
    const p = refundPatchFromCharge({ amount_refunded: 5000 }, { ...payment, refunded_amount_cents: 2000, refunded_at: 'X' }, 'T')
    expect(p.refunded_at).toBe('X')
  })
  it('never lowers a recorded refund (stale event) — returns null', () => {
    expect(refundPatchFromCharge({ amount_refunded: 1000 }, { ...payment, refunded_amount_cents: 2000, refunded_at: 'X' }, 'T')).toBeNull()
  })
})
