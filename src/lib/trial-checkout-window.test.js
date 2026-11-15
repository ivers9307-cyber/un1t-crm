// TRIALLEAK.1 — one number (how long a /trial order stays payable) and the
// rules that hang off it: when a row's checkout may still be handed out, how
// an ended order is read (ran out of time vs refused), and which in-app
// browser a user agent is.
import { describe, it, expect } from 'vitest'
import {
  TRIAL_CHECKOUT_EXPIRE_SECONDS, TRIAL_CHECKOUT_EXPIRE_AFTER, TRIAL_CHECKOUT_REUSE_MS,
  trialCheckoutUsable, trialPaymentFailure, inAppBrowserFromUserAgent,
  UN1T_CHECKOUT_REUSE_MS, UN1T_TRIAL_RESUME_MAX_AGE_MS, UN1T_TRIAL_RESUME_LINK_MS, un1tTrialRetryable,
} from './trial-checkout-window'
import { normaliseExpirePendingAfter } from './revolut-order-fields'

const NOW = Date.parse('2026-11-14T12:00:00.000Z')
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString()
const OPEN = { status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'revolut', payment_checkout_token: 'tok' }

describe('the window', () => {
  it('is two hours, as a duration Revolut accepts, and the reuse window sits inside it', () => {
    expect(TRIAL_CHECKOUT_EXPIRE_SECONDS).toBe(7200)
    expect(TRIAL_CHECKOUT_EXPIRE_AFTER).toBe('PT2H')
    expect(normaliseExpirePendingAfter(TRIAL_CHECKOUT_EXPIRE_AFTER)).toBe('PT2H')
    expect(TRIAL_CHECKOUT_REUSE_MS).toBe(110 * 60_000)
    expect(TRIAL_CHECKOUT_REUSE_MS).toBeLessThan(TRIAL_CHECKOUT_EXPIRE_SECONDS * 1000)
  })
})

describe('trialCheckoutUsable', () => {
  it('an open Revolut row with a token is usable until the reuse window closes', () => {
    expect(trialCheckoutUsable({ ...OPEN, created_at: ago(1) }, NOW)).toBe(true)
    expect(trialCheckoutUsable({ ...OPEN, created_at: ago(109) }, NOW)).toBe(true)
    expect(trialCheckoutUsable({ ...OPEN, created_at: ago(110) }, NOW)).toBe(false)
    expect(trialCheckoutUsable({ ...OPEN, created_at: ago(300) }, NOW)).toBe(false)
  })
  it('never a Hatch Street row, a row with no token, a settled row, or one with no readable age', () => {
    expect(trialCheckoutUsable({ ...OPEN, payment_provider: 'un1t_online', created_at: ago(1) }, NOW)).toBe(false)
    expect(trialCheckoutUsable({ ...OPEN, payment_checkout_token: null, created_at: ago(1) }, NOW)).toBe(false)
    expect(trialCheckoutUsable({ ...OPEN, payment_status: 'paid', created_at: ago(1) }, NOW)).toBe(false)
    expect(trialCheckoutUsable({ ...OPEN, status: 'payment_failed', created_at: ago(1) }, NOW)).toBe(false)
    expect(trialCheckoutUsable({ ...OPEN, payment_status: null, created_at: ago(1) }, NOW)).toBe(false)
    expect(trialCheckoutUsable({ ...OPEN }, NOW)).toBe(false)
    expect(trialCheckoutUsable({ ...OPEN, created_at: 'nonsense' }, NOW)).toBe(false)
    expect(trialCheckoutUsable(null, NOW)).toBe(false)
  })
})

describe('trialPaymentFailure', () => {
  it('a failed order inside its two hours is a refused payment', () => {
    expect(trialPaymentFailure('FAILED', { created_at: ago(5) }, NOW)).toEqual({ payment_status: 'failed', reason: 'payment_declined' })
    expect(trialPaymentFailure('failed', { created_at: ago(100) }, NOW)).toEqual({ payment_status: 'failed', reason: 'payment_declined' })
  })
  it('a failed order whose time is up is a checkout that expired (Revolut reports both as failed)', () => {
    expect(trialPaymentFailure('failed', { created_at: ago(120) }, NOW)).toEqual({ payment_status: 'expired', reason: 'checkout_expired' })
    expect(trialPaymentFailure('failed', { created_at: ago(119) }, NOW)).toEqual({ payment_status: 'expired', reason: 'checkout_expired' })
  })
  it('a failed order with no readable age stays a refusal', () => {
    expect(trialPaymentFailure('failed', {}, NOW)).toEqual({ payment_status: 'failed', reason: 'payment_declined' })
  })
  it('cancelled and expired say which they were; anything else is not an ending', () => {
    expect(trialPaymentFailure('cancelled', { created_at: ago(5) }, NOW)).toEqual({ payment_status: 'expired', reason: 'checkout_cancelled' })
    expect(trialPaymentFailure('expired', { created_at: ago(5) }, NOW)).toEqual({ payment_status: 'expired', reason: 'checkout_expired' })
    for (const s of ['pending', 'authorised', 'processing', 'completed', '', null]) expect(trialPaymentFailure(s, { created_at: ago(500) }, NOW)).toBeNull()
  })
})

