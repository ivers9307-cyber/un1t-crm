// SAAS-12 — GET/PUT/DELETE /api/bookings/event-types/[id]
// (requireApiKeyOrManager dual-auth route). assertRowInOrg only scopes
// per-org API keys (it no-ops when orgId is null — the legacy-key and
// cookie paths), so before the fix a manager cookie session could
// read/edit/soft-delete ANY tenant's event type by id. The route now
// adds a cookie-path location guard (404, not 403 — detail route). The
// per-org-key path stays gated by assertRowInOrg and the legacy global
// key stays unscoped by design. api-auth + validate are real; only
// supabase/getCurrentUser are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  makeFakeDb, twoOrgFixture, GLOBAL_KEY, ORG1_KEY,
} from '@/lib/api-auth.test-helpers.js'

let db
let tables
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual()
  return { ...actual, getCurrentUser: vi.fn(async () => null) }
})

import { GET, PUT, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'

// e1 lives in org-1 (loc-1a); e2 lives in org-2 (loc-2a).
const seed = () => {
  tables = twoOrgFixture()
  tables.event_types = [
    { id: 'e1', location_id: 'loc-1a', name: 'Bootcamp', slug: 'bootcamp', active: true },
    { id: 'e2', location_id: 'loc-2a', name: 'Yoga', slug: 'yoga', active: true },
  ]
  db = makeFakeDb(tables)
}
const etype = (id) => tables.event_types.find((e) => e.id === id)

const keyGet = (id, token) =>
  new Request(`http://localhost/api/bookings/event-types/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  })
// Cookie caller — no Authorization header.
const cookieGet = (id) =>
  new Request(`http://localhost/api/bookings/event-types/${id}`)
const cookiePut = (id, body) =>
  new Request(`http://localhost/api/bookings/event-types/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
const cookieDelete = (id) =>
  new Request(`http://localhost/api/bookings/event-types/${id}`, { method: 'DELETE' })
const props = (id) => ({ params: { id } })

const managerAt = (...locationIds) => ({
  role: 'manager',
  isMaster: false,
  locations: locationIds.map((id) => ({ id, organization_id: 'org-1' })),
})

beforeEach(() => {
  vi.stubEnv('CRM_API_KEY', GLOBAL_KEY)
  getCurrentUser.mockResolvedValue(null)
  seed()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('event-types/[id] — cookie/manager path (SAAS-12)', () => {
  it('GET a foreign-location event type → 404', async () => {
    getCurrentUser.mockResolvedValue(managerAt('loc-1a'))
    const res = await GET(cookieGet('e2'), props('e2'))
    expect(res.status).toBe(404)
  })

  it('GET own-location event type → 200', async () => {
    getCurrentUser.mockResolvedValue(managerAt('loc-1a'))
    const res = await GET(cookieGet('e1'), props('e1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe('e1')
  })

  it('PUT a foreign-location event type → 404, row untouched', async () => {
    getCurrentUser.mockResolvedValue(managerAt('loc-1a'))
    const res = await PUT(cookiePut('e2', { name: 'Hijacked' }), props('e2'))
    expect(res.status).toBe(404)
    expect(etype('e2').name).toBe('Yoga')
  })

  it('PUT own-location event type → 200, row updated', async () => {
    getCurrentUser.mockResolvedValue(managerAt('loc-1a'))
    const res = await PUT(cookiePut('e1', { name: 'Renamed' }), props('e1'))
    expect(res.status).toBe(200)
    expect(etype('e1').name).toBe('Renamed')
  })

  it('DELETE a foreign-location event type → 404, row not soft-deleted', async () => {
    getCurrentUser.mockResolvedValue(managerAt('loc-1a'))
    const res = await DELETE(cookieDelete('e2'), props('e2'))
    expect(res.status).toBe(404)
    expect(etype('e2').active).toBe(true)
  })

  it('DELETE own-location event type → 200, row soft-deleted', async () => {
    getCurrentUser.mockResolvedValue(managerAt('loc-1a'))
    const res = await DELETE(cookieDelete('e1'), props('e1'))
    expect(res.status).toBe(200)
    expect(etype('e1').active).toBe(false)
  })
})

describe('event-types/[id] — API-key paths unchanged (SAAS-3)', () => {
  it('per-org key targeting a foreign event type → 404 (assertRowInOrg)', async () => {
    const res = await GET(keyGet('e2', ORG1_KEY), props('e2'))
    expect(res.status).toBe(404)
  })

  it('per-org key reading its own event type → 200', async () => {
    const res = await GET(keyGet('e1', ORG1_KEY), props('e1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe('e1')
  })

  it('legacy global key stays unscoped — reads any tenant\'s event type', async () => {
    const res = await GET(keyGet('e2', GLOBAL_KEY), props('e2'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe('e2')
  })
})
