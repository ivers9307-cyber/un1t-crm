// EMAIL-TICKET-CLEANUP.3 — the Email nav badge count.
//
// TWO PROPERTIES CARRY THE WEIGHT HERE.
//
// 1. THE NUMBER MEANS SOMETHING AN OPERATOR CAN DRIVE TO ZERO. Nothing in this
//    feature auto-closes (Richard, 2026-08-06) — no cron, no sweep, no timer —
//    so a badge that counted the whole live queue would climb forever and be
//    trained into invisibility within a week. It counts mail somebody sent us
//    that nobody has answered: `open` AND an inbound last message. The tests
//    below pin each rejected alternative individually, because "it counts
//    tickets" is not a specification and the next person will be tempted.
//
// 2. IT RESPECTS THE SAME TWO-LEVEL VISIBILITY AS THE QUEUE. A badge is a
//    number about mail you cannot open if the per-account gate is missing —
//    the coach sees "3", clicks, finds one ticket, and learns the badge lies.
//    Worse, the number itself leaks how much billing correspondence exists.
//    Every fixture therefore carries an ungranted accounts@ ticket.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, selectsFrom } from '../_test-db'
import {
  LOC_A, LOC_B, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION, T_STUDIO, T_ACCOUNTS, T_OTHER_LOCATION,
  COACH, COACH_NO_INBOX, OWNER, MULTI_LOCATION,
  GRANT_STUDIO, GRANT_MULTI_OTHER_LOCATION, baseState,
} from '../_test-fixtures'

// The count route takes NO parameters — location comes off the session, like
// every other badge endpoint in the estate. So the fixtures need an active one.
const at = (user, locationId = LOC_A) => ({ ...user, activeLocation: { id: locationId } })

async function count() {
  const res = await GET()
  return { res, body: await res.json() }
}

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

// studio@ is granted to the coach; accounts@ is not. Both are `needs_reply`, so
// a missing per-account gate shows up as 2 instead of 1 rather than as a wash.
const NEEDS_REPLY_BOTH = [
  { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
  { ...T_ACCOUNTS, status: 'open', last_message_direction: 'inbound' },
]

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(at(COACH))
  setupDb(baseState({ tickets: NEEDS_REPLY_BOTH, grants: [GRANT_STUDIO] }))
})

describe('GET /api/email/tickets/count — gates', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await count()).res.status).toBe(401)
  })

  it('answers 0 rather than erroring for a session with no active location', async () => {
    // The poll must be harmless if it ever runs for a session it should not.
    getCurrentUser.mockResolvedValue({ ...COACH, activeLocation: null })
    const { res, body } = await count()
    expect(res.status).toBe(200)
    expect(body.data.count).toBe(0)
  })

  it('answers 0 rather than erroring without the email_inbox permission', async () => {
    getCurrentUser.mockResolvedValue(at(COACH_NO_INBOX))
    const { res, body } = await count()
    expect(res.status).toBe(200)
    expect(body.data.count).toBe(0)
  })

  it('resolves the permission AT the active location, not merely against it', async () => {
    // MULTI is a manager at LOC_A and staff at LOC_B. Pointed at LOC_B — where
    // they hold a mailbox grant but no key — the badge must be 0, or it reports
    // on correspondence they cannot open.
    getCurrentUser.mockResolvedValue(at(MULTI_LOCATION, LOC_B))
    setupDb(baseState({
      tickets: [{ ...T_OTHER_LOCATION, status: 'open', last_message_direction: 'inbound' }],
      grants: [GRANT_MULTI_OTHER_LOCATION],
    }))
    expect((await count()).body.data.count).toBe(0)
  })
})

