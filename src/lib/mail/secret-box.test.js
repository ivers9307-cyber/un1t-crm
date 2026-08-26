import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { isConfigured, seal, open } from './secret-box.js'

// Two distinct, valid 32-byte keys. Generated per run rather than hard-coded
// so no real-looking key literal ever lives in the repo (this file is public).
const KEY_A = crypto.randomBytes(32).toString('base64')
const KEY_B = crypto.randomBytes(32).toString('base64')

const ORIGINAL = process.env.MAILBOX_SECRET_KEY

function setKey(value) {
  if (value === undefined) delete process.env.MAILBOX_SECRET_KEY
  else process.env.MAILBOX_SECRET_KEY = value
}

/** Flip one bit inside a base64 field of a sealed value, keeping its shape. */
function tamper(sealed, fieldIndex) {
  const parts = sealed.split(':')
  const buf = Buffer.from(parts[fieldIndex], 'base64')
  buf[0] ^= 0x01
  parts[fieldIndex] = buf.toString('base64')
  return parts.join(':')
}

beforeEach(() => setKey(KEY_A))
afterEach(() => setKey(ORIGINAL))

describe('secret-box — round trip', () => {
  it('opens what it seals', () => {
    const secret = 'not-a-real-app-password' // the shape of a Google app password
    expect(open(seal(secret))).toBe(secret)
  })

  it('round-trips non-ASCII and long values (utf8, not latin1)', () => {
    const secret = 'pässwörd — 日本語 🔐 ' + 'x'.repeat(500)
    expect(open(seal(secret))).toBe(secret)
  })

  it('emits a fresh IV per call, so the same plaintext never seals identically', () => {
    // GCM nonce reuse under one key is catastrophic; identical output would be
    // the visible symptom of a static IV.
    const a = seal('same-secret')
    const b = seal('same-secret')
    expect(a).not.toBe(b)
    expect(a.split(':')[1]).not.toBe(b.split(':')[1])
    expect(open(a)).toBe('same-secret')
    expect(open(b)).toBe('same-secret')
  })
})

describe('secret-box — envelope format', () => {
  it('carries the v1: version prefix and four colon-separated fields', () => {
    const sealed = seal('secret')
    expect(sealed.startsWith('v1:')).toBe(true)
    const parts = sealed.split(':')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(12) // IV
    expect(Buffer.from(parts[2], 'base64')).toHaveLength(16) // GCM tag
    expect(Buffer.from(parts[3], 'base64').length).toBeGreaterThan(0)
  })

  it('never contains the plaintext', () => {
    const sealed = seal('super-secret-password')
    expect(sealed).not.toContain('super-secret-password')
  })

  it('refuses an unknown version prefix (the rotation seam)', () => {
    const sealed = seal('secret')
    const v2 = 'v2:' + sealed.slice('v1:'.length)
    expect(() => open(v2)).toThrow(/Unsupported sealed-value version/)
  })
})

describe('secret-box — tamper detection', () => {
  it('rejects a tampered ciphertext', () => {
    const sealed = seal('secret')
    expect(() => open(tamper(sealed, 3))).toThrow()
  })

  it('rejects a tampered authentication tag', () => {
    const sealed = seal('secret')
    expect(() => open(tamper(sealed, 2))).toThrow()
  })

  it('rejects a tampered IV', () => {
    const sealed = seal('secret')
    expect(() => open(tamper(sealed, 1))).toThrow()
  })

  it('rejects a truncated ciphertext', () => {
    const parts = seal('a much longer secret than one block').split(':')
    const buf = Buffer.from(parts[3], 'base64')
    parts[3] = buf.subarray(0, buf.length - 4).toString('base64')
    expect(() => open(parts.join(':'))).toThrow()
  })
})

describe('secret-box — wrong key', () => {
  it('refuses to open a value sealed under a different key', () => {
    const sealed = seal('secret')
    setKey(KEY_B)
    expect(() => open(sealed)).toThrow()
  })

  it('does not leak the plaintext or the key in the failure', () => {
    const sealed = seal('super-secret-password')
    setKey(KEY_B)
    let message = ''
    try { open(sealed) } catch (e) { message = String(e?.message || e) }
    expect(message).not.toBe('')
    expect(message).not.toContain('super-secret-password')
    expect(message).not.toContain(KEY_A)
    expect(message).not.toContain(KEY_B)
  })
})

