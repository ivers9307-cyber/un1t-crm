// SAAS-3 — org gate on PUT /api/bookings/[id] (detail route, per-org keys).
//
// api-auth is REAL (only the supabase client is faked): a per-org key
// targeting another org's booking must get 404 (not 403 — ids are not
// confirmed across orgs) and the row must NOT be touched. Since W0.1 the
// legacy shared key is scoped to CRM_API_KEY_ORG_ID and is gated the same way.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture,
  GLOBAL_KEY, ORG1_KEY, ORG2_KEY_REVOKED,
} from '@/lib/api-auth.test-helpers.js'

let db
let tables
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null) }))

import { PUT } from './route.js'

const req = (token, body = { status: 'confirmed' }) =>
  new Request('http://localhost/api/bookings/x', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const props = (id) => ({ params: { id } })

beforeEach(() => {
  vi.stubEnv('CRM_API_KEY', GLOBAL_KEY)
  vi.stubEnv('CRM_API_KEY_ORG_ID', 'org-1') // W0.1 — legacy key = org-1's key
  tables = twoOrgFixture()
  db = makeFakeDb(tables)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('PUT /api/bookings/[id] — per-org key row gate', () => {
  it('404s a per-org key targeting another org\'s booking — row untouched', async () => {
    const res = await PUT(req(ORG1_KEY), props('b2'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'not_found' })
    expect(tables.bookings.find((b) => b.id === 'b2').status).toBe('pending')
  })

  it('updates a booking inside the key\'s org', async () => {
    const res = await PUT(req(ORG1_KEY), props('b1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(tables.bookings.find((b) => b.id === 'b1').status).toBe('confirmed')
  })

  it('legacy CRM_API_KEY targeting another org\'s booking → 404, row untouched (W0.1 scoped)', async () => {
    const res = await PUT(req(GLOBAL_KEY), props('b2'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'not_found' })
    expect(tables.bookings.find((b) => b.id === 'b2').status).toBe('pending')
  })

  it('legacy CRM_API_KEY updates a booking inside CRM_API_KEY_ORG_ID (positive control)', async () => {
    const res = await PUT(req(GLOBAL_KEY), props('b1'))
    expect(res.status).toBe(200)
    expect(tables.bookings.find((b) => b.id === 'b1').status).toBe('confirmed')
  })

  it('revoked per-org key → 401 before any row is read', async () => {
    const res = await PUT(req(ORG2_KEY_REVOKED), props('b2'))
    expect(res.status).toBe(401)
    expect(tables.bookings.find((b) => b.id === 'b2').status).toBe('pending')
  })
})
