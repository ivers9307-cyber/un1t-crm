import { describe, it, expect } from 'vitest'
import { getLocationBranding } from './location-branding.js'

// Minimal supabase-builder mock: from().select().eq().limit() resolves to `result`.
function mockDb(result) {
  const builder = {
    from() { return this },
    select() { return this },
    eq() { return this },
    limit() { return Promise.resolve(result) },
  }
  return builder
}

describe('getLocationBranding', () => {
  it('returns the configured company name + assets', async () => {
    const db = mockDb({ data: [{ company_name: 'CCF Autos', logo_url: 'l.png', favicon_url: 'f.ico' }], error: null })
    expect(await getLocationBranding(db, 'loc1')).toEqual({ companyName: 'CCF Autos', logoUrl: 'l.png', faviconUrl: 'f.ico' })
  })

  it('falls back to UN1T when no row exists', async () => {
    const db = mockDb({ data: [], error: null })
    expect((await getLocationBranding(db, 'loc1')).companyName).toBe('UN1T')
  })

  it('falls back to UN1T when company_name is blank', async () => {
    const db = mockDb({ data: [{ company_name: '   ', logo_url: null, favicon_url: null }], error: null })
    expect((await getLocationBranding(db, 'loc1')).companyName).toBe('UN1T')
  })

  it('returns defaults (never throws) on a query error', async () => {
    const db = mockDb({ data: null, error: { message: 'boom' } })
    expect(await getLocationBranding(db, 'loc1')).toEqual({ companyName: 'UN1T', logoUrl: null, faviconUrl: null })
  })

  it('returns defaults when locationId is missing', async () => {
    expect(await getLocationBranding(mockDb({}), null)).toEqual({ companyName: 'UN1T', logoUrl: null, faviconUrl: null })
  })
})
