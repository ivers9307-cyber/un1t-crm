// CANCEL-FORM.3 — the form link token. It authorises a WRITE against a
// member's membership on their behalf, so (per start-prefill-token.js's
// docblock) it carries an expiry, and it deliberately never carries the
// contact id: the payload is {link id, exp}, and the cancellation_form_links
// row is the only thing that maps a link to a person.

import { describe, it, expect, beforeAll } from 'vitest'
import crypto from 'node:crypto'
import { signCancellationFormToken, verifyCancellationFormToken, CANCELLATION_FORM_TTL_DAYS } from './token.js'

const LINK = '11111111-2222-3333-4444-555555555555'

beforeAll(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret-for-cancel-form-tokens' })

describe('signCancellationFormToken / verifyCancellationFormToken', () => {
  it('round-trips a link id and reports the expiry', () => {
    const now = Date.UTC(2026, 8, 5)
    const t = signCancellationFormToken({ linkId: LINK, now })
    const out = verifyCancellationFormToken(t, { now })
    expect(out.linkId).toBe(LINK)
    expect(out.exp).toBe(Math.floor(now / 1000) + CANCELLATION_FORM_TTL_DAYS * 24 * 3600)
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(t).not.toContain(LINK)
  })

  it('defaults to a 30-day TTL', () => {
    expect(CANCELLATION_FORM_TTL_DAYS).toBe(30)
  })

  it('refuses a tampered payload and a tampered signature', () => {
    const t = signCancellationFormToken({ linkId: LINK })
    const [payload, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ l: 'someone-else', e: 9e9 })).toString('base64url')
    expect(verifyCancellationFormToken(`${forged}.${sig}`)).toBeNull()
    expect(verifyCancellationFormToken(`${payload}.${Buffer.from('nope').toString('base64url')}`)).toBeNull()
  })

  it('refuses garbage without throwing (length mismatch must not reach timingSafeEqual)', () => {
    for (const bad of ['', 'x', 'a.b', 'a.b.c', null, undefined, 42, {}]) {
      expect(() => verifyCancellationFormToken(bad)).not.toThrow()
      expect(verifyCancellationFormToken(bad)).toBeNull()
    }
  })

  it('expires: a link opened after the TTL resolves to nothing', () => {
    const now = Date.UTC(2026, 8, 5)
    const t = signCancellationFormToken({ linkId: LINK, now })
    expect(verifyCancellationFormToken(t, { now: now + 29 * 86400_000 })).not.toBeNull()
    expect(verifyCancellationFormToken(t, { now: now + 31 * 86400_000 })).toBeNull()
  })

  it('fails closed on a token with no expiry claim', () => {
    const secretless = Buffer.from(JSON.stringify({ l: LINK })).toString('base64url')
    // Sign it properly (same HMAC) so only the missing claim is under test.
    const sig = Buffer.from(crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY).update(secretless).digest()).toString('base64url')
    expect(verifyCancellationFormToken(`${secretless}.${sig}`)).toBeNull()
  })

  it('requires a link id to sign', () => {
    expect(() => signCancellationFormToken({})).toThrow()
  })
})