describe('secret-box — missing or malformed key fails CLOSED', () => {
  it('isConfigured() is false with no key and true with a valid one', () => {
    setKey(undefined)
    expect(isConfigured()).toBe(false)
    setKey(KEY_A)
    expect(isConfigured()).toBe(true)
  })

  it('seal() throws (never falls back to plaintext) when the key is absent', () => {
    setKey(undefined)
    expect(() => seal('secret')).toThrow(/MAILBOX_SECRET_KEY is not set/)
  })

  it('open() throws when the key is absent', () => {
    const sealed = seal('secret')
    setKey(undefined)
    expect(() => open(sealed)).toThrow(/MAILBOX_SECRET_KEY is not set/)
  })

  it('treats an empty / whitespace-only key as absent', () => {
    setKey('   ')
    expect(isConfigured()).toBe(false)
    expect(() => seal('secret')).toThrow(/MAILBOX_SECRET_KEY is not set/)
  })

  it('rejects a key that is not base64', () => {
    setKey('not base64 at all!!')
    expect(isConfigured()).toBe(false)
    expect(() => seal('secret')).toThrow(/not valid base64/)
  })

  it('rejects a base64 key of the wrong length (node base64 decoding is lenient)', () => {
    setKey(crypto.randomBytes(16).toString('base64'))
    expect(isConfigured()).toBe(false)
    expect(() => seal('secret')).toThrow(/decodes to 16 bytes/)
  })

  it('accepts a url-safe base64 key', () => {
    const raw = crypto.randomBytes(32)
    setKey(raw.toString('base64url'))
    expect(isConfigured()).toBe(true)
    // and it is the SAME key as its standard-base64 spelling
    const sealed = seal('secret')
    setKey(raw.toString('base64'))
    expect(open(sealed)).toBe('secret')
  })

  it('key errors never echo the key value', () => {
    const badKey = crypto.randomBytes(16).toString('base64')
    setKey(badKey)
    let message = ''
    try { seal('secret') } catch (e) { message = String(e?.message || e) }
    expect(message).not.toContain(badKey)
  })
})

describe('secret-box — malformed input', () => {
  it('seal() refuses a non-string', () => {
    for (const bad of [null, undefined, 123, {}, [], true]) {
      expect(() => seal(bad)).toThrow(TypeError)
    }
  })

  it('seal() refuses an empty string (a credential that authenticates against nothing)', () => {
    expect(() => seal('')).toThrow(/non-empty string/)
  })

  it('open() refuses a non-string or empty string', () => {
    for (const bad of [null, undefined, 123, {}, '']) {
      expect(() => open(bad)).toThrow(TypeError)
    }
  })

  it('open() refuses a plaintext value that was never sealed', () => {
    // The whole point of failing closed: a column holding a legacy plaintext
    // password must not silently pass through.
    expect(() => open('not-a-real-app-password')).toThrow(/expected 4 colon-separated fields/)
  })

  it('open() refuses the wrong field count', () => {
    expect(() => open('v1:aaa:bbb')).toThrow(/4 colon-separated fields/)
    expect(() => open('v1:aaa:bbb:ccc:ddd')).toThrow(/4 colon-separated fields/)
  })

  it('open() refuses a short IV', () => {
    const parts = seal('secret').split(':')
    parts[1] = Buffer.alloc(8).toString('base64')
    expect(() => open(parts.join(':'))).toThrow(/bad initialization vector/)
  })

  it('open() refuses a short authentication tag', () => {
    const parts = seal('secret').split(':')
    parts[2] = Buffer.alloc(8).toString('base64')
    expect(() => open(parts.join(':'))).toThrow(/bad authentication tag/)
  })

  it('open() refuses an empty ciphertext field', () => {
    const parts = seal('secret').split(':')
    parts[3] = ''
    expect(() => open(parts.join(':'))).toThrow(/empty ciphertext/)
  })
})
