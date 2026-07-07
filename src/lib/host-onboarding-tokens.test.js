// Host onboarding token HMAC (EVENTS-HOST.5) — round-trip + tamper rejection +
// EVENTS-HOST.6 expiry (iat/TTL, fail-closed on unstamped tokens).

import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import {
  signHostOnboardingToken,
  verifyHostOnboardingToken,
  HOST_ONBOARDING_TOKEN_TTL_MS,
} from './host-onboarding-tokens.js'

const SECRET = 'test-secret-123'

describe('host onboarding tokens', () => {
  it('round-trips a hostId', () => {
    const t = signHostOnboardingToken({ hostId: 'host-1' }, SECRET)
    expect(verifyHostOnboardingToken(t, SECRET)).toEqual({ hostId: 'host-1' })
  })

  it('rejects a tampered payload (re-pointing to another host) with the old signature', () => {
    const t = signHostOnboardingToken({ hostId: 'host-1' }, SECRET)
    const sig = t.split('.')[1]
    const forgedPayload = Buffer.from(JSON.stringify({ h: 'host-EVIL', k: 'host_onboard' })).toString('base64url')
    expect(verifyHostOnboardingToken(`${forgedPayload}.${sig}`, SECRET)).toBeNull()
  })

  it('rejects a bad signature', () => {
    const t = signHostOnboardingToken({ hostId: 'host-1' }, SECRET)
    const payload = t.split('.')[0]
    expect(verifyHostOnboardingToken(`${payload}.deadbeef`, SECRET)).toBeNull()
  })

  it('rejects the wrong secret', () => {
    const t = signHostOnboardingToken({ hostId: 'host-1' }, SECRET)
    expect(verifyHostOnboardingToken(t, 'other-secret')).toBeNull()
  })

  it('rejects malformed tokens', () => {
    expect(verifyHostOnboardingToken('', SECRET)).toBeNull()
    expect(verifyHostOnboardingToken('nodot', SECRET)).toBeNull()
    expect(verifyHostOnboardingToken(null, SECRET)).toBeNull()
  })

  it('accepts a token within its TTL', () => {
    const now = 1_700_000_000_000
    const t = signHostOnboardingToken({ hostId: 'host-1' }, SECRET, { nowMs: now })
    // verified a few hours later — still inside the window
    expect(verifyHostOnboardingToken(t, SECRET, { nowMs: now + 6 * 60 * 60 * 1000 }))
      .toEqual({ hostId: 'host-1' })
  })

  it('rejects a token past its TTL', () => {
    const now = 1_700_000_000_000
    const t = signHostOnboardingToken({ hostId: 'host-1' }, SECRET, { nowMs: now })
    expect(verifyHostOnboardingToken(t, SECRET, { nowMs: now + HOST_ONBOARDING_TOKEN_TTL_MS + 1 }))
      .toBeNull()
  })

  it('rejects a token stamped in the future (forged iat)', () => {
    const now = 1_700_000_000_000
    const t = signHostOnboardingToken({ hostId: 'host-1' }, SECRET, { nowMs: now + 10 * 60 * 1000 })
    expect(verifyHostOnboardingToken(t, SECRET, { nowMs: now })).toBeNull()
  })

  it('rejects a validly-signed legacy token that carries no iat (fail closed)', () => {
    // Mint a token the OLD way — a correct HMAC over a payload with no iat.
    const b64url = (s) => Buffer.from(s).toString('base64url')
    const payload = b64url(JSON.stringify({ h: 'host-1', k: 'host_onboard' }))
    const sig = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest())
    expect(verifyHostOnboardingToken(`${payload}.${sig}`, SECRET)).toBeNull()
  })
})
