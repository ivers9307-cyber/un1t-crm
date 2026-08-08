// EMAIL-TICKET.4 — marking a ticket read.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, updatesTo, writesTo } from '../../_test-db'
import {
  T_STUDIO, T_ACCOUNTS, T_OTHER_LOCATION, COACH, COACH_NO_INBOX, MULTI_LOCATION,
  GRANT_STUDIO, GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION, baseState,
} from '../../_test-fixtures'

function post(id) {
  return POST(
    new Request(`http://x/api/email/tickets/${id}/read`, { method: 'POST' }),
    { params: Promise.resolve({ id }) }
  )
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(COACH)
  db = makeDb(baseState({ grants: [GRANT_STUDIO] }))
  createServerClient.mockImplementation(() => db)
})

describe('POST …/read', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_STUDIO.id)).status).toBe(401)
  })

  // EMAIL-TICKET-CLEANUP.1 — 404, not the 403 this used to be. The gate moved
  // into loadTicketForUser so it can resolve at the TICKET'S location, which
  // means it now runs AFTER the row is read — and a 403 there would say "this
  // id exists, at a studio where you lack the key" while a bad id says 404.
  // Every other way to be refused on this surface is already indistinguishable;
  // a fourth reason has to be too.
  // The caller holds the studio@ GRANT and is assigned to the location. Only
  // the surface key is missing, so this is the one test that isolates it.
  it('404s without the email_inbox permission AT THE TICKET\u2019S location, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(COACH_NO_INBOX)
    expect((await post(T_STUDIO.id)).status).toBe(404)
    expect(db.updates).toHaveLength(0)
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

// EMAIL-TICKET-CLEANUP.1 — the permission follows the TICKET'S location.
//
// The gate used to be hasPermission(), resolved against the caller's ACTIVE
// location, which is not the question a route keyed on a ticket id is asked.
// ONE user, TWO studios, opposite answers — and the real resolver rather than a
// mock, because a mock cannot fail the way the shipped code did.
//
// They are a manager at LOC_A (email_inbox true by role default) and plain
// staff at LOC_B (false). They are ASSIGNED to both and hold a mailbox GRANT at
// both, so assertLocationAccess and the per-account gate pass either way: the
// only thing that can separate these two cases is where the key resolves.
describe('POST …/read — the permission follows the TICKET’S location', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(MULTI_LOCATION)
    db = makeDb(baseState({
      tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS }, { ...T_OTHER_LOCATION }],
      grants: [GRANT_MULTI_STUDIO, GRANT_MULTI_OTHER_LOCATION],
    }))
    createServerClient.mockImplementation(() => db)
  })

  it('ALLOWS the studio where they hold the key', async () => {
    // The wrongly-DENIED direction. The old gate read the active location — of
    // which this user has none — and refused their own studio outright.
    expect((await post(T_STUDIO.id)).status).toBe(200)
  })

  it('DENIES the studio where they do not, even holding a mailbox grant there', async () => {
    // The wrongly-ALLOWED direction, and the one that leaks: a grant on another
    // studio's address must not become readable because a DIFFERENT studio says
    // manager. 404, and nothing written.
    expect((await post(T_OTHER_LOCATION.id)).status).toBe(404)
    expect(writesTo(db)).toEqual([])
    expect(db._state.tickets.find(t => t.id === T_OTHER_LOCATION.id).unread_count).toBe(1)
  })
})

// EMAIL-TICKET-CLEANUP.2 — a FAILED visibility lookup is not "no mailboxes".
//
// Left as `|| []` it fell through the per-account gate as an empty visible set,
// so every detail route answered 404 — telling an operator the ticket in front
// of them does not exist, on the strength of a blipped query. Revert the error
// branch in loadVisibleMailboxes and this goes back to 404 and fails.
describe('POST …/read — a failed mailbox lookup is not an empty one', () => {
  it('500s when the mailbox query errors, rather than 404ing', async () => {
    db = makeDb(baseState({
      grants: [GRANT_STUDIO],
      errors: { email_mailboxes: { code: '42703', message: 'column does not exist' } },
    }))
    createServerClient.mockImplementation(() => db)
    expect((await post(T_STUDIO.id)).status).toBe(500)
    expect(writesTo(db)).toEqual([])
  })

  it('500s when the GRANT query errors — the half that silently demotes a granted coach', async () => {
    db = makeDb(baseState({
      grants: [GRANT_STUDIO],
      errors: { email_mailbox_access: { code: '42501', message: 'permission denied' } },
    }))
    createServerClient.mockImplementation(() => db)
    expect((await post(T_STUDIO.id)).status).toBe(500)
  })
})
