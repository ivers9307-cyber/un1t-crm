// INBOX-PERM.2 — GET/PATCH /api/email/conversations/[id] (legacy detail).
//
// This route both READS message bodies and WRITES (it zeroes unread_count on a
// GET, and PATCH stamps resolved_at), so the wrong permission key here was not
// only a disclosure — a user who should never have seen the queue could clear
// its unread badges and resolve threads out of it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET, PATCH } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, updatesTo } from '../../tickets/_test-db'
import { LOC_B, WA_ONLY, EMAIL_ONLY, CONV, baseState } from '../_test-fixtures'

function get(id = CONV.id) {
  return GET(new Request(`http://x/api/email/conversations/${id}`), { params: Promise.resolve({ id }) })
}
function patch(id, body) {
  return PATCH(
    new Request(`http://x/api/email/conversations/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  setupDb(baseState())
  getCurrentUser.mockResolvedValue(EMAIL_ONLY)
})

describe('GET /api/email/conversations/[id]', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403s a user holding `whatsapp` but NOT `email_inbox`', async () => {
    getCurrentUser.mockResolvedValue(WA_ONLY)
    const res = await get()
    expect(res.status).toBe(403)
    // No read of the thread AND no write of unread_count.
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('allows a user holding `email_inbox` and returns the thread oldest-first', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conversation.id).toBe(CONV.id)
    expect(body.messages.map(m => m.id)).toEqual(['m-1', 'm-2'])
  })

  it('404s a conversation at another location', async () => {
    setupDb(baseState({ conversations: [{ ...CONV, location_id: LOC_B }] }))
    expect((await get()).status).toBe(404)
  })
})

describe('PATCH /api/email/conversations/[id]', () => {
  it('403s a user holding `whatsapp` but NOT `email_inbox`', async () => {
    getCurrentUser.mockResolvedValue(WA_ONLY)
    const res = await patch(CONV.id, { resolved: true })
    expect(res.status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('allows a user holding `email_inbox` to resolve', async () => {
    const res = await patch(CONV.id, { resolved: true })
    expect(res.status).toBe(200)
    expect(updatesTo(db, 'email_conversations')[0].payload.resolved_at).toBeTruthy()
  })
})
