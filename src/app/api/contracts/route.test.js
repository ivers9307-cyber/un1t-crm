// Route-level tests for GET /api/contracts (the list).
//
// SECURITY REGRESSION GUARD (C1, 2026-06 platform audit). The route runs
// as service-role (RLS bypassed), so before this fix it SELECTed every
// contract and returned the lot to ANY authenticated caller — comp
// variables, signatures, signed_ip across all tenants. These tests pin
// the application-layer scoping that replicates mig 106's model:
//   master  → no filter (sees all)
//   owner   → profile_id = self OR organization_id IN (owned orgs)
//   else    → profile_id = self only
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

// ─── DB mock ─────────────────────────────────────────────────────
//
// GET builds: from('contracts').select(...).order(...) then optionally
// .or(...) (owner) or .eq(...) (plain caller), then awaits the builder.
// master awaits straight after .order(). We record which filter was
// applied so the test can assert the scoping branch taken.
function mockDb({ data = [], error = null } = {}) {
  const calls = { or: [], eq: [] }
  const result = { data, error }
  const builder = {}
  builder.or = vi.fn((arg) => { calls.or.push(arg); return builder })
  builder.eq = vi.fn((...args) => { calls.eq.push(args); return builder })
  // Thenable: `await query` resolves to the PostgREST-shaped result.
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  const order = vi.fn(() => builder)
  const select = vi.fn(() => ({ order }))
  const from = vi.fn((table) => {
    if (table !== 'contracts') throw new Error(`unexpected table ${table}`)
    return { select }
  })
  return { db: { from }, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

const FAKE_REQUEST = new Request('https://example.com/api/contracts')

describe('GET /api/contracts — list scoping', () => {
  it('returns 401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(FAKE_REQUEST)
    expect(res.status).toBe(401)
  })

  it('master gets an UNFILTERED query (no .or / .eq scoping applied)', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [],
    })
    const { db, calls } = mockDb({ data: [{ id: 'c1' }, { id: 'c2' }] })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(calls.or).toHaveLength(0)
    expect(calls.eq).toHaveLength(0)
  })

  it('owner is scoped to own contracts OR contracts in orgs they own', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'owner-a', isMaster: false, role: 'owner',
      rolesByLocation: { [LOC_A1]: 'owner' },
      locations: [{ id: LOC_A1, organization_id: ORG_A }],
    })
    const { db, calls } = mockDb({ data: [] })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST)
    expect(res.status).toBe(200)
    expect(calls.or).toHaveLength(1)
    // Both arms present: own contracts AND owned-org contracts.
    expect(calls.or[0]).toContain('profile_id.eq.owner-a')
    expect(calls.or[0]).toContain(`organization_id.in.(${ORG_A})`)
    // No bare .eq scoping — the owner uses the .or() branch.
    expect(calls.eq).toHaveLength(0)
  })

  it('plain staff (owns no org) is scoped to their OWN contracts only', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'staff-1', isMaster: false, role: 'staff',
      rolesByLocation: { [LOC_B1]: 'staff' },
      locations: [{ id: LOC_B1, organization_id: 'org-b' }],
    })
    const { db, calls } = mockDb({ data: [] })
    createServerClient.mockReturnValue(db)

    const res = await GET(FAKE_REQUEST)
    expect(res.status).toBe(200)
    expect(calls.or).toHaveLength(0)
    expect(calls.eq).toContainEqual(['profile_id', 'staff-1'])
  })

  it('surfaces a DB error as a 500', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [],
    })
    createServerClient.mockReturnValue(mockDb({ error: { message: 'boom' } }).db)
    const res = await GET(FAKE_REQUEST)
    expect(res.status).toBe(500)
  })
})
