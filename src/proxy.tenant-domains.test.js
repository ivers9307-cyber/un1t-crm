// SAAS-8 — the proxy's handling of DB-tier brands (tenant_domains).
// Mirrors proxy.test.js's mock pattern: @supabase/ssr and the in-code
// brand tier are faked, the proxy itself is real. What's pinned:
//
//   • a DB brand rides the SAME handler block as in-code brands —
//     'reject' 404s, 'rewrite' lands on /welcome via an IN-PROXY
//     rewrite (DB brands can't rely on the build-baked next.config
//     host rewrites), allowlisted paths pass untouched;
//   • layering — the DB tier is consulted only when the in-code tier
//     misses, and an in-code hit never pays the DB lookup;
//   • fail-safe — a host with no row (or a DB tier resolving null for
//     any reason) falls through to the CRM auth gate exactly like an
//     unknown hostname today: 307 → /login.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ssrClient = {
  auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  from: () => { throw new Error('no table access expected in these tests') },
}
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ssrClient }))

// Both tiers delegate to swappable impls so each test controls them.
let resolveBrandImpl = () => null
let tenantBrandImpl = async () => null
vi.mock('@/lib/brands', () => ({
  resolveBrand: (...a) => resolveBrandImpl(...a),
  isFrameworkAsset: (path) => path.startsWith('/_next/'),
}))
vi.mock('@/lib/tenant-domains-edge', () => ({
  resolveTenantDomainBrand: vi.fn(async (...a) => tenantBrandImpl(...a)),
}))

import { proxy } from './proxy.js'
import { resolveTenantDomainBrand } from '@/lib/tenant-domains-edge'

// A DB-tier brand exactly as tenant-domains-edge.js builds it from a
// row whose brand jsonb is {} (the column default — marketing shape).
const DB_MARKETING_BRAND = {
  id: 'tenant:members.acmegym.ie',
  description: 'Tenant domain (members.acmegym.ie)',
  hostnames: ['members.acmegym.ie'],
  allowedPaths: ['/welcome', '/book/', '/event/', '/api/public/', '/api/webhooks/'],
  rootHandler: 'rewrite',
  rootRewriteTo: '/welcome',
  fallbackHandler: 'rewrite',
  fallbackRewriteTo: '/welcome',
  organizationId: 'org-acme',
}

const DB_REJECT_BRAND = {
  ...DB_MARKETING_BRAND,
  id: 'tenant:pay.acmegym.ie',
  hostnames: ['pay.acmegym.ie'],
  allowedPaths: ['/deposit/'],
  rootHandler: 'reject',
  fallbackHandler: 'reject',
}

function makeReq({ host = 'members.acmegym.ie', path = '/' } = {}) {
  return {
    headers: new Headers({ host }),
    url: `https://${host}${path}`,
    nextUrl: { pathname: path, clone: () => new URL(`https://${host}${path}`) },
    cookies: { getAll: () => [], set: () => {} },
  }
}

const admitted = (res) => res.headers.get('x-middleware-next') === '1'
const rewrittenTo = (res) => res.headers.get('x-middleware-rewrite')

beforeEach(() => {
  vi.clearAllMocks()
  resolveBrandImpl = () => null
  tenantBrandImpl = async () => null
  ssrClient.auth.getUser.mockResolvedValue({ data: { user: null } })
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('proxy × DB-tier brand — rewrite mode (marketing defaults)', () => {
  beforeEach(() => { tenantBrandImpl = async () => DB_MARKETING_BRAND })

  it('root "/" rewrites to /welcome IN THE PROXY (no next.config dependency)', async () => {
    const res = await proxy(makeReq({ path: '/' }))
    expect(rewrittenTo(res)).toContain('/welcome')
    expect(res.status).toBe(200)
  })

  it('a disallowed path rewrites to /welcome (stray hits land home, no CRM leak)', async () => {
    const res = await proxy(makeReq({ path: '/dashboard' }))
    expect(rewrittenTo(res)).toContain('/welcome')
  })

  it('an allowlisted path passes through with NO CRM auth gate', async () => {
    const res = await proxy(makeReq({ path: '/book/intro-class' }))
    expect(admitted(res)).toBe(true)
    expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
  })

  it('framework assets pass unconditionally (page can render its CSS/JS)', async () => {
    const res = await proxy(makeReq({ path: '/_next/static/chunks/main.js' }))
    expect(admitted(res)).toBe(true)
  })
})

describe('proxy × DB-tier brand — reject mode (payment-style isolation)', () => {
  beforeEach(() => { tenantBrandImpl = async () => DB_REJECT_BRAND })

  it('root "/" 404s', async () => {
    const res = await proxy(makeReq({ host: 'pay.acmegym.ie', path: '/' }))
    expect(res.status).toBe(404)
  })

  it('a disallowed path 404s — nothing hints the CRM shares the deployment', async () => {
    const res = await proxy(makeReq({ host: 'pay.acmegym.ie', path: '/dashboard' }))
    expect(res.status).toBe(404)
  })

  it('the allowlisted path passes', async () => {
    const res = await proxy(makeReq({ host: 'pay.acmegym.ie', path: '/deposit/abc' }))
    expect(admitted(res)).toBe(true)
  })
})

describe('proxy × DB tier — layering + fail-safe', () => {
  it('an in-code brand hit NEVER consults the DB tier (live hostnames pay nothing)', async () => {
    resolveBrandImpl = () => ({
      id: 'ccfautos-pay',
      hostnames: ['pay.ccfautos.com'],
      allowedPaths: ['/deposit/'],
      rootHandler: 'reject',
      fallbackHandler: 'reject',
    })
    const res = await proxy(makeReq({ host: 'pay.ccfautos.com', path: '/' }))
    expect(res.status).toBe(404)
    expect(resolveTenantDomainBrand).not.toHaveBeenCalled()
  })

  it('unknown host with no row falls through to the CRM auth gate (today\'s behaviour, pinned)', async () => {
    const res = await proxy(makeReq({ host: 'nobody.example.com', path: '/dashboard' }))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login')
  })

  it('DB tier resolving null for ANY reason (down/empty/slow) = the same fall-through', async () => {
    // tenant-domains-edge already maps every failure to null; the proxy
    // must treat that null identically to "no row".
    tenantBrandImpl = async () => null
    const res = await proxy(makeReq({ host: 'members.acmegym.ie', path: '/' }))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login')
  })
})
