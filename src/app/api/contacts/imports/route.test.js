// GET /api/contacts/imports through the real withAuth wrapper: a manager
// somewhere (403), membership of the listed studio (403) and MANAGER_ROLES
// there (403); the list is that studio's.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const MANAGER_REQUIRED = { success: false, error: 'Manager+ required' }
const get = (loc) => GET(new Request(`http://localhost/api/contacts/imports${loc ? `?location_id=${loc}` : ''}`))
const rows = () => [
  { id: 'f0000000-0000-4000-8000-0000000000a1', location_id: LOC_A, source_filename: 'a.csv', status: 'committed', created_at: '2026-11-19T10:00:00Z' },
  { id: 'f0000000-0000-4000-8000-0000000000b1', location_id: LOC_B, source_filename: 'b.csv', status: 'committed', created_at: '2026-11-19T10:00:00Z' },
]
const managerAStaffB = () => person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'staff' } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { contact_imports: rows(), profiles: [] } }))
})

describe('GET /api/contacts/imports', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 "Manager+ required" for staff everywhere', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(MANAGER_REQUIRED)
  })

  it('403 "Manager+ required" at a listed studio where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(managerAStaffB())
    const res = await get(LOC_B)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(MANAGER_REQUIRED)
  })

  it('403 "Forbidden" for a studio the caller is not in', async () => {
    getCurrentUser.mockResolvedValue(managerAStaffB())
    const res = await get(LOC_OTHER)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('a manager gets the active studio\'s imports only', async () => {
    getCurrentUser.mockResolvedValue(managerAStaffB())
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((r) => r.location_id)).toEqual([LOC_A])
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(managerAStaffB())
    createServerClient.mockReturnValue(createFakeDb({ tables: { contact_imports: rows(), profiles: [] }, errors: { contact_imports: { select: { message: 'secret detail' } } } }))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
