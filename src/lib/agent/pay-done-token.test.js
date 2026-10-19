// MIAHATCH.6 — the pay-done token module is a leaf: node:crypto only, so the
// public /pay-done page can hash a token without importing purchase-intents
// (and with it the un1t write-ops graph).
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PAY_DONE_TOKEN_SHAPE, hashPayDoneToken, mintPayDoneToken } from './pay-done-token'

const read = (f) => fs.readFileSync(path.join(import.meta.dirname, f), 'utf8')
const importsOf = (src) => [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])

describe('pay-done token', () => {
  it('mints 32 random bytes as base64url; the hash is the sha256 hex', () => {
    const a = mintPayDoneToken()
    const b = mintPayDoneToken()
    expect(a.token).toMatch(PAY_DONE_TOKEN_SHAPE)
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32)
    expect(a.hash).toBe(createHash('sha256').update(a.token).digest('hex'))
    expect(hashPayDoneToken(a.token)).toBe(a.hash)
    expect(a.token).not.toBe(b.token)
  })

  it('the shape accepts exactly 43 base64url characters', () => {
    expect(PAY_DONE_TOKEN_SHAPE.test('A'.repeat(43))).toBe(true)
    expect(PAY_DONE_TOKEN_SHAPE.test('A'.repeat(42))).toBe(false)
    expect(PAY_DONE_TOKEN_SHAPE.test(`${'A'.repeat(42)}=`)).toBe(false)
  })

  it('imports nothing but node:crypto', () => {
    expect(importsOf(read('pay-done-token.js'))).toEqual(['node:crypto'])
  })

  it('pay-done.js takes the hash from the leaf, never from purchase-intents', () => {
    const imports = importsOf(read('pay-done.js'))
    expect(imports).toContain('./pay-done-token')
    expect(imports).not.toContain('./purchase-intents')
  })

  it('purchase-intents.js takes the token helpers from the leaf', () => {
    expect(importsOf(read('purchase-intents.js'))).toContain('./pay-done-token')
  })
})
