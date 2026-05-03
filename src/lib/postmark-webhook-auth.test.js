// Tests for the Postmark webhook auth gate (rollout hardening).
//
// We unit-test the exported `verifyPostmarkRequest` predicate so a regression
// to the gate (e.g. accidental restore of the rollout-only "accept on missing
// secret" branch) is caught immediately. Mirrors the pattern used in
// src/lib/twilio-status.test.js — pull the predicate out of the route, leave
// the full Supabase plumbing alone.

import { describe, it, expect } from 'vitest'
import { verifyPostmarkRequest } from '../app/api/webhooks/postmark/route.js'

describe('verifyPostmarkRequest', () => {
  const PRIMARY = 'a698fc84302a76c9f595d32013220a4486335d6403221f848b462ab5d05894cb'
  const PREVIOUS = '0000000000000000000000000000000000000000000000000000000000000000'

  it('accepts a request whose header matches the primary secret', () => {
    const r = verifyPostmarkRequest({
      headerValue: PRIMARY,
      primarySecret: PRIMARY,
      previousSecret: undefined,
    })
    expect(r).toEqual({ ok: true, matched: 'primary' })
  })

  it('accepts a request whose header matches the previous secret during rotation', () => {
    const r = verifyPostmarkRequest({
      headerValue: PREVIOUS,
      primarySecret: PRIMARY,
      previousSecret: PREVIOUS,
    })
    expect(r).toEqual({ ok: true, matched: 'previous' })
  })

  it('returns 500 missing_secret when POSTMARK_WEBHOOK_TOKEN is unset (no accept-with-warning fallback)', () => {
    // This is the regression guard for the rollout fallback we deliberately
    // removed. If anyone re-introduces an `if (!primarySecret) accept`
    // branch, this test fails.
    const r = verifyPostmarkRequest({
      headerValue: PRIMARY,
      primarySecret: undefined,
      previousSecret: undefined,
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
    expect(r.reason).toBe('missing_secret')
  })

  it('returns 500 even when the caller presented a header — config drift takes precedence over caller content', () => {
    const r = verifyPostmarkRequest({
      headerValue: 'whatever-the-caller-sent',
      primarySecret: '',
      previousSecret: undefined,
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
  })

  it('returns 403 missing_header when the caller forgot to send X-Webhook-Token', () => {
    const r = verifyPostmarkRequest({
      headerValue: null,
      primarySecret: PRIMARY,
      previousSecret: undefined,
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(r.reason).toBe('missing_header')
  })

  it('returns 403 token_mismatch when the header is wrong', () => {
    const r = verifyPostmarkRequest({
      headerValue: 'definitely-not-the-token',
      primarySecret: PRIMARY,
      previousSecret: undefined,
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(r.reason).toBe('token_mismatch')
  })

  it('returns 403 token_mismatch when neither primary nor previous matches', () => {
    const r = verifyPostmarkRequest({
      headerValue: 'something-else',
      primarySecret: PRIMARY,
      previousSecret: PREVIOUS,
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(r.reason).toBe('token_mismatch')
  })

  it('prefers the primary match over the previous match (no fall-through when primary is good)', () => {
    // If both happen to be set to the same value (operator mistake during
    // rotation), the response should still report `primary` so the rotation
    // warning log doesn't spam.
    const r = verifyPostmarkRequest({
      headerValue: PRIMARY,
      primarySecret: PRIMARY,
      previousSecret: PRIMARY,
    })
    expect(r).toEqual({ ok: true, matched: 'primary' })
  })

  it('does not accept the empty string as a secret (defensive against blank env vars)', () => {
    const r = verifyPostmarkRequest({
      headerValue: '',
      primarySecret: '',
      previousSecret: undefined,
    })
    // Empty primarySecret hits the missing_secret branch first.
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
    expect(r.reason).toBe('missing_secret')
  })

  it('rejects when only PREVIOUS is set (PRIMARY unset is still missing_secret)', () => {
    // Half-finished rotation where someone unset PRIMARY before unsetting
    // PREVIOUS — refuse, don't silently accept on the rotation key alone.
    const r = verifyPostmarkRequest({
      headerValue: PREVIOUS,
      primarySecret: undefined,
      previousSecret: PREVIOUS,
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
    expect(r.reason).toBe('missing_secret')
  })
})
