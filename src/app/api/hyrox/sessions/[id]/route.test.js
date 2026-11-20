// HYROX-TC.2 — PUT /api/hyrox/sessions/[id] through the real withAuth wrapper
// (ROUTEWRAP.R6): the row's studio and the hyrox approval permission there
// (404 otherwise), a published session is a 409; no database text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PUT } = await import('./route.js')

const S_A = 'a2000000-0000-4000-8000-00000000000a'
const S_B = 'a2000000-0000-4000-8000-00000000000b'
let db
const put = (id = S_A, body = { status: 'approved' }) => PUT(new Request(`http://localhost/api/hyrox/sessions/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const row = (id) => db.tables.hyrox_sessions.find((r) => r.id === id)
const owner = () => person({ [LOC_A]: { role: 'owner' } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { hyrox_sessions: [
    { id: S_A, location_id: LOC_A, status: 'draft' },
    { id: S_B, location_id: LOC_B, status: 'draft' },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('PUT /api/hyrox/sessions/[id]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await put()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('404 without the hyrox approval permission, and for another studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    expect((await put()).status).toBe(404)
    getCurrentUser.mockResolvedValue(owner())
    expect((await put(S_B)).status).toBe(404)
    expect(row(S_A).status).toBe('draft')
    expect(row(S_B).status).toBe('draft')
  })

  it("an owner approves their studio's session; a published one is a 409", async () => {
    getCurrentUser.mockResolvedValue(owner())
    const res = await put()
    expect(res.status).toBe(200)
    expect(row(S_A)).toMatchObject({ status: 'approved', approved_by: 'user-1' })
    row(S_A).status = 'published'
    expect((await put()).status).toBe(409)
  })

  it('a failed write is a 400 with a fixed message', async () => {
    getCurrentUser.mockResolvedValue(owner())
    db.errors.hyrox_sessions = { update: { code: '23514', message: 'violates check constraint "hyrox_sessions_status_check"' } }
    const res = await put()
    expect(res.status).toBe(400)
    expect((await res.json()).error).not.toMatch(/constraint/)
  })
})
