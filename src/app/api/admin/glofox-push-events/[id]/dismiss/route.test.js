// GLOFOX3.6 — POST /api/admin/glofox-push-events/[id]/dismiss through the real
// withAuth wrapper: masters only; stamps reviewed_at + reviewed_by on that row.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const E2 = 'e0000000-0000-4000-8000-0000000000e2'
const post = (id = E1) => POST(new Request(`http://localhost/api/admin/glofox-push-events/${id}/dismiss`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const rows = () => [
  { id: E1, source: 'trial', status: 'needs_review', reviewed_at: null, reviewed_by: null },
  { id: E2, source: 'trial', status: 'needs_review', reviewed_at: null, reviewed_by: null },
]
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { glofox_push_events: rows() } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/admin/glofox-push-events/[id]/dismiss', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
  })

  it('403 for an owner who is not a master, and nothing is stamped', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
    expect(db.tables.glofox_push_events.every((r) => r.reviewed_at === null)).toBe(true)
  })

  it('a master stamps only that event', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    const [one, two] = db.tables.glofox_push_events
    expect(one.reviewed_by).toBe(MASTER.id)
    expect(one.reviewed_at).toBeTruthy()
    expect(two.reviewed_at).toBeNull()
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(createFakeDb({ tables: { glofox_push_events: rows() }, errors: { glofox_push_events: { update: { message: 'secret detail' } } } }))
    const res = await post()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
