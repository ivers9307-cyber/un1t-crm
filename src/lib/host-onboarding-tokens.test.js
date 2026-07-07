// Host onboarding token HMAC (EVENTS-HOST.5) — round-trip + tamper rejection.

import { describe, it, expect } from 'vitest'
import { signHostOnboardingToken, verifyHostOnboardingToken } from './host-onboarding-tokens.js'

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
})
