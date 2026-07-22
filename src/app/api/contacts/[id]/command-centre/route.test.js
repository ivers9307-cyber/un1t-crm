// Route-level tests for GET /api/contacts/[id]/command-centre.
//
// Coverage:
//   - 401 when no user
//   - 404 when the contact doesn't exist
//   - 404 when the contact is in a different location (IDOR)
//   - base scope keeps the original bundle shape (no drawer keys), plus
//     the INBOX-REDESIGN.4.1 `signals` + `latestNote` triage fields
//   - signals: 'overdue' (+ arrears) wins when the contact has an open
//     PAST_DUE invoice, proving arrears is resolved BEFORE churn classifies
//   - signals: an 'active' member tripping a churn-radar signal scores
//     as at-risk with a label + tier
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
  for (const m of ['select', 'eq', 'order', 'limit', 'range']) c[m] = vi.fn(() => c)
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

  it('base scope keeps the original bundle shape, plus triage signals', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const db = mockDb({
      contacts: { data: CONTACT, error: null },
      activities: { data: [{ id: 'a1' }], error: null },
      event_types: { data: [{ id: 'et1' }], error: null },
      notes: {
        data: [{ content: 'Called about renewal', created_at: '2026-07-20T10:00:00.000Z' }],
        error: null,
      },
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j).toMatchObject({ success: true, contact: { id: 'c1' } })
    expect(j.activities).toHaveLength(1)
    expect(j.event_types).toHaveLength(1)
    // Drawer-only keys (the full notes list, wa window) still stay off the
    // base bundle — only DRAWER.2's ?scope=drawer branch adds those.
    expect(j.notes).toBeUndefined()
    expect(j.wa).toBeUndefined()
    // INBOX-REDESIGN.4.1 — signals + latestNote DO ship in the base bundle
    // (that's the point: the inbox panel gets them without ?scope=drawer),
    // so the base path now queries `notes` too (for latestNote only — a
    // single row, distinct from the drawer's full notes list).
    expect(db.__queried).toContain('notes')
    expect(j.signals).toEqual({
      churnClass: 'out',
      churnLabel: null,
      churnTier: null,
      arrearsCents: 0,
      arrearsCount: 0,
      visits30: 0,
      lastAttendedAt: null,
    })
    expect(j.latestNote).toEqual({ content: 'Called about renewal', created_at: '2026-07-20T10:00:00.000Z' })
  })

  it('signals: an open PAST_DUE invoice classifies as overdue (arrears resolved before churn)', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const MEMBER = { id: 'c1', location_id: 'loc1', name: 'Jay Byrne', glofox_membership_status: 'member' }
    const db = mockDb({
      contacts: { data: MEMBER, error: null },
      activities: { data: [], error: null },
      event_types: { data: [], error: null },
      // loadContactArrears fires two glofox_invoices reads (PAST_DUE, then
      // PAID); this table-keyed mock returns the SAME canned rows for both.
      // Omitting glofox_user_id keeps nettedOutByRetry (src/lib/glofox-
      // arrears.js) from matching the row against "itself" as a settled
      // retry — see that module's member-keyed matching — so it survives
      // netting and lands in arrears as a real PAST_DUE debt.
      glofox_invoices: {
        data: [{ id: 'inv1', contact_id: 'c1', amount_cents: 6000, invoice_date: '2026-07-01' }],
        error: null,
      },
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    const j = await res.json()
    expect(res.status).toBe(200)
    // The route can only reach 'overdue' here because arrears (loadContactArrears)
    // was awaited to completion BEFORE churnCtx/classifyContact ran — proving
    // the arrears-before-churn ordering the route relies on actually holds.
    expect(j.signals).toMatchObject({
      churnClass: 'overdue',
      churnLabel: 'Payment overdue',
      churnTier: null,
      arrearsCents: 6000,
      arrearsCount: 1,
    })
  })

  it('signals: an active member tripping a churn-radar signal scores as at risk', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const goneQuietAt = new Date(Date.now() - 20 * 86_400_000).toISOString()
    const MEMBER = {
      id: 'c1',
      location_id: 'loc1',
      name: 'Sam Byrne',
      glofox_membership_status: 'member',
      glofox_membership_type: 'time',
      last_attended_at: goneQuietAt,
      total_attended_30d: 0,
      total_attended_7d: 0,
      total_noshow_30d: 0,
    }
    const db = mockDb({
      contacts: { data: MEMBER, error: null },
      activities: { data: [], error: null },
      event_types: { data: [], error: null },
    })
    createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.signals.churnClass).toBe('active')
    expect(j.signals.churnLabel).toBe('At risk')
    expect(j.signals.churnTier).toBe('low')
    expect(j.signals.arrearsCents).toBe(0)
    expect(j.signals.arrearsCount).toBe(0)
    expect(j.signals.lastAttendedAt).toBe(goneQuietAt)
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
