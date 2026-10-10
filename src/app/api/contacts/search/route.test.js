// SAAS-3 — GET /api/contacts/search under API-key auth (the Pipedrive-
// replacement integration search). Regression for the thenable-assimilation bug
// (see campaigns/route.test.js): `query.ilike(…)` after the old scope
// call threw on the executed response object for every API-key caller.
// Also the two-org leak test for the org filter itself.
// api-auth is real; supabase + the POST-only heavy deps are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture, RETIRED_SHARED_KEY, ORG1_KEY,
} from '@/lib/api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/audience-filter', () => ({ applyAudienceFilterAsync: vi.fn(), InvalidAudienceFilterError: class extends Error {} }))
vi.mock('@/lib/contact-crossovers', () => ({ crossoverContactIds: vi.fn(), fetchCrossoverContext: vi.fn(), fetchListMembershipFlags: vi.fn() }))
vi.mock('@/lib/person-links', () => ({ attachLinkedCounts: vi.fn() }))

import { GET } from './route.js'

const req = (token, qs) =>
  new Request(`http://localhost/api/contacts/search${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  })

beforeEach(() => {
  db = makeFakeDb(twoOrgFixture())
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/contacts/search — API-key callers', () => {
  it('the retired shared key → 401 (APIKEYS.4)', async () => {
    const res = await GET(req(RETIRED_SHARED_KEY, '?term=example.com'))
    expect(res.status).toBe(401)
  })

  it('per-org key can only find its own org\'s contacts (two-org leak test)', async () => {
    const res = await GET(req(ORG1_KEY, '?term=example.com'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.items.map(({ item }) => item.id)).toEqual(['c1'])
  })

  it('per-org key gets no hit for another org\'s contact even by exact email', async () => {
    const res = await GET(req(ORG1_KEY, '?term=two@example.com'))
    const body = await res.json()
    expect(body.data.items).toEqual([])
  })
})
