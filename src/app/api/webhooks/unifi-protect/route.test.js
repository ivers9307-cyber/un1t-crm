// Locks the auth-gate contract for the Phase 2 Protect webhook
// receiver. The gate is the only piece of route logic worth
// unit-testing during dark-launch — payload parsing is intentionally
// loose and will get its own tests once we capture real shapes
// (P2.5).
//
// What we're locking:
//   1. Missing env secret → 500 (don't accept ANY request when
//      misconfigured, force the operator to set the env var).
//   2. Missing header → 403 (untrusted source).
//   3. Wrong header → 403.
//   4. Correct header → 200 + matched: 'primary'.
//   5. Old token still works during rotation → 200 + matched: 'previous'.
//
// All of this mirrors verifyUnifiAccessRequest's contract — keeping
// the two receivers behaviourally identical at the auth boundary
// means an operator who's onboarded one already knows the other.

import { describe, it, expect } from 'vitest'
import { verifyUnifiProtectRequest } from './route.js'

describe('verifyUnifiProtectRequest', () => {
  it('500 when no primary secret is configured', () => {
    const r = verifyUnifiProtectRequest({
      headerValue: 'whatever',
      primarySecret: undefined,
      previousSecret: undefined,
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
    expect(r.reason).toBe('missing_secret')
  })

  it('403 when no header is sent', () => {
    const r = verifyUnifiProtectRequest({
      headerValue: null,
      primarySecret: 'tok-prod',
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(r.reason).toBe('missing_header')
  })

  it('403 when header does not match either secret', () => {
    const r = verifyUnifiProtectRequest({
      headerValue: 'wrong',
      primarySecret: 'tok-prod',
      previousSecret: 'tok-old',
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(r.reason).toBe('token_mismatch')
  })

  it('accepts the primary token', () => {
    const r = verifyUnifiProtectRequest({
      headerValue: 'tok-prod',
      primarySecret: 'tok-prod',
    })
    expect(r.ok).toBe(true)
    expect(r.matched).toBe('primary')
  })

  it('accepts the previous token during rotation (and labels it)', () => {
    const r = verifyUnifiProtectRequest({
      headerValue: 'tok-old',
      primarySecret: 'tok-new',
      previousSecret: 'tok-old',
    })
    expect(r.ok).toBe(true)
    expect(r.matched).toBe('previous')
  })

  it('prefers the primary token when both could match', () => {
    // Sanity check: if the operator accidentally configured the
    // same token as both primary and previous, we still report
    // 'primary' so the rotation-warning log doesn't fire.
    const r = verifyUnifiProtectRequest({
      headerValue: 'same',
      primarySecret: 'same',
      previousSecret: 'same',
    })
    expect(r.ok).toBe(true)
    expect(r.matched).toBe('primary')
  })
})
