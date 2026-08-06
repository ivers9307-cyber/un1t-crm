// EMAIL-TICKET.4 — the ticket detail route.
//
// The load-bearing assertion is 404 (never 403) for a ticket on a mailbox the
// caller cannot see: a 403 would confirm the id exists and let an authenticated
// coach enumerate the studio's billing tickets by id.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual('@/lib/permissions')
  return { ...actual, hasPermission: vi.fn(() => true) }
})

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { makeDb } from '../_test-db'
import {
  LOC_B, MB_STUDIO, MB_ACCOUNTS, T_STUDIO, T_ACCOUNTS,
  COACH, OWNER, GRANT_STUDIO, baseState,
} from '../_test-fixtures'

function get(id) {
  return GET(new Request(`http://x/api/email/tickets/${id}`), { params: Promise.resolve({ id }) })
}

const MESSAGES = [
  {
    id: 'm-2', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'outbound', text_body: 'We open at 6.', is_internal_note: false,
    created_at: '2026-08-06T09:30:00Z',
  },
  {
    id: 'm-1', ticket_id: T_STUDIO.id, location_id: T_STUDIO.location_id,
    direction: 'inbound', text_body: 'What time is the 6am?', is_internal_note: false,
    created_at: '2026-08-06T09:00:00Z',
  },
  {
    id: 'm-other', ticket_id: T_ACCOUNTS.id, location_id: T_ACCOUNTS.location_id,
    direction: 'inbound', text_body: 'My DD bounced', is_internal_note: false,
    created_at: '2026-08-06T10:00:00Z',
  },
]

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(COACH)
  setupDb(baseState({ grants: [GRANT_STUDIO], messages: MESSAGES }))
})

describe('GET /api/email/tickets/[id]', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get(T_STUDIO.id)).status).toBe(401)
  })

  it('403s without the email_inbox permission', async () => {
    hasPermission.mockReturnValue(false)
    expect((await get(T_STUDIO.id)).status).toBe(403)
  })

  it('404s for a ticket on a mailbox the caller cannot see — NOT 403', async () => {
    const res = await get(T_ACCOUNTS.id)
    expect(res.status).toBe(404)
    // Byte-identical to a genuinely missing id: nothing distinguishes them.
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
  })

  it('404s for an id that does not exist', async () => {
    expect((await get('aaaaaaa9-0000-4000-8000-000000000009')).status).toBe(404)
  })

  it('404s for a ticket at another location', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      tickets: [{ ...T_STUDIO, id: 'foreign-1', location_id: LOC_B }],
    }))
    expect((await get('foreign-1')).status).toBe(404)
  })

  it('returns the ticket, its mailbox and the thread oldest-first', async () => {
    const res = await get(T_STUDIO.id)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.ticket.id).toBe(T_STUDIO.id)
    expect(data.ticket.mailbox.address).toBe(MB_STUDIO.address)
    expect(data.messages.map(m => m.id)).toEqual(['m-1', 'm-2'])
    // Another ticket's messages never bleed in.
    expect(data.messages.map(m => m.id)).not.toContain('m-other')
  })

  it('lets an elevated caller open a ticket on any active mailbox', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ grants: [], messages: MESSAGES }))
    const res = await get(T_ACCOUNTS.id)
    expect(res.status).toBe(200)
    expect((await res.json()).data.ticket.mailbox.address).toBe(MB_ACCOUNTS.address)
  })

  it('does not mark the ticket read as a side effect of reading it', async () => {
    await get(T_STUDIO.id)
    // Marking read is its own POST — a GET must not write.
    expect(db.updates).toHaveLength(0)
  })
})
