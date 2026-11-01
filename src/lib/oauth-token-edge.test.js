// MCP.1 — jwtClientId reads the OAuth `client_id` claim off a JWT payload
// without verifying it (edge-safe). The proxy uses it only to REFUSE such a
// token on every /api route but /api/mcp; the route verifies it properly.

import { describe, it, expect } from 'vitest'
import { jwtClientId } from './oauth-token-edge.js'

const mk = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

describe('jwtClientId', () => {
  it('reads client_id off a JWT payload', () => {
    expect(jwtClientId(mk({ sub: 'u1', client_id: 'abc' }))).toBe('abc')
  })

  it('answers null for a session JWT, a unitk_ key, garbage and empty', () => {
    expect(jwtClientId(mk({ sub: 'u1' }))).toBeNull()
    expect(jwtClientId('unitk_' + '1'.repeat(40))).toBeNull()
    expect(jwtClientId('not.a.jwt.at.all')).toBeNull()
    expect(jwtClientId('')).toBeNull()
  })

  it('answers null for a non-string or empty client_id and non-string input', () => {
    expect(jwtClientId(mk({ client_id: '' }))).toBeNull()
    expect(jwtClientId(mk({ client_id: 5 }))).toBeNull()
    expect(jwtClientId(mk({ client_id: null }))).toBeNull()
    expect(jwtClientId(undefined)).toBeNull()
    expect(jwtClientId(null)).toBeNull()
  })

  it('never throws on a malformed payload', () => {
    expect(jwtClientId('h.@@@.s')).toBeNull()
    expect(jwtClientId(`h.${Buffer.from('not json').toString('base64url')}.s`)).toBeNull()
    expect(jwtClientId(`h.${Buffer.from('[1]').toString('base64url')}.s`)).toBeNull()
    expect(jwtClientId(`h.${Buffer.from('null').toString('base64url')}.s`)).toBeNull()
  })
})
