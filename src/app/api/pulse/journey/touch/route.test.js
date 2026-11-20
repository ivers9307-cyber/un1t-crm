// ROUTEWRAP.R10 — POST /api/pulse/journey/touch through the real withAuth
// wrapper: signed out is the wrapper's 401, pulse_admin keeps its 403
// 'Forbidden', another studio's contact is 404, and a failed insert answers a
// fixed message.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const C_A = 'c0000000-0000-4000-8000-0000000000a1'
const C_B = 'c0000000-0000-4000-8000-0000000000b1'
const post = (contact_id) => POST(new Request('http://localhost/api/pulse/journey/touch', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contact_id }),
}))
const coach = (on = true) => person({ [LOC_A]: { role: 'head_coach', permissions: { pulse_admin: on } } }, LOC_A)
let db
const seed = (errors) => createFakeDb({
  tables: { contacts: [{ id: C_A, location_id: LOC_A }, { id: C_B, location_id: LOC_B }], churn_radar_actions: [] },
  errors,
})

beforeEach(() => {
  vi.clearAllMocks()
  db = seed()
  createServerClient.mockImplementation(() => db)
})

describe('POST /api/pulse/journey/touch', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post(C_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Forbidden" without pulse_admin', async () => {
    getCurrentUser.mockResolvedValue(coach(false))
    const res = await post(C_A)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('404 for another studio’s contact, nothing written', async () => {
    getCurrentUser.mockResolvedValue(coach())
    expect((await post(C_B)).status).toBe(404)
    expect(db.tables.churn_radar_actions).toHaveLength(0)
  })

  it('logs the touch at the active studio', async () => {
    getCurrentUser.mockResolvedValue(coach())
    const res = await post(C_A)
    expect(res.status).toBe(200)
    expect(db.tables.churn_radar_actions).toEqual([expect.objectContaining({ contact_id: C_A, location_id: LOC_A, action: 'contacted', actor_id: 'user-1' })])
  })

  it('a failed insert answers a fixed message', async () => {
    db = seed({ churn_radar_actions: { insert: { message: 'check constraint xyz' } } })
    getCurrentUser.mockResolvedValue(coach())
    const res = await post(C_A)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('xyz')
  })
})
