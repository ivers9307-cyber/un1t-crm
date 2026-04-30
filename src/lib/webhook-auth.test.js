import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { safeEqual, verifyMetaSignature, verifySharedSecret } from './webhook-auth.js'

describe('safeEqual', () => {
  it('returns true for matching strings', () => {
    expect(safeEqual('hello', 'hello')).toBe(true)
  })

  it('returns false for different strings of the same length', () => {
    expect(safeEqual('hello', 'world')).toBe(false)
  })

  it('returns false for strings of different length (no length-leak crash)', () => {
    expect(safeEqual('hello', 'helloo')).toBe(false)
    expect(safeEqual('helloo', 'hello')).toBe(false)
  })

  it('returns false for non-string inputs', () => {
    expect(safeEqual(null, 'hello')).toBe(false)
    expect(safeEqual(undefined, 'hello')).toBe(false)
    expect(safeEqual(123, 'hello')).toBe(false)
    expect(safeEqual('hello', null)).toBe(false)
  })

  it('returns true for empty strings (callers must gate with truthy check)', () => {
    expect(safeEqual('', '')).toBe(true)
  })

  it('handles 64-char hex tokens correctly (typical CRM_API_KEY shape)', () => {
    const hex = 'a'.repeat(64)
    expect(safeEqual(hex, hex)).toBe(true)
    expect(safeEqual(hex, 'b'.repeat(64))).toBe(false)
  })
})

describe('verifyMetaSignature', () => {
  const secret = 'meta-app-secret-test'
  const body = JSON.stringify({ entry: [{ id: '1' }] })

  function sign(rawBody, key) {
    return 'sha256=' + crypto.createHmac('sha256', key).update(rawBody, 'utf8').digest('hex')
  }

  it('accepts a correctly-signed payload', () => {
    const sig = sign(body, secret)
    expect(verifyMetaSignature(body, sig, secret)).toEqual({ ok: true })
  })

  it('rejects a wrong signature with reason signature_mismatch', () => {
    const sig = sign(body, 'wrong-secret')
    const r = verifyMetaSignature(body, sig, secret)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('signature_mismatch')
  })

  it('rejects when the secret is missing', () => {
    const sig = sign(body, secret)
    const r = verifyMetaSignature(body, sig, undefined)
    expect(r).toEqual({ ok: false, reason: 'missing_secret' })
  })

  it('rejects when the header is missing or malformed', () => {
    const r1 = verifyMetaSignature(body, null, secret)
    expect(r1).toEqual({ ok: false, reason: 'missing_or_malformed_header' })
    const r2 = verifyMetaSignature(body, 'sha512=abc', secret)
    expect(r2).toEqual({ ok: false, reason: 'missing_or_malformed_header' })
  })

  it('rejects if the signed body differs from what we hash', () => {
    const sig = sign(body, secret)
    const tampered = body.replace('1', '999')
    const r = verifyMetaSignature(tampered, sig, secret)
    expect(r.ok).toBe(false)
  })
})

describe('verifySharedSecret', () => {
  it('accepts the matching token', () => {
    expect(verifySharedSecret('the-token', 'the-token')).toEqual({ ok: true })
  })

  it('rejects a mismatch', () => {
    expect(verifySharedSecret('wrong', 'right').ok).toBe(false)
  })

  it('rejects missing inputs', () => {
    expect(verifySharedSecret(null, 'right')).toEqual({ ok: false, reason: 'missing_header' })
    expect(verifySharedSecret('something', undefined)).toEqual({ ok: false, reason: 'missing_secret' })
  })
})
