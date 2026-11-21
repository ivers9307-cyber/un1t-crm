// POST /api/admin/policies/[slug]/versions through the real withAuth
// wrapper: signed in, then by hand: master only 403, body 400, the slug in the
// caller's active organisation (404 otherwise). See also
// src/app/(team)/policies/manage/gate.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, ORG, LOC_A } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/audit', async (importOriginal) => ({ ...(await importOriginal()), logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/policies', async (importOriginal) => ({ ...(await importOriginal()), publishVersion: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { publishVersion } = await import('@/lib/policies')
const { POST } = await import('./route.js')

const BODY = { body_markdown: '# Conduct', effective_date: '2026-12-01' }
const post = (slug, body = BODY) => POST(new Request(`http://localhost/api/admin/policies/${slug}/versions`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ slug }) })
const MASTER_IN_ORG = { ...MASTER, activeOrganization: { id: ORG } }

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { policies: [
    { id: 'p1', slug: 'conduct', active: true, organization_id: ORG },
    { id: 'p2', slug: 'elsewhere', active: true, organization_id: 'f0000000-0000-4000-8000-0000000000f9' },
  ] } }))
  publishVersion.mockResolvedValue({ id: 'v2', version_number: 2, effective_date: '2026-12-01' })
})

describe('POST /api/admin/policies/[slug]/versions', () => {
  it('401 signed out (withAuth)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post('conduct')).status).toBe(401)
    expect(publishVersion).not.toHaveBeenCalled()
  })

  it('403 for an owner', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    expect((await post('conduct')).status).toBe(403)
  })

  it('404 for a policy of another organisation', async () => {
    getCurrentUser.mockResolvedValue(MASTER_IN_ORG)
    expect((await post('elsewhere')).status).toBe(404)
    expect(publishVersion).not.toHaveBeenCalled()
  })

  it('a master publishes into the active organisation', async () => {
    getCurrentUser.mockResolvedValue(MASTER_IN_ORG)
    const res = await post('conduct')
    expect(res.status).toBe(200)
    expect(publishVersion.mock.calls[0][0]).toMatchObject({ policyId: 'p1', publishedBy: MASTER.id })
  })

  it('a failed publish is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER_IN_ORG)
    publishVersion.mockRejectedValue(new Error('duplicate key value violates unique constraint "policy_versions_current"'))
    const res = await post('conduct')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Publish failed' })
  })
})
