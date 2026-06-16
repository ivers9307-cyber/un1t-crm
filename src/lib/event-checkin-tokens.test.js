// Tests for the signed check-in QR token (EVENT-CHECKIN.B). Server-only
// (node:crypto) — kept out of event-checkins.js so the client bundle stays
// crypto-free.

import { describe, it, expect } from 'vitest'
import { signCheckinToken, verifyCheckinToken } from './event-checkin-tokens.js'

const SECRET = 'test-secret-key'
const payload = { eventId: 'e1', registrationId: 'r1', memberId: 'm1' }

describe('signCheckinToken / verifyCheckinToken', () => {
  it('round-trips a valid token', () => {
    const token = signCheckinToken(payload, SECRET)
    expect(typeof token).toBe('string')
    expect(verifyCheckinToken(token, SECRET)).toEqual(payload)
  })

  it('rejects a token signed with a different secret', () => {
    const token = signCheckinToken(payload, SECRET)
    expect(verifyCheckinToken(token, 'other-secret')).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const token = signCheckinToken(payload, SECRET)
    const sig = token.split('.')[1]
    const forged = Buffer.from(JSON.stringify({ e: 'e1', r: 'r1', m: 'mX' })).toString('base64url')
    expect(verifyCheckinToken(`${forged}.${sig}`, SECRET)).toBeNull()
  })

  it('rejects malformed tokens', () => {
    expect(verifyCheckinToken('', SECRET)).toBeNull()
    expect(verifyCheckinToken('abc', SECRET)).toBeNull()
    expect(verifyCheckinToken('a.b.c', SECRET)).toBeNull()
    expect(verifyCheckinToken(null, SECRET)).toBeNull()
  })
})
