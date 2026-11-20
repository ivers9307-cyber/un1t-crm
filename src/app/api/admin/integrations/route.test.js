// SAAS-6 — GET /api/admin/integrations through the real withAuth wrapper:
// masters only (profiles.role), every provider row.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn(), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const rows = () => [
  { id: 'i2', provider: 'strava', display_name: 'Strava' },
  { id: 'i1', provider: 'garmin', display_name: 'Garmin' },
]

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { service_integrations: rows() } }))
})

describe('GET /api/admin/integrations', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost/api/admin/integrations'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 { ok: false, error: "Forbidden" } for an owner who is not a master', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await GET(new Request('http://localhost/api/admin/integrations'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Forbidden' })
  })

  it('a master gets every provider, by display name', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await GET(new Request('http://localhost/api/admin/integrations'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.integrations.map((i) => i.display_name)).toEqual(['Garmin', 'Strava'])
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(createFakeDb({ tables: { service_integrations: [] }, errors: { service_integrations: { select: { message: 'secret detail' } } } }))
    const res = await GET(new Request('http://localhost/api/admin/integrations'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
