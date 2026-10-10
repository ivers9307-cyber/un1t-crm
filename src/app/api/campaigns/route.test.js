// SAAS-3 — GET /api/campaigns under API-key auth. Regression for the
// thenable-assimilation bug: the old `query = await scopeQueryToOrg(…)`
// executed the builder mid-chain (await assimilates thenables), so the
// later `query.limit(50)` threw a TypeError on the plain response
// object for EVERY API-key caller.
// api-auth is real here; only the supabase client is faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture, RETIRED_SHARED_KEY, ORG1_KEY,
} from '@/lib/api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null) }))

import { GET } from './route.js'

const req = (token) =>
  new Request('http://localhost/api/campaigns', {
    headers: { authorization: `Bearer ${token}` },
  })

beforeEach(() => {
  db = makeFakeDb(twoOrgFixture())
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/campaigns — API-key callers', () => {
  it('the retired shared key → 401 (APIKEYS.4)', async () => {
    const res = await GET(req(RETIRED_SHARED_KEY))
    expect(res.status).toBe(401)
  })

  it('per-org key sees only its own org\'s campaigns', async () => {
    const res = await GET(req(ORG1_KEY))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((c) => c.id)).toEqual(['cam1'])
  })
})
