// Event host routing + marketplace fee math (EVENTS-HOST.1).

import { describe, it, expect } from 'vitest'
import {
  resolvePaymentProvider,
  computeApplicationFeeCents,
  hostCanTakePayments,
} from './event-hosts.js'

describe('resolvePaymentProvider', () => {
  it('routes internal (null host) events to Revolut', () => {
    expect(resolvePaymentProvider(null)).toBe('revolut')
    expect(resolvePaymentProvider(undefined)).toBe('revolut')
  })
  it('routes a stripe_connect host to Stripe Connect', () => {
    expect(resolvePaymentProvider({ payment_provider: 'stripe_connect' })).toBe('stripe_connect')
  })
  it('routes a revolut host to Revolut', () => {
    expect(resolvePaymentProvider({ payment_provider: 'revolut' })).toBe('revolut')
  })
  it('falls back to Revolut for an unexpected provider value', () => {
    expect(resolvePaymentProvider({ payment_provider: 'sumup' })).toBe('revolut')
  })
})

describe('computeApplicationFeeCents — €2/ticket booking fee', () => {
  const host = { payment_provider: 'stripe_connect', platform_fee_cents: 200 }

  it('is per-ticket: €2 × seats', () => {
    expect(computeApplicationFeeCents(host, 1)).toBe(200)
    expect(computeApplicationFeeCents(host, 4)).toBe(800)
  })
  it('is zero for internal (null host) events', () => {
    expect(computeApplicationFeeCents(null, 4)).toBe(0)
  })
  it('is zero for a Revolut host (no application fee on Revolut)', () => {
    expect(computeApplicationFeeCents({ payment_provider: 'revolut', platform_fee_cents: 200 }, 4)).toBe(0)
  })
  it('is zero when the host fee is unset/zero', () => {
    expect(computeApplicationFeeCents({ payment_provider: 'stripe_connect', platform_fee_cents: 0 }, 4)).toBe(0)
    expect(computeApplicationFeeCents({ payment_provider: 'stripe_connect' }, 4)).toBe(0)
  })
  it('never goes negative and floors fractional seat counts', () => {
    expect(computeApplicationFeeCents(host, -3)).toBe(0)
    expect(computeApplicationFeeCents(host, 2.9)).toBe(400)
  })
})

describe('hostCanTakePayments', () => {
  it('internal (null host) events can always charge', () => {
    expect(hostCanTakePayments(null)).toBe(true)
  })
  it('a stripe_connect host must have completed onboarding (charges_enabled)', () => {
    expect(hostCanTakePayments({ payment_provider: 'stripe_connect', charges_enabled: false })).toBe(false)
    expect(hostCanTakePayments({ payment_provider: 'stripe_connect', charges_enabled: true })).toBe(true)
  })
  it('a revolut host can always charge', () => {
    expect(hostCanTakePayments({ payment_provider: 'revolut' })).toBe(true)
  })
})
