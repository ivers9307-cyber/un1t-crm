// GET /api/contacts/imports/[id] through the real withAuth wrapper
// (ROUTEWRAP.R6): Manager+ somewhere (403), then the batch's studio (404) and
// MANAGER_ROLES there (403), as before.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const IMP_A = 'f1000000-0000-4000-8000-00000000000a'
const IMP_B = 'f1000000-0000-4000-8000-00000000000b'
const get = (id = IMP_A) => GET(new Request(`http://localhost/api/contacts/imports/${id}`), { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: {
    contact_imports: [{ id: IMP_A, location_id: LOC_A }, { id: IMP_B, location_id: LOC_B }],
    contact_import_rows: [
      { id: 'f2000000-0000-4000-8000-000000000001', import_id: IMP_A, row_number: 1, action: 'created' },
      { id: 'f2000000-0000-4000-8000-000000000002', import_id: IMP_B, row_number: 1, action: 'created' },
    ],
  } }))
})

describe('GET /api/contacts/imports/[id]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Manager+ required" for staff everywhere', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Manager+ required')
  })

  it("404 for another studio's batch", async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' } }, LOC_A))
    expect((await get(IMP_B)).status).toBe(404)
  })

  it("403 for a manager elsewhere who is staff at the batch's studio", async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'manager' } }, LOC_B))
    expect((await get(IMP_A)).status).toBe(403)
  })

  it("a manager at the batch's studio gets the batch and only its rows", async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.batch.id).toBe(IMP_A)
    expect(body.data.rows.map((r) => r.id)).toEqual(['f2000000-0000-4000-8000-000000000001'])
  })
})
