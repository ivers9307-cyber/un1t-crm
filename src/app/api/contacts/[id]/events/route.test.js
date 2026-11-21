// GET /api/contacts/[id]/events through the real withAuth wrapper: signed in,
// then the contact's studio (404 outside, same as a missing contact).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const C = 'cc000000-0000-4000-8000-000000000001'
const C_FAR = 'cc000000-0000-4000-8000-000000000002'
const get = (id) => GET(new Request(`http://localhost/api/contacts/${id}/events`), { params: Promise.resolve({ id }) })
const STAFF = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'staff' } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    contacts: [{ id: C, location_id: LOC_B }, { id: C_FAR, location_id: LOC_OTHER }],
    team_members: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/contacts/[id]/events', () => {
  it('401 signed out (withAuth)', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get(C)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('404 for another studio\'s contact, and for an unknown one', async () => {
    getCurrentUser.mockResolvedValue(STAFF)
    expect((await get(C_FAR)).status).toBe(404)
    expect((await get('cc000000-0000-4000-8000-000000000009')).status).toBe(404)
  })

  it('a staff member at the contact\'s studio gets the (empty) race history', async () => {
    getCurrentUser.mockResolvedValue(STAFF)
    const res = await get(C)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: [] })
  })
})
