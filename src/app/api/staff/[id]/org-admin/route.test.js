// Route-level tests for /api/staff/[id]/org-admin (SAAS-4, mig 417).
//
// The org-admin grant hands out owner-everywhere access across a whole
// org, so the surface is MASTER ONLY on both verbs — these tests pin
// that gate, the desired-state diff semantics (grant/revoke/idempotent
// resubmit), and the 404 for an unknown profile.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

// Audit must not hit a real client; the route already swallows audit
// failures, but mocking keeps the test's query ledger clean.
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { GET, PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logAuditEvent } from '@/lib/audit'

const PROFILE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ORG_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const ORG_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

const master = { id: 'master-1', isMaster: true, full_name: 'M', email: 'm@un1t.ie' }
const owner = { id: 'owner-1', isMaster: false, role: 'owner' }
const orgAdmin = { id: 'oa-1', isMaster: false, role: 'owner', orgAdminOrgIds: [ORG_A] }

// Scripted double for the route's query shapes:
//   profiles        select('...').eq('id', X).single()      → target
//   profile_orgs    select(...).eq('profile_id', X)         → existing grants
//   profile_orgs    insert([...])                           → recorded
//   profile_orgs    delete().eq(...).in(...)                → recorded
function mockDb({ target = { id: PROFILE_ID, full_name: 'T', email: 't@x.ie' }, existing = [], insertError = null } = {}) {
  const inserted = []
  const deleted = []
  function from(table) {
    if (table === 'profiles') {
      const b = {}
      b.select = () => b
      b.eq = () => b
      b.single = () => b
      b.then = (res, rej) => Promise.resolve({ data: target }).then(res, rej)
      return b
    }
    if (table === 'profile_organizations') {
      const b = { _op: 'select' }
      b.select = () => { b._op = 'select'; return b }
      b.eq = () => b
      b.in = (col, vals) => { if (b._op === 'delete') deleted.push(vals); return b }
      b.insert = (rows) => { b._op = 'insert'; inserted.push(rows); return b }
      b.delete = () => { b._op = 'delete'; return b }
      b.then = (res, rej) => {
        if (b._op === 'insert') return Promise.resolve({ error: insertError }).then(res, rej)
        if (b._op === 'delete') return Promise.resolve({ error: null }).then(res, rej)
        return Promise.resolve({ data: existing.map(orgId => ({ organization_id: orgId })) }).then(res, rej)
      }
      return b
    }
    throw new Error(`unexpected table ${table}`)
  }
  return { db: { from }, inserted, deleted }
}

function putRequest(organization_ids) {
  return new Request('http://test/api/staff/x/org-admin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ organization_ids }),
  })
}

const props = { params: Promise.resolve({ id: PROFILE_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/staff/[id]/org-admin', () => {
  it('401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://test'), props)
    expect(res.status).toBe(401)
  })

  it('403 for a non-master — even an owner or an org admin themselves', async () => {
    for (const user of [owner, orgAdmin]) {
      getCurrentUser.mockResolvedValue(user)
      const res = await GET(new Request('http://test'), props)
      expect(res.status).toBe(403)
    }
  })

  it('master reads the current grants', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db } = mockDb({ existing: [ORG_A, ORG_B] })
    createServerClient.mockReturnValue(db)

    const res = await GET(new Request('http://test'), props)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: { organization_ids: [ORG_A, ORG_B] } })
  })

  it('404 for an unknown profile', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db } = mockDb({ target: null })
    createServerClient.mockReturnValue(db)

    const res = await GET(new Request('http://test'), props)
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/staff/[id]/org-admin', () => {
  it('401 when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await PUT(putRequest([ORG_A]), props)
    expect(res.status).toBe(401)
  })

  it('403 for a non-master (grant is never delegated)', async () => {
    for (const user of [owner, orgAdmin]) {
      getCurrentUser.mockResolvedValue(user)
      const { db } = mockDb()
      createServerClient.mockReturnValue(db)
      const res = await PUT(putRequest([ORG_A]), props)
      expect(res.status).toBe(403)
    }
  })

  it('master grants to a foreign profile (no shared location needed — master is global)', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db, inserted, deleted } = mockDb({ existing: [] })
    createServerClient.mockReturnValue(db)

    const res = await PUT(putRequest([ORG_A]), props)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: { organization_ids: [ORG_A] } })
    expect(inserted).toEqual([[{ profile_id: PROFILE_ID, organization_id: ORG_A }]])
    expect(deleted).toEqual([])
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'auth',
      action: 'org_admin.granted',
      details: { organization_ids: [ORG_A] },
    }))
  })

  it('master revokes by omitting an org from the desired set', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db, inserted, deleted } = mockDb({ existing: [ORG_A, ORG_B] })
    createServerClient.mockReturnValue(db)

    const res = await PUT(putRequest([ORG_A]), props)

    expect(res.status).toBe(200)
    expect(inserted).toEqual([])
    expect(deleted).toEqual([[ORG_B]])
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'org_admin.revoked',
      details: { organization_ids: [ORG_B] },
    }))
  })

  it('duplicate grant is idempotent — resubmitting the same set performs no writes', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db, inserted, deleted } = mockDb({ existing: [ORG_A] })
    createServerClient.mockReturnValue(db)

    // Duplicates inside the body are deduped too.
    const res = await PUT(putRequest([ORG_A, ORG_A]), props)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.organization_ids).toEqual([ORG_A])
    expect(inserted).toEqual([])
    expect(deleted).toEqual([])
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('an unknown org id (FK violation) surfaces as a clean 400, not a 500', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db } = mockDb({ existing: [], insertError: { message: 'violates foreign key constraint' } })
    createServerClient.mockReturnValue(db)

    const res = await PUT(putRequest([ORG_A]), props)
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/foreign key/)
  })

  it('404 for an unknown profile', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db } = mockDb({ target: null })
    createServerClient.mockReturnValue(db)

    const res = await PUT(putRequest([ORG_A]), props)
    expect(res.status).toBe(404)
  })

  it('400 for a malformed body (non-uuid entries rejected by the schema)', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { db } = mockDb()
    createServerClient.mockReturnValue(db)

    const res = await PUT(putRequest(['not-a-uuid']), props)
    expect(res.status).toBe(400)
  })
})
