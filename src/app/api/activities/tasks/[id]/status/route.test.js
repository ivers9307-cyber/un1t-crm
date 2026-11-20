// POST /api/activities/tasks/[id]/status through the real withAuth wrapper:
// the web Tasks key anywhere (403), the body (400), then the task's own studio
// (404 outside it, 403 without the web rule there). The full rule matrix is in
// ../../task-web-writes.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const T1 = 'a1000000-0000-4000-8000-000000000001'
const FORBIDDEN = { success: false, error: 'No Tasks permission at this location' }
const post = (body) => POST(
  new Request(`http://localhost/api/activities/tasks/${T1}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: T1 }) },
)
const writer = () => person({ [LOC_B]: { role: 'staff', permissions: { activities: true, contacts: true } } }, LOC_B)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { activities: [{ id: T1, kind: 'task', status: 'todo', location_id: LOC_B, subject: 'Call' }] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/activities/tasks/[id]/status', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ status: 'done' })).status).toBe(401)
  })

  it('403 holding the web Tasks key nowhere, nothing written', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'staff', permissions: { activities: false, contacts: true } } }, LOC_B))
    const res = await post({ status: 'done' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(FORBIDDEN)
    expect(db.tables.activities[0].status).toBe('todo')
  })

  it('404 for a task at a studio the caller is not in', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: { activities: true, contacts: true } } }, LOC_A))
    expect((await post({ status: 'done' })).status).toBe(404)
    expect(db.tables.activities[0].status).toBe('todo')
  })

  it('an allowed caller moves the task', async () => {
    getCurrentUser.mockResolvedValue(writer())
    const res = await post({ status: 'in_progress' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: T1, status: 'in_progress' } })
    expect(db.tables.activities[0].status).toBe('in_progress')
  })
})
