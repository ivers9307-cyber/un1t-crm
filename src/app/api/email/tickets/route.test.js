// EMAIL-TICKET.4 — the ticket queue's access matrix and its saved views.
//
// THE PROPERTY THIS FILE EXISTS FOR
// A user must never see a ticket whose mailbox is not in their visible set.
// Every fixture therefore puts a SECOND ticket on an UNGRANTED mailbox at the
// SAME location: if the per-account gate is ever dropped back to a plain
// location check, these tests fail instead of quietly handing a coach the
// studio's billing correspondence.

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
import { makeDb } from './_test-db'
import {
  LOC_A, LOC_B, MB_STUDIO, MB_ACCOUNTS, T_STUDIO, T_ACCOUNTS,
  COACH, OWNER, MASTER, GRANT_STUDIO, baseState,
} from './_test-fixtures'

function req(query = `?location_id=${LOC_A}`) {
  return new Request(`http://x/api/email/tickets${query}`)
}

async function list(query) {
  const res = await GET(req(query))
  return { res, body: await res.json() }
}

const ids = (tickets) => tickets.map(t => t.id)

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
  setupDb(baseState({ grants: [GRANT_STUDIO] }))
})

describe('GET /api/email/tickets — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await list()).res.status).toBe(401)
  })

  it('403s without the email_inbox permission', async () => {
    hasPermission.mockReturnValue(false)
    expect((await list()).res.status).toBe(403)
    // …and it is THAT key, not the older marketing-email one.
    expect(hasPermission).toHaveBeenCalledWith(COACH, 'email_inbox')
  })

  it('400s without a location_id', async () => {
    expect((await list('')).res.status).toBe(400)
  })

  it('403s for a location outside the caller’s assignments', async () => {
    // List route: the location came from the caller, so 403 (the 404 rule is
    // for detail routes, where an id would otherwise be enumerable).
    expect((await list(`?location_id=${LOC_B}`)).res.status).toBe(403)
  })

  it('400s on an unknown view rather than silently defaulting', async () => {
    const { res } = await list(`?location_id=${LOC_A}&view=archived`)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/email/tickets — mailbox visibility', () => {
  it('a user with email_inbox but NO grants gets an empty list, not an error', async () => {
    setupDb(baseState({ grants: [] }))
    const { res, body } = await list()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: { mailboxes: [], tickets: [] } })
  })

  it('a granted user sees only their mailbox’s tickets', async () => {
    const { body } = await list()
    expect(ids(body.data.tickets)).toEqual([T_STUDIO.id])
    // The accounts@ ticket is at the SAME location and still must not appear.
    expect(ids(body.data.tickets)).not.toContain(T_ACCOUNTS.id)
    expect(body.data.mailboxes.map(m => m.id)).toEqual([MB_STUDIO.id])
  })

  it('an elevated user sees both mailboxes with no grant rows at all', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ grants: [] }))
    const { body } = await list()
    expect(ids(body.data.tickets).sort()).toEqual([T_STUDIO.id, T_ACCOUNTS.id].sort())
    // Tab order: the studio's default mailbox first, then label A→Z.
    expect(body.data.mailboxes.map(m => m.id)).toEqual([MB_STUDIO.id, MB_ACCOUNTS.id])
  })

  it('master is elevated too, and other locations’ mailboxes never leak in', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    setupDb(baseState({ grants: [] }))
    const { body } = await list()
    expect(body.data.mailboxes.map(m => m.location_id)).toEqual([LOC_A, LOC_A])
  })

  it('hides an INACTIVE mailbox and its tickets, from an owner too', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ mailboxes: [MB_STUDIO, { ...MB_ACCOUNTS, active: false }], grants: [] }))
    const { body } = await list()
    expect(body.data.mailboxes.map(m => m.id)).toEqual([MB_STUDIO.id])
    expect(ids(body.data.tickets)).toEqual([T_STUDIO.id])
  })

  it('surfaces mailbox-less tickets to an elevated caller only', async () => {
    // mailbox_id is ON DELETE SET NULL — removing an address must not erase
    // its correspondence from the owner's queue.
    const orphan = { ...T_ACCOUNTS, id: 'orphan-1', mailbox_id: null }
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ tickets: [{ ...T_STUDIO }, orphan], grants: [] }))
    expect(ids((await list()).body.data.tickets)).toContain('orphan-1')

    getCurrentUser.mockResolvedValue(COACH)
    setupDb(baseState({ tickets: [{ ...T_STUDIO }, orphan], grants: [GRANT_STUDIO] }))
    expect(ids((await list()).body.data.tickets)).not.toContain('orphan-1')
  })

  it('filtering to a mailbox the caller cannot see returns no tickets', async () => {
    const { res, body } = await list(`?location_id=${LOC_A}&mailbox_id=${MB_ACCOUNTS.id}`)
    // Empty rather than 403/404 — answering differently would confirm which
    // addresses the studio runs.
    expect(res.status).toBe(200)
    expect(body.data.tickets).toEqual([])
    expect(body.data.mailboxes.map(m => m.id)).toEqual([MB_STUDIO.id])
  })

  it('filters to a granted mailbox when asked', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ grants: [] }))
    const { body } = await list(`?location_id=${LOC_A}&mailbox_id=${MB_ACCOUNTS.id}`)
    expect(ids(body.data.tickets)).toEqual([T_ACCOUNTS.id])
  })
})

