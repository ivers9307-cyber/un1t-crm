// Route-level tests for GET /api/integrations/hub (INTEG-B4).
//
// SECURITY REGRESSION GUARD. The route runs as service-role (RLS
// bypassed) and, since B4, is no longer master-only — owners and
// SAAS-4 org admins can read it too. It MUST hard-scope the `locations`
// query (and therefore the whole assembled payload) to the caller's
// own org(s), so an owner never receives another tenant's locations.
// These tests pin that model:
//   master          → no org filter (every location)
//   owner/org-admin  → organization_id IN (orgs they own/administer)
//   manager/staff    → 403
//   owner of no org  → 403 (owns no org)
//
// We use the REAL getOwnerOrganizationIds — only getCurrentUser, the
// Supabase client, and the assembler are stubbed. The mocked assembler
// echoes back the locations it was handed, so the final payload's
// `locations` array is exactly what the (scoped) query returned —
// letting us assert that org B never leaks into org A's payload.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

// Echo assembler — the payload's `locations` is exactly the rows the
// (scoped) `locations` query returned, so a cross-tenant leak would show
// up as an out-of-org id in body.data.locations.
vi.mock('@/lib/integrations-hub', () => ({
  assembleIntegrationsHub: vi.fn(async (_db, locations) => ({
    locations: (locations || []).map((l) => ({ id: l.id, name: l.name })),
  })),
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const LOC_A1 = { id: 'loc-a1', name: 'A1', organization_id: ORG_A }
const LOC_A2 = { id: 'loc-a2', name: 'A2', organization_id: ORG_A }
const LOC_B1 = { id: 'loc-b1', name: 'B1', organization_id: ORG_B }
const ALL = [LOC_A1, LOC_A2, LOC_B1]

// GET builds: from('locations').select(...).eq('is_host_anchor', false)
// .order('created_at') then optionally .in('organization_id', [...]).
// The mock records .in() calls and, at await time, returns ALL rows
// filtered by any organization_id .in() that was applied — simulating
// the DB honouring the tenant scope.
function mockDb({ allLocations = ALL } = {}) {
  const calls = { in: [] }
  const builder = {}
  const resolveData = () => {
    const orgFilter = calls.in.find(([col]) => col === 'organization_id')
    if (!orgFilter) return allLocations
    const [, ids] = orgFilter
    return allLocations.filter((l) => ids.includes(l.organization_id))
  }
  builder.select = vi.fn(() => builder)
  builder.eq = vi.fn(() => builder)
  builder.order = vi.fn(() => builder)
  builder.in = vi.fn((...args) => { calls.in.push(args); return builder })
  builder.then = (resolve, reject) =>
    Promise.resolve({ data: resolveData(), error: null }).then(resolve, reject)
  const from = vi.fn((table) => {
    if (table !== 'locations') throw new Error(`unexpected table ${table}`)
    return builder
  })
  return { db: { from }, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/integrations/hub — access + org scoping', () => {
  it('returns 401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns 403 for a manager (not owner/org-admin/master)', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'mgr', isMaster: false, role: 'manager',
      rolesByLocation: { [LOC_B1.id]: 'manager' },
      locations: [{ id: LOC_B1.id, organization_id: ORG_B }],
    })
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('returns 403 for staff', async () => {
    getCurrentUser.mockResolvedValue({
      id: 's1', isMaster: false, role: 'staff', rolesByLocation: {}, locations: [],
    })
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('returns 403 for an "owner" role string who owns no org', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'o0', isMaster: false, role: 'owner',
      // owner role string but no owner assignment → owns no org
      rolesByLocation: { [LOC_B1.id]: 'manager' },
      locations: [{ id: LOC_B1.id, organization_id: ORG_B }],
    })
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('master gets an UNFILTERED query (every location, no org scoping)', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [],
    })
    const { db, calls } = mockDb()
    createServerClient.mockReturnValue(db)

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(calls.in.some(([col]) => col === 'organization_id')).toBe(false)
    expect(body.data.locations.map((l) => l.id).sort()).toEqual(['loc-a1', 'loc-a2', 'loc-b1'])
  })

  it('owner-of-orgA is scoped to orgA and NEVER receives orgB locations', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'owner-a', isMaster: false, role: 'owner',
      rolesByLocation: { [LOC_A1.id]: 'owner' },
      locations: [{ id: LOC_A1.id, organization_id: ORG_A }],
    })
    const { db, calls } = mockDb()
    createServerClient.mockReturnValue(db)

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    // The tenant boundary is applied at the query.
    expect(calls.in).toContainEqual(['organization_id', [ORG_A]])
    const ids = body.data.locations.map((l) => l.id)
    expect(ids).toEqual(expect.arrayContaining(['loc-a1', 'loc-a2']))
    // The cross-tenant leak this guards against: orgB must be absent.
    expect(ids).not.toContain('loc-b1')
  })

  it('org admin (SAAS-4) with a non-owner active role is scoped to their admin org', async () => {
    // An org admin holding an explicit staff assignment resolves role
    // 'staff' for the request, but the org_admin grant still admits them
    // — scoped to THEIR org only (getOwnerOrganizationIds bounds it).
    getCurrentUser.mockResolvedValue({
      id: 'org-admin-a', isMaster: false, role: 'staff',
      rolesByLocation: { [LOC_A1.id]: 'staff' },
      locations: [{ id: LOC_A1.id, organization_id: ORG_A }],
      orgAdminOrgIds: [ORG_A],
    })
    const { db, calls } = mockDb()
    createServerClient.mockReturnValue(db)

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(calls.in).toContainEqual(['organization_id', [ORG_A]])
    expect(body.data.locations.map((l) => l.id)).not.toContain('loc-b1')
  })
})