describe('inAppBrowserFromUserAgent', () => {
  const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  it('names Facebook and Instagram, Instagram first', () => {
    expect(inAppBrowserFromUserAgent(`${IOS} [FBAN/FBIOS;FBAV/480.0.0.0;FBBV/1]`)).toBe('facebook')
    expect(inAppBrowserFromUserAgent('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0]')).toBe('facebook')
    expect(inAppBrowserFromUserAgent(`${IOS} Instagram 350.0.0.0 (iPhone16,1; iOS 18_1)`)).toBe('instagram')
    expect(inAppBrowserFromUserAgent(`${IOS} Instagram 350.0 [FBAN/FBIOS;FBAV/1]`)).toBe('instagram')
  })
  it('is null for an ordinary browser or no user agent', () => {
    expect(inAppBrowserFromUserAgent(`${IOS} Version/18.1 Safari/604.1`)).toBeNull()
    expect(inAppBrowserFromUserAgent('')).toBeNull()
    expect(inAppBrowserFromUserAgent(undefined)).toBeNull()
    expect(inAppBrowserFromUserAgent(null)).toBeNull()
  })
})

// HATCHTRACK.1 — Hatch Street (un1t.online's hosted checkout).
describe('un1tTrialRetryable', () => {
  const HATCH = { status: 'awaiting_payment', payment_status: 'pending', payment_provider: 'un1t_online', un1t_user_id: 'u-1', un1t_product_id: 'p-1', created_at: new Date(NOW - 60 * 60_000).toISOString() }
  it('an unpaid Hatch row that carries its un1t.online account and product can go back to payment', () => {
    expect(un1tTrialRetryable(HATCH, NOW)).toBe(true)
    // A day and a half on: the settle sweep may still hold it open for a later checkout.
    expect(un1tTrialRetryable({ ...HATCH, created_at: new Date(NOW - 36 * 3_600_000).toISOString() }, NOW)).toBe(true)
  })
  it('never a Stillorgan row, a settled, expired or held one, one with no account, or one past the resume age', () => {
    for (const over of [
      { payment_provider: 'revolut' }, { payment_provider: null }, { status: 'granted' }, { status: 'expired' }, { status: 'help_requested' },
      { status: 'failed' }, { un1t_user_id: null }, { un1t_product_id: '' }, { created_at: null }, { created_at: 'nonsense' },
      { created_at: new Date(NOW - UN1T_TRIAL_RESUME_MAX_AGE_MS).toISOString() }, { created_at: new Date(NOW + 60_000).toISOString() },
    ]) expect(un1tTrialRetryable({ ...HATCH, ...over }, NOW)).toBe(false)
    expect(un1tTrialRetryable(null, NOW)).toBe(false)
  })
  it('a Hatch row is never "usable" by the embedded-checkout rule, and a Revolut row never retryable', () => {
    expect(trialCheckoutUsable(HATCH, NOW)).toBe(false)
    expect(un1tTrialRetryable({ ...HATCH, payment_provider: 'revolut', payment_checkout_token: 'tok' }, NOW)).toBe(false)
  })
  it('the windows: a stored URL is reused for less than Stripe\'s 30-minute floor; the email names the purchase for less than the row\'s life', () => {
    expect(UN1T_CHECKOUT_REUSE_MS).toBe(20 * 60_000)
    expect(UN1T_CHECKOUT_REUSE_MS).toBeLessThan(30 * 60_000)
    expect(UN1T_TRIAL_RESUME_LINK_MS).toBe(24 * 60 * 60_000)
    expect(UN1T_TRIAL_RESUME_LINK_MS).toBeLessThan(24 * 60 * 60_000 + 45 * 60_000) // UN1T_TRIAL_EXPIRY_MS
    expect(UN1T_TRIAL_RESUME_MAX_AGE_MS).toBe(72 * 60 * 60_000)
  })
})
