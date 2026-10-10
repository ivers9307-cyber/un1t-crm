// W1.B2 — /api/public/branding?location_id= is the phone's brand source.
// The route answers with the resolved chain (W1.B1) PLUS the product names
// built from the SHORT brand, so a screen that only needs "{Brand} Points"
// never has to import the helper or know which name is the short one.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 59, resetAt: new Date(0) })),
  getClientIp: vi.fn(() => '203.0.113.9'),
  rateLimitResponse: vi.fn(() => new Response('{}', { status: 429 })),
}))

const anonymousRow = { data: { logo_url: null, favicon_url: null, company_name: 'First Row' }, error: null }
vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => ({
    from: () => ({ select: () => ({ limit: () => ({ single: async () => anonymousRow }) }) }),
  })),
}))

vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({
    companyName: 'UN1T Dublin',
    shortName: 'UN1T',
    companyNameConfigured: true,
    logoUrl: 'https://cdn/logo.png',
    faviconUrl: null,
  })),
}))

import { getLocationBranding } from '@/lib/location-branding'
import { GET } from './route.js'

const req = (url) => new Request(`https://crm.repset.ie${url}`)

beforeEach(() => {
  getLocationBranding.mockClear()
})

describe('GET /api/public/branding?location_id= (W1.B2)', () => {
  it('answers the chain plus product names built from the SHORT brand', async () => {
    const res = await GET(req('/api/public/branding?location_id=loc-1'))
    expect(res.status).toBe(200)
    const { success, data } = await res.json()
    expect(success).toBe(true)
    expect(getLocationBranding).toHaveBeenCalledWith(expect.anything(), 'loc-1')
    expect(data).toEqual({
      logo_url: 'https://cdn/logo.png',
      favicon_url: null,
      company_name: 'UN1T Dublin',
      short_name: 'UN1T',
      product_names: { points: 'UN1T Points', hr: 'UN1T HR' },
      points_unit: 'UN1T',
    })
  })

  it('an unresolved brand yields bare nouns, never a literal', async () => {
    getLocationBranding.mockResolvedValueOnce({
      companyName: '', shortName: '', companyNameConfigured: false, logoUrl: null, faviconUrl: null,
    })
    const { data } = await (await GET(req('/api/public/branding?location_id=loc-9'))).json()
    expect(data.company_name).toBe('')
    expect(data.short_name).toBe('')
    expect(data.product_names).toEqual({ points: 'Points', hr: 'HR' })
    expect(data.points_unit).toBe('pts')
    expect(JSON.stringify(data)).not.toMatch(/UN1T/)
  })

  it('the anonymous (no location) answer is unchanged', async () => {
    const { data } = await (await GET(req('/api/public/branding'))).json()
    expect(data).toEqual({ logo_url: null, favicon_url: null, company_name: 'First Row' })
    expect(getLocationBranding).not.toHaveBeenCalled()
  })
})