describe('GET /api/email/tickets/count — the two-level visibility', () => {
  it('counts ONLY tickets on mailboxes the caller may see', async () => {
    // Both tickets need a reply; only studio@ is granted. A count of 2 here
    // means the per-account gate is gone — and the badge would be telling a
    // coach how much billing mail is outstanding.
    expect((await count()).body.data.count).toBe(1)
  })

  it('counts BOTH for an elevated caller, who needs no grants', async () => {
    getCurrentUser.mockResolvedValue(at(OWNER))
    setupDb(baseState({ tickets: NEEDS_REPLY_BOTH, grants: [] }))
    expect((await count()).body.data.count).toBe(2)
  })

  it('includes an ORPHANED ticket for an elevated caller only', async () => {
    // mailbox_id is ON DELETE SET NULL, so deleting an address orphans its
    // correspondence. It stays reachable by an owner — and therefore countable
    // by one — without ever widening to a coach, who can hold no grant for a
    // mailbox that no longer exists.
    const orphan = {
      ...T_STUDIO, id: 'aaaaaaa9-0000-4000-8000-000000000009',
      mailbox_id: null, status: 'open', last_message_direction: 'inbound',
    }
    setupDb(baseState({ tickets: [...NEEDS_REPLY_BOTH, orphan], grants: [GRANT_STUDIO] }))

    getCurrentUser.mockResolvedValue(at(OWNER))
    expect((await count()).body.data.count).toBe(3)

    getCurrentUser.mockResolvedValue(at(COACH))
    setupDb(baseState({ tickets: [...NEEDS_REPLY_BOTH, orphan], grants: [GRANT_STUDIO] }))
    expect((await count()).body.data.count).toBe(1)
  })

  it('never counts another studio’s tickets', async () => {
    getCurrentUser.mockResolvedValue(at(OWNER))
    setupDb(baseState({
      tickets: [...NEEDS_REPLY_BOTH, { ...T_OTHER_LOCATION, status: 'open', last_message_direction: 'inbound' }],
      grants: [],
    }))
    expect((await count()).body.data.count).toBe(2)
  })

  it('answers 0 — not an error — when the caller genuinely has no grants', async () => {
    setupDb(baseState({ tickets: NEEDS_REPLY_BOTH, grants: [] }))
    const { res, body } = await count()
    expect(res.status).toBe(200)
    expect(body.data.count).toBe(0)
  })
})

