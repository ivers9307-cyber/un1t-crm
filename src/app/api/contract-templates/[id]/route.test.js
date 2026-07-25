// Route-level tests for /api/contract-templates/[id] (GET/PATCH/DELETE).
//
// SECURITY REGRESSION GUARD (SAAS-5). The detail route runs as
// service-role (RLS bypassed), so before this fix it gated on role only
// with NO org scoping — any owner of ANY org could read another tenant's
// template body (comp copy), PATCH their live template, or soft-delete
// it by id. These tests pin the application-layer org-scoping that
// mirrors the list route / mig 106's model:
//   master     → any template, including NULL-org rows
//   non-master → only templates in orgs they own; foreign AND missing
//                ids collapse into the same 404 (no enumeration)
//   NULL organization_id → master-only for detail ops
//
// The DB mock is a tiny in-memory table that actually applies the
// .eq/.in filters, so the leak tests prove the foreign row is not
// merely hidden in the response but untouched by writes.
//
// We use the REAL getOwnerOrganizationIds — only getCurrentUser + the
// Supabase client are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET, PATCH, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const LOC_A1 = 'loc-a1'
const LOC_B1 = 'loc-b1'

const TPL_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const TPL_B = 'bbbbbbbb-0000-0000-0000-000000000001'
const TPL_NULL = 'cccccccc-0000-0000-0000-000000000001'

// ─── Fixtures ────────────────────────────────────────────────────

