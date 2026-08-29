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
  return { ...actual, hasPermissionForLocation: vi.fn(() => true) }
})

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { makeDb } from './_test-db'
import {
  LOC_A, LOC_B, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION, T_STUDIO, T_ACCOUNTS,
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
  hasPermissionForLocation.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(COACH)
  setupDb(baseState({ grants: [GRANT_STUDIO] }))
})

describe('GET /api/email/tickets — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await list()).res.status).toBe(401)
  })

  it('403s without the email_inbox permission', async () => {
    hasPermissionForLocation.mockReturnValue(false)
    expect((await list()).res.status).toBe(403)
    // …and it is THAT key, not the older marketing-email one, resolved at the
    // REQUESTED location rather than the caller's active one.
    expect(hasPermissionForLocation).toHaveBeenCalledWith(COACH, LOC_A, 'email_inbox')
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

describe('GET /api/email/tickets — the permission follows the REQUESTED location', () => {
  // EMAIL-TICKET.5. The gate used to be hasPermission(), which resolves
  // against the caller's ACTIVE location — a different question from the one
  // this route is asked. One user, two locations, opposite answers, and the
  // REAL resolver rather than a mock, because a mock cannot fail the way the
  // shipped code did.
  //
  // Their session is pointed at LOC_B (role: 'staff'), where email_inbox is
  // false by role default; at LOC_A they are a manager, where it is true.
  const MULTI = {
    id: COACH.id, email: 'multi@un1tdublin.com',
    role: 'staff', profileRole: 'manager',
    locations: [{ id: LOC_A }, { id: LOC_B }],
    rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
    assignmentsByLocation: {
      [LOC_A]: { role: 'manager', permissions: {} },
      [LOC_B]: { role: 'staff', permissions: {} },
    },
  }

  beforeEach(async () => {
    const real = await vi.importActual('@/lib/permissions')
    hasPermissionForLocation.mockImplementation(real.hasPermissionForLocation)
    getCurrentUser.mockResolvedValue(MULTI)
  })

  it('ALLOWS the location where they hold the key, even though their session is elsewhere', async () => {
    // The old gate denied this outright — the wrongly-denied direction.
    setupDb(baseState({ grants: [GRANT_STUDIO] }))
    const { res } = await list(`?location_id=${LOC_A}`)
    expect(res.status).toBe(200)
  })

  it('DENIES the location where they do not, even holding a mailbox grant there', async () => {
    // The wrongly-ALLOWED direction, and the one that leaks: a grant on
    // another studio's address must not become readable just because the
    // caller's active location says manager.
    setupDb(baseState({
      mailboxes: [MB_STUDIO, MB_ACCOUNTS, { ...MB_STUDIO, id: 'mb-b', location_id: LOC_B }],
      grants: [{ mailbox_id: 'mb-b', profile_id: MULTI.id }],
    }))
    const { res, body } = await list(`?location_id=${LOC_B}`)
    expect(res.status).toBe(403)
    expect(body.success).toBe(false)
  })
})

describe('GET /api/email/tickets — mailbox visibility', () => {
  it('a user with email_inbox but NO grants gets an empty list, not an error', async () => {
    setupDb(baseState({ grants: [] }))
    const { res, body } = await list()
    expect(res.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: { mailboxes: [], tickets: [], viewer_is_elevated: false, mailboxes_on_mail: [] },
    })
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

// EMAIL-MERGE.3 — a merged ticket is a TOMBSTONE and must not be listed.
//
// It is `closed` plus a pointer, deliberately — no fifth status value — which
// means the status vocabulary cannot hide it: the `closed` view asks for
// exactly solved+closed, so a tombstone lands there looking like an ordinary
// resolved ticket. That is the duplicate this whole feature exists to remove,
// wearing a different hat: the operator finds two records of one conversation
// in their closed queue and is back where they started.
describe('GET /api/email/tickets — merged tickets are tombstones', () => {
  const merged = (over) => ({ ...T_ACCOUNTS, merged_into_id: T_STUDIO.id, ...over })

  it('hides a merged ticket from the CLOSED view, where status cannot hide it', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({
      tickets: [
        { ...T_STUDIO, status: 'closed' },
        merged({ status: 'closed' }),
      ],
      grants: [],
    }))
    const { body } = await list(`?location_id=${LOC_A}&view=closed`)
    // The survivor is still there — hiding tombstones must not hide history.
    expect(ids(body.data.tickets)).toEqual([T_STUDIO.id])
  })

  it('hides one whose status write did not land either', async () => {
    // Merge stamps the pointer and flips the status as two writes with no
    // transaction around them, so "pointer set, still open" is a state that can
    // exist. The scope keys on the POINTER, not the status, so a half-applied
    // merge still cannot show the conversation twice in the live queue.
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({
      tickets: [{ ...T_STUDIO, status: 'open' }, merged({ status: 'open' })],
      grants: [],
    }))
    expect(ids((await list()).body.data.tickets)).toEqual([T_STUDIO.id])
  })

  it('leaves ordinary tickets alone — merged_into_id null is the normal row', async () => {
    // What this actually protects: the tombstone scope must not swallow the
    // ordinary rows — a filter written inside out (or an .is() left non-null)
    // would empty the queue completely, which is the more damaging direction.
    //
    // It does NOT protect the .eq('merged_into_id', null) misspelling, which
    // matches nothing in real PostgREST: the shared fake's `.eq` is
    // `value === a`, so it matches NULL exactly as `.is` does and this test
    // passes either way. That gap is the mock's, not this test's — it is a
    // tracked follow-up with wider blast radius than one route.
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ grants: [] }))
    expect(ids((await list()).body.data.tickets).sort()).toEqual([T_STUDIO.id, T_ACCOUNTS.id].sort())
  })
})

