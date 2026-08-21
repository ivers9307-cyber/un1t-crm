// STARTPREFILL.1 — the token resolves to a person's name, email and phone, so
// every one of these is a security property rather than a nicety.

import { describe, it, expect, beforeAll } from 'vitest'
import { signStartPrefillToken, verifyStartPrefillToken, PREFILL_TTL_DAYS } from './start-prefill-token.js'

const CONTACT = '11111111-2222-3333-4444-555555555555'

beforeAll(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret-for-prefill-tokens'
})

describe('signStartPrefillToken / verifyStartPrefillToken', () => {
  it('round-trips a contact id', () => {
    const t = signStartPrefillToken({ contactId: CONTACT })
    expect(verifyStartPrefillToken(t)).toEqual({ contactId: CONTACT })
  })

  it('refuses a tampered payload', () => {
    const t = signStartPrefillToken({ contactId: CONTACT })
    const [, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ c: 'someone-else', e: 9e9 })).toString('base64url')
    expect(verifyStartPrefillToken(`${forged}.${sig}`)).toBeNull()
  })

  it('refuses a tampered signature', () => {
    const [payload] = signStartPrefillToken({ contactId: CONTACT }).split('.')
    expect(verifyStartPrefillToken(`${payload}.${Buffer.from('nope').toString('base64url')}`)).toBeNull()
  })

  it('refuses garbage without throwing — a length mismatch must not reach timingSafeEqual', () => {
    // crypto.timingSafeEqual THROWS on differing lengths, and the attacker
    // controls the length, so the guard has to come first.
    for (const bad of ['', 'x', 'a.b', 'a.b.c', null, undefined, 42, {}]) {
      expect(() => verifyStartPrefillToken(bad)).not.toThrow()
      expect(verifyStartPrefillToken(bad)).toBeNull()
    }
  })

  it('EXPIRES — a forwarded link goes stale rather than disclosing details forever', () => {
    const now = Date.parse('2026-08-21T00:00:00Z')
    const t = signStartPrefillToken({ contactId: CONTACT, ttlDays: 10, now })
    const dayMs = 24 * 3600 * 1000
    expect(verifyStartPrefillToken(t, { now: now + 9 * dayMs })).toEqual({ contactId: CONTACT })
    expect(verifyStartPrefillToken(t, { now: now + 11 * dayMs })).toBeNull()
  })

  it('fails CLOSED on a token carrying no expiry claim', () => {
    // A hand-made or pre-STARTPREFILL.1 token must not fall back to "valid
    // forever" — unbounded validity is the exact thing the expiry prevents.
    const crypto = require('node:crypto')
    const payload = Buffer.from(JSON.stringify({ c: CONTACT })).toString('base64url')
    const sig = Buffer.from(
      crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY).update(payload).digest(),
    ).toString('base64url')
    expect(verifyStartPrefillToken(`${payload}.${sig}`)).toBeNull()
  })

  it('refuses a token signed under a different secret', () => {
    const t = signStartPrefillToken({ contactId: CONTACT })
    const original = process.env.SUPABASE_SERVICE_ROLE_KEY
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'rotated-secret'
    try {
      // This is the revocation story: rotating the secret invalidates every
      // outstanding token estate-wide, with no table to purge.
      expect(verifyStartPrefillToken(t)).toBeNull()
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = original
    }
  })

  it('requires a contactId to sign', () => {
    expect(() => signStartPrefillToken({ contactId: '' })).toThrow(/contactId is required/)
  })

  it('produces a URL-safe token — it travels in a query string', () => {
    const t = signStartPrefillToken({ contactId: CONTACT })
    expect(t).toBe(encodeURIComponent(t))
  })

  it('defaults to a bounded TTL, not forever', () => {
    expect(PREFILL_TTL_DAYS).toBeGreaterThan(0)
    expect(PREFILL_TTL_DAYS).toBeLessThanOrEqual(90)
  })
})
