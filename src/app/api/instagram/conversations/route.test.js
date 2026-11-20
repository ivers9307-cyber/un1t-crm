// GET /api/instagram/conversations through the real withAuth wrapper: signed in,
// the channel permission (403), then the caller's studios (or one named one,
// 403 if it is not theirs).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const inbox = (on) => person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: on } } }, LOC_A)
const get = (qs = '') => GET(new Request(`http://localhost/api/instagram/conversations${qs}`))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    instagram_conversations: [
      { id: 'a1000000-0000-4000-8000-000000000001', location_id: LOC_A, last_message_at: '2026-11-01T00:00:00Z' },
      { id: 'a1000000-0000-4000-8000-000000000002', location_id: LOC_B, last_message_at: '2026-11-02T00:00:00Z' },
    ],
    contacts: [],
    agent_membership_requests: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/instagram/conversations', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without the inbox permission, nothing read', async () => {
    getCurrentUser.mockResolvedValue(inbox(false))
    const res = await get()
    expect(res.status).toBe(403)
    expect(db.calls).toEqual([])
  })

  it('403 for a ?location_id that is not the caller’s', async () => {
    getCurrentUser.mockResolvedValue(inbox(true))
    expect((await get(`?location_id=${LOC_B}`)).status).toBe(403)
  })

  it('lists the caller’s studios’ threads only', async () => {
    getCurrentUser.mockResolvedValue(inbox(true))
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).conversations.map((c) => c.location_id)).toEqual([LOC_A])
  })

  it('a failed read answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(inbox(true))
    db.errors.instagram_conversations = { select: { message: 'canceling statement due to statement timeout' } }
    const res = await get()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load the conversations.' })
  })
})