// EMAIL-TICKET-CLEANUP.2 — a FAILED visibility lookup is not an empty one.
//
// `mailboxRes.data` is null on a PostgREST error, so `|| []` turned "we could
// not find out what you may read" into "you may read nothing" — served as a
// cheerful 200 `{ mailboxes: [], tickets: [], viewer_is_elevated: false }`. TicketInbox renders that as
// the calm "no email accounts here yet" empty state, so the operator reads it
// as "no mail", stops looking, and nobody ever learns the query failed.
//
// The 500 is what routes them to TicketInbox's OTHER branch — "Could not load
// the ticket inbox" with a Try again button — which is the whole point: the two
// outcomes have to look different to the person reading them. Revert the error
// branch in loadVisibleMailboxes and every test here goes back to 200 and fails.
describe('GET /api/email/tickets — a failed mailbox lookup is not an empty inbox', () => {
  it('500s when the mailbox query errors, rather than 200 with an empty list', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      errors: { email_mailboxes: { code: '42703', message: 'column does not exist' } },
    }))
    const { res, body } = await list()
    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    // …and it must NOT hand back the empty shape the UI reads as "no accounts".
    expect(body.data).toBeUndefined()
  })

  it('500s when the GRANT query errors — the half that silently demotes a granted coach', async () => {
    // The more dangerous of the two: the mailbox list itself loads fine, so the
    // surface looks healthy and simply shows a granted person nothing.
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      errors: { email_mailbox_access: { code: '42501', message: 'permission denied' } },
    }))
    expect((await list()).res.status).toBe(500)
  })

  it('still returns a NORMAL empty list when the caller genuinely has no grants', async () => {
    // The case the 500 must not swallow. A coach with no grants and a studio
    // with no addresses are both ordinary states, and a 403/500 there would
    // look like a bug to whoever hit it.
    setupDb(baseState({ grants: [] }))
    const { res, body } = await list()
    expect(res.status).toBe(200)
    expect(body.data).toEqual({
      mailboxes: [], tickets: [], viewer_is_elevated: false, mailboxes_on_mail: [],
    })
  })
})


