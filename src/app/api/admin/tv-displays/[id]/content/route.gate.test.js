// /api/admin/tv-displays/[id]/content through the real withAuth wrapper:
// signed in (401), the TV's own studio (404 for another studio's TV, nothing
// pushed), then the push. A failed push or clear answers a fixed 500, never
// the database text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/screen-doorbell', async (importOriginal) => ({ ...(await importOriginal()), ringScreensForDisplay: vi.fn(async () => {}) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PUT, DELETE } = await import('./route.js')

const TV_A = '70000000-0000-4000-8000-00000000000a'
const TV_B = '70000000-0000-4000-8000-00000000000b'
const ADMIN_A = person({ [LOC_A]: { role: 'manager', permissions: { tv_displays: true } } }, LOC_A)
const push = (id) => PUT(new Request(`http://localhost/api/admin/tv-displays/${id}/content`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_type: 'url', source_ref: 'https://example.com/board' }),
}), { params: Promise.resolve({ id }) })
const clear = (id) => DELETE(new Request(`http://localhost/api/admin/tv-displays/${id}/content`, { method: 'DELETE' }), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { tv_displays: [{ id: TV_A, location_id: LOC_A }, { id: TV_B, location_id: LOC_B }], tv_content: [] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/admin/tv-displays/[id]/content on withAuth', () => {
  it('401 signed out, nothing pushed', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await push(TV_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect((await clear(TV_A)).status).toBe(401)
    expect(db.tables.tv_content).toEqual([])
  })

  it('404 for another studio’s TV, nothing pushed', async () => {
    getCurrentUser.mockResolvedValue(ADMIN_A)
    expect((await push(TV_B)).status).toBe(404)
    expect((await clear(TV_B)).status).toBe(404)
    expect(db.tables.tv_content).toEqual([])
  })

  it('pushes to the caller’s own TV, stamped from the session', async () => {
    getCurrentUser.mockResolvedValue(ADMIN_A)
    expect((await push(TV_A)).status).toBe(200)
    expect(db.tables.tv_content[0]).toMatchObject({ tv_display_id: TV_A, pushed_by: ADMIN_A.id })
  })

  it('a failed push or clear answers a fixed 500', async () => {
    getCurrentUser.mockResolvedValue(ADMIN_A)
    db.errors.tv_content = { upsert: { message: 'insert or update on table "tv_content" violates foreign key' }, insert: { message: 'insert or update on table "tv_content" violates foreign key' }, delete: { message: 'permission denied' } }
    const p = await push(TV_A)
    expect(p.status).toBe(500)
    expect(await p.json()).toEqual({ success: false, error: 'Could not push to the TV.' })
    const c = await clear(TV_A)
    expect(c.status).toBe(500)
    expect(await c.json()).toEqual({ success: false, error: 'Could not clear the TV.' })
  })
})
