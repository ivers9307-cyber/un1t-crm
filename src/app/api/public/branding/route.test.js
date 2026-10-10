// /api/public/branding has two branches:
//   • `?location_id=` (W1.B2) — the phone's brand source: the resolved chain
//     (W1.B1) PLUS the product names built from the SHORT brand, so a screen
//     that only needs "{Brand} Points" never imports the helper.
//   • anonymous (W1.L4) — login screen, reset-password: no location known
//     yet, so it resolves by the REQUEST HOST's organisation. Before, it read
//     ONE company_settings row estate-wide (`.limit(1).single()`, no order),
//     so every tenant's login screen wore whichever logo sorted first. Now:
//     tenant host → that org's brand; CRM / unmapped host → the platform's
//     name and mark, never another tenant's logo.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { _resetTenantDomainsCache } from '@/lib/tenant-domains-edge.js'
import { _resetHostBrandCache } from '@/lib/host-brand.js'
import { PLATFORM_SITE_NAME } from '@/lib/default-site-name.js'
import { PLATFORM_FAVICON_URL } from '@/lib/default-favicon.js'

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 59, resetAt: new Date(0) })),
  getClientIp: () => '203.0.113.9',
  rateLimitResponse: () => new Response('{}', { status: 429 }),
}))

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

import { GET } from './route.js'

const ORG_A = 'org-a'
const ORG_B = 'org-b'

function tables() {
  return {
    tenant_domains: [
      { id: 'td-a', hostname: 'gym-a.repset.ie', organization_id: ORG_A, brand: {}, active: true, source: 'platform', location_id: null },
      { id: 'td-b', hostname: 'gym-b.repset.ie', organization_id: ORG_B, brand: {}, active: true, source: 'platform', location_id: null },
    ],
    organizations: [{ id: ORG_A, slug: 'gym-a', master_location_id: null }, { id: ORG_B, slug: 'gym-b', master_location_id: null }],
    locations: [
      { id: 'loc-a1', name: 'Gym A', organization_id: ORG_A, active: true, created_at: '2026-01-01' },
      { id: 'loc-b1', name: 'Gym B', organization_id: ORG_B, active: true, created_at: '2026-01-02' },
    ],
    org_settings: [{ organization_id: ORG_A, company_name: null, short_name: 'GA', logo_url: null, favicon_url: null }],
    company_settings: [
      // Gym B sorts first on every column — the row the old first-row pick served to everyone.
      { location_id: 'loc-b1', company_name: 'AAA Gym B', logo_url: 'https://cdn/b-logo.png', favicon_url: 'https://cdn/b.ico' },
      { location_id: 'loc-a1', company_name: 'Gym A', logo_url: 'https://cdn/a-logo.png', favicon_url: null },
    ],
  }
}

const req = (host, qs = '') => new Request(`https://${host}/api/public/branding${qs}`, { headers: { host } })

beforeEach(() => {
  _resetTenantDomainsCache()
  _resetHostBrandCache()
  db = makeFakeDb(tables())
})

describe('GET /api/public/branding?location_id= (W1.B2)', () => {
  it('answers the chain plus product names built from the SHORT brand', async () => {
    const res = await GET(req('crm.repset.ie', '?location_id=loc-a1'))
    expect(res.status).toBe(200)
    const { success, data } = await res.json()
    expect(success).toBe(true)
    expect(data).toEqual({
      logo_url: 'https://cdn/a-logo.png',
      favicon_url: null,
      company_name: 'Gym A',
      short_name: 'GA',
      product_names: { points: 'GA Points', hr: 'GA HR' },
      points_unit: 'GA',
    })
  })

  it('an unresolved brand yields bare nouns, never a literal', async () => {
    const { data } = await (await GET(req('crm.repset.ie', '?location_id=loc-9'))).json()
    expect(data.company_name).toBe('')
    expect(data.short_name).toBe('')
    expect(data.product_names).toEqual({ points: 'Points', hr: 'HR' })
    expect(data.points_unit).toBe('pts')
    expect(JSON.stringify(data)).not.toMatch(/UN1T/)
  })
})

describe('GET /api/public/branding — anonymous branch resolves by host (W1.L4)', () => {
  it('a tenant host → that org\'s brand (logo from its own location, name from its own rows)', async () => {
    const res = await GET(req('gym-a.repset.ie'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ logo_url: 'https://cdn/a-logo.png', favicon_url: null, company_name: 'Gym A' })
  })

  it('a second tenant\'s company_settings row cannot change another tenant\'s login branding', async () => {
    const a = (await (await GET(req('gym-a.repset.ie'))).json()).data
    const b = (await (await GET(req('gym-b.repset.ie'))).json()).data
    expect(a.logo_url).toBe('https://cdn/a-logo.png')
    expect(a.company_name).toBe('Gym A')
    expect(b.logo_url).toBe('https://cdn/b-logo.png')
    expect(b.company_name).toBe('AAA Gym B')
  })

  it('the CRM host → the platform name and mark, no tenant logo, whatever company_settings holds', async () => {
    for (const host of ['crm.repset.ie', 'crm.un1tdublin.com', 'nobody.example.com']) {
      const body = await (await GET(req(host))).json()
      expect(body.success).toBe(true)
      expect(body.data).toEqual({ logo_url: null, favicon_url: PLATFORM_FAVICON_URL, company_name: PLATFORM_SITE_NAME })
    }
  })

  it('the host is normalised: case, port and a trailing dot resolve the same tenant', async () => {
    const body = await (await GET(req('GYM-A.repset.ie:443'))).json()
    expect(body.data.company_name).toBe('Gym A')
  })
})
