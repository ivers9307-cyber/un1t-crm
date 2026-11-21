// /api/admin/location-trusted-ips through the real withAuth wrapper: a
// signed-out call is withAuth's 401 (it was a 403 'Forbidden' before); a
// non-master is the same 403 'Forbidden'; a bad CIDR the database refuses is a
// fixed 400 and any other failure a fixed 500, never the database text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/audit', async (importOriginal) => ({ ...(await importOriginal()), logAuditEvent: vi.fn(async () => ({ logged: true })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')

const OWNER = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const MASTER = person({ [LOC_A]: { role: 'owner' } }, LOC_A, { isMaster: true, profileRole: 'master', role: 'master' })
const add = (body = { location_id: LOC_A, ip_cidr: '203.0.113.0/24' }) => POST(new Request('http://localhost/api/admin/location-trusted-ips', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { location_trusted_ips: [] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/admin/location-trusted-ips on withAuth', () => {
  it('401 signed out, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost/api/admin/location-trusted-ips'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect((await add()).status).toBe(401)
    expect(db.tables.location_trusted_ips).toEqual([])
  })

  it('403 Forbidden for a studio owner, nothing written', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await add()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(db.tables.location_trusted_ips).toEqual([])
  })

  it('a master adds and lists', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await add()).status).toBe(201)
    const body = await (await GET(new Request('http://localhost/api/admin/location-trusted-ips'))).json()
    expect(body.ips).toHaveLength(1)
  })

  it('the database refusing the CIDR is a fixed 400; anything else a fixed 500', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    db.errors.location_trusted_ips = { insert: { code: '22P02', message: 'invalid input syntax for type inet: "1.2.3.999"' } }
    const bad = await add({ location_id: LOC_A, ip_cidr: '1.2.3.999' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ success: false, error: 'That is not a valid IP address or CIDR.' })
    db.errors.location_trusted_ips = { insert: { code: '23505', message: 'duplicate key value violates unique constraint' }, select: { message: 'statement timeout' } }
    const dup = await add()
    expect(dup.status).toBe(500)
    expect(await dup.json()).toEqual({ success: false, error: 'Could not add the trusted network. Try again.' })
    const list = await GET(new Request('http://localhost/api/admin/location-trusted-ips'))
    expect(await list.json()).toEqual({ success: false, error: 'Could not load the trusted networks. Try again.' })
  })
})
