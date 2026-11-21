// /api/settings/status-page gate through the real withAuth wrapper: signed in
// (401), `settings` at the active studio (403 'Forbidden'), an active studio
// (400 'No active location'), in that order, for GET and PUT.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, PUT } = await import('./route.js')

const NO_SETTINGS = person({ [LOC_A]: { role: 'staff', permissions: { settings: false } } }, LOC_A)
const SETTINGS = person({ [LOC_A]: { role: 'owner', permissions: { settings: true } } }, LOC_A)
const put = () => PUT(new Request('http://localhost/api/settings/status-page', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { locations: [{ id: LOC_A, name: 'Studio A', settings: { status_page: { brand: 'Keep' } } }] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/settings/status-page gate', () => {
  it('401 signed out, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    for (const res of [await GET(new Request('http://localhost/x')), await put()]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    }
    expect(db.tables.locations[0].settings.status_page).toEqual({ brand: 'Keep' })
  })

  it('403 Forbidden without settings, before the studio check', async () => {
    getCurrentUser.mockResolvedValue({ ...NO_SETTINGS, activeLocation: null })
    const res = await GET(new Request('http://localhost/x'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect((await put()).status).toBe(403)
  })

  it('400 without an active studio', async () => {
    getCurrentUser.mockResolvedValue({ ...SETTINGS, activeLocation: null, role: 'master' })
    const res = await GET(new Request('http://localhost/x'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'No active location' })
  })
})
