// HYROX-TC — POST /api/hyrox/sessions/[id]/push through the real withAuth
// wrapper: approvals_hyrox_sessions at the session's studio, else 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const S_A = '5e000000-0000-4000-8000-000000000001'
const S_B = '5e000000-0000-4000-8000-000000000002'
const TV = '7f000000-0000-4000-8000-000000000001'
let db
const build = (errors = {}) => createFakeDb({
  tables: {
    hyrox_sessions: [{ id: S_A, location_id: LOC_A, status: 'approved' }, { id: S_B, location_id: LOC_B, status: 'approved' }],
    locations: [{ id: LOC_A, settings: {} }, { id: LOC_B, settings: {} }],
    tv_displays: [{ id: TV, location_id: LOC_A, active: true }],
    tv_content: [],
  },
  errors,
})
const post = (id = S_A) => POST(new Request(`http://localhost/api/hyrox/sessions/${id}/push`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const coach = (on = true) => person({ [LOC_A]: { role: 'staff', permissions: { approvals_hyrox_sessions: on } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  db = build()
  createServerClient.mockReturnValue(db)
})

describe('POST /api/hyrox/sessions/[id]/push', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
  })

  it('404 without the approval permission at the studio, nothing pushed', async () => {
    getCurrentUser.mockResolvedValue(coach(false))
    expect((await post()).status).toBe(404)
    expect(db.tables.tv_content).toEqual([])
  })

  it('404 for a session at another studio', async () => {
    getCurrentUser.mockResolvedValue(coach())
    expect((await post(S_B)).status).toBe(404)
    expect(db.tables.tv_content).toEqual([])
  })

  it('pushes the board to the studio\'s active TV', async () => {
    getCurrentUser.mockResolvedValue(coach())
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { pushed: 1 } })
    expect(db.tables.tv_content).toMatchObject([{ tv_display_id: TV, source_ref: S_A, triggered_by: 'manual:user-1' }])
  })

  it('a failed write is a 400 without the database text', async () => {
    getCurrentUser.mockResolvedValue(coach())
    createServerClient.mockReturnValue(build({ tv_content: { upsert: { message: 'secret detail' } } }))
    const res = await post()
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
