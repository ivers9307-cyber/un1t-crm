// Route-level tests for /api/contracts.
//
// GET — SECURITY REGRESSION GUARD (C1, 2026-06 platform audit). The
// route runs as service-role (RLS bypassed), so before this fix it
// SELECTed every contract and returned the lot to ANY authenticated
// caller — comp variables, signatures, signed_ip across all tenants.
// These tests pin the application-layer scoping that replicates
// mig 106's model:
//   master  → no filter (sees all)
//   owner   → profile_id = self OR organization_id IN (owned orgs)
//   else    → profile_id = self only
//
// POST — SECURITY REGRESSION GUARD (SAAS-5). The issue path looked the
// template up by id with NO org check, so an owner of org A could issue
// a contract from org B's template — rendering B's body_markdown (comp
// copy) AND anchoring the new contract to org B via
// template.organization_id. These tests pin the template-pick scoping:
// non-master issuers only reach templates in orgs they own (NULL-org
// templates are master-only), foreign ids 404 as 'Template not found'.
//
// We use the REAL getOwnerOrganizationIds — only getCurrentUser + the
// Supabase client are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET, POST } from './route.js'
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

// ─── POST (issue) — template-pick scoping ────────────────────────
//
// The issue flow reads contract_templates first, then profiles, then
// inserts into contracts. For the scoping tests we only need the flow
// to reach (or be stopped at) the template gate: the mock resolves the
// template lookup from a fixture and returns null for the recipient,
// so a caller who CLEARS the gate surfaces as 404 'Recipient not
// found' while a caller the gate stops sees 404 'Template not found'
// — and we assert no contracts insert ever fires either way.

const TPL_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const TPL_B = 'bbbbbbbb-0000-0000-0000-000000000001'
const TPL_NULL = 'cccccccc-0000-0000-0000-000000000001'
const RECIPIENT = 'eeeeeeee-0000-0000-0000-000000000001'

function issueMockDb() {
  const templates = [
    { id: TPL_A, organization_id: ORG_A, body_markdown: 'A body', variables_schema: [], employment_type: 'both', active: true },
    { id: TPL_B, organization_id: 'org-b', body_markdown: 'B comp copy', variables_schema: [], employment_type: 'both', active: true },
    { id: TPL_NULL, organization_id: null, body_markdown: 'legacy', variables_schema: [], employment_type: 'both', active: true },
  ]
  const calls = { contractsInsert: [] }
  const from = vi.fn((table) => {
    if (table === 'contract_templates') {
      const filters = []
      const b = {
        eq: vi.fn((col, val) => { filters.push(r => r[col] === val); return b }),
        maybeSingle: vi.fn(async () => ({
          data: templates.find(r => filters.every(f => f(r))) || null,
          error: null,
        })),
      }
      return { select: vi.fn(() => b) }
    }
    if (table === 'profiles') {
      // Recipient never resolves — the tests only exercise the
      // template gate, and 'Recipient not found' proves it was passed.
      const b = { eq: vi.fn(() => b), maybeSingle: vi.fn(async () => ({ data: null, error: null })) }
      return { select: vi.fn(() => b) }
    }
    if (table === 'contracts') {
      const insert = vi.fn((row) => {
        calls.contractsInsert.push(row)
        const b = { select: vi.fn(() => b), single: vi.fn(async () => ({ data: { id: 'c-new', ...row }, error: null })) }
        return b
      })
      return { insert }
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { db: { from }, calls }
}

const issueReq = (template_id) => new Request('https://example.com/api/contracts', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    template_id,
    profile_id: RECIPIENT,
    variables: {},
    issuer_signature: 'Richard Ivers',
  }),
})

const OWNER_A = {
  id: 'owner-a', isMaster: false, role: 'owner',
  rolesByLocation: { [LOC_A1]: 'owner' },
  locations: [{ id: LOC_A1, organization_id: ORG_A }],
}

const MASTER = {
  id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [],
}

describe('POST /api/contracts — template-pick scoping', () => {
  it("owner of org A cannot issue from org B's template — 404, nothing inserted", async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const { db, calls } = issueMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReq(TPL_B))
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error).toBe('Template not found')
    expect(calls.contractsInsert).toHaveLength(0)
  })

  it('owner of org A cannot issue from a NULL-org template (master-only) — 404, nothing inserted', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const { db, calls } = issueMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReq(TPL_NULL))
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.error).toBe('Template not found')
    expect(calls.contractsInsert).toHaveLength(0)
  })

  it("owner of org A passes the gate on their OWN template (flow proceeds to recipient lookup)", async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const { db } = issueMockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(issueReq(TPL_A))
    const body = await res.json()
    // Recipient mock resolves null, so the gate having been cleared
    // surfaces as the NEXT 404 in the flow — not the template one.
    expect(res.status).toBe(404)
    expect(body.error).toBe('Recipient not found')
  })

  it('master passes the gate on any template, including NULL-org', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = issueMockDb()
    createServerClient.mockReturnValue(db)

    for (const tpl of [TPL_B, TPL_NULL]) {
      const res = await POST(issueReq(tpl))
      const body = await res.json()
      expect(res.status).toBe(404)
      expect(body.error).toBe('Recipient not found')
    }
  })
})
