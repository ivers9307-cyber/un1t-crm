// Tests for src/lib/twilio.js — alpha sender ID resolution +
// validation. We don't exercise the network call here (sendSms is
// integration-tested via the deposit flow); these are pure-function
// guarantees for the per-location helpers added in mig 059.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getLocationSenderId, validateAlphaSenderId, toE164Ireland,
} from './twilio.js'

describe('getLocationSenderId', () => {
  // Snapshot env so tests are isolated.
  const ORIG = process.env.TWILIO_FROM
  beforeEach(() => { delete process.env.TWILIO_FROM })
  afterEach(() => {
    if (ORIG === undefined) delete process.env.TWILIO_FROM
    else process.env.TWILIO_FROM = ORIG
  })

  it('prefers the per-location sender ID when set', () => {
    process.env.TWILIO_FROM = 'CCFautos'
    const loc = { twilio_alpha_sender_id: 'UN1T' }
    expect(getLocationSenderId(loc)).toBe('UN1T')
  })

  it('falls back to TWILIO_FROM when the per-location field is null', () => {
    process.env.TWILIO_FROM = 'CCFautos'
    expect(getLocationSenderId({ twilio_alpha_sender_id: null })).toBe('CCFautos')
  })

  it('falls back to TWILIO_FROM when no location is provided', () => {
    process.env.TWILIO_FROM = 'CCFautos'
    expect(getLocationSenderId(null)).toBe('CCFautos')
    expect(getLocationSenderId(undefined)).toBe('CCFautos')
  })

  it('falls back to the literal default when neither location nor env is set', () => {
    // No TWILIO_FROM in env (cleared above), no location.
    expect(getLocationSenderId(null)).toBe('CCFautos')
  })

  it('treats empty string per-location as missing (so admin can clear it)', () => {
    process.env.TWILIO_FROM = 'CCFautos'
    expect(getLocationSenderId({ twilio_alpha_sender_id: '' })).toBe('CCFautos')
  })
})

describe('validateAlphaSenderId', () => {
  it('accepts valid 11-char alphanumeric IDs', () => {
    expect(validateAlphaSenderId('UN1T')).toBeNull()
    expect(validateAlphaSenderId('UN1THATCH')).toBeNull()
    expect(validateAlphaSenderId('CCFautos')).toBeNull()
    expect(validateAlphaSenderId('A1B2C3D4E5F')).toBeNull() // 11 chars exactly
  })

  it('rejects empty / non-string', () => {
    expect(validateAlphaSenderId('')).toMatch(/empty/i)
    expect(validateAlphaSenderId(null)).toMatch(/string/i)
    expect(validateAlphaSenderId(undefined)).toMatch(/string/i)
    expect(validateAlphaSenderId(42)).toMatch(/string/i)
  })

  it('rejects > 11 chars', () => {
    expect(validateAlphaSenderId('TWELVECHARSXX')).toMatch(/exceed 11/i)
  })

  it('rejects spaces / punctuation', () => {
    expect(validateAlphaSenderId('UN1T HATCH')).toMatch(/alphanumeric/i)
    expect(validateAlphaSenderId('UN1T-Hatch')).toMatch(/alphanumeric/i)
    expect(validateAlphaSenderId('UN1T.Hatch')).toMatch(/alphanumeric/i)
  })
})

describe('toE164Ireland (regression coverage)', () => {
  // Pre-existing helper — keep coverage alive while we touch
  // the surrounding file.
  it('normalises common Irish phone shapes to E.164', () => {
    expect(toE164Ireland('0871234567')).toBe('+353871234567')
    expect(toE164Ireland('+353871234567')).toBe('+353871234567')
    expect(toE164Ireland('353871234567')).toBe('+353871234567')
    expect(toE164Ireland('00353871234567')).toBe('+353871234567')
  })
})
