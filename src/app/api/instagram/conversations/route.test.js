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

// INBOXFOLLOW.1 — the queues see every waiting thread, and the route returns the
// studio's follow-up config (the defaults when none is named).
describe('GET /api/instagram/conversations — queues and follow-up config', () => {
  const id = (n) => `a2000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const hoursAgo = (n) => new Date(Date.UTC(2026, 10, 25) - n * 3600_000).toISOString()

  it('returns all 55 waiting threads of a 60-thread studio, not the latest 50', async () => {
    const rows = []
    for (let n = 1; n <= 55; n++) rows.push({ id: id(n), location_id: LOC_A, last_message_at: hoursAgo(n + 10), last_message_direction: 'inbound' })
    for (let n = 56; n <= 60; n++) rows.push({ id: id(n), location_id: LOC_A, last_message_at: hoursAgo(n - 55), last_message_direction: 'outbound' })
    db.tables.instagram_conversations = rows
    getCurrentUser.mockResolvedValue(inbox(true))
    const body = await (await get(`?location_id=${LOC_A}`)).json()
    expect(body.conversations).toHaveLength(60)
    expect(body.conversations.filter((c) => c.last_message_direction === 'inbound')).toHaveLength(55)
  })

  it('answers the follow-up config: the defaults with no studio named or none stored', async () => {
    getCurrentUser.mockResolvedValue(inbox(true))
    expect((await (await get()).json()).followup).toEqual({ quietHours: 48, nudgeEnabled: false })
    expect((await (await get(`?location_id=${LOC_A}`)).json()).followup).toEqual({ quietHours: 48, nudgeEnabled: false })
  })
})
