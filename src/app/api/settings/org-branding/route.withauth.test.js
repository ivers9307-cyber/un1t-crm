// ROUTEWRAP.R16 — GET/PUT /api/settings/org-branding through the real withAuth
// wrapper: signed in (the same 401), an organisation admin (403 otherwise),
// keyed on the organisation they administer.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, ORG } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, PUT } = await import('./route.js')

const OTHER_ORG = 'f0000000-0000-4000-8000-0000000000fa'
const get = (q = '') => GET(new Request(`http://localhost/api/settings/org-branding${q}`))
const put = (body) => PUT(new Request('http://localhost/api/settings/org-branding', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const owner = () => person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const orgAdmin = () => person({ [LOC_A]: { role: 'owner' } }, LOC_A, { orgAdminOrgIds: [ORG], activeOrganization: { id: ORG } })

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { org_settings: [{ organization_id: ORG, company_name: 'UN1T' }, { organization_id: OTHER_ORG, company_name: 'Other' }] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/settings/org-branding', () => {
  it('401 signed out, both methods', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect(await (await get()).json()).toEqual({ success: false, error: 'Unauthorized' })
    expect((await put({ company_name: 'x' })).status).toBe(401)
  })

  it('403 for a studio owner who is not an organisation admin, nothing written', async () => {
    getCurrentUser.mockResolvedValue(owner())
    expect((await get()).status).toBe(403)
    expect((await put({ company_name: 'x' })).status).toBe(403)
    expect(db.tables.org_settings[0].company_name).toBe('UN1T')
  })

  it("an organisation admin cannot name another organisation", async () => {
    getCurrentUser.mockResolvedValue(orgAdmin())
    expect((await get(`?organization_id=${OTHER_ORG}`)).status).toBe(403)
    expect((await put({ organization_id: OTHER_ORG, company_name: 'x' })).status).toBe(403)
    expect(db.tables.org_settings[1].company_name).toBe('Other')
  })

  it('an organisation admin reads and saves their own', async () => {
    getCurrentUser.mockResolvedValue(orgAdmin())
    expect((await (await get()).json()).data.company_name).toBe('UN1T')
    const res = await put({ company_name: 'UN1T Group' })
    expect(res.status).toBe(200)
    expect(db.tables.org_settings[0].company_name).toBe('UN1T Group')
  })
})
