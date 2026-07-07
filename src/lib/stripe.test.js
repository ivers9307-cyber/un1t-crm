// Stripe client config guards (EVENTS-HOST.2). The key check runs BEFORE the
// singleton cache, so "unset → throws" holds regardless of test order.

import { describe, it, expect, afterEach } from 'vitest'
import { getStripe, isStripeConfigured, verifyStripeWebhook } from './stripe.js'

const origKey = process.env.STRIPE_SECRET_KEY
const origWh = process.env.STRIPE_WEBHOOK_SECRET

afterEach(() => {
  if (origKey === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = origKey
  if (origWh === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
  else process.env.STRIPE_WEBHOOK_SECRET = origWh
})

describe('stripe client config', () => {
  it('getStripe throws a clear error when STRIPE_SECRET_KEY is unset', () => {
    delete process.env.STRIPE_SECRET_KEY
    expect(() => getStripe()).toThrow(/STRIPE_SECRET_KEY is not configured/)
  })

  it('isStripeConfigured reflects the env var', () => {
    delete process.env.STRIPE_SECRET_KEY
    expect(isStripeConfigured()).toBe(false)
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
    expect(isStripeConfigured()).toBe(true)
  })

  it('verifyStripeWebhook throws when STRIPE_WEBHOOK_SECRET is unset', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
    delete process.env.STRIPE_WEBHOOK_SECRET
    expect(() => verifyStripeWebhook('{}', 'sig')).toThrow(/STRIPE_WEBHOOK_SECRET is not configured/)
  })
})
