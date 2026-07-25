// Route-level tests for /api/contract-templates/[id]/versions (GET).
//
// CONTRACTS-TPLVER.1. This route runs as service-role (RLS bypassed),
// so it must replicate the parent template GET's org-scoping model in
// app code (SAAS-5):
//   master     → any template's versions, including NULL-org templates
//   non-master → only versions of templates in orgs they own; foreign
//                AND missing template ids collapse into the same 404
//                (no enumeration)
//   NULL organization_id → master-only, same as the template GET
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
const ORG_B = 'org-b'
const LOC_A1 = 'loc-a1'
const LOC_B1 = 'loc-b1'

const TPL_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const TPL_B = 'bbbbbbbb-0000-0000-0000-000000000001'
const TPL_NULL = 'cccccccc-0000-0000-0000-000000000001'
const TPL_MISSING = 'dddddddd-0000-0000-0000-000000000001'

function templateRows() {
  return [
    { id: TPL_A, organization_id: ORG_A },
    { id: TPL_B, organization_id: ORG_B },
    { id: TPL_NULL, organization_id: null },
  ]
}

function versionRows() {
  return [
    { id: 'v-a1', template_id: TPL_A, version: 1, body_markdown: 'A v1', variables_schema: [], changed_by: 'owner-a', created_at: '2026-01-01T00:00:00Z' },
    { id: 'v-a2', template_id: TPL_A, version: 2, body_markdown: 'A v2 comp copy', variables_schema: [], changed_by: 'owner-a', created_at: '2026-02-01T00:00:00Z' },
    { id: 'v-b1', template_id: TPL_B, version: 1, body_markdown: 'B v1 comp copy', variables_schema: [], changed_by: 'owner-b', created_at: '2026-01-01T00:00:00Z' },
  ]
}

const ownerA = () => ({
  id: 'owner-a', isMaster: false, role: 'owner',
  rolesByLocation: { [LOC_A1]: 'owner' },
  locations: [{ id: LOC_A1, organization_id: ORG_A }],
})

const master = () => ({
  id: 'm1', isMaster: true, role: 'master', rolesByLocation: {}, locations: [],
})

// ─── DB mock ─────────────────────────────────────────────────────
//
// Two in-memory tables: contract_templates (existence/org-scoping
// check only — mirrors the parent GET's preflight) and
// contract_template_versions (the actual payload, thenable + .order).
function fakeDb({ templates = templateRows(), versions = versionRows() } = {}) {
  function templatesBuilder() {
    const filters = []
    const b = {
      eq: vi.fn((col, val) => { filters.push(r => r[col] === val); return b }),
      in: vi.fn((col, vals) => { filters.push(r => vals.includes(r[col])); return b }),
      maybeSingle: vi.fn(async () => {
        const matched = templates.filter(r => filters.every(f => f(r)))
        return { data: matched[0] ? { ...matched[0] } : null, error: null }
      }),
    }
    return b
  }
  function versionsBuilder() {
    const filters = []
    let orderCol = null
    let orderAsc = true
    const b = {
      eq: vi.fn((col, val) => { filters.push(r => r[col] === val); return b }),
      order: vi.fn((col, { ascending } = {}) => { orderCol = col; orderAsc = !!ascending; return b }),
      then: (resolve, reject) => {
        let matched = versions.filter(r => filters.every(f => f(r))).map(r => ({ ...r }))
        if (orderCol) {
          matched = matched.sort((a, c) => orderAsc ? a[orderCol] - c[orderCol] : c[orderCol] - a[orderCol])
        }
        return Promise.resolve({ data: matched, error: null }).then(resolve, reject)
      },
    }
    return b
  }
  const from = vi.fn((table) => {
    if (table === 'contract_templates') return { select: vi.fn(() => templatesBuilder()) }
    if (table === 'contract_template_versions') return { select: vi.fn(() => versionsBuilder()) }
    throw new Error(`unexpected table ${table}`)
  })
  return { from }
}

function setup(user, dbOpts) {
  getCurrentUser.mockResolvedValue(user)
  const db = fakeDb(dbOpts)
  createServerClient.mockReturnValue(db)
  return { db }
}

const props = (id) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/contract-templates/[id]/versions', () => {
  it('returns 401 when there is no user', async () => {
    setup(null)
    const res = await GET(null, props(TPL_A))
    expect(res.status).toBe(401)
  })

  it('returns 403 for a caller with no admin claim at all (staff, owns no org)', async () => {
    setup({
      id: 's1', isMaster: false, role: 'staff',
      rolesByLocation: { [LOC_B1]: 'staff' },
      locations: [{ id: LOC_B1, organization_id: ORG_B }],
    })
    const res = await GET(null, props(TPL_A))
    expect(res.status).toBe(403)
  })

  it("owner of org A gets 404 on org B's template versions (leak test)", async () => {
    setup(ownerA())
    const res = await GET(null, props(TPL_B))
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(JSON.stringify(body)).not.toContain('comp copy')
  })

  it('non-master gets 404 on a NULL-org template (master-only)', async () => {
    setup(ownerA())
    const res = await GET(null, props(TPL_NULL))
    expect(res.status).toBe(404)
  })

  it('a missing template id 404s the same as a foreign one', async () => {
    setup(ownerA())
    const res = await GET(null, props(TPL_MISSING))
    expect(res.status).toBe(404)
  })

  it('owner of org A gets their own template versions, newest first', async () => {
    setup(ownerA())
    const res = await GET(null, props(TPL_A))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.map(v => v.version)).toEqual([2, 1])
  })

  it('an owned template with no archived versions returns an empty array (not 404)', async () => {
    setup(ownerA(), { versions: [] })
    const res = await GET(null, props(TPL_A))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
  })

  it('master can read versions of a NULL-org template', async () => {
    setup(master(), { versions: [] })
    const res = await GET(null, props(TPL_NULL))
    expect(res.status).toBe(200)
  })
})