function twoOrgRows() {
  return [
    { id: TPL_A, organization_id: ORG_A, name: 'Org A FTE', body_markdown: 'A body', version: 3, active: true },
    { id: TPL_B, organization_id: ORG_B, name: 'Org B FTE', body_markdown: 'B comp copy', version: 5, active: true },
    // Unanchored template (pre-mig-106 era shape) — master-only.
    { id: TPL_NULL, organization_id: null, name: 'Legacy', body_markdown: 'legacy', version: 1, active: true },
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
// In-memory contract_templates table. Builders record .eq/.in filters
// and apply them at await-time (maybeSingle / thenable), matching
// PostgREST semantics: an UPDATE only touches rows the filters match,
// and `.in('organization_id', [...])` never matches a NULL value —
// which is exactly the property the NULL-org tests lean on.
//
// CONTRACTS-TPLVER.1 — also stubs contract_template_versions.upsert()
// so PATCH's archive-before-overwrite step can be exercised: upsertLog
// records every call (payload + onConflict/ignoreDuplicates options)
// for assertions, and archiveError lets a test force the archive to
// fail (mirrors a real PostgREST error shape).
function fakeTemplatesDb(rows, { archiveError = null } = {}) {
  function builder(mode, updates) {
    const filters = []
    const b = {
      eq: vi.fn((col, val) => { filters.push(r => r[col] === val); return b }),
      in: vi.fn((col, vals) => { filters.push(r => vals.includes(r[col])); return b }),
      select: vi.fn(() => b),
      maybeSingle: vi.fn(async () => {
        const matched = run()
        return { data: matched[0] ? { ...matched[0] } : null, error: null }
      }),
      then: (resolve, reject) => {
        const matched = run()
        return Promise.resolve({ data: matched.map(r => ({ ...r })), error: null }).then(resolve, reject)
      },
    }
    function run() {
      const matched = rows.filter(r => filters.every(f => f(r)))
      if (mode === 'update') matched.forEach(r => Object.assign(r, updates))
      return matched
    }
    return b
  }
  const upsertLog = []
  const from = vi.fn((table) => {
    if (table === 'contract_templates') {
      return {
        select: vi.fn(() => builder('select')),
        update: vi.fn((updates) => builder('update', updates)),
      }
    }
    if (table === 'contract_template_versions') {
      return {
        upsert: vi.fn((payload, options) => {
          upsertLog.push({ payload, options })
          return {
            then: (resolve, reject) => Promise.resolve(
              archiveError ? { data: null, error: archiveError } : { data: [payload], error: null }
            ).then(resolve, reject),
          }
        }),
      }
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { db: { from }, upsertLog }
}

function setup(user, rows = twoOrgRows(), opts = {}) {
  getCurrentUser.mockResolvedValue(user)
  const { db, upsertLog } = fakeTemplatesDb(rows, opts)
  createServerClient.mockReturnValue(db)
  return { rows, db, upsertLog }
}

const props = (id) => ({ params: Promise.resolve({ id }) })

const patchReq = (body) => new Request('https://example.com/api/contract-templates/x', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── GET ─────────────────────────────────────────────────────────

describe('GET /api/contract-templates/[id] — detail scoping', () => {
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

  it('owner of org A can read their own template', async () => {
    setup(ownerA())
    const res = await GET(null, props(TPL_A))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.id).toBe(TPL_A)
  })

  it("owner of org A gets 404 on org B's template (leak test)", async () => {
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

  it('owner-role caller who owns NO org gets 404, not an unscoped read', async () => {
    setup({
      id: 'mgr-1', isMaster: false, role: 'owner',
      // owner role string but no owner assignment → owns no org
      rolesByLocation: { [LOC_B1]: 'manager' },
      locations: [{ id: LOC_B1, organization_id: ORG_B }],
    })
    const res = await GET(null, props(TPL_B))
    expect(res.status).toBe(404)
  })

  it('master can read any template, including NULL-org rows', async () => {
    setup(master())
    expect((await GET(null, props(TPL_B))).status).toBe(200)
    const res = await GET(null, props(TPL_NULL))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.id).toBe(TPL_NULL)
  })

  it('passes the role gate on owner-org membership alone (composes with org-admin grants)', async () => {
    // Role string is not owner/master, but getOwnerOrganizationIds
    // resolves an org — the gate must accept membership, not just the
    // role label (SAAS-4 extends membership to org-admin grants).
    setup({
      id: 'grantee', isMaster: false, role: 'manager',
      rolesByLocation: { [LOC_A1]: 'owner' },
      locations: [{ id: LOC_A1, organization_id: ORG_A }],
    })
    const res = await GET(null, props(TPL_A))
    expect(res.status).toBe(200)
  })
})

// ─── PATCH ───────────────────────────────────────────────────────

describe('PATCH /api/contract-templates/[id] — detail scoping', () => {
  it("owner of org A gets 404 patching org B's template and the row is untouched", async () => {
    const { rows } = setup(ownerA())
    const res = await PATCH(patchReq({ name: 'hijacked' }), props(TPL_B))
    expect(res.status).toBe(404)
    expect(rows.find(r => r.id === TPL_B).name).toBe('Org B FTE')
  })

  it("owner of org A gets 404 on a body_markdown patch to org B's template — no version bump, body untouched", async () => {
    const { rows } = setup(ownerA())
    const res = await PATCH(patchReq({ body_markdown: 'rewritten terms' }), props(TPL_B))
    expect(res.status).toBe(404)
    const rowB = rows.find(r => r.id === TPL_B)
    expect(rowB.body_markdown).toBe('B comp copy')
    expect(rowB.version).toBe(5)
  })

  it('non-master gets 404 patching a NULL-org template (master-only), row untouched', async () => {
    const { rows } = setup(ownerA())
    const res = await PATCH(patchReq({ active: false }), props(TPL_NULL))
    expect(res.status).toBe(404)
    expect(rows.find(r => r.id === TPL_NULL).active).toBe(true)
  })

  it('owner of org A can patch their own template', async () => {
    const { rows } = setup(ownerA())
    const res = await PATCH(patchReq({ name: 'Renamed' }), props(TPL_A))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.name).toBe('Renamed')
    expect(rows.find(r => r.id === TPL_A).name).toBe('Renamed')
  })

  it('body_markdown patch on an owned template bumps version from the current row', async () => {
    const { rows } = setup(ownerA())
    const res = await PATCH(patchReq({ body_markdown: 'new body' }), props(TPL_A))
    expect(res.status).toBe(200)
    const rowA = rows.find(r => r.id === TPL_A)
    expect(rowA.body_markdown).toBe('new body')
    expect(rowA.version).toBe(4) // was 3
  })

  it('master can patch a NULL-org template', async () => {
    const { rows } = setup(master())
    const res = await PATCH(patchReq({ body_markdown: 'v2 legacy' }), props(TPL_NULL))
    expect(res.status).toBe(200)
    const row = rows.find(r => r.id === TPL_NULL)
    expect(row.body_markdown).toBe('v2 legacy')
    expect(row.version).toBe(2)
  })

  // ─── CONTRACTS-TPLVER.1 — archive-before-overwrite ────────────────

  it('a body_markdown patch archives the OLD row before bumping version', async () => {
    const { rows, upsertLog } = setup(ownerA())
    const res = await PATCH(patchReq({ body_markdown: 'new body' }), props(TPL_A))
    expect(res.status).toBe(200)

    expect(upsertLog).toHaveLength(1)
    expect(upsertLog[0].payload).toMatchObject({
      template_id: TPL_A,
      version: 3,          // the OLD version, not the bumped one
      body_markdown: 'A body', // the OLD body, not the new one
      changed_by: 'owner-a',
    })
    expect(upsertLog[0].options).toMatchObject({ onConflict: 'template_id,version', ignoreDuplicates: true })

    // The update itself still lands as normal.
    const rowA = rows.find(r => r.id === TPL_A)
    expect(rowA.body_markdown).toBe('new body')
    expect(rowA.version).toBe(4)
  })

  it('a name-only patch never touches contract_template_versions', async () => {
    const { upsertLog } = setup(ownerA())
    const res = await PATCH(patchReq({ name: 'Renamed' }), props(TPL_A))
    expect(res.status).toBe(200)
    expect(upsertLog).toHaveLength(0)
  })

  it('an archive failure 500s and the template update never runs', async () => {
    const { rows } = setup(ownerA(), twoOrgRows(), { archiveError: { message: 'archive failed' } })
    const res = await PATCH(patchReq({ body_markdown: 'new body' }), props(TPL_A))
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body.error).toBe('archive failed')
    // The row is untouched — version bump never landed, audit trail
    // can't be outrun.
    const rowA = rows.find(r => r.id === TPL_A)
    expect(rowA.body_markdown).toBe('A body')
    expect(rowA.version).toBe(3)
  })

  it('a missing id 404s the same as a foreign one', async () => {
    setup(ownerA())
    const res = await PATCH(patchReq({ name: 'x' }), props('dddddddd-0000-0000-0000-000000000001'))
    expect(res.status).toBe(404)
  })
})

// ─── DELETE ──────────────────────────────────────────────────────

describe('DELETE /api/contract-templates/[id] — detail scoping', () => {
  it("owner of org A gets 404 deleting org B's template and it stays active", async () => {
    const { rows } = setup(ownerA())
    const res = await DELETE(null, props(TPL_B))
    expect(res.status).toBe(404)
    expect(rows.find(r => r.id === TPL_B).active).toBe(true)
  })

  it('non-master gets 404 deleting a NULL-org template, which stays active', async () => {
    const { rows } = setup(ownerA())
    const res = await DELETE(null, props(TPL_NULL))
    expect(res.status).toBe(404)
    expect(rows.find(r => r.id === TPL_NULL).active).toBe(true)
  })

  it('owner of org A can soft-delete their own template', async () => {
    const { rows } = setup(ownerA())
    const res = await DELETE(null, props(TPL_A))
    expect(res.status).toBe(200)
    expect(rows.find(r => r.id === TPL_A).active).toBe(false)
  })

  it('master can soft-delete any template, including NULL-org', async () => {
    const { rows } = setup(master())
    const res = await DELETE(null, props(TPL_NULL))
    expect(res.status).toBe(200)
    expect(rows.find(r => r.id === TPL_NULL).active).toBe(false)
  })
})
