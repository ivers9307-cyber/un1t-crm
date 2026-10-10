// SAAS-3 — GET /api/tasks under API-key auth. Regression for the
// thenable-assimilation bug (see campaigns/route.test.js): the scope
// call sat BEFORE the searchParams filters here, so `query.eq(…)` threw
// on the executed response object for every API-key caller.
// api-auth is real; only the supabase client is faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture, RETIRED_SHARED_KEY, ORG1_KEY,
} from '@/lib/api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null) }))

import { GET, POST } from './route.js'

const req = (token, qs = '') =>
  new Request(`http://localhost/api/tasks${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  })

beforeEach(() => {
  db = makeFakeDb(twoOrgFixture())
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/tasks — API-key callers', () => {
  it('the retired shared key → 401 (APIKEYS.4)', async () => {
    const res = await GET(req(RETIRED_SHARED_KEY))
    expect(res.status).toBe(401)
  })

  it('per-org key sees only its own org\'s tasks, with later filters intact', async () => {
    const res = await GET(req(ORG1_KEY, '?status=todo'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((t) => t.id)).toEqual(['t1'])
  })
})

// C150 ACTSOURCECHECK.1 — activities_source_check (mig 138) allows only 'crm'
// and 'glofox'. POST used to stamp source 'api', so Postgres refused every
// API-key task create (prod held 0 kind='task' rows). The route stamps 'crm'
// and the caller cannot choose it (CreateTaskSchema has no source key).
describe('POST /api/tasks — source', () => {
  const LOC = '00000000-0000-4000-8000-0000000000a1'
  const post = (body) =>
    new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { authorization: `Bearer ${ORG1_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  beforeEach(() => {
    db = makeFakeDb({ ...twoOrgFixture(), locations: [{ id: LOC, organization_id: 'org-1' }], activities: [] })
  })

  it("stamps source 'crm', a value activities_source_check accepts", async () => {
    const res = await POST(post({ location_id: LOC, subject: 'Call back about the trial' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ kind: 'task', type: 'task', source: 'crm', location_id: LOC })
    expect(['crm', 'glofox']).toContain(body.data.source)
  })

  it('a caller-supplied source is not written', async () => {
    const res = await POST(post({ location_id: LOC, subject: 'x', source: 'glofox' }))
    expect(res.status).toBe(200)
    expect((await res.json()).data.source).toBe('crm')
  })
})
