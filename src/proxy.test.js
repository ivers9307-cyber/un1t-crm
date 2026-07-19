// SAAS-3 — middleware Bearer gate. Before this change the proxy accepted
// only the legacy shared CRM_API_KEY or a Supabase JWT: per-org `unitk_`
// keys failed both paths, fell through to cookie auth and got redirected
// to /login — dead on arrival regardless of route-level support. These
// tests pin all three Bearer paths, including that the legacy key's
// behaviour is byte-identical (admitted with zero Supabase calls).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture,
  GLOBAL_KEY, ORG1_KEY, ORG2_KEY_REVOKED, UNKNOWN_KEY,
} from './lib/api-auth.test-helpers.js'

let db
const ssrClient = {
  auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  from: (table) => db.from(table),
}
const createServerClient = vi.fn(() => ssrClient)
vi.mock('@supabase/ssr', () => ({ createServerClient: (...a) => createServerClient(...a) }))
vi.mock('@/lib/brands', () => ({ resolveBrand: () => null, isFrameworkAsset: () => false }))
// SAAS-8 — the DB brand tier is mocked to a miss here, same as the
// in-code tier above: this file pins the Bearer gate, and a null keeps
// the CRM-hostname flow identical. The DB tier's own behaviour is
// covered in proxy.tenant-domains.test.js + tenant-domains-edge.test.js.
vi.mock('@/lib/tenant-domains-edge', () => ({ resolveTenantDomainBrand: async () => null }))

import { proxy } from './proxy.js'

function makeReq({ path = '/api/bookings', token = null } = {}) {
  const headers = new Headers({ host: 'crm.un1tdublin.com' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return {
    headers,
    url: `http://localhost${path}`,
    nextUrl: { pathname: path, clone: () => new URL(`http://localhost${path}`) },
    cookies: { getAll: () => [], set: () => {} },
  }
}

const admitted = (res) => res.headers.get('x-middleware-next') === '1'

beforeEach(() => {
  vi.clearAllMocks()
  ssrClient.auth.getUser.mockResolvedValue({ data: { user: null } })
  vi.stubEnv('CRM_API_KEY', GLOBAL_KEY)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
  db = makeFakeDb(twoOrgFixture())
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('proxy Bearer gate', () => {
  it('legacy CRM_API_KEY admitted with ZERO Supabase calls — unchanged', async () => {
    const res = await proxy(makeReq({ token: GLOBAL_KEY }))
    expect(admitted(res)).toBe(true)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('active per-org unitk_ key is admitted (real hash lookup in api_keys)', async () => {
    const res = await proxy(makeReq({ token: ORG1_KEY }))
    expect(admitted(res)).toBe(true)
    // unitk_ tokens are never Supabase JWTs — the auth API must not be hit.
    expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
  })

  it('revoked per-org key is NOT admitted — falls to the cookie gate → /login', async () => {
    const res = await proxy(makeReq({ token: ORG2_KEY_REVOKED }))
    expect(admitted(res)).toBe(false)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login')
  })

  it('unknown unitk_ token is NOT admitted and skips the JWT path', async () => {
    const res = await proxy(makeReq({ token: UNKNOWN_KEY }))
    expect(admitted(res)).toBe(false)
    // The only getUser call allowed is the zero-arg cookie-session check.
    for (const call of ssrClient.auth.getUser.mock.calls) {
      expect(call).toHaveLength(0)
    }
  })

  it('non-unitk Bearer still rides the Supabase JWT path (mobile) — unchanged', async () => {
    ssrClient.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    const res = await proxy(makeReq({ token: 'some.supabase.jwt' }))
    expect(admitted(res)).toBe(true)
    expect(ssrClient.auth.getUser).toHaveBeenCalledWith('some.supabase.jwt')
  })

  it('missing SUPABASE_SERVICE_ROLE_KEY fails closed for unitk_ keys (no throw)', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    const res = await proxy(makeReq({ token: ORG1_KEY }))
    expect(admitted(res)).toBe(false)
    expect(res.status).toBe(307)
  })
})
