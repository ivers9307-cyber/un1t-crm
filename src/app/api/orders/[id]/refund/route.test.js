// Tests for the refund route's money-critical decision logic (P1-10).
//
// The POST handler is deeply tied to Next.js Request/Response infrastructure,
// so we test the pure `resolveRefund` helper extracted from the route, which
// owns all the financial guards. Each test asserts a concrete code/status that
// would be returned to the caller — NOT just that a mock was invoked.
//
// Guards tested:
//   - Non-completed order (double-refund / wrong-status guard)
//   - Non-revolut provider
//   - Missing provider ref
//   - Partial refund exceeds captured amount
//   - Partial refund within captured amount (ok path)
//   - Full refund (no amount_cents supplied)

import { describe, it, expect } from 'vitest'
import { resolveRefund } from './route.js'

// A minimal completed order fixture for a revolut-paid race entry.
const completedOrder = {
  id: 'order-uuid-1',
  status: 'completed',
  payment_provider: 'revolut',
  payment_provider_ref: 'rev-ord-abc',
  amount_cents: 5000,
  currency: 'EUR',
  location_id: 'loc-1',
}

describe('resolveRefund — money guards', () => {
  // ── Status guards ─────────────────────────────────────────────────────────

  it('rejects a pending order — cannot refund before capture', () => {
    const result = resolveRefund({ ...completedOrder, status: 'pending' }, undefined)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_status')
    expect(result.status).toBe(409)
    expect(result.error).toMatch(/pending/)
  })

  it('rejects a failed order', () => {
    const result = resolveRefund({ ...completedOrder, status: 'failed' }, undefined)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_status')
    expect(result.status).toBe(409)
  })

  it('rejects a refunded order — prevents double-refund (the key regression)', () => {
    // If an operator hits "refund" twice on an already-refunded order,
    // the status check must block it. A regression here (e.g. checking
    // payment_provider_ref instead of status) would let money leave twice.
    const result = resolveRefund({ ...completedOrder, status: 'refunded' }, undefined)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_status')
    expect(result.status).toBe(409)
    expect(result.error).toMatch(/refunded/)
  })

  it('rejects an abandoned order', () => {
    const result = resolveRefund({ ...completedOrder, status: 'abandoned' }, undefined)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_status')
  })

  // ── Provider guards ───────────────────────────────────────────────────────

  it('rejects a non-revolut provider', () => {
    const result = resolveRefund({ ...completedOrder, payment_provider: 'free' }, undefined)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('unsupported_provider')
    expect(result.status).toBe(400)
  })

  it('rejects a null payment_provider_ref (no Revolut handle to refund against)', () => {
    const result = resolveRefund({ ...completedOrder, payment_provider_ref: null }, undefined)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('no_provider_ref')
    expect(result.status).toBe(422)
  })

  // ── Amount guards ─────────────────────────────────────────────────────────

  it('rejects a partial refund that exceeds the captured amount', () => {
    // e.g. captured €50.00 (5000¢) but operator asks for €60.00 (6000¢)
    const result = resolveRefund(completedOrder, 6000)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('refund_exceeds_order')
    expect(result.status).toBe(400)
    expect(result.error).toMatch(/6000/)
    expect(result.error).toMatch(/5000/)
  })

  it('accepts a partial refund equal to the captured amount (full via explicit cents)', () => {
    const result = resolveRefund(completedOrder, 5000)
    expect(result.ok).toBe(true)
    expect(result.refundAmount).toBe(5000)
  })

  it('accepts a partial refund strictly below the captured amount', () => {
    const result = resolveRefund(completedOrder, 2500)
    expect(result.ok).toBe(true)
    expect(result.refundAmount).toBe(2500)
  })

  it('defaults to the full captured amount when no amount_cents supplied', () => {
    const result = resolveRefund(completedOrder, undefined)
    expect(result.ok).toBe(true)
    expect(result.refundAmount).toBe(5000)
  })

  it('defaults to the full captured amount when amount_cents is 0 (falsy)', () => {
    // amount_cents=0 is falsy; the route body schema requires positive
    // so 0 would be rejected upstream, but resolveRefund treats falsy as
    // "full refund" — no divide-by-zero or zero-charge escape hatch.
    const result = resolveRefund(completedOrder, 0)
    expect(result.ok).toBe(true)
    expect(result.refundAmount).toBe(5000)
  })

  // ── Partial vs full + cumulative refunds ───────────────────────────────────

  it('flags a full refund as isFull with the whole amount as the new total', () => {
    const result = resolveRefund(completedOrder, 5000)
    expect(result.ok).toBe(true)
    expect(result.isFull).toBe(true)
    expect(result.newRefundedTotal).toBe(5000)
  })

  it('flags a partial refund as NOT isFull (order stays completed)', () => {
    const result = resolveRefund(completedOrder, 2500)
    expect(result.ok).toBe(true)
    expect(result.isFull).toBe(false)
    expect(result.newRefundedTotal).toBe(2500)
  })

  it('guards against the REMAINING balance after a prior partial refund', () => {
    // €50 order, €20 already refunded → only €30 left; €40 must be rejected.
    const order = { ...completedOrder, refunded_amount_cents: 2000 }
    const result = resolveRefund(order, 4000)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('refund_exceeds_order')
    expect(result.error).toMatch(/3000/)
  })

  it('accepts a top-up refund up to the remaining balance and marks it full', () => {
    const order = { ...completedOrder, refunded_amount_cents: 2000 }
    const result = resolveRefund(order, 3000)
    expect(result.ok).toBe(true)
    expect(result.refundAmount).toBe(3000)
    expect(result.newRefundedTotal).toBe(5000)
    expect(result.isFull).toBe(true)
  })

  it('defaults to refunding the REMAINING balance when no amount is supplied', () => {
    const order = { ...completedOrder, refunded_amount_cents: 2000 }
    const result = resolveRefund(order, undefined)
    expect(result.ok).toBe(true)
    expect(result.refundAmount).toBe(3000)
    expect(result.isFull).toBe(true)
  })

  it('rejects a refund on an already fully-refunded order (balance exhausted)', () => {
    const order = { ...completedOrder, refunded_amount_cents: 5000 }
    const result = resolveRefund(order, undefined)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('already_refunded')
    expect(result.status).toBe(409)
  })
})
