// Route tests for GET /api/account/overview (REPSET-ACCOUNT.1).
//
// SECURITY: this is a service-role route (RLS bypassed), so org-scoping is
// enforced in app code. These tests pin the access matrix and, critically,
// that an owner of org A CANNOT read org B (the cross-tenant leak guard):
//   master             → any org (via ?organization_id, else active)
//   owner of org A      → org A only; org B answers 404 (not 403) with NO
//                         database access at all
//   manager / staff     → 403
//   no user             → 401
//
// We use the REAL resolveAccountScope + getOwnerOrganizationIds — only
// getCurrentUser and the Supabase client are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const LOC_A = 'a1a1a1a1-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const LOC_B = 'b1b1b1b1-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

function ownerOfA() {
  return {
    role: 'owner',
    isMaster: false,
    activeOrganization: { id: ORG_A },
    rolesByLocation: { [LOC_A]: 'owner' },
    locations: [{ id: LOC_A, organization_id: ORG_A }],
  }
}
function master() {
  return { isMaster: true, profileRole: 'master', role: 'master', activeOrganization: { id: ORG_A } }
}
function managerOfA() {
  return {
    role: 'manager',
    isMaster: false,
    activeOrganization: { id: ORG_A },
    rolesByLocation: { [LOC_A]: 'manager' },
    locations: [{ id: LOC_A, organization_id: ORG_A }],
  }
}

// Flexible mock db: chainable filters, thenable (for count/order reads),
// and .maybeSingle(). `orgRow` scripts the organizations lookup;
// `locationsByOrg` scripts fetchOrgLocations; counts default to 0.
function mockDb({ orgRow, locationsByOrg = {} }) {
  const seen = { tables: [], locationOrgFilter: null }
  function builder(table) {
    const filters = {}
    const b = {
      eq(col, val) { filters[col] = val; return b },
      in() { return b },
      gte() { return b },
      lte() { return b },
      neq() { return b },
      order() { return b },
      limit() { return b },
      maybeSingle() {
        if (table === 'organizations') return Promise.resolve({ data: orgRow, error: null })
        return Promise.resolve({ data: null, error: null })
      },
      then(resolve, reject) {
        let result
        if (table === 'locations') {
          seen.locationOrgFilter = filters.organization_id
          result = { data: locationsByOrg[filters.organization_id] || [], error: null }
        } else if (table === 'churn_radar_snapshots') {
          result = { data: [{ high_risk: 0 }], error: null }
        } else {
          result = { count: 0, error: null } // head-only counts
        }
        return Promise.resolve(result).then(resolve, reject)
      },
    }
    return b
  }
  return {
    db: {
      from(table) {
        seen.tables.push(table)
        return { select: () => builder(table) }
      },
    },
    seen,
  }
}

beforeEach(() => { vi.clearAllMocks() })

function req(orgParam) {
  const url = orgParam
    ? `http://localhost/api/account/overview?organization_id=${orgParam}`
    : 'http://localhost/api/account/overview'
  return new Request(url)
}

describe('GET /api/account/overview — access matrix', () => {
  it('401 when there is no user (no DB access)', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('403 for a manager (not an account-tier operator) — no DB access', async () => {
    getCurrentUser.mockResolvedValue(managerOfA())
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('owner sees their own org', async () => {
    getCurrentUser.mockResolvedValue(ownerOfA())
    const { db, seen } = mockDb({
      orgRow: { id: ORG_A, name: 'Org A', slug: 'a' },
      locationsByOrg: { [ORG_A]: [{ id: LOC_A, name: 'Studio A', slug: 'a', settings: {} }] },
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.organization.id).toBe(ORG_A)
    expect(seen.locationOrgFilter).toBe(ORG_A)
  })

  // THE cross-tenant leak guard.
  it('owner of A requesting org B gets 404 and NEVER touches the database', async () => {
    getCurrentUser.mockResolvedValue(ownerOfA())
    const res = await GET(req(ORG_B))
    expect(res.status).toBe(404)
    // resolveAccountScope short-circuits BEFORE createServerClient — so no
    // org-B row, location, or count is ever read. Airtight, not filtered.
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('master CAN target org B via the param, and only org B is read', async () => {
    getCurrentUser.mockResolvedValue(master())
    const { db, seen } = mockDb({
      orgRow: { id: ORG_B, name: 'Org B', slug: 'b' },
      locationsByOrg: { [ORG_B]: [{ id: LOC_B, name: 'Studio B', slug: 'b', settings: { glofox: {} } }] },
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(req(ORG_B))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.organization.id).toBe(ORG_B)
    expect(body.data.studios.map((s) => s.id)).toEqual([LOC_B])
    // Every studio read was scoped to org B's location set.
    expect(seen.locationOrgFilter).toBe(ORG_B)
  })

  it('404 for an unknown org id even for master (no such organization row)', async () => {
    getCurrentUser.mockResolvedValue(master())
    const { db } = mockDb({ orgRow: null }) // organizations lookup → null
    createServerClient.mockReturnValue(db)
    const res = await GET(req(ORG_B))
    expect(res.status).toBe(404)
  })
})
