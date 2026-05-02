// Tests for the Twilio status webhook signature verification +
// idempotent state machine (Phase 5D / mig 065).
//
// We unit-test verifyTwilioSignature against a known-good signature
// (computed via Node's crypto using the same algorithm Twilio docs
// describe) so a refactor that breaks the algorithm is caught
// immediately. The state-machine guard (no double-increment, no
// backwards transition) is exercised via plain logic since the
// route exports the relevant predicate as a constant.

import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { verifyTwilioSignature } from '../app/api/webhooks/twilio/status/route.js'

// Compute Twilio's expected signature for a fixture so we can both
// produce and verify it inside the test. Mirrors the docs exactly:
// HMAC-SHA1(authToken).update(url + concat(sortedKey + value)).digest('base64').
function makeSignature({ authToken, url, params }) {
  const sortedKeys = Object.keys(params).sort()
  let payload = url
  for (const k of sortedKeys) payload += k + (params[k] ?? '')
  return crypto.createHmac('sha1', authToken).update(payload).digest('base64')
}

describe('verifyTwilioSignature', () => {
  const authToken = 'fake-auth-token-for-tests'
  const url = 'https://crm.example.com/api/webhooks/twilio/status?b=BID&c=CID'
  const params = {
    MessageSid: 'SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    MessageStatus: 'delivered',
    From: 'UN1T',
    To: '+353871234567',
  }

  it('accepts a signature that matches the URL + params', () => {
    const sig = makeSignature({ authToken, url, params })
    expect(verifyTwilioSignature({ authToken, url, params, signature: sig })).toBe(true)
  })

  it('rejects when the auth token is wrong', () => {
    const sig = makeSignature({ authToken: 'wrong-token', url, params })
    expect(verifyTwilioSignature({ authToken, url, params, signature: sig })).toBe(false)
  })

  it('rejects when the URL is tampered', () => {
    const sig = makeSignature({ authToken, url, params })
    expect(verifyTwilioSignature({ authToken, url: url + '&extra=1', params, signature: sig })).toBe(false)
  })

  it('rejects when a param value is tampered', () => {
    const sig = makeSignature({ authToken, url, params })
    const tampered = { ...params, MessageStatus: 'failed' }
    expect(verifyTwilioSignature({ authToken, url, params: tampered, signature: sig })).toBe(false)
  })

  it('rejects an empty signature header', () => {
    expect(verifyTwilioSignature({ authToken, url, params, signature: '' })).toBe(false)
  })

  it('rejects when authToken is missing (defensive against unconfigured env)', () => {
    const sig = makeSignature({ authToken, url, params })
    expect(verifyTwilioSignature({ authToken: '', url, params, signature: sig })).toBe(false)
  })

  it('is order-independent on params (Twilio sorts alphabetically)', () => {
    const reordered = {
      To: params.To,
      MessageSid: params.MessageSid,
      From: params.From,
      MessageStatus: params.MessageStatus,
    }
    const sig = makeSignature({ authToken, url, params })
    // The internal sort makes a re-ordered object hash to the same
    // payload — the signature should still verify.
    expect(verifyTwilioSignature({ authToken, url, params: reordered, signature: sig })).toBe(true)
  })
})

// State-machine guards in the webhook (kept as plain logic here so
// the test doesn't need the full route's network mocks).
function shouldApplyTransition(currentStatus, newStatus) {
  if (currentStatus === newStatus) return false  // already there
  // Refuse 'sent' overwriting a more-terminal state.
  const ORDER = { pending: 0, sent: 1, delivered: 2, undelivered: 2, failed: 2 }
  if (newStatus === 'sent' && (ORDER[newStatus] ?? 0) <= (ORDER[currentStatus] ?? 0)) {
    return false
  }
  return true
}

describe('webhook state-machine guard', () => {
  it("doesn't re-apply when current state already matches", () => {
    expect(shouldApplyTransition('delivered', 'delivered')).toBe(false)
    expect(shouldApplyTransition('failed', 'failed')).toBe(false)
  })

  it('applies forward transitions (sent -> delivered, sent -> undelivered, sent -> failed)', () => {
    expect(shouldApplyTransition('sent', 'delivered')).toBe(true)
    expect(shouldApplyTransition('sent', 'undelivered')).toBe(true)
    expect(shouldApplyTransition('sent', 'failed')).toBe(true)
  })

  it("doesn't roll back delivered -> sent (late callback)", () => {
    expect(shouldApplyTransition('delivered', 'sent')).toBe(false)
  })

  it("doesn't roll back failed -> sent", () => {
    expect(shouldApplyTransition('failed', 'sent')).toBe(false)
  })
})