describe('GET /api/email/tickets/count — WHAT the number counts', () => {
  // Each case below is an alternative definition someone will propose, and the
  // reason it was not chosen. All of them are on the GRANTED mailbox, so only
  // the status/direction predicate can be what excludes them.
  const onStudio = (over) => ({ ...T_STUDIO, mailbox_id: MB_STUDIO.id, ...over })

  it('counts an open ticket whose last message came from THEM', async () => {
    setupDb(baseState({
      tickets: [onStudio({ status: 'open', last_message_direction: 'inbound' })],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(1)
  })

  it('does NOT count `pending` — we already replied, the ball is with the member', async () => {
    // The whole-live-queue definition. With nothing auto-closing, `pending`
    // accumulates permanently, so including it gives a number that only grows.
    setupDb(baseState({
      tickets: [onStudio({ status: 'pending', last_message_direction: 'outbound' })],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(0)
  })

  it('does NOT count a ticket WE started — an open ticket with an outbound last message', async () => {
    // The compose route mints exactly this: status `open`, direction outbound.
    // There is nothing to do about mail we just sent, and `open` alone would
    // badge it forever until someone replied.
    setupDb(baseState({
      tickets: [onStudio({ status: 'open', last_message_direction: 'outbound' })],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(0)
  })

  it('does NOT count solved or closed', async () => {
    setupDb(baseState({
      tickets: [
        onStudio({ id: 's-1', status: 'solved', last_message_direction: 'inbound' }),
        onStudio({ id: 'c-1', status: 'closed', last_message_direction: 'inbound' }),
      ],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(0)
  })

  it('still counts an unanswered ticket somebody has already OPENED', async () => {
    // The `unread_count > 0` definition fails exactly here: the …/read POST
    // zeroes it, so a ticket someone skimmed and did not answer would vanish
    // from the badge — the ticket most at risk of being forgotten.
    setupDb(baseState({
      tickets: [onStudio({ status: 'open', last_message_direction: 'inbound', unread_count: 0 })],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(1)
  })

  it('still counts an unanswered ticket that is ASSIGNED to somebody', async () => {
    // The `unassigned` definition fails here: assignment is optional on this
    // queue, so an assigned-but-untouched ticket is still outstanding work.
    setupDb(baseState({
      tickets: [onStudio({ status: 'open', last_message_direction: 'inbound', assigned_to: 'profile-someone' })],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(1)
  })
})

describe('GET /api/email/tickets/count — merged tickets are tombstones', () => {
  // A finished merge leaves the tombstone `closed`, which scopeToNeedsReply
  // already excludes — so the badge is safe by accident there, not by design.
  // This pins the case where the accident runs out: merge stamps the pointer
  // and flips the status as two writes with no transaction, so "pointer set,
  // still open with an inbound last message" can exist, and the badge would
  // count one conversation twice and send the operator to a ticket the queue
  // does not show. The list and the badge hide tombstones by the SAME scope.
  it('does not count a tombstone whose status write did not land', async () => {
    setupDb(baseState({
      tickets: [
        { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
        {
          ...T_STUDIO, id: 'aaaaaaa8-0000-4000-8000-000000000008',
          status: 'open', last_message_direction: 'inbound', merged_into_id: T_STUDIO.id,
        },
      ],
      grants: [GRANT_STUDIO],
    }))
    expect((await count()).body.data.count).toBe(1)
  })

  it('still counts ordinary tickets — merged_into_id null is the normal row', async () => {
    // What this actually protects: the tombstone scope must not swallow the
    // ordinary rows and badge a permanent 0 — calm and wrong.
    //
    // It does NOT protect the .eq(col, null) misspelling, which matches nothing
    // in real PostgREST: the shared fake's `.eq` is `value === a`, so it matches
    // NULL exactly as `.is` does and this test passes either way. That gap is
    // the mock's, not this test's — a tracked follow-up, since changing `.eq`
    // to reject NULL would ripple through every route test in this tree.
    expect((await count()).body.data.count).toBe(1)
  })
})

describe('GET /api/email/tickets/count — cheapness and failure', () => {
  it('asks for a COUNT ONLY — never the rows', async () => {
    await count()
    const ticketRead = selectsFrom(db, 'email_tickets').at(-1)
    // head: true is the difference between a badge and 200 rows of ticket body
    // fetched every 60 seconds for every staff session.
    expect(ticketRead.options).toEqual({ count: 'exact', head: true })
  })

  it('500s when the mailbox visibility lookup fails — it must NOT badge 0', async () => {
    // EMAIL-TICKET-CLEANUP.2, in miniature. A confident "nothing to do" is the
    // same silent wrong answer as an empty inbox, just smaller; usePolledCount
    // ignores a non-ok response and keeps the last good number, so a blip shows
    // a slightly stale count rather than a wrong zero.
    setupDb(baseState({
      tickets: NEEDS_REPLY_BOTH,
      grants: [GRANT_STUDIO],
      errors: { email_mailbox_access: { code: '42501', message: 'permission denied' } },
    }))
    const { res, body } = await count()
    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
  })

  it('500s when the count query itself fails — it must NOT badge 0', async () => {
    setupDb(baseState({
      tickets: NEEDS_REPLY_BOTH,
      grants: [GRANT_STUDIO],
      errors: { email_tickets: { code: '42703', message: 'column does not exist' } },
    }))
    expect((await count()).res.status).toBe(500)
  })
})

// INBOX-SURFACE.C — the badge counts THIS surface's mailboxes only.
//
// The badge sits on the tab the list route backs, so it has to be narrowed the
// same way. A badge counting mail that surface refuses to show is the red dot
// an operator clicks, finds nothing behind, and learns to ignore — the same
// argument the tombstone scope above makes. The moved account's unanswered mail
// is still real work; it is just counted by the other surface, which IS the
// comparison being run.
describe('GET /api/email/tickets/count — mailbox surface', () => {
  const MOVED = { ...MB_ACCOUNTS, surface: 'inbox' }
  const STAYS = { ...MB_STUDIO, surface: 'tickets' }

  it('does not count tickets on a mailbox moved to the mail surface', async () => {
    getCurrentUser.mockResolvedValue(at(OWNER))
    setupDb(baseState({
      mailboxes: [STAYS, MOVED, MB_OTHER_LOCATION],
      tickets: NEEDS_REPLY_BOTH,
      grants: [],
    }))
    // An owner is elevated, so without the surface narrowing this is 2.
    expect((await count()).body.data.count).toBe(1)
  })

  it('still counts an ORPHAN when every account has moved', async () => {
    // The tab strip is empty in this world but the queue is not: an orphan has
    // no mailbox, so no surface, and it stays on the ticket surface. A badge of
    // 0 here would say "nothing to answer" about mail nobody can see anywhere
    // else.
    const orphan = {
      ...T_STUDIO, id: 'aaaaaaa8-0000-4000-8000-000000000008',
      mailbox_id: null, status: 'open', last_message_direction: 'inbound',
    }
    getCurrentUser.mockResolvedValue(at(OWNER))
    setupDb(baseState({
      mailboxes: [{ ...MB_STUDIO, surface: 'inbox' }, MOVED, MB_OTHER_LOCATION],
      tickets: [...NEEDS_REPLY_BOTH, orphan],
      grants: [],
    }))
    expect((await count()).body.data.count).toBe(1)
  })
})

describe('GET /api/email/tickets/count — agrees with the queue it badges', () => {
  it('matches the list route’s needs_reply view exactly', async () => {
    // Both sides import the SAME predicate from _helpers (scopeToNeedsReply) so
    // they cannot drift, but the contract is worth a test: a badge that counts
    // rows the tab it links to does not show is worse than no badge, because the
    // operator clicks it, finds nothing, and stops trusting the red dot.
    const { GET: LIST } = await import('../route')
    const world = [
      { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
      { ...T_STUDIO, id: 'extra-1', status: 'open', last_message_direction: 'outbound' },
      { ...T_STUDIO, id: 'extra-2', status: 'pending', last_message_direction: 'outbound' },
      { ...T_ACCOUNTS, status: 'open', last_message_direction: 'inbound' },
    ]

    setupDb(baseState({ tickets: world, grants: [GRANT_STUDIO] }))
    const badge = (await count()).body.data.count

    setupDb(baseState({ tickets: world, grants: [GRANT_STUDIO] }))
    const listed = await LIST(new Request(`http://x/api/email/tickets?location_id=${LOC_A}&view=needs_reply`))
    const rows = (await listed.json()).data.tickets

    expect(badge).toBe(rows.length)
    expect(badge).toBe(1)
  })

  it('still agrees once an account has been MOVED to the other surface', async () => {
    // INBOX-SURFACE.C — the agreement has to survive the split, or the trial
    // ships a badge and a tab that disagree from day one. Same world, same
    // caller, elevated so neither side is being narrowed by grants.
    const { GET: LIST } = await import('../route')
    const mailboxes = [
      { ...MB_STUDIO, surface: 'tickets' },
      { ...MB_ACCOUNTS, surface: 'inbox' },
      MB_OTHER_LOCATION,
    ]
    const world = [
      { ...T_STUDIO, status: 'open', last_message_direction: 'inbound' },
      { ...T_ACCOUNTS, status: 'open', last_message_direction: 'inbound' },
    ]
    getCurrentUser.mockResolvedValue(at(OWNER))

    setupDb(baseState({ mailboxes, tickets: world, grants: [] }))
    const badge = (await count()).body.data.count

    setupDb(baseState({ mailboxes, tickets: world, grants: [] }))
    const listed = await LIST(new Request(`http://x/api/email/tickets?location_id=${LOC_A}&view=needs_reply`))
    const rows = (await listed.json()).data.tickets

    expect(badge).toBe(rows.length)
    expect(badge).toBe(1)
  })
})
