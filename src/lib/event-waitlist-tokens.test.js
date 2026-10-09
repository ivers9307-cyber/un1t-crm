import { describe, it, expect } from 'vitest'
import { signWaitlistClaimToken, verifyWaitlistClaimToken, WAITLIST_CLAIM_TTL_DAYS } from './event-waitlist-tokens'
import { signCheckinToken } from './event-checkin-tokens'

const SECRET = 'test-secret'
const NOW = Date.parse('2026-10-09T12:00:00Z')

describe('waitlist claim tokens', () => {
  it('round-trips the waitlist id', () => {
    const t = signWaitlistClaimToken({ waitlistId: 'wl-1', now: NOW }, SECRET)
    expect(verifyWaitlistClaimToken(t, SECRET, { now: NOW })).toEqual({ waitlistId: 'wl-1' })
  })

  it('is URL-safe', () => {
    const t = signWaitlistClaimToken({ waitlistId: 'wl-1', now: NOW }, SECRET)
    expect(encodeURIComponent(t)).toBe(t)
  })

  it(`expires after ${WAITLIST_CLAIM_TTL_DAYS} days`, () => {
    const t = signWaitlistClaimToken({ waitlistId: 'wl-1', now: NOW }, SECRET)
    const day = 24 * 3600 * 1000
    expect(verifyWaitlistClaimToken(t, SECRET, { now: NOW + 13 * day })).toEqual({ waitlistId: 'wl-1' })
    expect(verifyWaitlistClaimToken(t, SECRET, { now: NOW + 15 * day })).toBeNull()
  })

  it('refuses another secret, a tampered payload and junk', () => {
    const t = signWaitlistClaimToken({ waitlistId: 'wl-1', now: NOW }, SECRET)
    expect(verifyWaitlistClaimToken(t, 'other', { now: NOW })).toBeNull()
    const [p, s] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ p: 'wl', w: 'wl-2', e: 9e9 })).toString('base64url')
    expect(verifyWaitlistClaimToken(`${forged}.${s}`, SECRET, { now: NOW })).toBeNull()
    expect(verifyWaitlistClaimToken(`${p}`, SECRET)).toBeNull()
    expect(verifyWaitlistClaimToken('', SECRET)).toBeNull()
    expect(verifyWaitlistClaimToken(null, SECRET)).toBeNull()
    expect(verifyWaitlistClaimToken(t, '', { now: NOW })).toBeNull()
  })

  it('never accepts a token minted for another purpose with the same secret', () => {
    const checkin = signCheckinToken({ eventId: 'e1', registrationId: 'r1', memberId: 'm1' }, SECRET)
    expect(verifyWaitlistClaimToken(checkin, SECRET, { now: NOW })).toBeNull()
  })

  it('needs an id and a secret to sign', () => {
    expect(() => signWaitlistClaimToken({ waitlistId: '' }, SECRET)).toThrow(/waitlistId/)
    expect(() => signWaitlistClaimToken({ waitlistId: 'x' }, '')).toThrow(/secret/)
  })
})
