// CLASS-TIMER — POST /api/timer/runs/[id]/control through the real withAuth
// wrapper: class_timer somewhere, then at the run's studio (the full role
// sweep is tests/role-sweep/presentations-and-timer.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/timer-broadcast', () => ({ broadcastTimerPing: vi.fn(async () => {}) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const RUN = 'f1000000-0000-4000-8000-000000000001'
let db
const control = (action = 'pause') => POST(
  new Request(`http://localhost/api/timer/runs/${RUN}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }),
  { params: Promise.resolve({ id: RUN }) },
)
const timer = (on) => person({ [LOC_A]: { role: 'staff', permissions: { class_timer: on } }, [LOC_B]: { role: 'staff', permissions: { class_timer: true } } }, LOC_B)

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { class_timer_runs: [{ id: RUN, location_id: LOC_A, status: 'running', started_at: new Date().toISOString(), paused_at: null, paused_accum_ms: 0, structure_snapshot: {} }] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/timer/runs/[id]/control', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await control()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it("403 'Unauthorized' without class_timer at the run's studio, nothing changed", async () => {
    getCurrentUser.mockResolvedValue(timer(false))
    const res = await control()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.class_timer_runs[0].status).toBe('running')
  })

  it("404 for another studio's run", async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'owner', permissions: { class_timer: true } } }, LOC_B))
    expect((await control()).status).toBe(404)
  })

  it('pauses the run', async () => {
    getCurrentUser.mockResolvedValue(timer(true))
    const res = await control()
    expect(res.status).toBe(200)
    expect(db.tables.class_timer_runs[0].status).toBe('paused')
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(timer(true))
    db.errors.class_timer_runs = { update: { message: 'secret detail' } }
    const res = await control()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
