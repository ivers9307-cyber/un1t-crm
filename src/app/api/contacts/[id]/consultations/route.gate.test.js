// POST /api/contacts/[id]/consultations through the real withAuth wrapper and
// the real permission resolver: signed in (401), `consultations` somewhere
// (403 'Unauthorized', as before), the contact (404), its studio (404, never
// 403), then the insert. A failed insert answers a fixed 500.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const C_A = 'c0000000-0000-4000-8000-00000000000a'
const C_B = 'c0000000-0000-4000-8000-00000000000b'
const COACH_A = person({ [LOC_A]: { role: 'head_coach', permissions: { consultations: true } } }, LOC_A)
const NO_CONSULTS = person({ [LOC_A]: { role: 'staff', permissions: { consultations: false } } }, LOC_A)
const create = (id) => POST(new Request(`http://localhost/api/contacts/${id}/consultations`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'First visit' }),
}), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { contacts: [{ id: C_A, location_id: LOC_A }, { id: C_B, location_id: LOC_B }], consultations: [] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/contacts/[id]/consultations on withAuth', () => {
  it('401 signed out, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await create(C_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.consultations).toEqual([])
  })

  it('403 without consultations anywhere, before any read', async () => {
    getCurrentUser.mockResolvedValue(NO_CONSULTS)
    const res = await create(C_A)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.calls).toEqual([])
  })

  it('404 for another studio’s contact, nothing written', async () => {
    getCurrentUser.mockResolvedValue(COACH_A)
    expect((await create(C_B)).status).toBe(404)
    expect(db.tables.consultations).toEqual([])
  })

  it('creates the consultation at the contact’s studio', async () => {
    getCurrentUser.mockResolvedValue(COACH_A)
    expect((await create(C_A)).status).toBe(200)
    expect(db.tables.consultations[0]).toMatchObject({ contact_id: C_A, location_id: LOC_A, created_by: COACH_A.id })
  })

  it('a failed insert answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(COACH_A)
    db.errors.consultations = { insert: { message: 'insert or update on table "consultations" violates foreign key constraint' } }
    const res = await create(C_A)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not save the consultation. Try again.' })
  })
})
