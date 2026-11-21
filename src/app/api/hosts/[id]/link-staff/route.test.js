// GET/POST/DELETE /api/hosts/[id]/link-staff through the real withAuth wrapper
// (a staff admin's session, not the host portal): signed in, then by hand:
// ADMIN_ROLES at the active studio 403, an active organisation 400, the host
// in that organisation (404 otherwise).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, ORG, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/hosts', async (importOriginal) => ({ ...(await importOriginal()), loadHostForOrg: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { loadHostForOrg } = await import('@/lib/hosts')
const { GET, POST, DELETE } = await import('./route.js')

const HOST = '40000000-0000-4000-8000-000000000001'
const STAFF_ID = '50000000-0000-4000-8000-000000000001'
const props = { params: Promise.resolve({ id: HOST }) }
const req = (method, body) => new Request(`http://localhost/api/hosts/${HOST}/link-staff`, {
  method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
})
const OWNER = { ...person({ [LOC_A]: { role: 'owner' } }, LOC_A), activeOrganization: { id: ORG } }
const STAFF = { ...person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'owner' } }, LOC_A), activeOrganization: { id: ORG } }
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    host_users: [{ id: 'hu-1', host_id: HOST, auth_user_id: STAFF_ID, email: 'coach@example.com' }],
    profiles: [{ id: STAFF_ID, full_name: 'Coach', email: 'coach@example.com' }],
    profile_locations: [], locations: [],
  } })
  createServerClient.mockReturnValue(db)
  loadHostForOrg.mockImplementation(async (_db, id, orgId) => (id === HOST && orgId === ORG ? { id: HOST } : null))
})

describe('/api/hosts/[id]/link-staff', () => {
  it('401 signed out (withAuth), nothing unlinked', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req('GET'), props)).status).toBe(401)
    expect((await DELETE(req('DELETE', { auth_user_id: STAFF_ID }), props)).status).toBe(401)
    expect(db.tables.host_users).toHaveLength(1)
  })

  it('403 for a staff role at the active studio (the old words)', async () => {
    getCurrentUser.mockResolvedValue(STAFF)
    const res = await GET(req('GET'), props)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
  })

  it('404 for a host outside the caller\'s organisation', async () => {
    getCurrentUser.mockResolvedValue({ ...OWNER, activeOrganization: { id: 'f0000000-0000-4000-8000-0000000000f9' }, activeLocation: { ...OWNER.activeLocation, organization_id: 'f0000000-0000-4000-8000-0000000000f9' } })
    expect((await POST(req('POST', { email: 'coach@example.com' }), props)).status).toBe(404)
  })

  it('lists the host\'s linked logins, and unlinks one', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await GET(req('GET'), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([{ auth_user_id: STAFF_ID, email: 'coach@example.com', full_name: 'Coach' }])
    expect((await DELETE(req('DELETE', { auth_user_id: STAFF_ID }), props)).status).toBe(200)
    expect(db.tables.host_users).toHaveLength(0)
  })
})
