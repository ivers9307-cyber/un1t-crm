// EMAIL-TICKET.4 — marking a ticket read.

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

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { makeDb, updatesTo } from '../../_test-db'
import { T_STUDIO, T_ACCOUNTS, COACH, GRANT_STUDIO, baseState } from '../../_test-fixtures'

function post(id) {
  return POST(
    new Request(`http://x/api/email/tickets/${id}/read`, { method: 'POST' }),
    { params: Promise.resolve({ id }) }
  )
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(COACH)
  db = makeDb(baseState({ grants: [GRANT_STUDIO] }))
  createServerClient.mockImplementation(() => db)
})

describe('POST …/read', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_STUDIO.id)).status).toBe(401)
  })

  it('403s without the email_inbox permission', async () => {
    hasPermission.mockReturnValue(false)
    expect((await post(T_STUDIO.id)).status).toBe(403)
  })

  it('404s on a ticket whose mailbox the caller cannot see, and writes nothing', async () => {
    expect((await post(T_ACCOUNTS.id)).status).toBe(404)
    expect(db.updates).toHaveLength(0)
    expect(db._state.tickets.find(t => t.id === T_ACCOUNTS.id).unread_count).toBe(1)
  })

  it('zeroes unread_count and nothing else', async () => {
    const res = await post(T_STUDIO.id)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ unread_count: 0 })
    expect(db._state.tickets.find(t => t.id === T_STUDIO.id).unread_count).toBe(0)
    // Reading is not a change to the ticket — updated_at must not move, or any
    // queue sorted on it silently reorders every time someone looks.
    expect(updatesTo(db, 'email_tickets')[0].payload).toEqual({ unread_count: 0 })
  })
})
