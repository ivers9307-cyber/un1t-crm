// SONOS.11/12 fixup — direct coverage for signState/verifyState.
//
// THE PROPERTY THIS FILE EXISTS FOR
//
// verifyState is the ENTIRE authentication model for /api/sonos/callback —
// that route is deliberately unauthenticated (Sonos redirects the
// operator's browser straight there with no way to attach a session
// cookie), so the signed `state` round trip is the only thing standing
// between "an operator who really started this OAuth flow" and "anyone who
// can guess a URL". Both functions are pure (the secret is an explicit
// argument, no env/DB reads), which is exactly why they're unit-testable
// directly off the named exports rather than through the route handler —
// see src/app/api/email/tickets/[id]/attachments/[attachmentId]/preview/route.test.js
// for the precedent of importing straight from a route.js.
//
// Every failure path below must resolve to `null`, never throw —
// callback/route.js calls `verifyState(state, secret)` with no try/catch
// around it, so a throw here is an unhandled 500 instead of the clean
// `bad_state` redirect the rest of that route is built to give.

import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { signState, verifyState } from './route'

const SECRET = 'test-cron-secret-first'
const OTHER_SECRET = 'test-cron-secret-second'
const PAYLOAD = { locationId: 'loc-1', profileId: 'prof-1', householdId: null, ts: 1723000000000 }

/** Signs a raw segment the same way signState does, for hand-built states. */
function signRaw(raw, secret) {
  return crypto.createHmac('sha256', secret).update(raw).digest('base64url')
}

describe('signState -> verifyState round trip', () => {
  it('a valid sign then verify returns the original payload', () => {
    const state = signState(PAYLOAD, SECRET)
    expect(verifyState(state, SECRET)).toEqual(PAYLOAD)
  })
})

describe('verifyState failure paths — every one returns null, none throw', () => {
  it('a tampered payload segment fails', () => {
    const state = signState(PAYLOAD, SECRET)
    const [raw, sig] = state.split('.')
    // Flip one character of the payload segment; the signature was minted
    // over the ORIGINAL raw, so this must be caught by the HMAC check
    // before JSON.parse ever runs.
    const tamperedRaw = (raw[0] === 'a' ? 'b' : 'a') + raw.slice(1)
    const tampered = `${tamperedRaw}.${sig}`
    expect(() => verifyState(tampered, SECRET)).not.toThrow()
    expect(verifyState(tampered, SECRET)).toBeNull()
  })

  it('a tampered signature fails (same length)', () => {
    const state = signState(PAYLOAD, SECRET)
    const [raw, sig] = state.split('.')
    const tamperedSig = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1)
    const tampered = `${raw}.${tamperedSig}`
    expect(() => verifyState(tampered, SECRET)).not.toThrow()
    expect(verifyState(tampered, SECRET)).toBeNull()
  })

  it('a truncated (different-length) signature fails without throwing', () => {
    // crypto.timingSafeEqual THROWS on a byte-length mismatch — verifyState
    // guards it with an explicit a.length !== b.length check first. A
    // shortened sig segment is exactly what exercises that guard rather
    // than the equality check itself, so it's worth pinning separately
    // from the same-length tamper above.
    const state = signState(PAYLOAD, SECRET)
    const [raw, sig] = state.split('.')
    const tampered = `${raw}.${sig.slice(0, -4)}`
    expect(() => verifyState(tampered, SECRET)).not.toThrow()
    expect(verifyState(tampered, SECRET)).toBeNull()
  })

  it('verification under a different secret fails', () => {
    const state = signState(PAYLOAD, SECRET)
    expect(() => verifyState(state, OTHER_SECRET)).not.toThrow()
    expect(verifyState(state, OTHER_SECRET)).toBeNull()
  })

  it('a state with no dot fails', () => {
    expect(() => verifyState('nodothere', SECRET)).not.toThrow()
    expect(verifyState('nodothere', SECRET)).toBeNull()
  })

  it('an empty string state fails', () => {
    expect(() => verifyState('', SECRET)).not.toThrow()
    expect(verifyState('', SECRET)).toBeNull()
  })

  it('a null state fails', () => {
    expect(() => verifyState(null, SECRET)).not.toThrow()
    expect(verifyState(null, SECRET)).toBeNull()
  })

  it('an undefined state fails', () => {
    expect(() => verifyState(undefined, SECRET)).not.toThrow()
    expect(verifyState(undefined, SECRET)).toBeNull()
  })

  it('an empty signature segment fails', () => {
    const state = signState(PAYLOAD, SECRET)
    const [raw] = state.split('.')
    expect(() => verifyState(`${raw}.`, SECRET)).not.toThrow()
    expect(verifyState(`${raw}.`, SECRET)).toBeNull()
  })

  it('malformed base64 in the payload segment fails', () => {
    // A raw segment that is not valid base64url AND does not decode to
    // valid JSON — signed correctly (HMAC'd over the raw string exactly as
    // signState does it), so this exercises the JSON.parse/catch branch
    // specifically, not the signature check. Verified experimentally:
    // Buffer.from(raw, 'base64url').toString() on this string decodes to
    // non-JSON bytes and JSON.parse throws on them.
    const raw = 'not-base64!!!json'
    const state = `${raw}.${signRaw(raw, SECRET)}`
    expect(() => verifyState(state, SECRET)).not.toThrow()
    expect(verifyState(state, SECRET)).toBeNull()
  })

  it('a payload that is valid JSON but not an object (null) does not throw', () => {
    // Documented, not a defect: verifyState's failure sentinel and a
    // legitimately-signed `null` payload are the same value. Harmless here
    // — callback/route.js only ever checks `claims?.locationId`, which is
    // falsy either way — but the property under test is "does not throw",
    // not "distinguishes the two".
    const state = signState(null, SECRET)
    expect(() => verifyState(state, SECRET)).not.toThrow()
  })

  it('a payload that is valid JSON but not an object (a bare number) does not throw', () => {
    const state = signState(42, SECRET)
    expect(() => verifyState(state, SECRET)).not.toThrow()
    expect(verifyState(state, SECRET)).toBe(42)
  })
})
