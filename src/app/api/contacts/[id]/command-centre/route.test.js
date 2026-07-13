// Route-level tests for GET /api/contacts/[id]/command-centre.
//
// Coverage:
//   - 401 when no user
//   - 404 when the contact doesn't exist
//   - 404 when the contact is in a different location (IDOR)
//   - base scope keeps the original bundle shape (no drawer keys)
//   - ?scope=drawer adds notes / sequences / wa / composer_templates /
//     permissions; wa.window_open derives from window_expires_at
//   - whatsapp_templates only queried when the caller holds `whatsapp`

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    return null
  },
}))

vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => false),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

const USER = { id: 'u1', locations: [{ id: 'loc1' }] }
const CONTACT = { id: 'c1', location_id: 'loc1', name: 'Emma Byrne' }

// Generic awaitable query-chain mock: every builder method returns the
// chain; awaiting it resolves the table's canned result.
function chain(result) {
  const c = {}
  for (const m of ['select', 'eq', 'order', 'limit']) c[m] = vi.fn(() => c)
  c.maybeSingle = vi.fn(() => Promise.resolve(result))
  c.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return c
}

function mockDb(results) {
  const queried = []
  return {
    __queried: queried,
    from: vi.fn((table) => {
      queried.push(table)
      return chain(results[table] ?? { data: [], error: null })
    }),
  }
}

function req(query = '') {
  return new Request(`https://example.com/api/contacts/c1/command-centre${query}`)
}
const props = { params: Promise.resolve({ id: 'c1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(false)
})

describe('GET /api/contacts/[id]/command-centre', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req(), props)
    expect(res.status).toBe(401)
  })

  it('404 when the contact does not exist', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(mockDb({ contacts: { data: null, error: null } }))
    const res = await GET(req(), props)
    expect(res.status).toBe(404)
  })

  it('404 (not 403) when the contact is in another location', async () => {
    getCurrentUser.mockResolvedValue(USER)
    createServerClient.mockReturnValue(mockDb({
      contacts: { data: { ...CONTACT, location_id: 'other' }, error: null },
    }))
    const res = await GET(req(), props)
    expect(res.status).toBe(404)
  })

  it('base scope keeps the original bundle shape', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const db = mockDb({
      contacts: { data: CONTACT, error: null },
      activities: { data: [{ id: 'a1' }], error: null },
      event_types: { data: [{ id: 'et1' }], error: null },
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j).toMatchObject({ success: true, contact: { id: 'c1' } })
    expect(j.activities).toHaveLength(1)
    expect(j.event_types).toHaveLength(1)
    expect(j.notes).toBeUndefined()
    expect(j.wa).toBeUndefined()
    expect(db.__queried).not.toContain('notes')
  })

  it('?scope=drawer adds notes, sequences, wa window and permissions', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const db = mockDb({
      contacts: { data: CONTACT, error: null },
      activities: { data: [], error: null },
      event_types: { data: [], error: null },
      notes: { data: [{ id: 'n1' }], error: null },
      sequence_enrollments: { data: [{ id: 's1' }], error: null },
      whatsapp_conversations: { data: [{ id: 'w1', window_expires_at: future }], error: null },
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(req('?scope=drawer'), props)
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.notes).toHaveLength(1)
    expect(j.sequences).toHaveLength(1)
    expect(j.wa).toMatchObject({ window_open: true, window_expires_at: future })
    expect(j.permissions).toEqual({ whatsapp: false, sms: false, email: false })
    // no `whatsapp` permission → template table never touched
    expect(db.__queried).not.toContain('whatsapp_templates')
    expect(j.composer_templates).toEqual([])
  })

  it('drawer scope loads composer templates when the caller can WhatsApp', async () => {
    getCurrentUser.mockResolvedValue(USER)
    hasPermission.mockImplementation((_u, perm) => perm === 'whatsapp')
    const db = mockDb({
      contacts: { data: CONTACT, error: null },
      activities: { data: [], error: null },
      event_types: { data: [], error: null },
      notes: { data: [], error: null },
      sequence_enrollments: { data: [], error: null },
      whatsapp_conversations: { data: [], error: null },
      whatsapp_templates: {
        data: [{
          name: 'welcome_util', language: 'en', status: 'APPROVED', category: 'UTILITY',
          components: [{ type: 'BODY', text: 'Hi there' }],
        }],
        error: null,
      },
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(req('?scope=drawer'), props)
    const j = await res.json()
    expect(db.__queried).toContain('whatsapp_templates')
    expect(j.composer_templates).toEqual([
      { name: 'welcome_util', language: 'en', bodyText: 'Hi there', sendable: true },
    ])
    expect(j.wa).toEqual({ window_open: false, window_expires_at: null })
  })
})
