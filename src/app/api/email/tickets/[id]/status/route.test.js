// EMAIL-TICKET.4 — ticket lifecycle transitions.
//
// solved_at / closed_at must be stamped going in and CLEARED coming out. A
// ticket reopened while still carrying solved_at reads as handled in every
// report that touches those columns, which is exactly the "silently shrinking
// queue" this design refuses.

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
import { makeDb } from '../../_test-db'
import { T_STUDIO, T_ACCOUNTS, COACH, GRANT_STUDIO, baseState } from '../../_test-fixtures'

function post(id, body) {
  return POST(
    new Request(`http://x/api/email/tickets/${id}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

let db
function setupDb(ticket) {
  db = makeDb(baseState({ grants: [GRANT_STUDIO], tickets: [{ ...T_STUDIO, ...ticket }] }))
  createServerClient.mockImplementation(() => db)
  return db
}

/** Set a status and hand back the persisted row. */
async function move(status) {
  const res = await post(T_STUDIO.id, { status })
  expect(res.status).toBe(200)
  return (await res.json()).data.ticket
}

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(COACH)
  setupDb({})
})

describe('POST …/status — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_STUDIO.id, { status: 'solved' })).status).toBe(401)
  })

  it('403s without the email_inbox permission', async () => {
    hasPermission.mockReturnValue(false)
    expect((await post(T_STUDIO.id, { status: 'solved' })).status).toBe(403)
  })

  it('404s on a ticket whose mailbox the caller cannot see', async () => {
    db = makeDb(baseState({ grants: [GRANT_STUDIO] }))
    createServerClient.mockImplementation(() => db)
    expect((await post(T_ACCOUNTS.id, { status: 'solved' })).status).toBe(404)
    expect(db.updates).toHaveLength(0)
  })

  it('400s on a status outside the CHECK constraint', async () => {
    expect((await post(T_STUDIO.id, { status: 'in_progress' })).status).toBe(400)
    expect((await post(T_STUDIO.id, {})).status).toBe(400)
  })
})

describe('POST …/status — timestamps', () => {
  it('solving stamps solved_at', async () => {
    const t = await move('solved')
    expect(t.status).toBe('solved')
    expect(t.solved_at).toBeTruthy()
    expect(t.closed_at).toBeNull()
  })

  it('reopening a solved ticket clears solved_at', async () => {
    setupDb({ status: 'solved', solved_at: '2026-08-05T00:00:00Z' })
    const t = await move('open')
    expect(t.status).toBe('open')
    expect(t.solved_at).toBeNull()
    expect(t.closed_at).toBeNull()
  })

  it('closing stamps closed_at and keeps an earlier solved_at', async () => {
    setupDb({ status: 'solved', solved_at: '2026-08-05T00:00:00Z' })
    const t = await move('closed')
    expect(t.closed_at).toBeTruthy()
    // It genuinely was solved, then closed — don't rewrite that.
    expect(t.solved_at).toBe('2026-08-05T00:00:00Z')
  })

  it('reopening a closed ticket clears BOTH stamps', async () => {
    setupDb({ status: 'closed', solved_at: '2026-08-05T00:00:00Z', closed_at: '2026-08-06T00:00:00Z' })
    const t = await move('pending')
    expect(t.status).toBe('pending')
    expect(t.solved_at).toBeNull()
    expect(t.closed_at).toBeNull()
  })

  it('re-solving an already-solved ticket does not rewrite solved_at', async () => {
    setupDb({ status: 'solved', solved_at: '2026-08-05T00:00:00Z' })
    expect((await move('solved')).solved_at).toBe('2026-08-05T00:00:00Z')
  })
})
