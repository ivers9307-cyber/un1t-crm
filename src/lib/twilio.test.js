// Tests for src/lib/twilio.js — alpha sender ID resolution +
// validation. We don't exercise the network call here (sendSms is
// integration-tested via the deposit flow); these are pure-function
// guarantees for the per-location helpers added in mig 059.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getLocationSenderId, validateAlphaSenderId, toE164Ireland,
  effectiveSenderLocation, getOrgDefaultSenderId,
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

// SENDER-ORG-FALLBACK — host events sit on a per-host anchor location with no
// Twilio sender; without an org-aware fallback they resolve to the global
// TWILIO_FROM default (the CCF Autos sender), so a UN1T event texts from the
// wrong brand. These pin the two helpers that let a senderless UN1T location
// text from its own org's sender instead.
describe('effectiveSenderLocation', () => {
  it('leaves a location that already has its own sender untouched', () => {
    const loc = { twilio_alpha_sender_id: 'UN1THATCH', organization_id: 'org1' }
    expect(effectiveSenderLocation(loc, 'UN1T Dub')).toBe(loc)
  })

  it('applies the org sender when the location has none', () => {
    const loc = { twilio_alpha_sender_id: null, organization_id: 'org1' }
    const out = effectiveSenderLocation(loc, 'UN1T Dub')
    expect(out.twilio_alpha_sender_id).toBe('UN1T Dub')
    // end-to-end: the resolved sender is now the org's, not the CCFautos default
    expect(getLocationSenderId(out)).toBe('UN1T Dub')
  })

  it('leaves the location unchanged when there is no org sender to apply', () => {
    const loc = { twilio_alpha_sender_id: null, organization_id: 'org1' }
    expect(effectiveSenderLocation(loc, null)).toBe(loc)
  })

  it('tolerates a null location', () => {
    expect(effectiveSenderLocation(null, 'UN1T Dub')).toBeNull()
  })
})

describe('getOrgDefaultSenderId', () => {
  function stubDb(result) {
    const b = {
      from: () => b, select: () => b, eq: () => b,
      not: () => b, order: () => b, limit: () => Promise.resolve(result),
    }
    return b
  }

  it('returns the org location sender when one exists', async () => {
    const db = stubDb({ data: [{ twilio_alpha_sender_id: 'UN1T Dub' }], error: null })
    expect(await getOrgDefaultSenderId(db, 'org1')).toBe('UN1T Dub')
  })

  it('returns null when the org has no location with a sender', async () => {
    const db = stubDb({ data: [], error: null })
    expect(await getOrgDefaultSenderId(db, 'org1')).toBeNull()
  })

  it('returns null on a query error (never guesses a sender)', async () => {
    const db = stubDb({ data: null, error: { message: 'boom' } })
    expect(await getOrgDefaultSenderId(db, 'org1')).toBeNull()
  })

  it('does not query when no organization id is given', async () => {
    const db = { from() { throw new Error('should not query without an org id') } }
    expect(await getOrgDefaultSenderId(db, null)).toBeNull()
  })
})

describe('validateAlphaSenderId', () => {
  it('accepts valid 11-char alphanumeric IDs', () => {
    expect(validateAlphaSenderId('UN1T')).toBeNull()
    expect(validateAlphaSenderId('UN1THATCH')).toBeNull()
    expect(validateAlphaSenderId('CCFautos')).toBeNull()
    expect(validateAlphaSenderId('A1B2C3D4E5F')).toBeNull() // 11 chars exactly
  })

  it('accepts spaces between words (Twilio allows the space character, ≤11 chars)', () => {
    expect(validateAlphaSenderId('UN1T STILL')).toBeNull() // 10 chars incl. the space
    expect(validateAlphaSenderId('UN1T HATCH')).toBeNull()
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

  it('rejects punctuation (hyphen, dot, etc.)', () => {
    expect(validateAlphaSenderId('UN1T-Hatch')).toMatch(/letters, numbers and spaces/i)
    expect(validateAlphaSenderId('UN1T.Hatch')).toMatch(/letters, numbers and spaces/i)
  })

  it('rejects leading or trailing spaces', () => {
    expect(validateAlphaSenderId(' UN1T')).toMatch(/start or end with a space/i)
    expect(validateAlphaSenderId('UN1T ')).toMatch(/start or end with a space/i)
  })

  it('requires at least one letter (rejects all-number / all-space IDs)', () => {
    expect(validateAlphaSenderId('12345')).toMatch(/at least one letter/i)
    expect(validateAlphaSenderId('   ')).toBeTruthy() // rejected — it has leading/trailing space
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
