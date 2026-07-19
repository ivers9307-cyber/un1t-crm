// SAAS-3 — GET /api/stages (requireApiKeyOrManager dual-auth route)
// under per-org keys: the org filter really filters, the legacy shared
// key stays unscoped. api-auth is real; only supabase/auth are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture, GLOBAL_KEY, ORG1_KEY,
} from '@/lib/api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null) }))

import { GET } from './route.js'

const req = (token) =>
  new Request('http://localhost/api/stages', {
    headers: { authorization: `Bearer ${token}` },
  })

beforeEach(() => {
  vi.stubEnv('CRM_API_KEY', GLOBAL_KEY)
  const tables = twoOrgFixture()
  tables.pipeline_stages = [
    { id: 's1', location_id: 'loc-1a', name: 'Lead', display_order: 1 },
    { id: 's2', location_id: 'loc-2a', name: 'Lead', display_order: 1 },
  ]
  db = makeFakeDb(tables)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/stages — API-key callers', () => {
  it('per-org key sees only its own org\'s stages', async () => {
    const res = await GET(req(ORG1_KEY))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((s) => s.id)).toEqual(['s1'])
  })

  it('legacy CRM_API_KEY stays unscoped — sees both orgs (unchanged)', async () => {
    const res = await GET(req(GLOBAL_KEY))
    const body = await res.json()
    expect(body.data.map((s) => s.id).sort()).toEqual(['s1', 's2'])
  })
})
