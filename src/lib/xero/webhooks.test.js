// XERO-WEBHOOK — signature verification coverage.
//
// verifyXeroSignature is the security boundary for the webhook
// endpoint, so the cases that matter: a genuine signature passes,
// every way of being wrong fails, and the empty-body "intent to
// receive" handshake still verifies.

import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyXeroSignature } from './webhooks'

const KEY = 'test-webhook-signing-key'
const sign = (body, key = KEY) =>
  createHmac('sha256', key).update(body).digest('base64')

describe('verifyXeroSignature', () => {
  it('accepts a correctly-signed body', () => {
    const body = JSON.stringify({ events: [{ eventCategory: 'INVOICE' }] })
    expect(verifyXeroSignature(body, sign(body), KEY)).toBe(true)
  })

  it('accepts an empty body signed with the key (intent-to-receive handshake)', () => {
    expect(verifyXeroSignature('', sign(''), KEY)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const sig = sign('{"events":[]}')
    expect(verifyXeroSignature('{"events":[{"hacked":true}]}', sig, KEY)).toBe(false)
  })

  it('rejects a signature made with the wrong key', () => {
    const body = '{"events":[]}'
    expect(verifyXeroSignature(body, sign(body, 'wrong-key'), KEY)).toBe(false)
  })

  it('rejects when the signing key is missing', () => {
    const body = '{"events":[]}'
    expect(verifyXeroSignature(body, sign(body), '')).toBe(false)
    expect(verifyXeroSignature(body, sign(body), undefined)).toBe(false)
  })

  it('rejects when the signature header is missing', () => {
    expect(verifyXeroSignature('{"events":[]}', null, KEY)).toBe(false)
    expect(verifyXeroSignature('{"events":[]}', '', KEY)).toBe(false)
  })

  it('rejects a garbage signature without throwing', () => {
    expect(verifyXeroSignature('{"events":[]}', 'not-base64-or-right-length', KEY)).toBe(false)
  })
})
