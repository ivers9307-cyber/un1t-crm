import { describe, it, expect } from 'vitest'
import { resolveLocationPaymentProvider, locationCanTakePayments } from './location-payments'

const loc = (payments) => ({ settings: { payments } })

describe('resolveLocationPaymentProvider', () => {
  it('defaults to revolut when unset', () => {
    expect(resolveLocationPaymentProvider(loc(undefined))).toEqual({ provider: 'revolut', connectedAccountId: null })
    expect(resolveLocationPaymentProvider({})).toEqual({ provider: 'revolut', connectedAccountId: null })
  })
  it('returns stripe_connect with the connected account when configured', () => {
    expect(resolveLocationPaymentProvider(loc({ provider: 'stripe_connect', stripe_connected_account_id: 'acct_1' })))
      .toEqual({ provider: 'stripe_connect', connectedAccountId: 'acct_1' })
  })
  it('falls back to revolut for an unknown provider value', () => {
    expect(resolveLocationPaymentProvider(loc({ provider: 'paypal' })).provider).toBe('revolut')
  })
})

describe('locationCanTakePayments', () => {
  it('revolut is always able', () => {
    expect(locationCanTakePayments(loc({ provider: 'revolut' }))).toBe(true)
    expect(locationCanTakePayments(loc(undefined))).toBe(true)
  })
  it('stripe_connect needs a connected account', () => {
    expect(locationCanTakePayments(loc({ provider: 'stripe_connect' }))).toBe(false)
    expect(locationCanTakePayments(loc({ provider: 'stripe_connect', stripe_connected_account_id: 'acct_1' }))).toBe(true)
  })
})
