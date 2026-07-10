// Tests for the per-host unsubscribe token (HOST-EMAIL.2). HMAC-SHA256 over
// {hostId, contactId} keyed on SUPABASE_SERVICE_ROLE_KEY — same stateless
// pattern as signCheckinToken (event-checkin-tokens.js).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { signHostUnsubToken, verifyHostUnsubToken } from './host-unsubscribe.js'

const SECRET = 'test-service-role-key'
const ids = { hostId: 'host-1', contactId: 'contact-9' }

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
})

afterEach(() => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

describe('signHostUnsubToken / verifyHostUnsubToken', () => {
  it('round-trips a valid token', () => {
    const token = signHostUnsubToken(ids)
    expect(typeof token).toBe('string')
    expect(token.split('.')).toHaveLength(2)
    expect(verifyHostUnsubToken(token)).toEqual(ids)
  })

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = signHostUnsubToken(ids)
    const sig = token.split('.')[1]
    const forged = Buffer.from(JSON.stringify({ h: 'host-1', c: 'someone-else' })).toString('base64url')
    expect(verifyHostUnsubToken(`${forged}.${sig}`)).toBeNull()
  })

  it('rejects a tampered signature', () => {
    const token = signHostUnsubToken(ids)
    const [payload, sig] = token.split('.')
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
    expect(verifyHostUnsubToken(`${payload}.${flipped}`)).toBeNull()
  })

  it('rejects a token signed under a different secret', () => {
    const token = signHostUnsubToken(ids)
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'another-secret'
    expect(verifyHostUnsubToken(token)).toBeNull()
  })

  it('rejects malformed tokens', () => {
    expect(verifyHostUnsubToken('')).toBeNull()
    expect(verifyHostUnsubToken('abc')).toBeNull()
    expect(verifyHostUnsubToken('a.b.c')).toBeNull()
    expect(verifyHostUnsubToken(null)).toBeNull()
    expect(verifyHostUnsubToken(undefined)).toBeNull()
    // Valid HMAC over a payload missing the required fields → still rejected.
    const partial = Buffer.from(JSON.stringify({ h: 'host-only' })).toString('base64url')
    const crypto = require('node:crypto')
    const sig = Buffer.from(crypto.createHmac('sha256', SECRET).update(partial).digest()).toString('base64url')
    expect(verifyHostUnsubToken(`${partial}.${sig}`)).toBeNull()
  })

  it('throws a clear config error when SUPABASE_SERVICE_ROLE_KEY is unset', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect(() => signHostUnsubToken(ids)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
    expect(() => verifyHostUnsubToken('a.b')).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
  })
})
