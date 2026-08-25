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

function makeReq({ path = '/api/bookings', token = null, method } = {}) {
  const headers = new Headers({ host: 'crm.un1tdublin.com' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return {
    headers,
    method,
    url: `http://localhost${path}`,
    nextUrl: { pathname: path, clone: () => new URL(`http://localhost${path}`) },
    cookies: { getAll: () => [], get: () => undefined, set: () => {} },
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

  // FLEET-CMD.1 — self-guarding device routes must reach their handler.
  //
  // These 307'd to /login on stillorgan-tv2 (2026-08-02): the agent received
  // the login PAGE, tried to JSON.parse the HTML, and crash-looped. Nothing in
  // CI could catch it, because no test ran the agent against a real proxy.
  describe('device-authenticated API prefixes', () => {
    it('lets the fleet agent through to its own bearer check', async () => {
      const res = await proxy(makeReq({ path: '/api/fleet/commands/next' }))
      expect(admitted(res)).toBe(true)
    })

    it('lets the fleet agent post a result', async () => {
      const res = await proxy(makeReq({ path: '/api/fleet/commands/abc/result' }))
      expect(admitted(res)).toBe(true)
    })

    it('still gates the STAFF fleet surface behind a session', async () => {
      // /api/admin/fleet/* issues commands and mints device tokens. If the
      // prefix match ever loosened to catch it, anyone could shut down a Pi.
      const res = await proxy(makeReq({ path: '/api/admin/fleet/commands' }))
      expect(admitted(res)).toBe(false)
    })

    it('keeps the bridge prefix working (regression)', async () => {
      const res = await proxy(makeReq({ path: '/api/bridge/heartbeat' }))
      expect(admitted(res)).toBe(true)
    })
  })

  // REPSET-PUB.3A — the App Store reviewer login gate.
  //
  // Same class as the fleet block above, with a harder consequence: this route
  // is called with NO session (minting one is its job), so a missing
  // publicPaths entry 401s every attempt and Apple can never sign in. That is
  // a rejection under Guideline 2.1 discovered days into a review queue, not a
  // crash-loop someone can watch — nothing else in CI would surface it.
  describe('App Store reviewer login gate', () => {
    it('admits the unauthenticated POST to its handler', async () => {
      const res = await proxy(makeReq({ path: '/api/mobile/review-login', method: 'POST' }))
      expect(admitted(res)).toBe(true)
      // Admitted on the path alone — no session lookup, no Bearer.
      expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
    })

    it('does NOT open the rest of the mobile surface', async () => {
      for (const path of ['/api/mobile/me', '/api/mobile/impersonate', '/api/mobile/today-feed']) {
        const res = await proxy(makeReq({ path }))
        expect(admitted(res), `${path} must stay session-gated`).toBe(false)
      }
    })

    it('matches EXACT-or-slash — a future sibling route is not silently public', async () => {
      // REPSET-PUB.3A-b — the rest of publicPaths is bare-prefix matched, so
      // this entry would also have admitted /api/mobile/review-login-debug,
      // /api/mobile/review-login-status and anything else someone later names
      // with that stem. Nobody adding such a route would think to check the
      // proxy allowlist, which is exactly how an unauthenticated endpoint
      // ships by accident.
      for (const path of [
        '/api/mobile/review-login-debug',
        '/api/mobile/review-loginx',
        '/api/mobile/review-login-status',
      ]) {
        const res = await proxy(makeReq({ path, method: 'POST' }))
        expect(admitted(res), `${path} must NOT be public`).toBe(false)
      }
    })

    it('still admits a child path under the gate itself', async () => {
      const res = await proxy(makeReq({ path: '/api/mobile/review-login/', method: 'POST' }))
      expect(admitted(res)).toBe(true)
    })
  })
})
