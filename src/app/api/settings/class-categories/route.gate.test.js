// /api/settings/class-categories through the real withAuth wrapper: a
// signed-out call is withAuth's 401 (it was a 403 'Unauthorized' before); a
// caller who manages nowhere is the same 403 'Unauthorized'; another studio
// is refused with nothing written; a failed write answers a fixed message.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/class-categories', async (importOriginal) => ({ ...(await importOriginal()), loadSeenClassCategories: vi.fn(async () => []) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, PUT } = await import('./route.js')

const MANAGER_A = person({ [LOC_A]: { role: 'manager' } }, LOC_A)
const STAFF_A = person({ [LOC_A]: { role: 'staff' } }, LOC_A)
const put = (body) => PUT(new Request('http://localhost/api/settings/class-categories', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const ENTRY = { class_name: 'DR1VE', category: 'cardio' }
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { class_categories: [] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/settings/class-categories on withAuth', () => {
  it('401 signed out, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost/api/settings/class-categories'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect((await put({ entries: [ENTRY] })).status).toBe(401)
    expect(db.tables.class_categories).toEqual([])
  })

  it('403 Unauthorized for a caller who manages nowhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    const res = await GET(new Request('http://localhost/api/settings/class-categories'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('another studio is refused, nothing written', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await put({ location_id: LOC_B, entries: [ENTRY] })).status).toBe(403)
    expect(db.tables.class_categories).toEqual([])
  })

  it('saves at the caller’s studio; a failed write is a fixed 400', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await put({ entries: [ENTRY] })).status).toBe(200)
    expect(db.tables.class_categories[0]).toMatchObject({ location_id: LOC_A, category: 'cardio' })
    db.errors.class_categories = { upsert: { message: 'there is no unique constraint matching ON CONFLICT' }, insert: { message: 'there is no unique constraint matching ON CONFLICT' } }
    const res = await put({ entries: [ENTRY] })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Could not save the categories. Try again.' })
  })
})
