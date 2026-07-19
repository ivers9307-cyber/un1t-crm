import { describe, it, expect } from 'vitest'
import {
  STILLORGAN_LANDING_LOGO,
  resolveLandingLogo,
  getLandingLogo,
} from './landing-logo.js'

// supabase-builder mock for the helper's single query shape:
// from('landing_page_settings').select().eq().maybeSingle().
function mockDb(result) {
  return {
    from() { return this },
    select() { return this },
    eq() { return this },
    maybeSingle() {
      if (result instanceof Error) return Promise.reject(result)
      return Promise.resolve(result)
    },
  }
}

describe('STILLORGAN_LANDING_LOGO', () => {
  it('pins the exact pre-SAAS-7 hardcoded /start + /free-class logo (fallback equivalence)', () => {
    expect(STILLORGAN_LANDING_LOGO).toBe(
      'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/a0000000-0000-0000-0000-000000000001/de12ffbe-22db-4c34-b307-8983488ffd96.png'
    )
  })
})

describe('resolveLandingLogo', () => {
  it('returns the operator-configured logo_url when present', () => {
    expect(resolveLandingLogo({ logo_url: 'https://cdn/logo.png' }, 'fb')).toBe('https://cdn/logo.png')
  })

  it('falls back when the row has no logo_url', () => {
    expect(resolveLandingLogo({ logo_url: null }, 'fb')).toBe('fb')
  })

  it('falls back when logo_url is blank', () => {
    expect(resolveLandingLogo({ logo_url: '   ' }, 'fb')).toBe('fb')
  })

  it('falls back when the row is missing entirely', () => {
    expect(resolveLandingLogo(null, 'fb')).toBe('fb')
  })
})

describe('getLandingLogo', () => {
  it('returns the configured logo for the public path', async () => {
    const db = mockDb({ data: { logo_url: 'https://cdn/logo.png' }, error: null })
    expect(await getLandingLogo('stillorgan', 'fb', db)).toBe('https://cdn/logo.png')
  })

  it('falls back on a missing row', async () => {
    const db = mockDb({ data: null, error: null })
    expect(await getLandingLogo('stillorgan', 'fb', db)).toBe('fb')
  })

  it('falls back on a query error', async () => {
    const db = mockDb({ data: null, error: { message: 'boom' } })
    expect(await getLandingLogo('stillorgan', 'fb', db)).toBe('fb')
  })

  it('falls back when the client throws (never breaks a live ad page)', async () => {
    const db = mockDb(new Error('network down'))
    expect(await getLandingLogo('stillorgan', 'fb', db)).toBe('fb')
  })

  it('resolves the SAME logo as today for UN1T when the row is unset (fallback equivalence)', async () => {
    const db = mockDb({ data: null, error: null })
    expect(await getLandingLogo('stillorgan', STILLORGAN_LANDING_LOGO, db)).toBe(STILLORGAN_LANDING_LOGO)
  })
})
