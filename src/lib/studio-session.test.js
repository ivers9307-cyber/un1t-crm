// STUDIO-PIN.3 — coverage for the studio_session signed cookie.
// Round-trip, tampering, idle-lock, hard expiry, and the refresh
// semantics are the cases that matter.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  mintStudioSession,
  readStudioSession,
  inspectStudioSession,
  refreshStudioSession,
  IDLE_TIMEOUT_MS,
  ABSOLUTE_TTL_MS,
} from './studio-session'

// The lib reads STUDIO_SESSION_SECRET (or SUPABASE_SERVICE_ROLE_KEY)
// at every operation. Pin a known value across the suite.
const originalSecret = process.env.STUDIO_SESSION_SECRET
const originalSrk = process.env.SUPABASE_SERVICE_ROLE_KEY

beforeAll(() => {
  process.env.STUDIO_SESSION_SECRET = 'test-secret-do-not-use-in-prod'
})
afterAll(() => {
  process.env.STUDIO_SESSION_SECRET = originalSecret
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalSrk
})

const FIXTURE = {
  profileId: 'p-123',
  deviceId:  'd-456',
  locationId:'l-789',
}

describe('mintStudioSession + readStudioSession', () => {
  it('round-trips and returns the active payload', () => {
    const now = 1_000_000_000_000
    const cookie = mintStudioSession({ ...FIXTURE, now })
    const payload = readStudioSession(cookie, { now })
    expect(payload).toBeTruthy()
    expect(payload.sub).toBe(FIXTURE.profileId)
    expect(payload.dev).toBe(FIXTURE.deviceId)
    expect(payload.loc).toBe(FIXTURE.locationId)
    expect(payload.iat).toBe(now)
    expect(payload.exp).toBe(now + ABSOLUTE_TTL_MS)
    expect(payload.last_act).toBe(now)
  })

  it('requires every input', () => {
    expect(() => mintStudioSession({ profileId: 'p' })).toThrow()
    expect(() => mintStudioSession({ profileId: 'p', deviceId: 'd' })).toThrow()
  })
})

describe('inspectStudioSession — status routing', () => {
  it('"active" for fresh cookie', () => {
    const now = 1_000_000
    const cookie = mintStudioSession({ ...FIXTURE, now })
    expect(inspectStudioSession(cookie, { now }).status).toBe('active')
  })

  it('"idle_locked" when last_act is older than IDLE_TIMEOUT_MS but exp is fresh', () => {
    const issued = 1_000_000
    const cookie = mintStudioSession({ ...FIXTURE, now: issued })
    const checkAt = issued + IDLE_TIMEOUT_MS + 1
    const r = inspectStudioSession(cookie, { now: checkAt })
    expect(r.status).toBe('idle_locked')
    expect(r.payload.sub).toBe(FIXTURE.profileId)
  })

  it('"expired" when past exp', () => {
    const issued = 1_000_000
    const cookie = mintStudioSession({ ...FIXTURE, now: issued })
    const checkAt = issued + ABSOLUTE_TTL_MS + 1
    expect(inspectStudioSession(cookie, { now: checkAt }).status).toBe('expired')
  })

  it('"invalid" for nonsense input', () => {
    expect(inspectStudioSession(null).status).toBe('invalid')
    expect(inspectStudioSession('').status).toBe('invalid')
    expect(inspectStudioSession('no-dot').status).toBe('invalid')
    expect(inspectStudioSession('only.dots.too.many').status).toBe('invalid')
  })

  it('"invalid" for tampered payload', () => {
    const cookie = mintStudioSession({ ...FIXTURE, now: 1_000_000 })
    const [payloadB64, sig] = cookie.split('.')
    // Decode + tamper + re-encode.
    const tampered = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')),
      sub: 'malicious-profile-id',
    })).toString('base64url')
    expect(inspectStudioSession(`${tampered}.${sig}`).status).toBe('invalid')
  })

  it('"invalid" for tampered signature', () => {
    const cookie = mintStudioSession({ ...FIXTURE, now: 1_000_000 })
    const [payloadB64, sig] = cookie.split('.')
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A')
    expect(inspectStudioSession(`${payloadB64}.${flipped}`).status).toBe('invalid')
  })

  it('"invalid" when signed with a different secret', () => {
    const cookie = mintStudioSession({ ...FIXTURE, now: 1_000_000 })
    process.env.STUDIO_SESSION_SECRET = 'a-different-secret'
    expect(inspectStudioSession(cookie).status).toBe('invalid')
    process.env.STUDIO_SESSION_SECRET = 'test-secret-do-not-use-in-prod'
  })
})

describe('readStudioSession', () => {
  it('returns payload only for status=active', () => {
    const issued = 1_000_000
    const cookie = mintStudioSession({ ...FIXTURE, now: issued })
    expect(readStudioSession(cookie, { now: issued })).toBeTruthy()
    expect(readStudioSession(cookie, { now: issued + IDLE_TIMEOUT_MS + 1 })).toBe(null)
    expect(readStudioSession(cookie, { now: issued + ABSOLUTE_TTL_MS + 1 })).toBe(null)
    expect(readStudioSession('garbage')).toBe(null)
  })
})

describe('refreshStudioSession', () => {
  it('refreshes last_act on an active cookie + preserves iat/exp/sub/dev/loc', () => {
    const issued = 1_000_000
    const cookie = mintStudioSession({ ...FIXTURE, now: issued })
    const laterMs = issued + 60_000 // 1 minute later
    const refreshed = refreshStudioSession(cookie, { now: laterMs })
    const p = readStudioSession(refreshed, { now: laterMs })
    expect(p.sub).toBe(FIXTURE.profileId)
    expect(p.dev).toBe(FIXTURE.deviceId)
    expect(p.loc).toBe(FIXTURE.locationId)
    expect(p.iat).toBe(issued)        // unchanged
    expect(p.exp).toBe(issued + ABSOLUTE_TTL_MS) // unchanged
    expect(p.last_act).toBe(laterMs)  // bumped
  })

  it('refuses to refresh an idle-locked cookie by default', () => {
    const issued = 1_000_000
    const cookie = mintStudioSession({ ...FIXTURE, now: issued })
    const stale = issued + IDLE_TIMEOUT_MS + 1
    expect(refreshStudioSession(cookie, { now: stale })).toBe(null)
  })

  it('refreshes an idle-locked cookie when refreshIdleLocked=true (PIN re-entry path)', () => {
    const issued = 1_000_000
    const cookie = mintStudioSession({ ...FIXTURE, now: issued })
    const stale = issued + IDLE_TIMEOUT_MS + 1
    const refreshed = refreshStudioSession(cookie, { now: stale, refreshIdleLocked: true })
    expect(refreshed).toBeTruthy()
    expect(readStudioSession(refreshed, { now: stale }).last_act).toBe(stale)
  })

  it('refuses to refresh an expired cookie even with refreshIdleLocked=true', () => {
    const issued = 1_000_000
    const cookie = mintStudioSession({ ...FIXTURE, now: issued })
    const past = issued + ABSOLUTE_TTL_MS + 1
    expect(refreshStudioSession(cookie, { now: past })).toBe(null)
    expect(refreshStudioSession(cookie, { now: past, refreshIdleLocked: true })).toBe(null)
  })

  it('refuses to refresh garbage', () => {
    expect(refreshStudioSession('not-a-cookie')).toBe(null)
    expect(refreshStudioSession('')).toBe(null)
    expect(refreshStudioSession(null)).toBe(null)
  })
})
