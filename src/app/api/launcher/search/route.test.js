// GET /api/launcher/search through the real withAuth wrapper: signed in, an
// active studio (400, same words), then each entity behind its own permission
// at that studio, never another studio's rows.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const get = (q) => GET(new Request(`http://localhost/api/launcher/search?q=${encodeURIComponent(q)}`))
const withKeys = (perms) => person({ [LOC_A]: { role: 'staff', permissions: perms }, [LOC_B]: { role: 'owner' } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    contacts: [
      { id: 'c-a', name: 'Aoife Byrne', email: null, phone: null, location_id: LOC_A, is_primary_contact: true },
      { id: 'c-b', name: 'Aoife Kelly', email: null, phone: null, location_id: LOC_B, is_primary_contact: true },
    ],
    profiles: [], profile_locations: [], race_events: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/launcher/search', () => {
  it('401 signed out (withAuth)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get('aoife')).status).toBe(401)
  })

  it('400 with no active studio, in its old words', async () => {
    getCurrentUser.mockResolvedValue({ ...withKeys({ contacts: true }), activeLocation: null })
    const res = await get('aoife')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'No active location' })
  })

  it('without Contacts at the active studio, no contacts are searched', async () => {
    getCurrentUser.mockResolvedValue(withKeys({ contacts: false, settings: false, races: false }))
    const res = await get('aoife')
    expect(await res.json()).toEqual({ success: true, results: [] })
    expect(db.calls).toHaveLength(0)
  })

  it('finds contacts at the active studio only', async () => {
    getCurrentUser.mockResolvedValue(withKeys({ contacts: true, settings: false, races: false }))
    const res = await get('aoife')
    expect(res.status).toBe(200)
    const { results } = await res.json()
    expect(results.map((r) => r.key || r.href)).toHaveLength(1)
    expect(JSON.stringify(results)).toContain('c-a')
    expect(JSON.stringify(results)).not.toContain('c-b')
  })
})
