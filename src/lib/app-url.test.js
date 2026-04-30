import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getAppUrl, getRequestOrigin } from './app-url.js'

describe('getAppUrl', () => {
  const original = process.env.NEXT_PUBLIC_APP_URL

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = original
  })

  it('returns the configured URL when set', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://crm.example.com'
    expect(getAppUrl()).toBe('https://crm.example.com')
  })

  it('strips a trailing slash', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://crm.example.com/'
    expect(getAppUrl()).toBe('https://crm.example.com')
  })

  it('throws a descriptive error when unset (no silent fallback)', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(() => getAppUrl()).toThrow(/NEXT_PUBLIC_APP_URL is not set/)
  })
})

describe('getRequestOrigin', () => {
  it('returns origin from request.url', () => {
    const req = { url: 'https://crm.un1tdublin.com/api/unsubscribe/abc?x=1' }
    expect(getRequestOrigin(req)).toBe('https://crm.un1tdublin.com')
  })

  it('handles localhost dev URLs', () => {
    const req = { url: 'http://localhost:3000/api/foo' }
    expect(getRequestOrigin(req)).toBe('http://localhost:3000')
  })
})
