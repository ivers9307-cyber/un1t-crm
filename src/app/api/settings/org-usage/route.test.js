// /api/settings/org-usage through the real withAuth wrapper, which only signs
// the caller in. The org-admin check (403, its own words per verb) and the
// organisation (403) keep their order.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, ORG, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/usage-summary', async (importOriginal) => ({ ...(await importOriginal()), getOrgUsageSummary: vi.fn(async () => ({ meters: [] })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { getOrgUsageSummary } = await import('@/lib/usage-summary')
const { GET, PUT } = await import('./route.js')

const OTHER_ORG = 'f1000000-0000-4000-8000-0000000000f1'
const ORG_ADMIN = person({ [LOC_A]: { role: 'owner' } }, LOC_A, { orgAdminOrgIds: [ORG] })
const OWNER = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const put = (body) => PUT(new Request('http://localhost/api/settings/org-usage', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { org_settings: [] } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/settings/org-usage', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost/api/settings/org-usage'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Forbidden" for a studio owner who is not an org admin', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await GET(new Request('http://localhost/api/settings/org-usage'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(getOrgUsageSummary).not.toHaveBeenCalled()
  })

  it('403 for an organisation the admin does not administer', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await GET(new Request(`http://localhost/api/settings/org-usage?organization_id=${OTHER_ORG}`))
    expect(res.status).toBe(403)
    expect(getOrgUsageSummary).not.toHaveBeenCalled()
  })

  it('an org admin reads their own organisation', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await GET(new Request('http://localhost/api/settings/org-usage'))
    expect(res.status).toBe(200)
    expect(getOrgUsageSummary.mock.calls[0][1]).toBe(ORG)
  })
})

describe('PUT /api/settings/org-usage', () => {
  it('401 signed out, 403 with its own words for a non-admin, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await put({ ai_hard_cap_cents: 500 })).status).toBe(401)
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await put({ ai_hard_cap_cents: 500 })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Only organisation admins can change usage caps' })
    expect(db.tables.org_settings).toEqual([])
  })

  it('an org admin sets a cap', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await put({ ai_hard_cap_cents: 500 })
    expect(res.status).toBe(200)
    expect(db.tables.org_settings[0]).toMatchObject({ organization_id: ORG, ai_hard_cap_cents: 500 })
  })

  it('a failed save answers a fixed 400, never the database text', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    db.errors.org_settings = { upsert: { message: 'null value in column "organization_id" violates not-null constraint' } }
    const res = await put({ ai_hard_cap_cents: 500 })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Could not save the usage settings. Try again.' })
  })
})
