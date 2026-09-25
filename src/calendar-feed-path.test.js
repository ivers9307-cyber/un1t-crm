// ICSFEED.1 — which hosts serve the calendar feed anonymously.
//
// Deliberately NOT in src/public-compliance-paths.test.jsx: that file guards
// paths that must be public on EVERY host. This one must be public on the CRM
// hosts only (the URL is always minted from getAppUrl()), and must NOT be
// served on the marketing host or a tenant host. Both directions are pinned,
// so an entry added "for completeness" to brands.js fails here.
//
// Scaffolding mirrors public-compliance-paths.test.jsx: the REAL proxy, the
// REAL brand registry and the REAL DB brand defaults; only Supabase and the
// tenant_domains row lookup are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ssrClient = {
  auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  from: () => { throw new Error('no table access expected in these tests') },
}
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ssrClient }))

let tenantBrandImpl = async () => null
vi.mock('@/lib/tenant-domains-edge', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveTenantDomainBrand: (...args) => tenantBrandImpl(...args),
}))

import { proxy } from './proxy.js'
import { BRANDS } from './lib/brands.js'
import { DB_BRAND_DEFAULTS } from './lib/tenant-domains-edge.js'

const FEED = `/api/calendar-feed/rcf_${'A'.repeat(43)}.ics`
const TENANT_HOST = 'fitness.example.com'

function makeReq({ host, path }) {
  return {
    method: 'GET',
    headers: new Headers({ host }),
    url: `https://${host}${path}`,
    nextUrl: { pathname: path, search: '', clone: () => new URL(`https://${host}${path}`) },
    cookies: { getAll: () => [], get: () => undefined, set: () => {} },
  }
}
const admitted = (res) => res.headers.get('x-middleware-next') === '1'
const rewrittenTo = (res) => res.headers.get('x-middleware-rewrite')

beforeEach(() => {
  vi.clearAllMocks()
  ssrClient.auth.getUser.mockResolvedValue({ data: { user: null } })
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
  tenantBrandImpl = async () => null
})
afterEach(() => { vi.unstubAllEnvs() })

describe('the feed is anonymous on the CRM hosts', () => {
  for (const host of ['crm.repset.ie', 'crm.un1tdublin.com']) {
    it(`${host} admits it without consulting a session`, async () => {
      const res = await proxy(makeReq({ host, path: FEED }))
      expect(admitted(res)).toBe(true)
      expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
    })
  }

  it('also without the .ics suffix', async () => {
    const res = await proxy(makeReq({ host: 'crm.repset.ie', path: FEED.replace(/\.ics$/, '') }))
    expect(admitted(res)).toBe(true)
  })
})

describe('nothing else inherits the exemption', () => {
  for (const path of ['/api/calendar-feeds/x', '/api/calendar-feed-admin', '/api/me/calendar-feed']) {
    it(`${path} still needs a session`, async () => {
      const res = await proxy(makeReq({ host: 'crm.repset.ie', path }))
      expect(admitted(res)).toBe(false)
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/login')
    })
  }
})

describe('brand and tenant hosts do NOT serve it (deliberate)', () => {
  it('the marketing host rewrites it to /welcome', async () => {
    const res = await proxy(makeReq({ host: 'un1tdublin.com', path: FEED }))
    expect(rewrittenTo(res)).toContain('/welcome')
  })

  it('a tenant host rewrites it to /welcome', async () => {
    tenantBrandImpl = async (hostname) =>
      hostname && hostname.split(':')[0] === TENANT_HOST
        ? { id: `tenant:${TENANT_HOST}`, hostnames: [TENANT_HOST], ...DB_BRAND_DEFAULTS }
        : null
    const res = await proxy(makeReq({ host: TENANT_HOST, path: FEED }))
    expect(rewrittenTo(res)).toContain('/welcome')
  })

  it('no brand allowlist and not the tenant defaults name it', () => {
    for (const b of BRANDS) {
      expect(b.allowedPaths.some((p) => FEED.startsWith(p)), `brand ${b.id}`).toBe(false)
    }
    expect(DB_BRAND_DEFAULTS.allowedPaths.some((p) => FEED.startsWith(p))).toBe(false)
  })
})
