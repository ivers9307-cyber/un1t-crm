// Tests for GET /api/whatsapp/conversations/[id] — the authz gate
// (2026-06-10 audit). This GET previously had NO guard: any
// authenticated principal could read any tenant's full WhatsApp thread
// (message bodies + contact name/email/phone) by id, and reset its
// unread count. It now mirrors the /send and /add-contact siblings:
// getCurrentUser → location gate on the conversation's location_id.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (user?.role === 'master') return null
    const ids = (user?.locations || []).map((l) => l.id)
    if (ids.includes(locationId)) return null
    return new Response(JSON.stringify({ success: false, error: 'forbidden' }), { status: 403 })
  },
  assertLocationAccessOr404: (user, locationId) => {
    if (user?.role === 'master') return null
    const ids = (user?.locations || []).map((l) => l.id)
    if (ids.includes(locationId)) return null
    return new Response(JSON.stringify({ success: false, error: 'forbidden' }), { status: 404 })
  },
  // Mirrors the real guard's contract (INBOX-PERM.1): 403 Response when the
  // channel permission is explicitly off, null otherwise. Real resolver
  // behaviour is pinned in src/lib/auth.test.js; here we only need the
  // route to HONOUR the guard's verdict.
  requireInboxPermission: (user, _channel) => {
    if (user?.permissions?.whatsapp === false) {
      return new Response(JSON.stringify({ success: false, error: 'forbidden' }), { status: 403 })
    }
    return null
  },
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

// db mock dispatching by table. Captures the unread-reset update so
// tests can assert the side-effect is gated too.
function mockDb({ conversation, messages = [], locationSettings = {} } = {}) {
  const updateEq = vi.fn(() => Promise.resolve({ data: null, error: null }))
  return {
    updateEq,
    from: vi.fn((table) => {
      if (table === 'whatsapp_conversations') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() =>
                Promise.resolve(
                  conversation
                    ? { data: conversation, error: null }
                    : { data: null, error: { message: 'no rows' } }
                )
              ),
            })),
          })),
          update: vi.fn(() => ({ eq: updateEq })),
        }
      }
      if (table === 'whatsapp_messages') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn(() => Promise.resolve({ data: messages, error: null })),
              })),
            })),
          })),
        }
      }
      if (table === 'locations') {
        // FLOW-SEND — the flow_available lookup
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: { settings: locationSettings }, error: null })),
            })),
          })),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
}

const req = () => new Request('http://localhost/api/whatsapp/conversations/c1')
const props = { params: { id: 'c1' } }

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/whatsapp/conversations/[id] — authz gate', () => {
  it('401 when no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req(), props)
    expect(res.status).toBe(401)
  })

  it('404 when the conversation does not exist', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(mockDb({}))
    const res = await GET(req(), props)
    expect(res.status).toBe(404)
  })

  it('404 when the conversation is at another location — thread read blocked, unread count untouched', async () => {
    getCurrentUser.mockResolvedValue({ role: 'manager', locations: [{ id: 'loc-OTHER' }] })
    const db = mockDb({ conversation: { id: 'c1', location_id: 'loc-1' } })
    createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    expect(res.status).toBe(404)
    expect(db.updateEq).not.toHaveBeenCalled()
  })

  it('returns thread + messages and resets unread for a caller at the location', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', locations: [{ id: 'loc-1' }] })
    const db = mockDb({
      conversation: { id: 'c1', location_id: 'loc-1' },
      messages: [{ id: 'm1', body: 'hi' }],
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.conversation.id).toBe('c1')
    expect(body.messages).toHaveLength(1)
    expect(body.flow_available).toBe(false)
    expect(db.updateEq).toHaveBeenCalled()
  })

  it('flags flow_available when the location has a booking Flow configured (FLOW-SEND)', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', locations: [{ id: 'loc-1' }] })
    const db = mockDb({
      conversation: { id: 'c1', location_id: 'loc-1' },
      locationSettings: { whatsapp_flow: { flow_id: '1343015528022374' } },
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    const body = await res.json()
    expect(body.flow_available).toBe(true)
  })

  it('403 when the caller lacks the whatsapp channel permission — no DB touched (INBOX-PERM.1)', async () => {
    getCurrentUser.mockResolvedValue({
      role: 'staff',
      locations: [{ id: 'loc-1' }],
      permissions: { whatsapp: false },
    })
    const db = mockDb({ conversation: { id: 'c1', location_id: 'loc-1' } })
    createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    expect(res.status).toBe(403)
    expect(db.from).not.toHaveBeenCalled()
    expect(db.updateEq).not.toHaveBeenCalled()
  })

  it('master can read any conversation', async () => {
    getCurrentUser.mockResolvedValue({ role: 'master', locations: [] })
    createServerClient.mockReturnValue(
      mockDb({ conversation: { id: 'c1', location_id: 'loc-1' } })
    )
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
  })
})
