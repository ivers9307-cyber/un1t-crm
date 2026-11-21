// ROUTEWRAP.R10 — POST /api/timer/runs through the real withAuth wrapper:
// signed out is the wrapper's 401 (it was a 403), class_timer is judged at the
// body's studio, another studio's template is 404, and a failed insert answers
// a fixed message.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/timer-broadcast', () => ({ broadcastTimerPing: vi.fn(async () => {}) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const TPL_A = 'f0000000-0000-4000-8000-0000000000a1'
const TPL_B = 'f0000000-0000-4000-8000-0000000000b1'
const post = (body) => POST(new Request('http://localhost/api/timer/runs', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
const coach = (on = true) => person({ [LOC_A]: { role: 'staff', permissions: { class_timer: on } } }, LOC_A)
let db
const seed = (errors) => createFakeDb({
  tables: {
    class_timer_templates: [
      { id: TPL_A, location_id: LOC_A, name: 'EMOM', structure: { blocks: [] } },
      { id: TPL_B, location_id: LOC_B, name: 'Other', structure: { blocks: [] } },
    ],
    class_timer_runs: [],
  },
  errors,
})

beforeEach(() => {
  vi.clearAllMocks()
  db = seed()
  createServerClient.mockImplementation(() => db)
})

describe('POST /api/timer/runs', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post({ location_id: LOC_A, template_id: TPL_A })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without class_timer anywhere', async () => {
    getCurrentUser.mockResolvedValue(coach(false))
    const res = await post({ location_id: LOC_A, template_id: TPL_A })
    expect(res.status).toBe(403)
    expect(db.tables.class_timer_runs).toHaveLength(0)
  })

  it('403 for a studio outside the caller’s', async () => {
    getCurrentUser.mockResolvedValue(coach())
    const res = await post({ location_id: LOC_B, template_id: TPL_B })
    expect(res.status).toBe(403)
    expect(db.tables.class_timer_runs).toHaveLength(0)
  })

  it('404 for another studio’s template', async () => {
    getCurrentUser.mockResolvedValue(coach())
    const res = await post({ location_id: LOC_A, template_id: TPL_B })
    expect(res.status).toBe(404)
  })

  it('starts a run at the caller’s studio', async () => {
    getCurrentUser.mockResolvedValue(coach())
    const res = await post({ location_id: LOC_A, template_id: TPL_A })
    expect(res.status).toBe(200)
    expect(db.tables.class_timer_runs).toEqual([expect.objectContaining({ location_id: LOC_A, template_id: TPL_A, status: 'running', started_by: 'user-1' })])
  })

  it('a failed insert answers a fixed message', async () => {
    db = seed({ class_timer_runs: { insert: { message: 'duplicate key value violates xyz' } } })
    getCurrentUser.mockResolvedValue(coach())
    const res = await post({ location_id: LOC_A, template_id: TPL_A })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('xyz')
  })
})
