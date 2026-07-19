// SAAS-3 — GET /api/tasks under API-key auth. Regression for the
// thenable-assimilation bug (see campaigns/route.test.js): the scope
// call sat BEFORE the searchParams filters here, so `query.eq(…)` threw
// on the executed response object for every API-key caller.
// api-auth is real; only the supabase client is faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture, GLOBAL_KEY, ORG1_KEY,
} from '@/lib/api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null) }))

import { GET } from './route.js'

const req = (token, qs = '') =>
  new Request(`http://localhost/api/tasks${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  })

beforeEach(() => {
  vi.stubEnv('CRM_API_KEY', GLOBAL_KEY)
  db = makeFakeDb(twoOrgFixture())
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/tasks — API-key callers', () => {
  it('legacy CRM_API_KEY lists every org\'s tasks without crashing (assimilation regression)', async () => {
    const res = await GET(req(GLOBAL_KEY))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((t) => t.id).sort()).toEqual(['t1', 't2'])
  })

  it('per-org key sees only its own org\'s tasks, with later filters intact', async () => {
    const res = await GET(req(ORG1_KEY, '?status=todo'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((t) => t.id)).toEqual(['t1'])
  })
})
