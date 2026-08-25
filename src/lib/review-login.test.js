// REPSET-PUB.3A — the reviewer gate's pure decisions.
//
// These are deliberately falsifiable against the mutations that would
// actually hurt: a truthy `configuredCode` default, a substring/prefix
// compare, a case-folded secret, a `||` where an `&&` belongs, an
// x-forwarded-for reader that returns the LAST hop (attacker-controlled) or
// an empty bucket that every un-attributable attempt would then share with
// nobody.

import { describe, it, expect } from 'vitest'
import {
  REVIEW_DEMO_EMAIL,
  constantTimeEquals,
  readReviewCode,
  credentialsMatch,
} from './review-login.js'

// Fabricated test-only gate code — never a real reviewer code.
const TEST_CODE = 'Test-Gate-Code-9f2b'

describe('REVIEW_DEMO_EMAIL', () => {
  it('is the one member-only demo account, lowercase', () => {
    expect(REVIEW_DEMO_EMAIL).toBe('appreview@un1tdublin.com')
    expect(REVIEW_DEMO_EMAIL).toBe(REVIEW_DEMO_EMAIL.toLowerCase())
  })
})

describe('constantTimeEquals', () => {
  it('is true only for an exact match', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true)
    expect(constantTimeEquals('', '')).toBe(true)
  })

  it('is false for a prefix, a suffix and a case difference', () => {
    expect(constantTimeEquals('abc', 'ab')).toBe(false)
    expect(constantTimeEquals('ab', 'abc')).toBe(false)
    expect(constantTimeEquals('abc', 'abcd')).toBe(false)
    expect(constantTimeEquals('abc', 'ABC')).toBe(false)
  })

  it('handles different lengths without throwing (the timingSafeEqual trap)', () => {
    // node:crypto's timingSafeEqual throws on unequal-length buffers; hashing
    // both sides first is what makes this safe AND length-blind.
    expect(() => constantTimeEquals('a', 'a-much-longer-value')).not.toThrow()
    expect(constantTimeEquals('a', 'a-much-longer-value')).toBe(false)
  })

  it('is false for anything that is not a string on either side', () => {
    expect(constantTimeEquals(null, 'abc')).toBe(false)
    expect(constantTimeEquals('abc', null)).toBe(false)
    expect(constantTimeEquals(undefined, undefined)).toBe(false)
    expect(constantTimeEquals(123, 123)).toBe(false)
    expect(constantTimeEquals({}, {})).toBe(false)
  })
})

describe('readReviewCode', () => {
  it('returns null when unset — there is NO source fallback', () => {
    expect(readReviewCode({})).toBe(null)
    expect(readReviewCode({ REVIEW_LOGIN_CODE: undefined })).toBe(null)
  })

  it('treats blank and whitespace-only as unset (still OFF)', () => {
    expect(readReviewCode({ REVIEW_LOGIN_CODE: '' })).toBe(null)
    expect(readReviewCode({ REVIEW_LOGIN_CODE: '   ' })).toBe(null)
    expect(readReviewCode({ REVIEW_LOGIN_CODE: '\n\t' })).toBe(null)
  })

  it('returns the trimmed code when set', () => {
    expect(readReviewCode({ REVIEW_LOGIN_CODE: TEST_CODE })).toBe(TEST_CODE)
    expect(readReviewCode({ REVIEW_LOGIN_CODE: `  ${TEST_CODE}  ` })).toBe(TEST_CODE)
  })

  it('ignores non-string env values', () => {
    expect(readReviewCode({ REVIEW_LOGIN_CODE: 12345678 })).toBe(null)
  })
})

describe('credentialsMatch', () => {
  const ok = (over = {}) =>
    credentialsMatch({ configuredCode: TEST_CODE, email: REVIEW_DEMO_EMAIL, code: TEST_CODE, ...over })

  it('opens only on the exact demo email + exact configured code', () => {
    expect(ok()).toBe(true)
  })

  it('normalises the typed email (trim + case) — it is typed on a phone', () => {
    expect(ok({ email: '  AppReview@UN1TDublin.com ' })).toBe(true)
  })

  it('refuses any other email even with the right code', () => {
    expect(ok({ email: 'someone@else.com' })).toBe(false)
    expect(ok({ email: '' })).toBe(false)
    expect(ok({ email: null })).toBe(false)
    // Not a prefix/suffix match either.
    expect(ok({ email: 'x' + REVIEW_DEMO_EMAIL })).toBe(false)
    expect(ok({ email: REVIEW_DEMO_EMAIL.slice(0, -1) })).toBe(false)
  })

  it('refuses a wrong code even with the right email', () => {
    expect(ok({ code: 'wrong' })).toBe(false)
    expect(ok({ code: '' })).toBe(false)
    expect(ok({ code: null })).toBe(false)
    expect(ok({ code: TEST_CODE.slice(0, -1) })).toBe(false)
    expect(ok({ code: TEST_CODE + 'x' })).toBe(false)
  })

  it('does NOT case-fold the secret', () => {
    expect(ok({ code: TEST_CODE.toLowerCase() })).toBe(false)
    expect(ok({ code: TEST_CODE.toUpperCase() })).toBe(false)
  })

  it('trims the typed code (a pasted code can carry whitespace)', () => {
    expect(ok({ code: `  ${TEST_CODE}\n` })).toBe(true)
  })

  it('is closed when no code is configured, whatever is supplied', () => {
    expect(credentialsMatch({ configuredCode: null, email: REVIEW_DEMO_EMAIL, code: TEST_CODE })).toBe(false)
    expect(credentialsMatch({ configuredCode: '', email: REVIEW_DEMO_EMAIL, code: '' })).toBe(false)
    // The dangerous mutation: an unset code matching an unset submission.
    expect(credentialsMatch({ configuredCode: undefined, email: REVIEW_DEMO_EMAIL, code: undefined })).toBe(false)
  })
})
