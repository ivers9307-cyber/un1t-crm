// EVENTS-HOST.2 — GET/POST /api/hosts through the real withAuth wrapper:
// master/owner/manager at the active studio ('Manager+ required' 403), hosts of
// the active organisation only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'
import { person, LOC_A, ORG } from '../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')

const OTHER_ORG = 'f0000000-0000-4000-8000-0000000000f9'
const at = (role) => person({ [LOC_A]: { role } }, LOC_A)
const get = () => GET(new Request('http://localhost/api/hosts'))
const post = (body = { name: 'Run Club' }) => POST(new Request('http://localhost/api/hosts', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { event_hosts: [
    { id: 'a1000000-0000-4000-8000-000000000001', organization_id: ORG, name: 'Ours', created_at: '2026-11-01T00:00:00Z' },
    { id: 'a1000000-0000-4000-8000-000000000002', organization_id: OTHER_ORG, name: 'Theirs', created_at: '2026-11-02T00:00:00Z' },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/hosts', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    for (const res of [await get(), await post()]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    }
  })

  it('403 "Manager+ required" for staff, nothing read or written', async () => {
    getCurrentUser.mockResolvedValue(at('staff'))
    for (const res of [await get(), await post()]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
    }
    expect(db.calls).toEqual([])
  })

  it('400 no_active_organization without one', async () => {
    getCurrentUser.mockResolvedValue({ ...at('owner'), activeLocation: { id: LOC_A }, activeOrganization: null })
    expect((await get()).status).toBe(400)
  })

  it('GET lists the active organisation’s hosts only', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data.map((h) => h.name)).toEqual(['Ours'])
  })

  it('POST creates the host in the active organisation', async () => {
    getCurrentUser.mockResolvedValue(at('owner'))
    const res = await post()
    expect(res.status).toBe(200)
    expect(db.tables.event_hosts.at(-1)).toMatchObject({ organization_id: ORG, name: 'Run Club' })
  })

  it('a failed write answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(at('owner'))
    db.errors.event_hosts = { insert: { message: 'duplicate key value violates unique constraint "event_hosts_slug_key"' } }
    const res = await post()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not create the host.' })
  })
})