// RETIRE-TICKETS.1 — this route is a DEPRECATED SHIM for the shipped staff
// app: surface narrowing is gone (mig 578), so it lists every visible
// mailbox, exactly like /api/email/mail. What stays load-bearing here is the
// orphan rule and the access model — the shim must keep serving them until
// the mobile Mail port's OTA lands and the sweep deletes it.
describe('GET /api/email/tickets — shim lists ALL visible mailboxes', () => {
  it('lists both of a studio\'s accounts for an owner, tickets included', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ grants: [] }))
    const { body } = await list()
    expect(body.data.mailboxes.map(m => m.id).sort()).toEqual([MB_ACCOUNTS.id, MB_STUDIO.id].sort())
    expect(ids(body.data.tickets).sort()).toEqual([T_STUDIO.id, T_ACCOUNTS.id].sort())
  })

  // 🔴 THE HALF THAT LOSES MAIL IF IT IS GOT WRONG. email_tickets.mailbox_id
  // is ON DELETE SET NULL — deliberately, so removing an address never
  // deletes a member's correspondence — and mig 484's backfill predates the
  // column, so orphans genuinely exist. Elevated-only, on every surface.
  describe('tickets with no mailbox', () => {
    const orphan = { ...T_ACCOUNTS, id: 'orphan-1', mailbox_id: null }

    it('shows an orphan to an elevated caller', async () => {
      getCurrentUser.mockResolvedValue(OWNER)
      setupDb(baseState({ tickets: [{ ...T_STUDIO }, orphan], grants: [] }))
      expect(ids((await list()).body.data.tickets)).toContain('orphan-1')
    })

    it('is still elevated-only — a granted coach never sees orphans', async () => {
      getCurrentUser.mockResolvedValue(COACH)
      setupDb(baseState({ tickets: [{ ...T_STUDIO }, orphan], grants: [GRANT_STUDIO] }))
      expect(ids((await list()).body.data.tickets)).not.toContain('orphan-1')
    })

    it('a caller with NO visible mailboxes at all still gets a plain empty list', async () => {
      // Not an error and not an orphan dump: a coach with no grants is an
      // ordinary state, and elevation is what unlocks orphans.
      getCurrentUser.mockResolvedValue(COACH)
      setupDb(baseState({ tickets: [{ ...T_STUDIO }, orphan], grants: [] }))
      const { res, body } = await list()
      expect(res.status).toBe(200)
      expect(body.data).toEqual({
        mailboxes: [], tickets: [], viewer_is_elevated: false, mailboxes_on_mail: [],
      })
    })
  })
})

// RETIRE-TICKETS.1 — `mailboxes_on_mail` described the surface split; the
// split is gone but the SHAPE is frozen for the shipped bundle: always
// present, always [].
describe('GET /api/email/tickets — mailboxes_on_mail is a frozen, empty field', () => {
  it('is present and [] on a populated response', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    setupDb(baseState({ grants: [] }))
    const { body } = await list()
    expect(body.data.mailboxes_on_mail).toEqual([])
  })

  it('is present, and empty, on the visible.length === 0 early return', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    setupDb(baseState({ grants: [] }))
    const { body } = await list()
    expect(body.data).toHaveProperty('mailboxes_on_mail')
    expect(body.data.mailboxes_on_mail).toEqual([])
  })
})

// EMAIL-ASSIGN.1 — the queue resolves assignee names server-side (profiles is
// unreadable client-side) and tells the UI whether the viewer may reassign.
describe('assignment enrichment', () => {
  it('attaches assignee_name to assigned rows and leaves unassigned ones null', async () => {
    setupDb(baseState({
      grants: [GRANT_STUDIO],
      tickets: [
        { ...T_STUDIO, assigned_to: 'profile-owner' },
        { ...T_ACCOUNTS, assigned_to: null },
      ],
      profiles: [{ id: 'profile-owner', full_name: 'Orla Owner', role: 'owner' }],
    }))
    getCurrentUser.mockResolvedValue(OWNER)
    const { res, body } = await list()
    expect(res.status).toBe(200)
    const byId = new Map(body.data.tickets.map(t => [t.id, t]))
    expect(byId.get(T_STUDIO.id).assignee_name).toBe('Orla Owner')
    expect(byId.get(T_ACCOUNTS.id).assignee_name).toBeNull()
  })

  it('tells the UI whether the viewer is elevated — the reassign control gates on it', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    expect((await list()).body.data.viewer_is_elevated).toBe(true)

    getCurrentUser.mockResolvedValue(COACH)
    expect((await list()).body.data.viewer_is_elevated).toBe(false)
  })
})
