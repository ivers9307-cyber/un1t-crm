// SAAS-3 — GET /api/stages (requireApiKeyOrManager dual-auth route)
// under per-org keys: the org filter really filters, the legacy shared
// key stays unscoped. api-auth is real; only supabase/auth are faked.
//
// SAAS-12 — the cookie/manager path: orgScopeLocationIds no-ops for
// cookie callers (orgId is null), so before the fix a manager cookie
// session with no ?location_id read EVERY tenant's stages. The route
// now constrains cookie callers to their own locations and 403s a
// foreign ?location_id. real assertLocationAccess/getUserLocationIds
// are exercised (only getCurrentUser is stubbed).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture, GLOBAL_KEY, ORG1_KEY,
} from '@/lib/api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual()
  return { ...actual, getCurrentUser: vi.fn(async () => null) }
})

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'

const req = (token) =>
  new Request('http://localhost/api/stages', {
    headers: { authorization: `Bearer ${token}` },
  })
// Cookie caller — no Authorization header, so requireApiKeyOrManager
// falls through to getCurrentUser().
const cookieReq = (locationId) =>
  new Request(
    `http://localhost/api/stages${locationId ? `?location_id=${locationId}` : ''}`,
  )

const managerAt = (...locationIds) => ({
  role: 'manager',
  isMaster: false,
  locations: locationIds.map((id) => ({ id, organization_id: 'org-1' })),
})

beforeEach(() => {
  vi.stubEnv('CRM_API_KEY', GLOBAL_KEY)
  getCurrentUser.mockResolvedValue(null)
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

describe('GET /api/stages — cookie/manager callers (SAAS-12)', () => {
  it('manager at loc-1a sees only their own stages, not another tenant\'s', async () => {
    getCurrentUser.mockResolvedValue(managerAt('loc-1a'))
    const res = await GET(cookieReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((s) => s.id)).toEqual(['s1'])
  })

  it('403 when a manager passes a ?location_id outside their assignments', async () => {
    getCurrentUser.mockResolvedValue(managerAt('loc-1a'))
    const res = await GET(cookieReq('loc-2a'))
    expect(res.status).toBe(403)
  })

  it('own ?location_id is allowed and filters to that location', async () => {
    getCurrentUser.mockResolvedValue(managerAt('loc-1a', 'loc-1b'))
    const res = await GET(cookieReq('loc-1a'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((s) => s.id)).toEqual(['s1'])
  })
})
