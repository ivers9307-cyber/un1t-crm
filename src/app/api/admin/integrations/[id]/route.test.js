// PATCH /api/admin/integrations/[id] through the real withAuth wrapper:
// masters only (profiles.role), no studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn(), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PATCH } = await import('./route.js')

const ID = 'f1000000-0000-4000-8000-000000000001'
const patch = (body = { is_enabled: true }) => PATCH(new Request(`http://localhost/api/admin/integrations/${ID}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: ID }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { service_integrations: [{ id: ID, provider: 'xero', display_name: 'Xero', is_enabled: false }] } })
  createServerClient.mockReturnValue(db)
})

describe('PATCH /api/admin/integrations/[id]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await patch()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 { ok: false, error: "Forbidden" } for an owner, nothing written', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await patch()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Forbidden' })
    expect(db.tables.service_integrations[0].is_enabled).toBe(false)
  })

  it('a master updates the row', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await patch()
    expect(res.status).toBe(200)
    expect(db.tables.service_integrations[0].is_enabled).toBe(true)
  })

  it('a failed write answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    db.errors.service_integrations = { update: { message: 'permission denied for table service_integrations' } }
    const res = await patch()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'Could not update the integration.' })
  })
})
