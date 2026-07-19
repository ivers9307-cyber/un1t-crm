// Route-level tests for GET /api/contract-templates (the list).
//
// SECURITY REGRESSION GUARD (IDOR audit, batch B). The route runs as
// service-role (RLS bypassed), so before this fix it gated on role only
// and SELECTed every org's templates — any owner could read other
// tenants' contract template bodies. These tests pin the application-
// layer org-scoping that replicates mig 106's model:
//   master  → no filter (sees all)
//   owner   → organization_id IN (orgs they own)
//   else    → empty result set (owns no org)
//
// We use the REAL getOwnerOrganizationIds — only getCurrentUser + the
// Supabase client are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG_A = 'org-a'
const LOC_A1 = 'loc-a1'
const LOC_B1 = 'loc-b1'

// GET builds: from('contract_templates').select(...).order(...) then
// optionally .in('organization_id', [...]) (non-master). We record which
// filter was applied so the test can assert the scoping branch taken.
function mockDb({ data = [], error = null } = {}) {
  const calls = { in: [] }
  const result = { data, error }
  const builder = {}
  builder.in = vi.fn((...args) => { calls.in.push(args); return builder })
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  const order = vi.fn(() => builder)
  const select = vi.fn(() => ({ order }))
  const from = vi.fn((table) => {
    if (table !== 'contract_templates') throw new Error(`unexpected table ${table}`)
    return { select }
  })
  return { db: { from }, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/contract-templates — list scoping', () => {
  it('returns 401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-owner/non-master role', async () => {
    getCurrentUser.mockResolvedValue({
      id: 's1', isMaster: false, role: 'staff', rolesByLocation: {}, locations: [],
    })
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('master gets an UNFILTERED query (no .in scoping applied)', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [],
    })
    const { db, calls } = mockDb({ data: [{ id: 't1' }, { id: 't2' }] })
    createServerClient.mockReturnValue(db)

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(calls.in).toHaveLength(0)
  })

  it('owner is scoped to templates in orgs they own', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'owner-a', isMaster: false, role: 'owner',
      rolesByLocation: { [LOC_A1]: 'owner' },
      locations: [{ id: LOC_A1, organization_id: ORG_A }],
    })
    const { db, calls } = mockDb({ data: [] })
    createServerClient.mockReturnValue(db)

    const res = await GET()
    expect(res.status).toBe(200)
    expect(calls.in).toContainEqual(['organization_id', [ORG_A]])
  })

  it('org admin (SAAS-4) is scoped to their admin orgs — even with a non-owner active role', async () => {
    // An org admin holding an explicit staff assignment at their
    // active location resolves role 'staff' for the request, but the
    // org_admin grant must still let them manage THEIR org's templates
    // (and only theirs — getOwnerOrganizationIds bounds the query).
    getCurrentUser.mockResolvedValue({
      id: 'org-admin-a', isMaster: false, role: 'staff',
      rolesByLocation: { [LOC_A1]: 'staff' },
      locations: [{ id: LOC_A1, organization_id: ORG_A }],
      orgAdminOrgIds: [ORG_A],
    })
    const { db, calls } = mockDb({ data: [] })
    createServerClient.mockReturnValue(db)

    const res = await GET()
    expect(res.status).toBe(200)
    expect(calls.in).toContainEqual(['organization_id', [ORG_A]])
  })

  it('owner of NO org gets an empty result set (no unscoped query)', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'mgr-1', isMaster: false, role: 'owner',
      // owner role string but no owner assignment → owns no org
      rolesByLocation: { [LOC_B1]: 'manager' },
      locations: [{ id: LOC_B1, organization_id: 'org-b' }],
    })
    const { db, calls } = mockDb({ data: [{ id: 'leak' }] })
    createServerClient.mockReturnValue(db)

    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
    // Never ran a DB query — short-circuited before createServerClient use.
    expect(calls.in).toHaveLength(0)
  })
})
