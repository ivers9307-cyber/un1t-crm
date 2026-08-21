import { describe, it, expect, afterEach, vi } from 'vitest'
import { getAppUrl, getRequestOrigin, getMemberAppUrl, MEMBER_APP_DEFAULT_ORIGIN } from './app-url.js'

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

// URLSEAM.1 — the member app is a SEPARATE deployment. Its base must never
// be derived from this repo's own NEXT_PUBLIC_APP_URL (that is what 404'd
// every post-class-email session CTA in prod, #1444), and the literal it
// falls back to must live in exactly one place.
describe('getMemberAppUrl', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('reads NEXT_PUBLIC_CHAMP_APP_URL — the member host, not the CRM host', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAMP_APP_URL', 'https://members.example.com')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    expect(getMemberAppUrl()).toBe('https://members.example.com')
  })

  it('strips a trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAMP_APP_URL', 'https://members.example.com/')
    expect(getMemberAppUrl()).toBe('https://members.example.com')
  })

  // Deliberately NOT a throw — see the accessor's comment. A throw on this
  // path deletes a customer email and re-arms the 5-minute push loop.
  it('falls back to the single documented member origin when unset', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAMP_APP_URL', '')
    expect(getMemberAppUrl()).toBe(MEMBER_APP_DEFAULT_ORIGIN)
  })

  it('never falls back to the CRM host, even when NEXT_PUBLIC_APP_URL is set', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAMP_APP_URL', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    expect(getMemberAppUrl()).not.toContain('crm.example.com')
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
