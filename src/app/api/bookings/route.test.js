// SAAS-3 — org scoping on GET /api/bookings (list route, per-org keys).
//
// api-auth is REAL here (only the supabase client is faked, with a
// filter-aware double): the per-org key resolves by actual SHA-256
// lookup and the org filter actually filters. If the route ever drops
// its orgLocationIds scoping block, the two-org leak test fails.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture,
  GLOBAL_KEY, ORG1_KEY, ORG2_KEY_REVOKED, EMPTY_ORG_KEY,
} from '@/lib/api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null) }))

import { GET } from './route.js'

const req = (token, qs = '') =>
  new Request(`http://localhost/api/bookings${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  })

beforeEach(() => {
  vi.stubEnv('CRM_API_KEY', GLOBAL_KEY)
  db = makeFakeDb(twoOrgFixture())
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/bookings — per-org key scoping', () => {
  it('per-org key sees ONLY its own org\'s locations\' bookings (two-org leak test)', async () => {
    const res = await GET(req(ORG1_KEY))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((b) => b.id)).toEqual(['b1'])
  })

  it('per-org key of an org with zero locations gets an empty list, never everything', async () => {
    const res = await GET(req(EMPTY_ORG_KEY))
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toEqual([])
  })

  it('legacy CRM_API_KEY stays unscoped — sees both orgs (unchanged)', async () => {
    const res = await GET(req(GLOBAL_KEY))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((b) => b.id).sort()).toEqual(['b1', 'b2'])
  })

  it('revoked per-org key → 401', async () => {
    const res = await GET(req(ORG2_KEY_REVOKED))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.success).toBe(false)
  })

  it('per-org key cannot widen scope via ?location_id= for another org', async () => {
    const res = await GET(req(ORG1_KEY, '?location_id=loc-2a'))
    const body = await res.json()
    // Org filter (IN org-1 locations) intersects the explicit loc-2a → nothing.
    expect(body.data).toEqual([])
  })
})
