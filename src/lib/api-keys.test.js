import { describe, it, expect } from 'vitest'
import {
  hashApiKey, isApiKeyToken, apiKeyDisplayPrefix, generateApiKey,
  API_KEY_PREFIX, API_KEY_DISPLAY_LEN,
} from './api-keys.js'

describe('hashApiKey', () => {
  it('is deterministic and 64 hex chars (sha256)', () => {
    const a = hashApiKey('unitk_abc')
    expect(a).toBe(hashApiKey('unitk_abc'))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
  it('differs for different input', () => {
    expect(hashApiKey('unitk_a')).not.toBe(hashApiKey('unitk_b'))
  })
})

describe('isApiKeyToken', () => {
  it('true only for the unitk_ prefix', () => {
    expect(isApiKeyToken('unitk_deadbeef')).toBe(true)
    expect(isApiKeyToken('some-legacy-shared-secret')).toBe(false)
    expect(isApiKeyToken('')).toBe(false)
    expect(isApiKeyToken(null)).toBe(false)
    expect(isApiKeyToken(undefined)).toBe(false)
  })
})

describe('generateApiKey', () => {
  it('produces a well-formed key', () => {
    const k = generateApiKey()
    expect(k.full.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(k.full).toHaveLength(API_KEY_PREFIX.length + 40)
    expect(k.prefix).toHaveLength(API_KEY_DISPLAY_LEN)
    expect(k.full.startsWith(k.prefix)).toBe(true)
    expect(k.hash).toBe(hashApiKey(k.full))
    expect(isApiKeyToken(k.full)).toBe(true)
  })
  it('is unique per call', () => {
    expect(generateApiKey().full).not.toBe(generateApiKey().full)
  })
  it('stored prefix never reveals enough to reconstruct the key', () => {
    const k = generateApiKey()
    expect(k.prefix.length).toBeLessThan(k.full.length)
    expect(apiKeyDisplayPrefix(k.full)).toBe(k.prefix)
  })
})
