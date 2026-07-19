// SAAS-3 — Edge-safe per-org API key helpers (used by src/proxy.js).
//
// The load-bearing property: sha256HexEdge (Web Crypto, Edge runtime)
// must produce byte-identical output to hashApiKey (node:crypto) —
// the proxy hashes the presented token on the Edge and looks it up
// against api_keys.key_hash rows that were written by the Node side.
// Any divergence silently locks every per-org key out at the middleware.

import { describe, it, expect } from 'vitest'
import { API_KEY_PREFIX, isApiKeyToken, sha256HexEdge } from './api-keys-edge.js'
import { hashApiKey, generateApiKey, API_KEY_PREFIX as NODE_PREFIX } from './api-keys.js'

describe('sha256HexEdge', () => {
  it('matches node:crypto hashApiKey byte-for-byte', async () => {
    for (const input of ['unitk_deadbeef', 'unitk_' + 'a'.repeat(40), '', 'not-a-key']) {
      expect(await sha256HexEdge(input)).toBe(hashApiKey(input))
    }
  })

  it('matches for a freshly generated key (the round-trip the proxy performs)', async () => {
    const k = generateApiKey()
    expect(await sha256HexEdge(k.full)).toBe(k.hash)
  })

  it('is 64 lowercase hex chars', async () => {
    expect(await sha256HexEdge('unitk_abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('isApiKeyToken (edge copy is the single source of truth)', () => {
  it('shares the prefix constant with api-keys.js', () => {
    expect(API_KEY_PREFIX).toBe(NODE_PREFIX)
  })
  it('true only for the unitk_ prefix', () => {
    expect(isApiKeyToken('unitk_deadbeef')).toBe(true)
    expect(isApiKeyToken('some-legacy-shared-secret')).toBe(false)
    expect(isApiKeyToken('')).toBe(false)
    expect(isApiKeyToken(null)).toBe(false)
  })
})
