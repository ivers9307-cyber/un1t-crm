// REPSET-PUB.3A — the reviewer gate's client-side logic.
//
// Falsifiable against the mutations that would actually cost a review cycle:
// an email match that also fires for a member's own address, a normaliser
// that case-folds the secret (the server does not), a submit gate that reuses
// the digits-only OTP rules (champ's latent trap — an alphanumeric code would
// never enable the button), and an envelope reader that mistakes a 404/429
// body for a token.

import { describe, it, expect } from 'vitest'
import {
  REVIEW_DEMO_EMAIL,
  MIN_GATE_CODE_LENGTH,
  MAX_GATE_CODE_LENGTH,
  isReviewDemoEmail,
  normalizeGateCode,
  isCompleteGateCode,
  reviewLoginOtp,
} from './review-login.js'

describe('REVIEW_DEMO_EMAIL', () => {
  it('matches the server constant exactly, lowercase', () => {
    expect(REVIEW_DEMO_EMAIL).toBe('appreview@un1tdublin.com')
    expect(REVIEW_DEMO_EMAIL).toBe(REVIEW_DEMO_EMAIL.toLowerCase())
  })
})

describe('isReviewDemoEmail', () => {
  it('accepts the demo email as a phone keyboard produces it', () => {
    expect(isReviewDemoEmail(REVIEW_DEMO_EMAIL)).toBe(true)
    expect(isReviewDemoEmail('  AppReview@UN1TDublin.com  ')).toBe(true)
    expect(isReviewDemoEmail('APPREVIEW@UN1TDUBLIN.COM')).toBe(true)
  })

  it('does not fire for anyone else — no prefix, suffix or substring match', () => {
    expect(isReviewDemoEmail('richard@un1tdublin.com')).toBe(false)
    expect(isReviewDemoEmail('appreview@un1tdublin.com.evil.com')).toBe(false)
    expect(isReviewDemoEmail('x.appreview@un1tdublin.com')).toBe(false)
    expect(isReviewDemoEmail('appreview@un1tdublin.co')).toBe(false)
    expect(isReviewDemoEmail('')).toBe(false)
  })

  it('is false for non-strings', () => {
    expect(isReviewDemoEmail(null)).toBe(false)
    expect(isReviewDemoEmail(undefined)).toBe(false)
    expect(isReviewDemoEmail(123)).toBe(false)
    expect(isReviewDemoEmail({})).toBe(false)
  })
})

describe('normalizeGateCode', () => {
  it('strips whitespace anywhere in the value', () => {
    expect(normalizeGateCode('  ab cd\tef\n')).toBe('abcdef')
  })

  it('preserves case and punctuation — the server does NOT case-fold the secret', () => {
    expect(normalizeGateCode('Ab-Cd_9!')).toBe('Ab-Cd_9!')
    expect(normalizeGateCode('MiXeD')).toBe('MiXeD')
  })

  it('keeps non-digits, unlike the emailed-OTP normaliser', () => {
    // mobile/lib/otp.js strips everything but digits; reusing it here is the
    // exact defect this module exists to avoid.
    expect(normalizeGateCode('a1b2c3')).toBe('a1b2c3')
  })

  it('caps a runaway paste', () => {
    expect(normalizeGateCode('x'.repeat(500))).toHaveLength(MAX_GATE_CODE_LENGTH)
  })

  it('is "" for non-strings', () => {
    expect(normalizeGateCode(null)).toBe('')
    expect(normalizeGateCode(undefined)).toBe('')
    expect(normalizeGateCode(12345678)).toBe('')
  })
})

describe('isCompleteGateCode', () => {
  it('is a FLOOR, not an exact length — the screen cannot know the code length', () => {
    expect(isCompleteGateCode('a'.repeat(MIN_GATE_CODE_LENGTH))).toBe(true)
    expect(isCompleteGateCode('a'.repeat(MIN_GATE_CODE_LENGTH + 20))).toBe(true)
  })

  it('rejects a too-short code', () => {
    expect(isCompleteGateCode('a'.repeat(MIN_GATE_CODE_LENGTH - 1))).toBe(false)
    expect(isCompleteGateCode('')).toBe(false)
    expect(isCompleteGateCode('   ')).toBe(false)
  })

  it('enables on an alphanumeric code (champ’s digits-only gate would not)', () => {
    expect(isCompleteGateCode('Rv-2026-x9')).toBe(true)
  })

  it('measures the NORMALISED value, so a spaced paste still counts', () => {
    expect(isCompleteGateCode(' abc def ')).toBe(true)
  })
})

describe('reviewLoginOtp', () => {
  it('returns the token on the success envelope', () => {
    expect(reviewLoginOtp({ success: true, data: { otp: '12345678' } })).toBe('12345678')
  })

  it('returns null for every refusal the route can produce', () => {
    // 404 gate-off, 403 wrong code, 429 throttled, 503 limiter down.
    expect(reviewLoginOtp({ success: false, error: 'Not available' })).toBe(null)
    expect(reviewLoginOtp({ success: false, error: 'Invalid code' })).toBe(null)
    expect(reviewLoginOtp({ success: false, error: 'Too many attempts' })).toBe(null)
    expect(reviewLoginOtp({ success: false, error: 'Try again shortly' })).toBe(null)
    // api()-minted transport failure.
    expect(reviewLoginOtp({ success: false, transport: true, error: 'Network error' })).toBe(null)
  })

  it('returns null for a success-shaped envelope carrying no usable token', () => {
    expect(reviewLoginOtp({ success: true })).toBe(null)
    expect(reviewLoginOtp({ success: true, data: {} })).toBe(null)
    expect(reviewLoginOtp({ success: true, data: { otp: '' } })).toBe(null)
    expect(reviewLoginOtp({ success: true, data: { otp: 12345678 } })).toBe(null)
    // champ's flat shape is NOT this route's envelope — reading it would be a
    // silent contract drift.
    expect(reviewLoginOtp({ success: true, otp: '12345678' })).toBe(null)
  })

  it('returns null for a missing or truthy-but-wrong envelope', () => {
    expect(reviewLoginOtp(null)).toBe(null)
    expect(reviewLoginOtp(undefined)).toBe(null)
    expect(reviewLoginOtp({})).toBe(null)
    // `success: 'true'` is not success.
    expect(reviewLoginOtp({ success: 'true', data: { otp: '1' } })).toBe(null)
  })
})