describe('GET /api/email/tickets — views', () => {
  const world = (tickets) => {
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ tickets, grants: [] }))
  }

  it('defaults to the live queue (open + pending), newest first', async () => {
    world([
      { ...T_STUDIO, status: 'open', last_message_at: '2026-08-01T00:00:00Z' },
      { ...T_ACCOUNTS, status: 'pending', last_message_at: '2026-08-05T00:00:00Z' },
      { ...T_STUDIO, id: 'solved-1', status: 'solved', last_message_at: '2026-08-09T00:00:00Z' },
    ])
    const { body } = await list()
    expect(ids(body.data.tickets)).toEqual([T_ACCOUNTS.id, T_STUDIO.id])
  })

  it('unassigned = open AND nobody has it', async () => {
    world([
      { ...T_STUDIO, status: 'open', assigned_to: null },
      { ...T_ACCOUNTS, status: 'open', assigned_to: OWNER.id },
      { ...T_STUDIO, id: 'pending-1', status: 'pending', assigned_to: null },
    ])
    const { body } = await list(`?location_id=${LOC_A}&view=unassigned`)
    expect(ids(body.data.tickets)).toEqual([T_STUDIO.id])
  })

  it('mine = assigned to me, open or pending', async () => {
    world([
      { ...T_STUDIO, status: 'open', assigned_to: OWNER.id },
      { ...T_ACCOUNTS, status: 'pending', assigned_to: OWNER.id },
      { ...T_STUDIO, id: 'someone-else', status: 'open', assigned_to: COACH.id },
      { ...T_STUDIO, id: 'mine-solved', status: 'solved', assigned_to: OWNER.id },
    ])
    const { body } = await list(`?location_id=${LOC_A}&view=mine`)
    expect(ids(body.data.tickets).sort()).toEqual([T_STUDIO.id, T_ACCOUNTS.id].sort())
  })

  it('needs_reply = open and the last word was theirs', async () => {
    world([
      { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
      { ...T_ACCOUNTS, status: 'open', last_message_direction: 'outbound' },
    ])
    const { body } = await list(`?location_id=${LOC_A}&view=needs_reply`)
    expect(ids(body.data.tickets)).toEqual([T_STUDIO.id])
  })

  it('closed = solved + closed, and nothing live', async () => {
    world([
      { ...T_STUDIO, status: 'solved' },
      { ...T_ACCOUNTS, status: 'closed' },
      { ...T_STUDIO, id: 'still-open', status: 'open' },
    ])
    const { body } = await list(`?location_id=${LOC_A}&view=closed`)
    expect(ids(body.data.tickets).sort()).toEqual([T_STUDIO.id, T_ACCOUNTS.id].sort())
  })
})
