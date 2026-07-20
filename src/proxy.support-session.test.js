// SUPPORT-ACCESS (Repset Phase 3) — the read-only enforcement AT THE
// CENTRAL CHOKEPOINT. Drives the real proxy() with a real signed cookie
// so the whole decision (cookie verify → decideSupportWriteBlock → 403)
// is exercised end-to-end, not just the pure helper.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Same mocks as proxy.test.js — brand tiers miss so the CRM-hostname flow
// runs; the SSR client resolves no user (we never reach the auth gate for
// the block cases). support-session-edge is NOT mocked — real crypto.
const ssrClient = {
  auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
}
const createServerClient = vi.fn(() => ssrClient)
vi.mock('@supabase/ssr', () => ({ createServerClient: (...a) => createServerClient(...a) }))
vi.mock('@/lib/brands', () => ({ resolveBrand: () => null, isFrameworkAsset: () => false }))
vi.mock('@/lib/tenant-domains-edge', () => ({ resolveTenantDomainBrand: async () => null }))

import { proxy } from './proxy.js'
import { signSupportPayload, SUPPORT_COOKIE } from './lib/support-session-edge.js'

function makeReq({ path = '/api/contacts', method = 'GET', supportCookie = null } = {}) {
  const headers = new Headers({ host: 'crm.un1tdublin.com' })
  const cookieJar = new Map()
  if (supportCookie) cookieJar.set(SUPPORT_COOKIE, supportCookie)
  return {
    method,
    headers,
    url: `http://localhost${path}`,
    nextUrl: { pathname: path, clone: () => new URL(`http://localhost${path}`) },
    cookies: {
      get: (name) => (cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined),
      getAll: () => [],
      set: () => {},
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ssrClient.auth.getUser.mockResolvedValue({ data: { user: null } })
  vi.stubEnv('SUPPORT_SESSION_SECRET', 'proxy-test-secret-abcdef')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
})
afterEach(() => vi.unstubAllEnvs())

const future = () => Date.now() + 60 * 60 * 1000

async function roCookie(org = 'org-a') {
  return signSupportPayload({ sid: 's1', org, mode: 'read_only', master: 'm1', exp: future() })
}
async function aobCookie(org = 'org-a') {
  return signSupportPayload({ sid: 's1', org, mode: 'act_on_behalf', master: 'm1', exp: future() })
}

describe('proxy — read-only support session blocks writes', () => {
  it('read-only + POST /api/* → 403 read_only_support_mode', async () => {
    const res = await proxy(makeReq({ path: '/api/contacts', method: 'POST', supportCookie: await roCookie() }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('read_only_support_mode')
  })

  it('read-only + server-action POST to a PAGE route → 403 (covers server actions)', async () => {
    const res = await proxy(makeReq({ path: '/portfolio', method: 'POST', supportCookie: await roCookie() }))
    expect(res.status).toBe(403)
  })

  it('read-only + PATCH / PUT / DELETE → 403', async () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const res = await proxy(makeReq({ path: '/api/contacts/1', method, supportCookie: await roCookie() }))
      expect(res.status).toBe(403)
    }
  })

  it('read-only + GET → NOT blocked (read passes through the gate)', async () => {
    const res = await proxy(makeReq({ path: '/api/contacts', method: 'GET', supportCookie: await roCookie() }))
    // GET is not blocked by the support gate; it continues to the normal
    // auth flow (no user → redirect to /login), i.e. status 307 not 403.
    expect(res.status).not.toBe(403)
  })

  it('read-only + POST to the EXIT control route → NOT blocked (allowlisted)', async () => {
    const res = await proxy(makeReq({ path: '/api/support-session/exit', method: 'POST', supportCookie: await roCookie() }))
    expect(res.status).not.toBe(403)
  })

  it('read-only + POST to the SWITCH control route → NOT blocked (can upgrade)', async () => {
    const res = await proxy(makeReq({ path: '/api/support-session/switch', method: 'POST', supportCookie: await roCookie() }))
    expect(res.status).not.toBe(403)
  })

  it('read-only + POST to /api/impersonate/stop → NOT blocked (escape hatch)', async () => {
    const res = await proxy(makeReq({ path: '/api/impersonate/stop', method: 'POST', supportCookie: await roCookie() }))
    expect(res.status).not.toBe(403)
  })
})

describe('proxy — act-on-behalf allows scoped writes', () => {
  it('act_on_behalf + POST /api/* → NOT blocked by the support gate', async () => {
    const res = await proxy(makeReq({ path: '/api/contacts', method: 'POST', supportCookie: await aobCookie() }))
    expect(res.status).not.toBe(403)
  })
})

describe('proxy — fail closed', () => {
  it('a tampered support cookie + POST → 403 (cannot upgrade to act_on_behalf)', async () => {
    const res = await proxy(makeReq({ path: '/api/contacts', method: 'POST', supportCookie: 'forged.cookie' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('read_only_support_mode')
  })

  it('no support cookie + POST → NOT blocked by the support gate (normal traffic)', async () => {
    const res = await proxy(makeReq({ path: '/api/contacts', method: 'POST' }))
    expect(res.status).not.toBe(403)
  })
})
