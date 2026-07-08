// Payments dispatcher (EVENTS-HOST.1) — provider routing + adapter shape.

import { describe, it, expect } from 'vitest'
import { paymentsFor, PAYMENT_PROVIDERS } from './index.js'

describe('paymentsFor — provider dispatch', () => {
  it('routes "revolut" to an adapter exposing the full payment interface', () => {
    const a = paymentsFor('revolut')
    expect(a.provider).toBe('revolut')
    expect(typeof a.createPayment).toBe('function')
    expect(typeof a.getPayment).toBe('function')
    expect(typeof a.refundPayment).toBe('function')
  })

  it('routes "stripe_connect" to the stub adapter (same interface)', () => {
    const a = paymentsFor('stripe_connect')
    expect(a.provider).toBe('stripe_connect')
    expect(typeof a.createPayment).toBe('function')
    expect(typeof a.getPayment).toBe('function')
    expect(typeof a.refundPayment).toBe('function')
  })

  it('throws on an unknown provider (no silent fall-through to a default)', () => {
    expect(() => paymentsFor('paypal')).toThrow(/Unknown payment provider/)
  })

  it('exposes both known providers', () => {
    expect(PAYMENT_PROVIDERS).toContain('revolut')
    expect(PAYMENT_PROVIDERS).toContain('stripe_connect')
  })

  it('the stripe_connect adapter validates charge + refund inputs (both need the connected account)', async () => {
    const a = paymentsFor('stripe_connect')
    // createPayment is wired (EVENTS-HOST.3): it validates inputs (a direct
    // charge needs the host connected account id) rather than being a blanket stub.
    await expect(a.createPayment({})).rejects.toThrow(/connected account/)
    // refundPayment is wired (EVENTS-HOST.7): refunds on the connected account,
    // so a missing account id fails loud before any Stripe call.
    await expect(a.refundPayment('cs_x', {})).rejects.toThrow(/connected account/)
  })
})
